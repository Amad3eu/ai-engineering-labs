import { z } from 'zod';
import { type PiiType, sanitizePii } from './pii-sanitizer.js';
import { Category, type Example, Priority } from './schema.js';

// Funções puras de limpeza do dado bruto. Ficam separadas do pipeline porque são o que mais
// precisa de teste: um erro aqui vira defeito treinado dentro do modelo.

const RawRecord = z.object({ text: z.string(), category: z.string(), priority: z.string() });

/** Texto mais curto que isto não carrega sinal para classificar. */
const MIN_CHARS = 15;

export const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Chave da duplicata exata: ignora caixa, acento e pontuação. A aproximada fica em dataset-builder.ts. */
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
  /** Quantas ocorrências o gate de PII mascarou, em todo texto que chegou a ele, descartado depois ou não. */
  piiRedactions: Record<PiiType, number>;
}

/**
 * Valida, normaliza, mascara PII e deduplica. Devolve também a contagem do que saiu e por
 * quê: descartar em silêncio esconde problema na origem do dado.
 *
 * PONTO DE EXTENSÃO: detectar o mesmo texto com rótulos diferentes (hoje vale o primeiro)
 * e filtrar idioma entram como passos aqui.
 */
export function cleanDataset(records: unknown[]): CleanReport {
  const report: CleanReport = {
    kept: [],
    dropped: { invalid: 0, unknownLabel: 0, tooShort: 0, duplicate: 0 },
    piiRedactions: { CPF: 0, EMAIL: 0, PHONE: 0 },
  };
  const seen = new Set<string>();

  for (const record of records) {
    const raw = RawRecord.safeParse(record);
    if (!raw.success) {
      report.dropped.invalid++;
      continue;
    }
    // Rótulo digitado à mão chega com caixa e espaço variados: "Billing", " p2 ".
    const category = Category.safeParse(raw.data.category.trim().toLowerCase());
    const priority = Priority.safeParse(raw.data.priority.trim().toUpperCase());
    if (!category.success || !priority.success) {
      report.dropped.unknownLabel++;
      continue;
    }
    // O gate de PII vem antes de qualquer passo que guarde ou compare o texto.
    const { sanitizedText: text, redactions } = sanitizePii(normalizeWhitespace(raw.data.text));
    for (const { type, count } of redactions) report.piiRedactions[type] += count;
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
    report.kept.push({ text, category: category.data, priority: priority.data });
  }
  return report;
}
