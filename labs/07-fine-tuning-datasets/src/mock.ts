import { setMockResponder } from '@labs/shared-llm';
import { type TicketTriage, triageJson } from './schema.js';

// Roteiro do provedor mock: um classificador por palavra-chave no lugar do modelo. Só tem
// efeito sem chave de API (ou com LLM_PROVIDERS=mock, que é o que o CI usa).
//
// O que ele simula no A/B:
// - `ab:fine-tuned`: um modelo ajustado, que responde sempre com o JSON puro;
// - `ab:few-shot`: um modelo base, que acerta o conteúdo e, a cada `formatSlipEvery`
//   respostas, embrulha o JSON em bloco de código, um deslize típico de modelo sem treino.
//
// A taxa de deslize é PREMISSA do roteiro, escolhida para a métrica de aderência aparecer em
// uma validação de 8 exemplos. Não é medição nem estimativa de modelo nenhum. Para medir,
// rode com um provedor real.

const OUTAGE =
  /fora do ar|erro 50\d|timeout|inacessível|pararam|ninguém|nenhum|para todos|todas as|todo mundo|empresa inteira/i;
const BILLING = /cobra|fatura|nota fiscal|estorno|reembolso|cartão|plano subiu|boleto/i;
const ACCESS = /senha|login|entrar|acesso|autenticador|autenticação|permissão|bloqueada|ex-funcionário/i;
/** Alguém impedido de trabalhar, cobrança indevida ou risco de segurança: é o que separa P2 de P3. */
const BLOCKED =
  /cobrado duas|recusado|suspensa|a mais do que|vencida|não consigo|não chega|perdi|bloqueada|ex-funcionário|negado/i;

function triage(ticket: string): TicketTriage {
  if (OUTAGE.test(ticket)) return { category: 'outage', priority: 'P1' };
  const priority = BLOCKED.test(ticket) ? 'P2' : 'P3';
  if (BILLING.test(ticket)) return { category: 'billing', priority };
  if (ACCESS.test(ticket)) return { category: 'access', priority };
  return { category: 'question', priority: 'P3' };
}

export const FORMAT_SLIP_EVERY = 8;

export function installMockScript({ formatSlipEvery = FORMAT_SLIP_EVERY }: { formatSlipEvery?: number } = {}): void {
  let fewShotAnswers = 0;
  setMockResponder(({ label, prompt }) => {
    if (!label?.startsWith('ab:')) return undefined;
    const answer = triageJson(triage(prompt));
    if (label !== 'ab:few-shot') return answer;

    fewShotAnswers++;
    return fewShotAnswers % formatSlipEvery === 0 ? `\`\`\`json\n${answer}\n\`\`\`` : answer;
  });
}
