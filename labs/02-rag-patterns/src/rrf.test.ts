import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reciprocalRankFusion } from './rrf.js';

const docs = (...ids: string[]) => ids.map((id) => ({ id }));
const order = (results: Array<{ id: string }>) => results.map((result) => result.id);

test('documento bem colocado nas duas buscas supera o 1º lugar isolado de cada uma', () => {
  // "comum" é só o 2º na vetorial e o 2º na lexical; "so-vetorial" e "so-lexical" são 1º em uma e somem na outra.
  const fused = reciprocalRankFusion(docs('so-vetorial', 'comum', 'v3'), docs('so-lexical', 'comum', 'l3'));

  assert.deepEqual(order(fused), ['comum', 'so-vetorial', 'so-lexical', 'v3', 'l3']);

  const [comum, soVetorial] = fused;
  assert.ok(comum && soVetorial);
  assert.ok(comum.score > soVetorial.score);
  // Com k = 60: 2 × 1/62 contra 1/61. Aparecer nas duas quase dobra o score.
  assert.ok(Math.abs(comum.score - 2 / 62) < 1e-12);
  assert.ok(Math.abs(soVetorial.score - 1 / 61) < 1e-12);
});

test('mesmo um 5º lugar nas duas buscas supera um 1º lugar isolado', () => {
  const vector = docs('topo-vetorial', 'v2', 'v3', 'v4', 'comum');
  const lexical = docs('topo-lexical', 'l2', 'l3', 'l4', 'comum');

  const [first] = reciprocalRankFusion(vector, lexical);

  assert.equal(first?.id, 'comum'); // 2/65 = 0,0308 contra 1/61 = 0,0164
});

test('o score é a soma de 1 / (k + posição), e as posições de origem ficam no resultado', () => {
  const fused = reciprocalRankFusion(docs('a', 'b', 'c'), docs('c', 'a'));
  const byId = new Map(fused.map((item) => [item.id, item]));

  assert.deepEqual(byId.get('a'), { id: 'a', score: 1 / 61 + 1 / 62, vectorRank: 1, lexicalRank: 2 });
  assert.deepEqual(byId.get('c'), { id: 'c', score: 1 / 63 + 1 / 61, vectorRank: 3, lexicalRank: 1 });
  assert.deepEqual(byId.get('b'), { id: 'b', score: 1 / 62, vectorRank: 2, lexicalRank: null });
  assert.deepEqual(order(fused), ['a', 'c', 'b']);
});

test('k regula o peso do topo: com k baixo, um 1º lugar isolado vence um 4º lugar duplo', () => {
  const vector = docs('topo', 'v2', 'v3', 'comum');
  const lexical = docs('l1', 'l2', 'l3', 'comum');

  // k = 60: comum = 2/64 = 0,031 > topo = 1/61 = 0,016
  assert.equal(reciprocalRankFusion(vector, lexical, 60)[0]?.id, 'comum');
  // k = 1:  comum = 2/5 = 0,4   < topo = 1/2 = 0,5
  assert.equal(reciprocalRankFusion(vector, lexical, 1)[0]?.id, 'topo');
});

test('com uma lista vazia, a ordem da outra é preservada; com as duas vazias, o resultado é vazio', () => {
  assert.deepEqual(order(reciprocalRankFusion(docs('a', 'b', 'c'), [])), ['a', 'b', 'c']);
  assert.deepEqual(order(reciprocalRankFusion([], docs('x', 'y'))), ['x', 'y']);
  assert.deepEqual(reciprocalRankFusion([], []), []);
});

test('empate é resolvido sempre do mesmo jeito: melhor posição individual, depois ordem de entrada', () => {
  // "a" (1º vetorial) e "x" (1º lexical) empatam em 1/61: vence o que entrou primeiro, a lista vetorial.
  assert.deepEqual(order(reciprocalRankFusion(docs('a', 'b'), docs('x', 'y'))), ['a', 'x', 'b', 'y']);
  assert.deepEqual(order(reciprocalRankFusion(docs('a', 'b'), docs('x', 'y'))), ['a', 'x', 'b', 'y']);
});

test('preserva os campos do item, troca o score pelo do RRF e não altera as entradas', () => {
  const vector = [{ id: 7, source: 'runbook', content: 'ERR-4012', score: 0.91 }];
  const lexical = [{ id: 7, source: 'runbook', content: 'ERR-4012', score: 12.5 }];
  const snapshot = structuredClone({ vector, lexical });

  const [hit] = reciprocalRankFusion(vector, lexical);

  assert.deepEqual(hit, {
    id: 7,
    source: 'runbook',
    content: 'ERR-4012',
    score: 2 / 61,
    vectorRank: 1,
    lexicalRank: 1,
  });
  assert.deepEqual({ vector, lexical }, snapshot);
});

test('id repetido na mesma lista conta uma vez, pela melhor posição', () => {
  const [hit] = reciprocalRankFusion(docs('a', 'a'), []);

  assert.deepEqual(hit, { id: 'a', score: 1 / 61, vectorRank: 1, lexicalRank: null });
});

test('k inválido é recusado', () => {
  assert.throws(() => reciprocalRankFusion(docs('a'), docs('a'), -1), RangeError);
  assert.throws(() => reciprocalRankFusion(docs('a'), docs('a'), Number.NaN), RangeError);
  assert.equal(reciprocalRankFusion(docs('a'), docs('a'), 0)[0]?.score, 2); // k = 0 é válido: 1/1 + 1/1
});
