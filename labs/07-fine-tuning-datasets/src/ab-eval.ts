import { estimateCostUsd, generateText, type ModelTier, type ProviderName } from '@labs/shared-llm';
import { ticketPrompt } from './prompts.js';
import { type Example, parseTriage } from './schema.js';

// Avaliação A/B: a mesma tarefa, os mesmos tickets de validação, dois jeitos de ensinar o
// modelo.
//
//   few-shot     modelo base + prompt grande: definições, regras e exemplos em toda requisição
//   fine-tuned   modelo ajustado + prompt enxuto: o que os exemplos ensinavam está nos pesos
//
// Três medidas: aderência ao schema, tokens por requisição e o custo projetado em volume.

export interface Arm {
  name: 'few-shot' | 'fine-tuned';
  system: string;
  tier: ModelTier;
  /** Id exato de modelo. Quando definido, tem prioridade sobre a faixa e desliga o fallback. */
  model?: string;
}

export interface ArmResult {
  arm: Arm['name'];
  model: string;
  provider: ProviderName;
  requests: number;
  /** Fração das respostas que são exatamente o JSON do schema (veja `parseTriage`). */
  schemaAdherence: number;
  /** Fração com categoria e prioridade iguais ao rótulo. Resposta fora do schema conta como erro. */
  accuracy: number;
  avgTokensIn: number;
  avgTokensOut: number;
  avgLatencyMs: number;
}

/** Roda um braço sobre os exemplos de validação. Uma requisição por ticket, em sequência. */
export async function evaluateArm(arm: Arm, examples: Example[]): Promise<ArmResult> {
  if (examples.length === 0) throw new Error('A/B sem exemplos de validação: não há o que medir.');

  let adherent = 0;
  let correct = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let model = '';
  let provider: ProviderName = 'mock';

  for (const example of examples) {
    // generateText, e não generateObject, de propósito: generateObject pede o formato ao
    // provedor e ainda tenta corrigir a resposta, o que esconderia a falha que este teste
    // conta. Aqui a resposta crua é validada com o schema Zod, sem segunda chance.
    const result = await generateText({
      system: arm.system,
      prompt: ticketPrompt(example.text),
      tier: arm.tier,
      model: arm.model,
      label: `ab:${arm.name}`,
    });
    ({ model, provider } = result);
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
    latencyMs += result.latencyMs;

    const triage = parseTriage(result.text);
    if (!triage) continue;
    adherent++;
    if (triage.category === example.category && triage.priority === example.priority) correct++;
  }

  const requests = examples.length;
  return {
    arm: arm.name,
    model,
    provider,
    requests,
    schemaAdherence: adherent / requests,
    accuracy: correct / requests,
    avgTokensIn: tokensIn / requests,
    avgTokensOut: tokensOut / requests,
    avgLatencyMs: latencyMs / requests,
  };
}

/** USD por 1 milhão de tokens. */
export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Preço de tabela de um modelo, lido de @labs/shared-llm: a única tabela de preços do
 * monorepo. Provedor local (mock, ollama) e modelo sem preço cadastrado voltam com zero.
 */
export const tablePrice = (provider: ProviderName, model: string): TokenPrice => ({
  inputPerMillion: estimateCostUsd(provider, model, 1_000_000, 0),
  outputPerMillion: estimateCostUsd(provider, model, 0, 1_000_000),
});

export const costPerRequestUsd = (usage: Pick<ArmResult, 'avgTokensIn' | 'avgTokensOut'>, price: TokenPrice) =>
  (usage.avgTokensIn * price.inputPerMillion + usage.avgTokensOut * price.outputPerMillion) / 1_000_000;

export interface SavingsProjection {
  requests: number;
  baselineCostUsd: number;
  candidateCostUsd: number;
  /** Negativa quando o candidato sai mais caro. */
  savingsUsd: number;
  /** Economia sobre o custo do baseline, de 0 a 100. Zero quando o baseline não custa nada. */
  savingsPercent: number;
}

/**
 * Projeta em volume a diferença de custo por requisição entre dois braços.
 *
 * shortcut: preço cheio de tabela e só o custo por requisição. Ficam de fora o custo fixo do
 * treino (curadoria, treino, reavaliação a cada modelo base), o desconto de cache de prompt,
 * que barateia justamente o bloco fixo do few-shot, e a nova tentativa que uma resposta fora
 * do schema custa. Antes de decidir com este número, some os três.
 */
export function projectSavings(
  baselinePerRequestUsd: number,
  candidatePerRequestUsd: number,
  requests = 100_000,
): SavingsProjection {
  for (const value of [baselinePerRequestUsd, candidatePerRequestUsd, requests]) {
    // NaN e negativo aqui viram uma projeção com cara de número: melhor parar.
    if (!(value >= 0))
      throw new RangeError(`Projeção: custo e volume precisam ser números não negativos (recebido: ${value}).`);
  }
  const baselineCostUsd = baselinePerRequestUsd * requests;
  const candidateCostUsd = candidatePerRequestUsd * requests;
  const savingsUsd = baselineCostUsd - candidateCostUsd;
  return {
    requests,
    baselineCostUsd,
    candidateCostUsd,
    savingsUsd,
    savingsPercent: baselineCostUsd > 0 ? (savingsUsd / baselineCostUsd) * 100 : 0,
  };
}
