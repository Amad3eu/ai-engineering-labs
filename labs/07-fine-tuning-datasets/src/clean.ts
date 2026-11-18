import { createHash } from 'node:crypto';
import { z } from 'zod';

// Funções puras de preparo do dataset. Ficam separadas do script porque são o que mais
// precisa de teste: um erro aqui vira defeito treinado dentro do modelo.

export const Label = z.enum(['billing', 'outage', 'access', 'question']);
export type Label = z.infer<typeof Label>;

export interface Example {
  text: string;
  label: Label;
}

/** Formato de chat para fine-tuning: uma conversa completa por linha do JSONL. */
export const ChatExample = z.object({
  messages: z.tuple([
    z.object({ role: z.literal('system'), content: z.string().min(1) }),
    z.object({ role: z.literal('user'), content: z.string().min(1) }),
    z.object({ role: z.literal('assistant'), content: Label }),
  ]),
});

const RawRecord = z.object({ text: z.string(), label: z.string() });

/** Texto mais curto que isto não carrega sinal para classificar. */
const MIN_CHARS = 15;

export const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

// shortcut: regex cobre e-mail, CPF e telefone nos formatos comuns no Brasil; nome de pessoa,
// endereço e formatos soltos escapam. Antes de enviar dado real para treino, passe por um
// detector de PII de verdade e por uma amostra revisada por gente.
//
// A ordem importa: 11 dígitos sem pontuação servem tanto para celular quanto para CPF.
// O CPF pontuado sai primeiro, depois o telefone, e o que sobrar com 11 dígitos é tratado
// como CPF. Na dúvida o número some do texto de qualquer jeito; só a etiqueta pode errar.
export function redactPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[CPF]')
    .replace(/(?:\+55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, '[TELEFONE]')
    .replace(/\b\d{11}\b/g, '[CPF]');
}

/** Chave de comparação: ignora caixa, acento e pontuação, para pegar a duplicata quase igual. */
const dedupeKey = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface CleanReport {
  kept: Example[];
  dropped: { invalid: number; unknownLabel: number; tooShort: number; duplicate: number };
}

/**
 * Valida, normaliza, remove PII e deduplica. Devolve também a contagem do que saiu e por
 * quê: descartar em silêncio esconde problema na origem do dado.
 *
 * PONTO DE EXTENSÃO: balancear classes, detectar o mesmo texto com rótulos diferentes
 * (hoje vale o primeiro) e filtrar idioma entram como passos aqui.
 */
export function cleanDataset(records: unknown[]): CleanReport {
  const report: CleanReport = { kept: [], dropped: { invalid: 0, unknownLabel: 0, tooShort: 0, duplicate: 0 } };
  const seen = new Set<string>();

  for (const record of records) {
    const raw = RawRecord.safeParse(record);
    if (!raw.success) {
      report.dropped.invalid++;
      continue;
    }
    const label = Label.safeParse(raw.data.label.trim().toLowerCase());
    if (!label.success) {
      report.dropped.unknownLabel++;
      continue;
    }
    const text = redactPii(normalizeWhitespace(raw.data.text));
    if (text.length < MIN_CHARS) {
      report.dropped.tooShort++;
      continue;
    }
    const key = dedupeKey(text);
    if (seen.has(key)) {
      report.dropped.duplicate++;
      continue;
    }
    seen.add(key);
    report.kept.push({ text, label: label.data });
  }
  return report;
}

/**
 * Separa treino e validação de forma estável: ordena pelo hash do texto e tira um a cada
 * `validationEvery`. A mesma entrada dá sempre a mesma divisão, e um exemplo nunca muda
 * de lado entre execuções, o que contaminaria a comparação entre modelos.
 */
export function splitDataset(examples: Example[], validationEvery = 5): { train: Example[]; validation: Example[] } {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const ordered = examples.toSorted((a, b) => hash(a.text).localeCompare(hash(b.text)));
  return {
    train: ordered.filter((_, index) => index % validationEvery !== 0),
    validation: ordered.filter((_, index) => index % validationEvery === 0),
  };
}

export function toChatJsonl(examples: Example[], system: string): string {
  return examples
    .map(({ text, label }) =>
      JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
          { role: 'assistant', content: label },
        ],
      } satisfies z.infer<typeof ChatExample>),
    )
    .join('\n')
    .concat('\n');
}

/** Relê um JSONL e valida cada linha. Devolve o número de exemplos; lança no primeiro inválido. */
export function validateChatJsonl(jsonl: string): number {
  const lines = jsonl.split('\n').filter(Boolean);
  lines.forEach((line, index) => {
    const parsed = ChatExample.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`JSONL inválido na linha ${index + 1}:\n${z.prettifyError(parsed.error)}`);
  });
  return lines.length;
}
