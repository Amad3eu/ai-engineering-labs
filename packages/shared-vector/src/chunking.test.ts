import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText } from './chunking.js';

const sentence = (n: number) => `A frase número ${n} descreve um passo do procedimento de deploy.`;
const paragraphs = (count: number, sentencesEach: number) =>
  Array.from({ length: count }, (_, p) =>
    Array.from({ length: sentencesEach }, (_, s) => sentence(p * sentencesEach + s)).join(' '),
  ).join('\n\n');

test('texto que cabe vira um chunk só, com o espaçamento normalizado', () => {
  assert.deepEqual(chunkText('  Uma frase   curta.  '), ['Uma frase curta.']);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('texto longo vira vários chunks, cada um perto do tamanho alvo', () => {
  const options = { maxChars: 300, overlapChars: 60 };
  const chunks = chunkText(paragraphs(6, 5), options);

  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= options.maxChars + options.overlapChars + 1, `chunk com ${chunk.length} caracteres`);
  }
});

test('nenhuma frase se perde na divisão', () => {
  const chunks = chunkText(paragraphs(6, 5), { maxChars: 300, overlapChars: 60 });

  for (let n = 0; n < 30; n++) {
    assert.ok(
      chunks.some((chunk) => chunk.includes(sentence(n))),
      `faltou a frase ${n}`,
    );
  }
});

test('cada chunk começa repetindo o fim do anterior', () => {
  const chunks = chunkText(paragraphs(6, 5), { maxChars: 300, overlapChars: 60 });

  for (let i = 1; i < chunks.length; i++) {
    const opening = chunks[i]?.split('\n')[0] ?? '';
    assert.ok(opening.length > 0 && chunks[i - 1]?.endsWith(opening), `chunk ${i} não repete o fim do anterior`);
  }
});

test('sem overlap, os chunks juntos reconstroem o texto sem repetir nada', () => {
  const text = paragraphs(4, 5);
  const chunks = chunkText(text, { maxChars: 300, overlapChars: 0 });

  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('parágrafo sem pontuação é dividido por palavra, não cortado no meio dela', () => {
  const words = Array.from({ length: 120 }, (_, i) => `palavra${i}`);
  const chunks = chunkText(words.join(' '), { maxChars: 200, overlapChars: 0 });

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.join('\n').split(/\s+/), words);
});
