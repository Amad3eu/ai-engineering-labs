import { setMockResponder } from '@labs/shared-llm';
import type { Classification, Extraction } from './chain.js';

// Roteiro do provedor mock para este laboratório: regras de palavra-chave no lugar do modelo.
// Só tem efeito quando o provedor ativo é o mock (sem chave no .env, ou LLM_PROVIDERS=mock).
// Serve para a cadeia e a suíte rodarem no CI sem rede e sempre com o mesmo resultado.
// NÃO mede qualidade de prompt: para isso, rode com um provedor real.

const OUTAGE = /fora do ar|erro 500|indispon|caiu|ninguém .* consegue/i;
const BILLING = /cobra|fatura|nota fiscal|estorno|reembolso/i;
const ACCESS = /senha|login|entrar|acesso|autenticador/i;

/** O texto do ticket, que os prompts mandam entre as tags <ticket>. */
const ticketOf = (prompt: string) => prompt.match(/<ticket>\n([\s\S]*?)\n<\/ticket>/)?.[1] ?? prompt;

function extract(ticket: string): Extraction {
  return {
    summary: ticket.split(/(?<=[.!?])\s/)[0] ?? ticket,
    product: /\bAPI\b/.test(ticket) ? 'API' : /painel/i.test(ticket) ? 'painel' : null,
    mentionsOutage: OUTAGE.test(ticket),
    sentiment: /urgente|não consigo|perdi|duas vezes|fora do ar/i.test(ticket) ? 'negative' : 'neutral',
  };
}

function classify(ticket: string): Classification {
  if (OUTAGE.test(ticket)) {
    return { category: 'outage', priority: 'P1', reasoning: 'Relato de indisponibilidade com impacto amplo.' };
  }
  if (BILLING.test(ticket)) {
    const financialLoss = /duas vezes|estorno|reembolso/i.test(ticket);
    return {
      category: 'billing',
      priority: financialLoss ? 'P2' : 'P3',
      reasoning: financialLoss ? 'Cobrança indevida: prejuízo financeiro.' : 'Pedido de documento, sem urgência.',
    };
  }
  if (ACCESS.test(ticket)) {
    return { category: 'access', priority: 'P2', reasoning: 'Cliente bloqueado, sem conseguir entrar.' };
  }
  return { category: 'question', priority: 'P3', reasoning: 'Dúvida de uso, nada quebrado.' };
}

export function installMockScript(): void {
  setMockResponder(({ label, prompt }) => {
    if (label === 'triage:extract') return extract(ticketOf(prompt));
    if (label === 'triage:classify') return classify(ticketOf(prompt));
    if (label === 'triage:draft') {
      return 'Recebemos o seu relato e já estamos tratando. Daremos retorno dentro do prazo da prioridade atribuída. [resposta roteirizada do mock]';
    }
    return undefined;
  });
}
