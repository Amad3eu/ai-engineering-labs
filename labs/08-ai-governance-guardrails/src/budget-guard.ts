import type { ModelTier } from '@labs/shared-llm';
import { logger, summarizeLlmCalls } from '@labs/shared-observability';

// Circuit breaker financeiro: um orçamento em USD por tenant e três faixas de uso.
//
//   abaixo de 80%   normal: a requisição roda na faixa de modelo que pediu
//   de 80% a 99%    alerta e downgrade: roda, mas no modelo econômico
//   100% ou mais    circuito aberto: não chama o modelo
//
// O gasto de cada requisição sai do acumulado de @labs/shared-observability, que já recebe o
// custo de toda chamada feita por @labs/shared-llm.

// PONTO DE EXTENSÃO: os cortes da política e a faixa de modelo do downgrade.
export const BUDGET_POLICY = {
  downgradeAt: 0.8,
  blockAt: 1,
  economyTier: 'fast' as ModelTier,
} as const;

export type BudgetStatus = 'normal' | 'downgrade' | 'blocked';

export interface BudgetDecision {
  status: BudgetStatus;
  tenantId: string;
  budgetUsd: number;
  spentUsd: number;
  /** Fração do orçamento já gasta: 0.85 são 85%. */
  usedRatio: number;
  /** A faixa de modelo liberada. `null` com o circuito aberto. */
  tier: ModelTier | null;
}

// 0.1 somado oito vezes dá 0.7999999999999999: sem a folga, 80% gastos ficariam "abaixo de 80%".
const EPSILON = 1e-9;

export type BudgetGuard = ReturnType<typeof createBudgetGuard>;

/** Cria o controlador com o orçamento de cada tenant, em USD. */
export function createBudgetGuard(budgetsUsd: Record<string, number>) {
  const budgets = new Map<string, number>();
  const spent = new Map<string, number>();
  for (const [tenantId, budget] of Object.entries(budgetsUsd)) {
    if (!(budget > 0)) throw new RangeError(`Orçamento do tenant "${tenantId}" precisa ser maior que zero.`);
    budgets.set(tenantId, budget);
    spent.set(tenantId, 0);
  }

  // Tenant sem orçamento cadastrado não roda: negar é o padrão seguro.
  const budgetOf = (tenantId: string) => {
    const budget = budgets.get(tenantId);
    if (budget === undefined) throw new Error(`Tenant "${tenantId}" não tem orçamento cadastrado.`);
    return budget;
  };

  /** Soma um gasto ao tenant. Use direto para importar o que já foi gasto no período. */
  function charge(tenantId: string, costUsd: number): void {
    budgetOf(tenantId);
    if (!(costUsd >= 0)) throw new RangeError('O custo precisa ser um número não negativo.');
    spent.set(tenantId, (spent.get(tenantId) ?? 0) + costUsd);
  }

  /** Decide, ANTES da chamada, se o tenant pode gastar e em qual faixa de modelo. */
  function authorize(tenantId: string, requestedTier: ModelTier): BudgetDecision {
    const budgetUsd = budgetOf(tenantId);
    const spentUsd = spent.get(tenantId) ?? 0;
    const usedRatio = spentUsd / budgetUsd;
    const usage = { tenantId, budgetUsd, spentUsd, usedRatio };

    if (usedRatio >= BUDGET_POLICY.blockAt - EPSILON) {
      logger.error({ event: 'budget.blocked', ...usage }, `[BUDGET] ${tenantId}: orçamento esgotado, circuito aberto`);
      return { ...usage, status: 'blocked', tier: null };
    }
    if (usedRatio >= BUDGET_POLICY.downgradeAt - EPSILON) {
      logger.warn(
        { event: 'budget.downgrade', ...usage },
        `[BUDGET] ${tenantId}: ${Math.floor(usedRatio * 100)}% do orçamento, modelo econômico`,
      );
      return { ...usage, status: 'downgrade', tier: BUDGET_POLICY.economyTier };
    }
    return { ...usage, status: 'normal', tier: requestedTier };
  }

  /**
   * Roda a operação e cobra do tenant o que ela gastou, lido do acumulado de
   * @labs/shared-observability. `priceIfFree` dá preço à chamada que saiu de graça: o mock
   * e o Ollama não têm tabela, e sem isso o orçamento nunca andaria fora de produção.
   *
   * shortcut: mede pela diferença de um acumulado global, o que só vale com uma requisição
   * por vez. Com concorrência, o custo precisa chegar marcado com o tenant (um atributo na
   * métrica de cada chamada).
   */
  async function meter<T>(
    tenantId: string,
    operation: () => Promise<T>,
    priceIfFree?: (value: T) => number,
  ): Promise<{ value: T; costUsd: number }> {
    budgetOf(tenantId);
    const before = summarizeLlmCalls().estimatedCostUsd;
    const value = await operation();
    let costUsd = summarizeLlmCalls().estimatedCostUsd - before;
    if (costUsd === 0 && priceIfFree) costUsd = priceIfFree(value);
    charge(tenantId, costUsd);
    return { value, costUsd };
  }

  /** A situação do tenant agora, sem autorizar nada. */
  function usage(tenantId: string): Omit<BudgetDecision, 'status' | 'tier'> {
    const budgetUsd = budgetOf(tenantId);
    const spentUsd = spent.get(tenantId) ?? 0;
    return { tenantId, budgetUsd, spentUsd, usedRatio: spentUsd / budgetUsd };
  }

  return { authorize, charge, meter, usage };
}
