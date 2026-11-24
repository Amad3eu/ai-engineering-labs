import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { logger, logLlmCall, resetLlmMetrics } from '@labs/shared-observability';
import { BUDGET_POLICY, createBudgetGuard } from './budget-guard.js';

logger.level = 'silent';
// O acumulado da observabilidade é global: cada teste começa do zero, e a conta fica exata.
beforeEach(() => resetLlmMetrics());

/** Um tenant com orçamento de US$ 100 e `spentUsd` já gastos. */
const guardWith = (spentUsd: number) => {
  const guard = createBudgetGuard({ acme: 100 });
  guard.charge('acme', spentUsd);
  return guard;
};
const decide = (spentUsd: number) => guardWith(spentUsd).authorize('acme', 'powerful');

/** Uma chamada de LLM registrada na observabilidade, como @labs/shared-llm faz. */
const recordCall = (estimatedCostUsd: number) =>
  logLlmCall({ model: 'teste', latencyMs: 1, tokensIn: 10, tokensOut: 5, estimatedCostUsd, cacheHit: false });

test('abaixo de 80%: operação normal, na faixa de modelo que a requisição pediu', () => {
  for (const spent of [0, 50, 79.99]) {
    const decision = decide(spent);
    assert.equal(decision.status, 'normal', `${spent}`);
    assert.equal(decision.tier, 'powerful');
  }
  assert.deepEqual(decide(50), {
    status: 'normal',
    tenantId: 'acme',
    budgetUsd: 100,
    spentUsd: 50,
    usedRatio: 0.5,
    tier: 'powerful',
  });
});

test('de 80% a 99%: alerta e downgrade para o modelo econômico', () => {
  assert.equal(BUDGET_POLICY.economyTier, 'fast');
  for (const spent of [80, 85, 99.99]) {
    const decision = decide(spent);
    assert.equal(decision.status, 'downgrade', `${spent}`);
    assert.equal(decision.tier, 'fast');
  }
  // Quem já pedia o modelo econômico continua nele, e a faixa de alerta aparece do mesmo jeito.
  assert.deepEqual(
    [guardWith(85).authorize('acme', 'fast').status, guardWith(85).authorize('acme', 'fast').tier],
    ['downgrade', 'fast'],
  );
});

test('100% ou mais: circuito aberto, nenhuma faixa de modelo liberada', () => {
  for (const spent of [100, 100.01, 250]) {
    const decision = decide(spent);
    assert.equal(decision.status, 'blocked', `${spent}`);
    assert.equal(decision.tier, null);
  }
});

test('o corte vale para a soma em ponto flutuante: oito gastos de 0,1 são 80% de 1', () => {
  const guard = createBudgetGuard({ acme: 1 });
  for (let i = 0; i < 8; i++) guard.charge('acme', 0.1);

  assert.ok(guard.usage('acme').spentUsd < 0.8); // 0.7999999999999999
  assert.equal(guard.authorize('acme', 'balanced').status, 'downgrade');

  for (let i = 0; i < 2; i++) guard.charge('acme', 0.1);
  assert.equal(guard.authorize('acme', 'balanced').status, 'blocked');
});

test('cada tenant tem o seu orçamento: o estouro de um não trava o outro', () => {
  const guard = createBudgetGuard({ acme: 10, globex: 10 });
  guard.charge('globex', 10);

  assert.equal(guard.authorize('globex', 'balanced').status, 'blocked');
  assert.equal(guard.authorize('acme', 'balanced').status, 'normal');
  assert.deepEqual(guard.usage('acme'), { tenantId: 'acme', budgetUsd: 10, spentUsd: 0, usedRatio: 0 });
});

test('meter: cobra do tenant o que a operação gastou, lido da observabilidade', async () => {
  const guard = createBudgetGuard({ acme: 10 });

  const { value, costUsd } = await guard.meter('acme', async () => {
    recordCall(0.25);
    recordCall(0.5); // uma requisição pode fazer mais de uma chamada
    return 'resposta';
  });

  assert.equal(value, 'resposta');
  assert.equal(costUsd, 0.75);
  assert.equal(guard.usage('acme').spentUsd, 0.75);
});

test('meter: chamada de graça leva o preço de referência; com custo real, ele não entra', async () => {
  const guard = createBudgetGuard({ acme: 10 });

  const free = await guard.meter(
    'acme',
    async () => recordCall(0),
    () => 0.02,
  );
  assert.equal(free.costUsd, 0.02);

  const paid = await guard.meter(
    'acme',
    async () => recordCall(0.4),
    () => 0.02,
  );
  assert.equal(paid.costUsd, 0.4);

  const unpriced = await guard.meter('acme', async () => recordCall(0));
  assert.equal(unpriced.costUsd, 0);
  assert.ok(Math.abs(guard.usage('acme').spentUsd - 0.42) < 1e-12);
});

test('tenant sem orçamento cadastrado não roda, e valor inválido é recusado', async () => {
  const guard = createBudgetGuard({ acme: 10 });

  assert.throws(() => guard.authorize('desconhecido', 'fast'), /não tem orçamento cadastrado/);
  assert.throws(() => guard.charge('desconhecido', 1), /não tem orçamento cadastrado/);
  await assert.rejects(
    guard.meter('desconhecido', async () => 'x'),
    /não tem orçamento cadastrado/,
  );
  assert.throws(() => guard.charge('acme', -1), RangeError);
  assert.throws(() => guard.charge('acme', Number.NaN), RangeError);
  assert.throws(() => createBudgetGuard({ acme: 0 }), RangeError);
  assert.throws(() => createBudgetGuard({ acme: Number.NaN }), RangeError);
});
