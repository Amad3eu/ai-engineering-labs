import { logger } from '@labs/shared-observability';

export type ProviderName = 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'mock';

/**
 * Model Tiering: o código pede uma faixa de capacidade, não um modelo.
 * Cada provedor traduz a faixa para o seu modelo, e é isso que deixa o fallback
 * trocar de provedor sem mudar o tipo de trabalho pedido.
 */
export type ModelTier = 'fast' | 'balanced' | 'powerful';
export type TierModels = Record<ModelTier, string>;

// PONTO DE EXTENSÃO: trocar de modelo é editar estas duas tabelas e a de preços abaixo.
// Os ids foram conferidos em 18/11/2026 (tipos do SDK da OpenAI, página de modelos do
// Gemini e catálogo do OpenRouter). Modelo novo sai toda semana: revise ao atualizar.
export const DEFAULT_MODELS = {
  openai: { fast: 'gpt-6-luna', balanced: 'gpt-6.1-terra', powerful: 'gpt-6.1-sol' },
  gemini: { fast: 'gemini-3.5-flash-lite', balanced: 'gemini-4-hydrogen', powerful: 'gemini-4-carbon' },
  openrouter: { fast: 'openai/gpt-6-luna', balanced: 'openai/gpt-6.1-terra', powerful: 'openai/gpt-6.1-sol' },
} satisfies Record<string, TierModels>;

export const DEFAULT_EMBEDDING_MODELS = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
  openrouter: 'openai/text-embedding-3-small',
};

/**
 * USD por 1 milhão de tokens. Preço de tabela em 18/11/2026.
 * É ESTIMATIVA: não cobre desconto de cache de prompt, lote nem faixa por tamanho de contexto.
 */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-4-hydrogen': { input: 1.5, output: 7.5 },
  'gemini-4-carbon': { input: 2, output: 10 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
};

/** Rodam na máquina: não há cobrança por token. */
const FREE_PROVIDERS: ReadonlySet<ProviderName> = new Set(['ollama', 'mock']);
const warnedModels = new Set<string>();

export function estimateCostUsd(provider: ProviderName, model: string, tokensIn: number, tokensOut: number): number {
  if (FREE_PROVIDERS.has(provider)) return 0;

  // No OpenRouter o id vem com o fornecedor na frente: "openai/gpt-6-luna".
  const price = PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION[model.slice(model.indexOf('/') + 1)];
  if (!price) {
    // Custo zero silencioso esconderia gasto real: avisa uma vez por modelo.
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      logger.warn(
        `[COST] sem preço cadastrado para "${model}": custo estimado como 0. Cadastre em shared-llm/src/models.ts.`,
      );
    }
    return 0;
  }
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}
