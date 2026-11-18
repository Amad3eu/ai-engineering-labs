import { type Classification, classifyTicket } from './chain.js';

export interface EvalCase {
  id: string;
  ticket: string;
  expected: Pick<Classification, 'category' | 'priority'>;
}

// Conjunto de referência ("golden set"): entradas com a resposta certa anotada por gente.
// PONTO DE EXTENSÃO: todo erro visto em produção vira um caso novo aqui. É assim que a
// suíte passa a proteger contra a volta dos problemas que já aconteceram.
export const DATASET: EvalCase[] = [
  {
    id: 'cobranca-duplicada',
    ticket: 'Fui cobrado duas vezes na fatura de outubro. Preciso do estorno de uma das cobranças.',
    expected: { category: 'billing', priority: 'P2' },
  },
  {
    id: 'api-erro-500',
    ticket:
      'Desde as 14h a API de vocês devolve erro 500 para todos os nossos clientes. Precisamos de retorno urgente.',
    expected: { category: 'outage', priority: 'P1' },
  },
  {
    id: 'senha-nao-chega',
    ticket: 'Não consigo entrar no painel. Pedi a redefinição de senha três vezes e o e-mail não chega.',
    expected: { category: 'access', priority: 'P2' },
  },
  {
    id: 'exportar-csv',
    ticket: 'Como faço para exportar os relatórios mensais em CSV?',
    expected: { category: 'question', priority: 'P3' },
  },
  {
    id: 'painel-fora-do-ar',
    ticket: 'O painel está fora do ar para a empresa inteira, ninguém aqui consegue trabalhar.',
    expected: { category: 'outage', priority: 'P1' },
  },
  {
    id: 'segunda-via-nota',
    ticket: 'Bom dia, podem me enviar a segunda via da nota fiscal de setembro? Sem pressa.',
    expected: { category: 'billing', priority: 'P3' },
  },
  {
    id: 'perdi-autenticador',
    ticket: 'Perdi o celular com o aplicativo autenticador e fiquei sem acesso à minha conta.',
    expected: { category: 'access', priority: 'P2' },
  },
  {
    id: 'limite-do-plano',
    ticket: 'Qual é o limite de requisições por minuto do plano Pro?',
    expected: { category: 'question', priority: 'P3' },
  },
];

/** Piso de qualidade. Abaixo disto, a mudança no prompt ou no modelo não entra. */
export const THRESHOLDS = { categoryAccuracy: 0.85, priorityAccuracy: 0.75 };

export interface EvalRow {
  id: string;
  category: string;
  priority: string;
  categoryOk: boolean;
  priorityOk: boolean;
}

export interface EvalReport {
  rows: EvalRow[];
  categoryAccuracy: number;
  priorityAccuracy: number;
}

/** Roda a cadeia em cada caso e compara com o esperado. */
export async function runEvals(cases: EvalCase[] = DATASET): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  // Em série de propósito: a ordem dos logs fica legível e não estoura limite de requisições.
  for (const { id, ticket, expected } of cases) {
    const { classification } = await classifyTicket(ticket);
    rows.push({
      id,
      category: classification.category,
      priority: classification.priority,
      categoryOk: classification.category === expected.category,
      priorityOk: classification.priority === expected.priority,
    });
  }

  const share = (pick: (row: EvalRow) => boolean) => rows.filter(pick).length / rows.length;
  return {
    rows,
    categoryAccuracy: share((row) => row.categoryOk),
    priorityAccuracy: share((row) => row.priorityOk),
  };
}
