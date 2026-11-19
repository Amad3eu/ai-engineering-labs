import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DEFAULT_MODELS } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import { type Arm, costPerRequestUsd, evaluateArm, projectSavings, tablePrice } from './ab-eval.js';
import { buildDataset } from './dataset-builder.js';
import { installMockScript } from './mock.js';
import { fewShotSystem, TRIAGE_SYSTEM } from './prompts.js';
import { type Example, parseTriage } from './schema.js';

// O A/B inteiro sem rede: provedor mock e o roteiro do laboratório. É o que roda no CI.
process.env.LLM_PROVIDERS = 'mock';
logger.level = 'silent';
installMockScript();
// O roteiro conta as respostas do braço few-shot: cada teste começa com a contagem zerada.
afterEach(() => installMockScript());

/** Conta em dinheiro passa por ponto flutuante: compara com folga. */
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `esperado ${expected}, veio ${actual}`);

const SHOTS: Example[] = [
  { text: 'Fui cobrado duas vezes na fatura de outubro.', category: 'billing', priority: 'P2' },
  { text: 'O painel está fora do ar para a empresa inteira.', category: 'outage', priority: 'P1' },
];
const FEW_SHOT: Arm = { name: 'few-shot', system: fewShotSystem(SHOTS), tier: 'fast' };
const FINE_TUNED: Arm = { name: 'fine-tuned', system: TRIAGE_SYSTEM, tier: 'fast' };

test('parseTriage só aceita o JSON exato do schema', () => {
  assert.deepEqual(parseTriage('{"category":"billing","priority":"P2"}'), { category: 'billing', priority: 'P2' });
  assert.deepEqual(parseTriage('\n  {"priority": "P1", "category": "outage"}\n'), {
    category: 'outage',
    priority: 'P1',
  });

  const rejected = [
    '```json\n{"category":"billing","priority":"P2"}\n```', // bloco de código
    'Claro! {"category":"billing","priority":"P2"}', // texto antes
    '{"category":"billing","priority":"P2","reasoning":"cobrança"}', // chave a mais
    '{"category":"billing"}', // chave a menos
    '{"category":"urgent","priority":"P2"}', // valor fora da lista
    '{"category":"Billing","priority":"p2"}', // caixa errada
    '{"categoria":"billing","prioridade":"P2"}', // chave traduzida
    '["billing","P2"]',
    'billing',
    '',
  ];
  for (const text of rejected) assert.equal(parseTriage(text), undefined, text);
});

test('evaluateArm mede aderência, acerto e tokens por requisição', async () => {
  // O roteiro faz o braço few-shot embrulhar o JSON em bloco de código a cada 2 respostas.
  installMockScript({ formatSlipEvery: 2 });
  const tickets: Example[] = [
    { text: 'Meu cartão foi recusado na renovação e a assinatura foi suspensa.', category: 'billing', priority: 'P2' },
    { text: 'Todas as requisições estão dando timeout desde cedo.', category: 'outage', priority: 'P1' },
    { text: 'Como altero o e-mail de login da minha conta?', category: 'access', priority: 'P3' },
    // Rótulo errado de propósito: a resposta sai no formato, mas não bate com o esperado.
    { text: 'Como exporto os relatórios mensais em CSV?', category: 'billing', priority: 'P3' },
  ];

  const fewShot = await evaluateArm(FEW_SHOT, tickets);
  const fineTuned = await evaluateArm(FINE_TUNED, tickets);

  // few-shot: as respostas 2 e 4 saem do formato; das duas que ficam, as duas acertam.
  assert.equal(fewShot.schemaAdherence, 0.5);
  assert.equal(fewShot.accuracy, 0.5);
  // fine-tuned: tudo no formato, e só o ticket de rótulo errado não bate.
  assert.equal(fineTuned.schemaAdherence, 1);
  assert.equal(fineTuned.accuracy, 0.75);

  assert.deepEqual(
    [fewShot, fineTuned].map(({ arm, model, provider, requests }) => ({ arm, model, provider, requests })),
    [
      { arm: 'few-shot', model: 'mock-fast', provider: 'mock', requests: 4 },
      { arm: 'fine-tuned', model: 'mock-fast', provider: 'mock', requests: 4 },
    ],
  );
  // O prompt few-shot carrega instruções e exemplos em toda requisição: é isto que o A/B mede.
  assert.ok(fewShot.avgTokensIn > fineTuned.avgTokensIn * 3, `${fewShot.avgTokensIn} × ${fineTuned.avgTokensIn}`);
  assert.ok(fineTuned.avgTokensOut > 0);
});

test('evaluateArm recusa rodar sem exemplos', async () => {
  await assert.rejects(evaluateArm(FINE_TUNED, []), /sem exemplos de validação/);
});

test('o roteiro do mock e os rótulos do dado de exemplo concordam em todos os tickets', async () => {
  const file = join(import.meta.dirname, '../data/raw-tickets.json');
  const { train, validation } = buildDataset(JSON.parse(await readFile(file, 'utf8')), TRIAGE_SYSTEM);

  // Se este teste quebrar, o dado mudou e os números do modo mock no README deixaram de valer.
  const result = await evaluateArm(FINE_TUNED, [...train, ...validation]);
  assert.equal(result.requests, 40);
  assert.equal(result.schemaAdherence, 1);
  assert.equal(result.accuracy, 1);
});

test('costPerRequestUsd e tablePrice: tokens viram dinheiro pelo preço de tabela', () => {
  near(
    costPerRequestUsd({ avgTokensIn: 1_000, avgTokensOut: 100 }, { inputPerMillion: 2, outputPerMillion: 10 }),
    0.003,
  );

  // O mock roda na máquina e não tem preço; o modelo de referência da projeção tem.
  assert.deepEqual(tablePrice('mock', 'mock-fast'), { inputPerMillion: 0, outputPerMillion: 0 });
  const reference = tablePrice('openai', DEFAULT_MODELS.openai.fast);
  assert.ok(reference.inputPerMillion > 0 && reference.outputPerMillion > 0);
});

test('projectSavings projeta a diferença por requisição em 100.000 requisições', () => {
  const projection = projectSavings(0.00013, 0.00002);

  assert.equal(projection.requests, 100_000);
  near(projection.baselineCostUsd, 13);
  near(projection.candidateCostUsd, 2);
  near(projection.savingsUsd, 11);
  near(projection.savingsPercent, (11 / 13) * 100);

  near(projectSavings(0.00013, 0.00002, 1_000_000).savingsUsd, 110);
});

test('projectSavings: candidato mais caro dá economia negativa, e custo zero não vira NaN', () => {
  const worse = projectSavings(0.00002, 0.00005);
  near(worse.savingsUsd, -3);
  near(worse.savingsPercent, -150);

  // Modelo local não custa por token: a projeção é zero, não uma divisão por zero.
  assert.deepEqual(projectSavings(0, 0), {
    requests: 100_000,
    baselineCostUsd: 0,
    candidateCostUsd: 0,
    savingsUsd: 0,
    savingsPercent: 0,
  });
});

test('projectSavings recusa custo ou volume que não seja número não negativo', () => {
  assert.throws(() => projectSavings(-0.1, 0.1), RangeError);
  assert.throws(() => projectSavings(0.1, Number.NaN), RangeError);
  assert.throws(() => projectSavings(0.1, 0.1, -5), RangeError);
});
