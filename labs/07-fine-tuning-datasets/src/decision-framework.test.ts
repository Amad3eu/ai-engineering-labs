import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArchitectureRecommendation,
  evaluateApproach,
  HEAVY_FEW_SHOT_TOKENS,
  REFERENCE_SCENARIOS,
  UseCaseCriteria,
} from './decision-framework.js';

// O caso mais calmo possível: nada pede busca, nada pede treino. Cada teste mexe em um critério.
const CALM: UseCaseCriteria = {
  dataChangeFrequency: 'static',
  needsSourceTraceability: false,
  styleComplexity: 'low',
  avgFewShotPromptTokens: 200,
  latencyCostTarget: 'relaxed',
};
const approachOf = (overrides: Partial<UseCaseCriteria>) => evaluateApproach({ ...CALM, ...overrides }).approach;

test('cada caso de referência cai na sua abordagem', () => {
  assert.deepEqual(
    REFERENCE_SCENARIOS.map(({ criteria }) => evaluateApproach(criteria).approach),
    ['prompt-only', 'rag', 'fine-tuning', 'rag-plus-fine-tuning'],
  );
});

test('conhecimento: exigir fonte ou mudar rápido pede busca; mudar devagar, não', () => {
  assert.equal(approachOf({}), 'prompt-only');
  assert.equal(approachOf({ needsSourceTraceability: true }), 'rag');
  assert.equal(approachOf({ dataChangeFrequency: 'daily' }), 'rag');
  assert.equal(approachOf({ dataChangeFrequency: 'weekly' }), 'rag');
  assert.equal(approachOf({ dataChangeFrequency: 'monthly' }), 'prompt-only');
});

test('comportamento: treino só entra com few-shot pesado E pressão de formato ou de meta', () => {
  const heavy = { avgFewShotPromptTokens: HEAVY_FEW_SHOT_TOKENS };

  // Toda a pressão, com few-shot um token abaixo do corte: o prompt ainda dá conta.
  assert.equal(
    approachOf({
      styleComplexity: 'high',
      latencyCostTarget: 'strict',
      avgFewShotPromptTokens: HEAVY_FEW_SHOT_TOKENS - 1,
    }),
    'prompt-only',
  );

  // Few-shot pesado, com pressão de menos.
  assert.equal(approachOf(heavy), 'prompt-only');
  assert.equal(approachOf({ ...heavy, styleComplexity: 'medium' }), 'prompt-only');
  assert.equal(approachOf({ ...heavy, latencyCostTarget: 'moderate' }), 'prompt-only');

  // Um dos dois no grau máximo basta, e os dois em grau médio também.
  assert.equal(approachOf({ ...heavy, styleComplexity: 'high' }), 'fine-tuning');
  assert.equal(approachOf({ ...heavy, latencyCostTarget: 'strict' }), 'fine-tuning');
  assert.equal(approachOf({ ...heavy, styleComplexity: 'medium', latencyCostTarget: 'moderate' }), 'fine-tuning');
});

test('os dois eixos são independentes: busca e treino juntos dão rag-plus-fine-tuning', () => {
  assert.equal(
    approachOf({ dataChangeFrequency: 'daily', styleComplexity: 'high', avgFewShotPromptTokens: 4000 }),
    'rag-plus-fine-tuning',
  );
});

test('em toda combinação de critérios a saída respeita o schema e as duas regras duras', () => {
  let combinations = 0;
  for (const dataChangeFrequency of UseCaseCriteria.shape.dataChangeFrequency.options) {
    for (const needsSourceTraceability of [true, false]) {
      for (const styleComplexity of UseCaseCriteria.shape.styleComplexity.options) {
        for (const avgFewShotPromptTokens of [0, HEAVY_FEW_SHOT_TOKENS - 1, HEAVY_FEW_SHOT_TOKENS, 50_000]) {
          for (const latencyCostTarget of UseCaseCriteria.shape.latencyCostTarget.options) {
            const recommendation = evaluateApproach({
              dataChangeFrequency,
              needsSourceTraceability,
              styleComplexity,
              avgFewShotPromptTokens,
              latencyCostTarget,
            });
            combinations++;

            assert.ok(ArchitectureRecommendation.safeParse(recommendation).success);
            // Quem exige fonte nunca sai sem busca.
            if (needsSourceTraceability) assert.match(recommendation.approach, /^rag/);
            // Few-shot leve nunca justifica treino.
            if (avgFewShotPromptTokens < HEAVY_FEW_SHOT_TOKENS)
              assert.doesNotMatch(recommendation.approach, /fine-tuning/);
          }
        }
      }
    }
  }
  assert.equal(combinations, 288);
});

test('a justificativa cita o número do cenário e os trade-offs acompanham o contexto', () => {
  const tuned = evaluateApproach({
    ...CALM,
    dataChangeFrequency: 'monthly',
    styleComplexity: 'high',
    avgFewShotPromptTokens: 2400,
  });
  assert.equal(tuned.approach, 'fine-tuning');
  assert.ok(tuned.justification.some((reason) => reason.includes('2400 tokens')));
  assert.ok(tuned.tradeOffs.some((tradeOff) => tradeOff.includes('muda todo mês')));

  // Few-shot pesado sem pressão: fica no prompt, com o aviso do que tentar antes de treinar.
  const heavyButCalm = evaluateApproach({ ...CALM, avgFewShotPromptTokens: 2400 });
  assert.equal(heavyButCalm.approach, 'prompt-only');
  assert.ok(heavyButCalm.tradeOffs.some((tradeOff) => tradeOff.includes('cache de prompt')));

  const strictRag = evaluateApproach({ ...CALM, needsSourceTraceability: true, latencyCostTarget: 'strict' });
  assert.equal(strictRag.approach, 'rag');
  assert.ok(strictRag.tradeOffs.some((tradeOff) => tradeOff.includes('cache semântico')));
});

test('cenário fora do contrato é recusado na entrada', () => {
  assert.throws(() => evaluateApproach({ ...CALM, avgFewShotPromptTokens: -1 }), /avgFewShotPromptTokens/);
  assert.throws(() => evaluateApproach({ ...CALM, avgFewShotPromptTokens: 12.5 }), /avgFewShotPromptTokens/);
  // Cenário que veio de um JSON, sem o tipo para proteger.
  const fromJson = JSON.parse('{"dataChangeFrequency":"hourly","needsSourceTraceability":true}');
  assert.throws(() => evaluateApproach(fromJson), /dataChangeFrequency/);
});
