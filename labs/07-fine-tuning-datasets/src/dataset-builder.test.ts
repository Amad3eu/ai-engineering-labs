import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assessQuality,
  buildDataset,
  ChatLine,
  dropNearDuplicates,
  estimateTokens,
  jaccardSimilarity,
  NEAR_DUPLICATE,
  QUALITY_LIMITS,
  type SplitStats,
  shingles,
  splitDataset,
  toChatJsonl,
  validateChatJsonl,
  writeDataset,
} from './dataset-builder.js';
import { sanitizePii } from './pii-sanitizer.js';
import { Category, type Example } from './schema.js';

const SYSTEM = 'Faça a triagem do ticket.';

// Um assunto por ticket: texto que só muda em um número é quase duplicata, e o pipeline tira.
const SUBJECTS = [
  'fatura',
  'senha',
  'relatório',
  'webhook',
  'painel',
  'convite',
  'plano',
  'cartão',
  'certificado',
  'integração',
];

/** `perCategory` tickets por categoria (até 10), todos de assunto diferente. */
const examples = (perCategory: number): Example[] =>
  Category.options.flatMap((category) =>
    SUBJECTS.slice(0, perCategory).map((subject) => ({
      text: `Ticket de exemplo sobre ${subject} da categoria ${category}`,
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
  const raw = [
    ...clean,
    clean[0], // cópia exata
    { ...clean[1], text: `Boa tarde, ${clean[1]?.text}!` }, // quase duplicata: só a saudação muda
    { text: 'Registro sem rótulo nenhum, do sistema antigo.' },
  ];
  const { train, validation, files, report } = buildDataset(raw, SYSTEM);

  assert.equal(report.raw, 43);
  assert.deepEqual(report.dropped, { invalid: 1, unknownLabel: 0, tooShort: 0, duplicate: 1, nearDuplicate: 1 });
  assert.deepEqual(report.piiRedactions, { CPF: 0, EMAIL: 0, PHONE: 0 });
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

// --- Quase duplicatas ---------------------------------------------------------------------------

const ticket = (text: string): Example => ({ text, category: 'billing', priority: 'P2' });
/** `count` palavras diferentes, sem número: "palavraa palavrab palavrac ...". */
const distinctWords = (count: number) =>
  Array.from({ length: count }, (_, i) => `palavra${'abcdefghijklmnopqrstuvwxyz'[i]}`);

test('shingles: caixa, acento, pontuação, saudação e número não diferenciam dois tickets', () => {
  assert.deepEqual([...shingles('Olá, bom dia! O PEDIDO 48213 atrasou.')], ['o pedido', 'pedido 0', '0 atrasou']);
  assert.deepEqual(shingles('Boa tarde. O pedido 51977 atrasou'), shingles('o pedido 7 atrasou'));
  assert.deepEqual([...shingles('um dois três quatro', 3)], ['um dois tres', 'dois tres quatro']);

  // Saudação só sai do começo, e só como palavra inteira.
  assert.deepEqual([...shingles('Oito boletos, bom dia')], ['oito boletos', 'boletos bom', 'bom dia']);
  // Texto mais curto que um shingle vira um shingle só; sem palavra nenhuma, conjunto vazio.
  assert.deepEqual([...shingles('Estorno!')], ['estorno']);
  assert.equal(shingles('...').size, 0);
});

test('jaccardSimilarity: interseção sobre união, e conjunto vazio não é duplicata de nada', () => {
  const set = (...items: string[]) => new Set(items);
  assert.equal(jaccardSimilarity(set('a', 'b', 'c'), set('c', 'b', 'a')), 1);
  assert.equal(jaccardSimilarity(set('a', 'b'), set('c', 'd')), 0);
  assert.equal(jaccardSimilarity(set('a', 'b', 'c'), set('b', 'c', 'd')), 0.5); // 2 em comum, 4 na união
  assert.equal(jaccardSimilarity(set(), set()), 0);
  assert.equal(jaccardSimilarity(set('a'), set()), 0);
});

test('dropNearDuplicates: saudação e ID diferentes não fazem um ticket novo, e fica o primeiro', () => {
  const first = ticket('Fui cobrado duas vezes na fatura de outubro, pedido 48213.');
  const otherMonth = ticket('Olá, fui cobrado duas vezes na fatura de novembro, pedido 48213.');
  const { kept, dropped } = dropNearDuplicates([
    first,
    ticket('Bom dia! Fui cobrado duas vezes na fatura de outubro, pedido 51977.'),
    otherMonth, // outro mês é outro ticket: 6 shingles em comum de 10
    ticket('FUI COBRADO DUAS VEZES NA FATURA DE OUTUBRO... PEDIDO 7'),
  ]);

  assert.deepEqual(kept, [first, otherMonth]);
  assert.equal(dropped, 2);
});

test('dropNearDuplicates: Jaccard de 0,85 derruba; logo abaixo, o ticket fica', () => {
  assert.equal(NEAR_DUPLICATE.threshold, 0.85);
  const base = ticket(distinctWords(19).join(' ')); // 18 shingles
  // 17 shingles em comum. Com 2 novos, a união tem 20: 17/20 = 0,85. Com 3 novos, 21: 0,81.
  const atThreshold = ticket([...distinctWords(18), 'outra', 'coisa'].join(' '));
  const below = ticket([...distinctWords(18), 'outra', 'coisa', 'ainda'].join(' '));

  assert.equal(jaccardSimilarity(shingles(base.text), shingles(atThreshold.text)), 0.85);
  assert.deepEqual(dropNearDuplicates([base, atThreshold]), { kept: [base], dropped: 1 });
  assert.deepEqual(dropNearDuplicates([base, below]), { kept: [base, below], dropped: 0 });
  // O corte é parâmetro: mais frouxo, o segundo também cai.
  assert.deepEqual(dropNearDuplicates([base, below], 0.8), { kept: [base], dropped: 1 });
});

test('nenhuma PII chega aos JSONL: o gate roda antes de o texto entrar no dataset', () => {
  const raw = examples(3).map((example) => ({
    ...example,
    text: `${example.text}. Contato: ana@empresa.com, (47) 99123-4567, CPF 123.456.789-09`,
  }));
  const { files, report } = buildDataset(raw, SYSTEM);
  const written = files['train.jsonl'] + files['val.jsonl'];

  assert.deepEqual(report.piiRedactions, { CPF: 12, EMAIL: 12, PHONE: 12 });
  assert.match(written, /Contato: <EMAIL>, <PHONE>, CPF <CPF>/);
  assert.deepEqual(sanitizePii(written).redactions, []);
});

test('o dado de exemplo: 50 registros, 40 aproveitados, 2 quase duplicatas e 3 PII mascaradas', async () => {
  const file = join(import.meta.dirname, '..', 'data', 'raw-tickets.json');
  const { files, report } = buildDataset(JSON.parse(await readFile(file, 'utf8')), SYSTEM);

  // Se este teste quebrar, o dado mudou e os números do dataset no README deixaram de valer.
  assert.equal(report.raw, 50);
  assert.deepEqual(report.dropped, { invalid: 2, unknownLabel: 2, tooShort: 2, duplicate: 2, nearDuplicate: 2 });
  assert.deepEqual(report.piiRedactions, { CPF: 1, EMAIL: 1, PHONE: 1 });
  assert.equal(report.train.examples + report.validation.examples, 40);
  assert.deepEqual(sanitizePii(files['train.jsonl'] + files['val.jsonl']).redactions, []);
});
