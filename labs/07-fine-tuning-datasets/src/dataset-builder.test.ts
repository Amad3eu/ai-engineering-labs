import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assessQuality,
  buildDataset,
  ChatLine,
  estimateTokens,
  QUALITY_LIMITS,
  type SplitStats,
  splitDataset,
  toChatJsonl,
  validateChatJsonl,
  writeDataset,
} from './dataset-builder.js';
import { Category, type Example } from './schema.js';

const SYSTEM = 'Faça a triagem do ticket.';

/** `perCategory` tickets por categoria, todos com texto diferente. */
const examples = (perCategory: number): Example[] =>
  Category.options.flatMap((category) =>
    Array.from({ length: perCategory }, (_, i) => ({
      text: `Ticket de exemplo número ${i} da categoria ${category}`,
      category,
      priority: 'P3' as const,
    })),
  );

const countBy = (list: Example[], category: Category) => list.filter((example) => example.category === category).length;

const stats = (byCategory: Record<Category, number>): SplitStats => ({
  examples: Object.values(byCategory).reduce((total, count) => total + count, 0),
  estimatedTokens: 0,
  byCategory,
});
const even = (count: number) => stats({ billing: count, outage: count, access: count, question: count });

test('splitDataset divide 80/20 dentro de cada categoria, sem perder nem repetir exemplo', () => {
  const all = examples(10);
  const { train, validation } = splitDataset(all);

  assert.equal(train.length, 32);
  assert.equal(validation.length, 8);
  for (const category of Category.options) {
    assert.equal(countBy(train, category), 8);
    assert.equal(countBy(validation, category), 2);
  }
  assert.equal(new Set([...train, ...validation].map((example) => example.text)).size, all.length);
});

test('splitDataset dá a mesma divisão para a mesma entrada, em qualquer ordem', () => {
  const all = examples(10);
  assert.deepEqual(splitDataset(all), splitDataset(all.toReversed()));
});

test('splitDataset deixa no treino a classe que só tem um exemplo', () => {
  const lonely: Example = {
    text: 'O único ticket de indisponibilidade do dataset',
    category: 'outage',
    priority: 'P1',
  };
  const billing = examples(5).filter((example) => example.category === 'billing');
  const { train, validation } = splitDataset([...billing, lonely]);

  assert.ok(train.includes(lonely));
  assert.equal(countBy(validation, 'outage'), 0);
  assert.equal(countBy(validation, 'billing'), 1);
});

test('o JSONL gerado segue o formato de chat e passa na própria validação', () => {
  const jsonl = toChatJsonl(
    [
      { text: 'O painel está fora do ar.', category: 'outage', priority: 'P1' },
      { text: 'Como exporto em CSV? Tem "aspas" e\nquebra de linha.', category: 'question', priority: 'P3' },
    ],
    SYSTEM,
  );
  const lines = jsonl.trimEnd().split('\n');

  assert.equal(lines.length, 2);
  assert.deepEqual(ChatLine.parse(JSON.parse(lines[0] ?? '')), {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: '<ticket>\nO painel está fora do ar.\n</ticket>' },
      { role: 'assistant', content: '{"category":"outage","priority":"P1"}' },
    ],
  });
  assert.deepEqual(validateChatJsonl(jsonl), { valid: 2, errors: [] });
  assert.equal(toChatJsonl([], SYSTEM), '');
});

test('validateChatJsonl aponta cada linha inválida pelo número, sem parar na primeira', () => {
  const line = (messages: unknown) => JSON.stringify({ messages });
  const user = { role: 'user', content: 'Não consigo entrar na conta.' };
  const answer = (content: string) => ({ role: 'assistant', content });
  const jsonl = [
    line([user, answer('{"category":"access","priority":"P2"}')]),
    'isto não é json',
    line([
      { role: 'tool', content: 'papel que o formato de chat não tem' },
      answer('{"category":"access","priority":"P2"}'),
    ]),
    line([answer('{"category":"access","priority":"P2"}'), user]),
    line([user, answer('{"category":"urgente","priority":"P2"}')]),
    line([user, answer('{"category":"access","priority":"P2","motivo":"chave a mais"}')]),
    line([user, answer('```json\n{"category":"access","priority":"P2"}\n```')]),
    '',
    line([user, answer('{"category":"access","priority":"P2"}')]),
  ].join('\n');

  const { valid, errors } = validateChatJsonl(jsonl);

  assert.equal(valid, 2);
  assert.deepEqual(
    errors.map((error) => error.line),
    [2, 3, 4, 5, 6, 7],
  );
  assert.match(errors[0]?.message ?? '', /não é JSON válido/);
  assert.match(errors[1]?.message ?? '', /fora do formato de chat/);
  assert.match(errors[2]?.message ?? '', /última mensagem precisa ser do assistant/);
  for (const error of errors.slice(3)) assert.match(error.message, /não é o JSON da triagem/);
});

test('assessQuality: dataset saudável não gera alerta', () => {
  assert.deepEqual(assessQuality(even(15), even(4)), []);
});

test('assessQuality: treino abaixo do mínimo é erro; abaixo do recomendado, aviso', () => {
  const tooSmall = assessQuality(even(2), even(1));
  assert.deepEqual(
    tooSmall.map(({ level, code }) => [level, code]),
    [['error', 'too-small']],
  );
  assert.match(tooSmall[0]?.message ?? '', new RegExp(`pelo menos ${QUALITY_LIMITS.minTrainExamples}`));

  assert.deepEqual(
    assessQuality(even(8), even(2)).map(({ level, code }) => [level, code]),
    [['warning', 'below-recommended']],
  );
});

test('assessQuality: avisa do desbalanceamento só acima do limite', () => {
  const skewed = assessQuality(stats({ billing: 40, outage: 10, access: 10, question: 10 }), even(4));
  assert.deepEqual(
    skewed.map(({ level, code }) => [level, code]),
    [['warning', 'imbalanced']],
  );
  assert.match(skewed[0]?.message ?? '', /40 exemplos e a menor, 10/);

  // 30 para 10 é exatamente o limite de 3×: ainda passa.
  assert.deepEqual(assessQuality(stats({ billing: 30, outage: 10, access: 10, question: 10 }), even(4)), []);
});

test('assessQuality: classe ausente do treino é erro; ausente só da validação, aviso', () => {
  const noQuestion = assessQuality(stats({ billing: 20, outage: 20, access: 20, question: 0 }), even(4));
  assert.deepEqual(
    noQuestion.map(({ level, code }) => [level, code]),
    [['error', 'missing-category']],
  );
  assert.match(noQuestion[0]?.message ?? '', /"question" no treino/);

  const unmeasured = assessQuality(even(15), stats({ billing: 4, outage: 4, access: 0, question: 4 }));
  assert.deepEqual(
    unmeasured.map(({ level, code }) => [level, code]),
    [['warning', 'missing-category']],
  );
  assert.match(unmeasured[0]?.message ?? '', /"access" na validação/);
});

test('buildDataset vai do dado bruto aos arquivos e ao relatório', () => {
  const clean = examples(10);
  const raw = [...clean, clean[0], { text: 'Registro sem rótulo nenhum, do sistema antigo.' }];
  const { train, validation, files, report } = buildDataset(raw, SYSTEM);

  assert.equal(report.raw, 42);
  assert.deepEqual(report.dropped, { invalid: 1, unknownLabel: 0, tooShort: 0, duplicate: 1 });
  assert.equal(train.length, 32);
  assert.equal(validation.length, 8);
  assert.deepEqual(report.train.byCategory, { billing: 8, outage: 8, access: 8, question: 8 });
  assert.deepEqual(report.validation.byCategory, { billing: 2, outage: 2, access: 2, question: 2 });
  assert.deepEqual(
    report.alerts.map((alert) => alert.code),
    ['below-recommended'],
  );

  assert.deepEqual(validateChatJsonl(files['train.jsonl']), { valid: 32, errors: [] });
  assert.deepEqual(validateChatJsonl(files['val.jsonl']), { valid: 8, errors: [] });

  // A contagem do relatório confere com o que está escrito no arquivo.
  const tokensInFile = files['train.jsonl']
    .trimEnd()
    .split('\n')
    .flatMap((line) => ChatLine.parse(JSON.parse(line)).messages)
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  assert.equal(report.train.estimatedTokens, tokensInFile);
  assert.ok(tokensInFile > 0);
});

test('writeDataset grava train.jsonl e val.jsonl, e valida o que releu do disco', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lab07-dataset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataset = buildDataset(examples(10), SYSTEM);

  assert.deepEqual(await writeDataset(dataset, dir), { 'train.jsonl': 32, 'val.jsonl': 8 });
  assert.equal(await readFile(join(dir, 'train.jsonl'), 'utf8'), dataset.files['train.jsonl']);
  assert.equal(await readFile(join(dir, 'val.jsonl'), 'utf8'), dataset.files['val.jsonl']);

  // Arquivo com linha quebrada não passa: o erro diz qual arquivo e qual linha.
  const broken = {
    ...dataset,
    files: { ...dataset.files, 'val.jsonl': `${dataset.files['val.jsonl']}linha quebrada\n` },
  };
  await assert.rejects(writeDataset(broken, dir), /val\.jsonl tem linha inválida:\n {2}linha 9: não é JSON válido/);
});
