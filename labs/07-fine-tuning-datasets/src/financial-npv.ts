import { z } from 'zod';

// Payback e NPV de um fine-tuning: o investimento volta, e em quanto tempo?
//
//   investimento (mês 0)   engenharia (curadoria, treino, avaliação) + job de treino
//   fluxo líquido mensal   requisições × (custo base − custo ajustado) − hospedagem
//   break-even             investimento ÷ fluxo líquido mensal (payback simples, sem desconto)
//   NPV em 12 meses        −investimento + Σ fluxo ÷ (1 + taxa)^mês, do mês 1 ao 12
//
// O A/B (ab-eval.ts) responde quanto cada requisição economiza. Aqui entra o que ele deixa de
// fora: o custo fixo para chegar ao modelo ajustado e o valor do dinheiro no tempo.

export const PaybackParams = z.object({
  /** Horas de engenharia até o modelo ajustado: curadoria do dataset, treino e avaliação. */
  capexEngineeringUsd: z.number().nonnegative(),
  /** O job de treino em si: tokens ou horas de GPU. */
  trainingJobUsd: z.number().nonnegative(),
  monthlyRequests: z.number().nonnegative(),
  /** Custo por requisição hoje, com o prompt few-shot. */
  baselineCostPerReqUsd: z.number().nonnegative(),
  /** Custo por requisição com o modelo ajustado e o prompt enxuto. */
  fineTunedCostPerReqUsd: z.number().nonnegative(),
  /** Custo fixo mensal de servir o modelo ajustado: endpoint dedicado ou GPU. Zero se for só por token. */
  monthlyHostingUsd: z.number().nonnegative(),
});
export type PaybackParams = z.infer<typeof PaybackParams>;

export const NPV_HORIZON_MONTHS = 12;
/** PONTO DE EXTENSÃO: 1% ao mês é premissa. Use o custo de capital da sua empresa. */
export const DEFAULT_MONTHLY_DISCOUNT_RATE = 0.01;

export interface PaybackReport {
  initialInvestmentUsd: number;
  /** Economia do mês menos a hospedagem. Negativo: o modelo ajustado custa mais do que economiza. */
  monthlyNetFlowUsd: number;
  /** Meses até o fluxo pagar o investimento. `null`: com fluxo mensal zero ou negativo, nunca paga. */
  breakEvenMonths: number | null;
  npv12MonthsUsd: number;
  monthlyDiscountRate: number;
}

/**
 * Fluxo líquido mensal, ponto de equilíbrio e NPV em 12 meses de um fine-tuning.
 * `monthlyDiscountRate` é fração ao mês: 0.01 é 1%.
 */
export function calculateFineTuningPayback(
  params: PaybackParams,
  monthlyDiscountRate = DEFAULT_MONTHLY_DISCOUNT_RATE,
): PaybackReport {
  // As premissas chegam de planilha ou formulário: a entrada é validada aqui.
  const {
    capexEngineeringUsd,
    trainingJobUsd,
    monthlyRequests,
    baselineCostPerReqUsd,
    fineTunedCostPerReqUsd,
    monthlyHostingUsd,
  } = PaybackParams.parse(params);
  const rate = z.number().nonnegative().parse(monthlyDiscountRate);

  const initialInvestmentUsd = capexEngineeringUsd + trainingJobUsd;
  const monthlyNetFlowUsd = monthlyRequests * (baselineCostPerReqUsd - fineTunedCostPerReqUsd) - monthlyHostingUsd;

  let npv12MonthsUsd = -initialInvestmentUsd;
  for (let month = 1; month <= NPV_HORIZON_MONTHS; month++) npv12MonthsUsd += monthlyNetFlowUsd / (1 + rate) ** month;

  return {
    initialInvestmentUsd,
    monthlyNetFlowUsd,
    breakEvenMonths: monthlyNetFlowUsd > 0 ? initialInvestmentUsd / monthlyNetFlowUsd : null,
    npv12MonthsUsd,
    monthlyDiscountRate: rate,
  };
}
