import { z } from 'zod';

// O domínio do laboratório: a triagem de um ticket de suporte.

export const Category = z.enum(['billing', 'outage', 'access', 'question']);
export type Category = z.infer<typeof Category>;

export const Priority = z.enum(['P1', 'P2', 'P3']);
export type Priority = z.infer<typeof Priority>;

/**
 * O schema rígido da tarefa: a resposta do modelo é este objeto, e só ele. `strictObject`
 * recusa chave a mais, porque quem lê a resposta do outro lado é código, não gente.
 *
 * É a triagem do lab 01 sem o campo de justificativa. Em produção, a política dura
 * (indisponibilidade é sempre P1) continua em código depois do modelo, como lá.
 */
export const TicketTriage = z.strictObject({ category: Category, priority: Priority });
export type TicketTriage = z.infer<typeof TicketTriage>;

/** Um ticket rotulado: o texto e a triagem que o modelo deve aprender a devolver. */
export interface Example extends TicketTriage {
  text: string;
}

/** A resposta-alvo, com as chaves sempre na mesma ordem: é este texto que o modelo aprende a escrever. */
export const triageJson = ({ category, priority }: TicketTriage) => JSON.stringify({ category, priority });

/**
 * Lê uma resposta como triagem. Aderência estrita: o texto inteiro tem que ser o JSON do
 * schema. Bloco de código em volta, frase antes ou chave a mais contam como falha, porque
 * quebram o consumidor que faz o parse.
 *
 * É a mesma régua nos dois lados: valida a resposta-alvo de cada linha do JSONL
 * (dataset-builder.ts) e mede a resposta do modelo no A/B (ab-eval.ts).
 */
export function parseTriage(text: string): TicketTriage | undefined {
  try {
    return TicketTriage.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}
