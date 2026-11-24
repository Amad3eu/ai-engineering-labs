import { DEFAULT_MODELS, estimateCostUsd, type GenerateResult, generateText, type ModelTier } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import { type AuditRecord, type AuditTrail, type GuardStatus, hashInput, type Outcome } from './audit-trail.js';
import type { BudgetGuard, BudgetStatus } from './budget-guard.js';
import { checkInput, checkOutput, sanitize } from './guardrails.js';
import { ASSISTANT_SYSTEM, answerPrompt, type Source } from './prompts.js';
import { type AiUseCase, classifyAiSystemRisk, type RiskAssessment } from './risk-classifier.js';

// O caminho de uma requisição governada. Cada trava pode encerrar o caminho, e toda saída,
// entregue ou barrada, deixa um registro na trilha de auditoria.
//
//   risco → guardrail de entrada → orçamento → modelo → guardrail de saída → revisão humana
//
// A ordem é a do custo: o que barra sem gastar token vem antes de qualquer chamada.

export interface GovernedRequest {
  tenantId: string;
  useCase: AiUseCase;
  prompt: string;
  /** Faixa de modelo pedida. O orçamento pode rebaixar. */
  tier?: ModelTier;
}

export interface GovernedResponse {
  outcome: Outcome;
  /** O texto entregue ao usuário. `null` quando a resposta foi barrada ou espera revisão. */
  answer: string | null;
  /** Em `pending-human-review`: o rascunho que a pessoa revisora recebe. */
  draft: string | null;
  risk: RiskAssessment;
  audit: AuditRecord;
}

export interface Governance {
  budget: BudgetGuard;
  audit: AuditTrail;
  knowledge: Source[];
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 4),
  );

const MIN_SHARED_WORDS = 2;

/**
 * As fontes que entram no contexto: as que têm mais palavras em comum com a pergunta.
 * Uma palavra só em comum não basta: fonte que entra por acaso vira explicação falsa na
 * trilha de auditoria.
 *
 * shortcut: sobreposição de palavras de 5 letras ou mais basta para quatro documentos.
 * Busca de verdade, vetorial e híbrida, é o assunto do lab 02.
 */
export function findSources(question: string, knowledge: Source[], limit = 2): Source[] {
  const asked = words(question);
  return knowledge
    .map((source) => ({ source, shared: [...words(source.text)].filter((word) => asked.has(word)).length }))
    .filter(({ shared }) => shared >= MIN_SHARED_WORDS)
    .toSorted((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map(({ source }) => source);
}

// O mock e o Ollama não têm preço. Para o orçamento andar sem chave de API, a chamada
// gratuita é cobrada a preço de tabela do modelo da OpenAI na mesma faixa.
const referenceCostUsd = (result: GenerateResult) =>
  estimateCostUsd('openai', DEFAULT_MODELS.openai[result.tier], result.tokensIn, result.tokensOut);

export async function processRequest(governance: Governance, request: GovernedRequest): Promise<GovernedResponse> {
  const { budget, audit, knowledge } = governance;
  const { tenantId, useCase, prompt, tier = 'balanced' } = request;

  const risk = classifyAiSystemRisk(useCase);
  // O que cada trava decidiu até aqui. Trava que não chegou a rodar fica como `skipped`.
  const state = {
    input: 'skipped' as GuardStatus,
    output: 'skipped' as GuardStatus,
    budget: 'skipped' as BudgetStatus | 'skipped',
    model: null as string | null,
    sources: [] as string[],
    costUsd: 0,
  };

  const finish = (outcome: Outcome, text: string | null = null): GovernedResponse => {
    const record = audit.append({
      tenantId,
      inputHash: hashInput(sanitize(prompt)),
      riskLevel: risk.riskLevel,
      guardrails: { input: state.input, output: state.output },
      budget: state.budget,
      model: state.model,
      sources: state.sources,
      costUsd: state.costUsd,
      outcome,
    });
    return {
      outcome,
      answer: outcome === 'delivered' ? text : null,
      draft: outcome === 'pending-human-review' ? text : null,
      risk,
      audit: record,
    };
  };

  if (risk.riskLevel === 'unacceptable-risk') {
    logger.error({ event: 'risk.blocked', tenantId, domain: useCase.domain }, '[RISK] caso de uso proibido');
    return finish('blocked-by-risk');
  }

  const inputCheck = checkInput(prompt);
  if (!inputCheck.allowed) {
    state.input = 'blocked';
    const rules = inputCheck.violations.map((violation) => violation.rule);
    logger.warn(
      { event: 'guardrail.input.blocked', tenantId, rules },
      `[GUARDRAIL] entrada barrada: ${rules.join(', ')}`,
    );
    return finish('blocked-by-input-guard');
  }
  state.input = 'passed';

  const decision = budget.authorize(tenantId, tier);
  state.budget = decision.status;
  if (decision.tier === null) return finish('blocked-by-budget');

  const sources = findSources(prompt, knowledge);
  state.sources = sources.map((source) => source.id);
  const allowedTier = decision.tier;
  const { value: result, costUsd } = await budget.meter(
    tenantId,
    () =>
      generateText({
        system: ASSISTANT_SYSTEM,
        prompt: answerPrompt(prompt, sources),
        tier: allowedTier,
        label: 'governance:answer',
      }),
    referenceCostUsd,
  );
  state.model = result.model;
  state.costUsd = costUsd;

  const outputCheck = checkOutput(result.text);
  if (!outputCheck.allowed) {
    state.output = 'blocked';
    // Só a regra e a evidência mascarada vão para o log: o vazamento não se repete nele.
    logger.error(
      { event: 'guardrail.output.blocked', tenantId, violations: outputCheck.violations },
      `[GUARDRAIL] saída barrada: ${outputCheck.violations.map((violation) => violation.rule).join(', ')}`,
    );
    return finish('blocked-by-output-guard');
  }
  state.output = 'passed';

  // PONTO DE EXTENSÃO: aqui o rascunho entraria em uma fila de revisão. A pausa e a retomada
  // com aprovação humana estão no lab 05.
  if (risk.requirements.includes('human-in-the-loop')) return finish('pending-human-review', result.text);

  return finish('delivered', result.text);
}
