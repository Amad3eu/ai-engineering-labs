export interface ChunkOptions {
  /** Tamanho alvo de cada chunk, em caracteres. Com o overlap, um chunk pode passar um pouco disso. */
  maxChars?: number;
  /** Quanto do fim de um chunk se repete no começo do seguinte. */
  overlapChars?: number;
}

// Parágrafo, depois frase, depois palavra: só desce um nível quando o pedaço ainda não cabe.
// É o que mantém junto o que o autor escreveu junto.
const SEPARATORS = [/\n\s*\n/, /(?<=[.!?])\s+/, /\s+/];

function splitUnits(text: string, maxChars: number): string[] {
  let units = [text];
  for (const separator of SEPARATORS) {
    units = units.flatMap((unit) => (unit.length <= maxChars ? [unit] : unit.split(separator)));
  }
  // Uma "palavra" maior que o limite (um blob, uma URL enorme) fica inteira: cortar no meio
  // não ajuda a busca. Limpe esse tipo de conteúdo antes de indexar.
  return units.map((unit) => unit.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function overlapTail(text: string, chars: number): string {
  if (chars <= 0) return '';
  const tail = text.slice(-chars);
  // Começa em início de palavra, para o chunk não abrir com meia palavra.
  return text.length > chars ? tail.slice(tail.search(/\s/) + 1) : tail;
}

/**
 * Divide um texto em chunks para indexação, respeitando parágrafos e frases.
 *
 * PONTO DE EXTENSÃO: tamanho e overlap são os dois botões que mais mexem na qualidade
 * do RAG. Chunk menor acha o trecho exato, mas perde contexto; chunk maior é o contrário.
 * Meça no lab 02 antes de mudar o padrão.
 */
export function chunkText(text: string, { maxChars = 800, overlapChars = 100 }: ChunkOptions = {}): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const unit of splitUnits(text, maxChars)) {
    if (current && current.length + unit.length + 1 > maxChars) {
      chunks.push(current);
      // O próximo chunk repete o fim deste: uma resposta que cai na fronteira continua
      // inteira em pelo menos um dos dois.
      current = overlapTail(current, overlapChars);
    }
    current = current ? `${current}\n${unit}` : unit;
  }
  if (current) chunks.push(current);
  return chunks;
}
