// Gate de anonimização: nenhum texto entra no dataset sem passar por aqui (clean.ts chama
// antes de olhar tamanho ou duplicata). O que o modelo vê no treino ele pode repetir em
// produção, então e-mail, CPF e telefone viram tokens fixos.

export type PiiType = 'CPF' | 'EMAIL' | 'PHONE';
const PII_TYPES: PiiType[] = ['CPF', 'EMAIL', 'PHONE'];

export interface SanitizedText {
  sanitizedText: string;
  /** Só os tipos encontrados, na ordem CPF, EMAIL, PHONE. Vazio quando o texto estava limpo. */
  redactions: Array<{ type: PiiType; count: number }>;
}

// shortcut: regex cobre e-mail, CPF e telefone nos formatos comuns no Brasil; nome de pessoa,
// endereço e formatos soltos escapam. Antes de enviar dado real para treino, passe por um
// detector de PII de verdade e por uma amostra revisada por gente.
//
// A ordem importa: 11 dígitos sem pontuação servem tanto para celular quanto para CPF.
// O CPF pontuado sai primeiro, depois o telefone, e o que sobrar com 11 dígitos é tratado
// como CPF. Na dúvida o número some do texto de qualquer jeito; só o token pode errar.
const PATTERNS: Array<[PiiType, RegExp]> = [
  ['EMAIL', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['CPF', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g],
  ['PHONE', /(?:\+55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g],
  ['CPF', /\b\d{11}\b/g],
];

/**
 * Troca cada e-mail, CPF e telefone por `<EMAIL>`, `<CPF>` e `<PHONE>`, e conta o que trocou.
 * Função pura, e passar duas vezes dá o mesmo resultado: os tokens não casam com nenhum padrão.
 */
export function sanitizePii(text: string): SanitizedText {
  const counts: Record<PiiType, number> = { CPF: 0, EMAIL: 0, PHONE: 0 };
  let sanitizedText = text;
  for (const [type, pattern] of PATTERNS) {
    sanitizedText = sanitizedText.replace(pattern, () => {
      counts[type]++;
      return `<${type}>`;
    });
  }
  return {
    sanitizedText,
    redactions: PII_TYPES.filter((type) => counts[type] > 0).map((type) => ({ type, count: counts[type] })),
  };
}
