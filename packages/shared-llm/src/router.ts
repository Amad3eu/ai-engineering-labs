import type { ModelTier } from './models.js';

// Sinais de que a tarefa pede raciocínio, não só reescrita ou extração.
const REASONING_HINTS =
  /\b(analis|compar|justifi|planej|diagnos|refator|arquitetura|passo a passo|step by step|trade-?offs?|debug|prove)/i;

/**
 * Roteador por complexidade: decide a faixa de modelo olhando só para o prompt.
 * É uma heurística barata e determinística, de propósito: a decisão não custa uma
 * chamada de LLM e o mesmo prompt cai sempre na mesma faixa.
 *
 * PONTO DE EXTENSÃO: troque por um classificador (um modelo `fast` que devolve a faixa)
 * ou por um roteador treinado quando houver dados de qualidade por faixa para calibrar.
 */
export function routeByComplexity(prompt: string): ModelTier {
  const words = prompt.trim().split(/\s+/).length;
  const asksForReasoning = REASONING_HINTS.test(prompt) || prompt.includes('```');

  if (words > 400 || (asksForReasoning && words > 80)) return 'powerful';
  if (words > 80 || asksForReasoning) return 'balanced';
  return 'fast';
}
