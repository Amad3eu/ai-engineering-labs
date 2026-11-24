import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateFineTuningPayback,
  DEFAULT_MONTHLY_DISCOUNT_RATE,
  NPV_HORIZON_MONTHS,
  type PaybackParams,
} from './financial-npv.js';

// Investimento de 4.200. Economia de 1.500 por mês (1 milhão × 0,0015), menos 300 de hospedagem.
const BASE: PaybackParams = {
  capexEngineeringUsd: 4_000,
  trainingJobUsd: 200,
  monthlyRequests: 1_000_000,
  baselineCostPerReqUsd: 0.002,
  fineTunedCostPerReqUsd: 0.0005,
  monthlyHostingUsd: 300,
};
const paybackOf = (overrides: Partial<PaybackParams>, rate?: number) =>
  calculateFineTuningPayback({ ...BASE, ...overrides }, rate);
const assertClose = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} não é ${expected}`);

test('fluxo líquido mensal: economia por requisição vezes o volume, menos a hospedagem', () => {
  const payback = paybackOf({});
  assert.equal(payback.initialInvestmentUsd, 4_200);
  assertClose(payback.monthlyNetFlowUsd, 1_200);

  assertClose(paybackOf({ monthlyHostingUsd: 0 }).monthlyNetFlowUsd, 1_500);
  assertClose(paybackOf({ monthlyRequests: 2_000_000 }).monthlyNetFlowUsd, 2_700);
});

test('break-even: investimento dividido pelo fluxo mensal, sem desconto', () => {
  assertClose(paybackOf({}).breakEvenMonths ?? Number.NaN, 3.5); // 4.200 ÷ 1.200
  // A taxa de desconto não entra no payback simples.
  assertClose(paybackOf({}, 0.05).breakEvenMonths ?? Number.NaN, 3.5);
  // Sem investimento, já nasce pago.
  assert.equal(paybackOf({ capexEngineeringUsd: 0, trainingJobUsd: 0 }).breakEvenMonths, 0);
});

test('NPV em 12 meses: sem desconto é a soma simples; com desconto, cada mês vale menos', () => {
  assert.equal(NPV_HORIZON_MONTHS, 12);
  assertClose(paybackOf({}, 0).npv12MonthsUsd, -4_200 + 12 * 1_200);

  // A 1% ao mês, 12 parcelas de 1 valem 11,2551 hoje: (1 − 1,01^−12) ÷ 0,01.
  const atOnePercent = paybackOf({}, 0.01).npv12MonthsUsd;
  assertClose(atOnePercent, -4_200 + (1_200 * (1 - 1.01 ** -12)) / 0.01);
  assert.equal(atOnePercent.toFixed(2), '9306.09');

  assert.ok(paybackOf({}, 0.03).npv12MonthsUsd < atOnePercent);
});

test('a taxa padrão é 1% ao mês, e o relatório diz qual taxa usou', () => {
  assert.equal(DEFAULT_MONTHLY_DISCOUNT_RATE, 0.01);
  assert.deepEqual(paybackOf({}), paybackOf({}, 0.01));
  assert.equal(paybackOf({}, 0.02).monthlyDiscountRate, 0.02);
});

test('fluxo mensal zero ou negativo: nunca paga, e o NPV não passa do investimento perdido', () => {
  // A hospedagem come a economia inteira.
  const zero = paybackOf({ monthlyHostingUsd: 1_500 });
  assertClose(zero.monthlyNetFlowUsd, 0);
  assert.equal(zero.breakEvenMonths, null);
  assertClose(zero.npv12MonthsUsd, -4_200);

  // O modelo ajustado custa mais por requisição do que o base.
  const worse = paybackOf({ fineTunedCostPerReqUsd: 0.003 });
  assert.ok(worse.monthlyNetFlowUsd < 0);
  assert.equal(worse.breakEvenMonths, null);
  assert.ok(worse.npv12MonthsUsd < -4_200);
});

test('break-even depois do horizonte: paga um dia, mas o NPV em 12 meses é negativo', () => {
  const slow = paybackOf({ monthlyRequests: 250_000 }); // 375 de economia, 75 de fluxo
  assertClose(slow.monthlyNetFlowUsd, 75);
  assertClose(slow.breakEvenMonths ?? Number.NaN, 56); // 4.200 ÷ 75
  assert.ok(slow.npv12MonthsUsd < 0);
});

test('entrada inválida é recusada, não vira relatório', () => {
  assert.throws(() => paybackOf({ capexEngineeringUsd: -1 }));
  assert.throws(() => paybackOf({ monthlyRequests: -100 }));
  assert.throws(() => paybackOf({ baselineCostPerReqUsd: Number.NaN }));
  assert.throws(() => paybackOf({}, -0.01));
  assert.throws(() => paybackOf({}, Number.NaN));
});
