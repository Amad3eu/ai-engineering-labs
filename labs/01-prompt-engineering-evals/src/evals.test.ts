import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logger } from '@labs/shared-observability';
import { applyPolicy } from './chain.js';
import { DATASET, runEvals, THRESHOLDS } from './evals.js';
import { installMockScript } from './mock.js';

// Suíte de regressão dos prompts. Roda contra o provedor que estiver configurado:
// - sem chave (ou no CI, com LLM_PROVIDERS=mock): valida o encadeamento, sem rede;
// - com chave: mede o prompt de verdade. Rode antes e depois de mexer em prompts.ts.
installMockScript();
logger.level = 'warn';

const report = await runEvals();
const failed = (pick: 'categoryOk' | 'priorityOk') =>
  report.rows
    .filter((row) => !row[pick])
    .map((row) => row.id)
    .join(', ');

test('categoria: a acurácia não cai abaixo do piso', () => {
  assert.ok(
    report.categoryAccuracy >= THRESHOLDS.categoryAccuracy,
    `acurácia ${report.categoryAccuracy.toFixed(2)} < ${THRESHOLDS.categoryAccuracy}. Erraram: ${failed('categoryOk')}`,
  );
});

test('prioridade: a acurácia não cai abaixo do piso', () => {
  assert.ok(
    report.priorityAccuracy >= THRESHOLDS.priorityAccuracy,
    `acurácia ${report.priorityAccuracy.toFixed(2)} < ${THRESHOLDS.priorityAccuracy}. Erraram: ${failed('priorityOk')}`,
  );
});

test('política: toda indisponibilidade do conjunto sai como P1', () => {
  const outages = new Set(DATASET.filter((c) => c.expected.category === 'outage').map((c) => c.id));
  for (const row of report.rows.filter((r) => outages.has(r.id) && r.category === 'outage')) {
    assert.equal(row.priority, 'P1', `${row.id} saiu como ${row.priority}`);
  }
});

test('política: indisponibilidade vira P1 mesmo quando o modelo sugere menos', () => {
  const fixed = applyPolicy({ category: 'outage', priority: 'P3', reasoning: 'Parece pontual.' });
  assert.equal(fixed.priority, 'P1');
  assert.match(fixed.reasoning, /política/);

  const untouched = applyPolicy({ category: 'billing', priority: 'P3', reasoning: 'Segunda via.' });
  assert.equal(untouched.priority, 'P3');
});
