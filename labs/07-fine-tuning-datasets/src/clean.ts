import { z } from 'zod';
import { Category, type Example, Priority } from './schema.js';

// Funções puras de limpeza do dado bruto. Ficam separadas do pipeline porque são o que mais
// precisa de teste: um erro aqui vira defeito treinado dentro do modelo.

const RawRecord = z.object({ text: z.string(), category: z.string(), priority: z.string() });

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
 * PONTO DE EXTENSÃO: detectar o mesmo texto com rótulos diferentes (hoje vale o primeiro)
 * e filtrar idioma entram como passos aqui.
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
    // Rótulo digitado à mão chega com caixa e espaço variados: "Billing", " p2 ".
    const category = Category.safeParse(raw.data.category.trim().toLowerCase());
    const priority = Priority.safeParse(raw.data.priority.trim().toUpperCase());
    if (!category.success || !priority.success) {
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
    report.kept.push({ text, category: category.data, priority: priority.data });
  }
  return report;
}
