import { generateObject, generateText } from '@labs/shared-llm';
import { z } from 'zod';
import {
  CLASSIFY_SYSTEM,
  classifyPrompt,
  DRAFT_SYSTEM,
  draftPrompt,
  EXTRACT_SYSTEM,
  extractPrompt,
} from './prompts.js';

// Saída estruturada: cada passo da cadeia devolve um objeto com contrato. O passo seguinte
// recebe campos tipados, não um texto para interpretar de novo.
// Em schema de saída use `.nullable()`, não `.optional()`: o modo estrito dos provedores
// exige que todo campo venha na resposta.
export const Extraction = z.object({
  summary: z.string().describe('O problema em uma frase.'),
  product: z.string().nullable().describe('Produto ou área citada no ticket, se houver.'),
  mentionsOutage: z.boolean().describe('O cliente relata serviço indisponível ou erro generalizado?'),
  sentiment: z.enum(['negative', 'neutral', 'positive']),
});
export type Extraction = z.infer<typeof Extraction>;

export const Classification = z.object({
  category: z.enum(['billing', 'outage', 'access', 'question']),
  priority: z.enum(['P1', 'P2', 'P3']),
  reasoning: z.string().describe('Uma frase justificando categoria e prioridade.'),
});
export type Classification = z.infer<typeof Classification>;

/**
 * Regra de negócio determinística, aplicada depois do modelo.
 * O SLA de uma indisponibilidade não pode depender de o modelo acertar a prioridade:
 * o que é regra fica em código, testável e igual em toda execução.
 *
 * PONTO DE EXTENSÃO: outras regras duras entram aqui (cliente enterprise nunca é P3,
 * ticket com termo jurídico vai para uma fila própria).
 */
export function applyPolicy(classification: Classification): Classification {
  if (classification.category === 'outage' && classification.priority !== 'P1') {
    return {
      ...classification,
      priority: 'P1',
      reasoning: `${classification.reasoning} [política: indisponibilidade é sempre P1]`,
    };
  }
  return classification;
}

/** Passos 1 a 3 da cadeia: extrair os fatos, classificar e aplicar a política. */
export async function classifyTicket(
  ticket: string,
): Promise<{ extraction: Extraction; classification: Classification }> {
  // Passo 1: extração. Tarefa simples e de alto volume: faixa `fast`.
  const { object: extraction } = await generateObject({
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt(ticket),
    schema: Extraction,
    schemaName: 'extraction',
    tier: 'fast',
    label: 'triage:extract',
  });

  // Passo 2: classificação, já com os fatos na mão. Separar os dois passos deixa cada
  // prompt com uma tarefa só e mostra em qual deles um erro nasceu.
  const { object: classification } = await generateObject({
    system: CLASSIFY_SYSTEM,
    prompt: classifyPrompt(ticket, extraction),
    schema: Classification,
    schemaName: 'classification',
    tier: 'fast',
    label: 'triage:classify',
  });

  // Passo 3: política em código.
  return { extraction, classification: applyPolicy(classification) };
}

/** A cadeia inteira: classificação mais o rascunho de resposta ao cliente. */
export async function triageTicket(
  ticket: string,
): Promise<{ extraction: Extraction; classification: Classification; reply: string }> {
  const { extraction, classification } = await classifyTicket(ticket);

  // Passo 4: redação. Sem `tier`, o roteador de @labs/shared-llm escolhe a faixa pelo prompt.
  // PONTO DE EXTENSÃO: novos passos (traduzir, checar tom, anexar artigo da base) entram aqui.
  const { text: reply } = await generateText({
    system: DRAFT_SYSTEM,
    prompt: draftPrompt(extraction, classification),
    label: 'triage:draft',
  });

  return { extraction, classification, reply };
}
