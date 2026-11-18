// Reciprocal Rank Fusion (RRF): junta duas listas ordenadas olhando só para a POSIÇÃO de
// cada item, nunca para o score. É o que permite fundir a busca vetorial (similaridade de
// cosseno, de 0 a 1) com a lexical (ts_rank, sem teto): as duas escalas não se comparam,
// mas "foi o 2º colocado" quer dizer a mesma coisa nas duas.
//
//   score(item) = soma, nas listas em que ele aparece, de 1 / (k + posição)
//
// Um item bem colocado nas duas listas soma duas parcelas e passa na frente de quem só
// foi bem em uma. É a propriedade que os testes em rrf.test.ts provam.

/** Um item fundido: os campos originais, o score do RRF e a posição que teve em cada lista. */
export type Fused<T> = T & {
  /** Soma de 1 / (k + posição). Só serve para ordenar: não é probabilidade nem similaridade. */
  score: number;
  /** Posição na lista vetorial, a partir de 1. `null` se o item não apareceu nela. */
  vectorRank: number | null;
  /** Posição na lista lexical, a partir de 1. `null` se o item não apareceu nela. */
  lexicalRank: number | null;
};

const bestRank = (item: Fused<unknown>) => Math.min(item.vectorRank ?? Infinity, item.lexicalRank ?? Infinity);

/**
 * Funde o resultado da busca vetorial com o da lexical. As duas listas chegam ordenadas
 * da melhor para a pior. Função pura: não altera as entradas e não depende de nada externo.
 *
 * `k` amortece o peso do topo. Com k baixo, ser o 1º de uma lista vale muito mais do que
 * ser o 5º; com k alto (60 é o valor do artigo original e o padrão de mercado), a
 * diferença entre posições vizinhas é pequena e o que decide é aparecer nas duas listas.
 *
 * PONTO DE EXTENSÃO: para dar mais peso a uma das buscas, multiplique a parcela dela por
 * um fator (RRF ponderado). Para fundir três ou mais listas, a mesma soma se estende.
 */
export function reciprocalRankFusion<T extends { id: number | string }>(
  vectorResults: readonly T[],
  lexicalResults: readonly T[],
  k = 60,
): Fused<T>[] {
  // k negativo pode zerar o denominador (k = -1 com a posição 1) e inverter a ordem.
  if (!(k >= 0)) throw new RangeError(`RRF: k precisa ser um número maior ou igual a zero (recebido: ${k}).`);

  const fused = new Map<T['id'], Fused<T>>();
  const add = (results: readonly T[], rankField: 'vectorRank' | 'lexicalRank') => {
    results.forEach((item, index) => {
      const entry: Fused<T> = fused.get(item.id) ?? { ...item, score: 0, vectorRank: null, lexicalRank: null };
      // O mesmo id duas vezes na mesma lista conta uma vez só, pela melhor posição.
      if (entry[rankField] !== null) return;
      entry[rankField] = index + 1;
      entry.score += 1 / (k + index + 1);
      fused.set(item.id, entry);
    });
  };
  add(vectorResults, 'vectorRank');
  add(lexicalResults, 'lexicalRank');

  // Empate no score: vence quem teve a melhor posição individual. A ordenação é estável,
  // então o que ainda empatar fica na ordem de entrada. O resultado é sempre o mesmo.
  return [...fused.values()].sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b));
}
