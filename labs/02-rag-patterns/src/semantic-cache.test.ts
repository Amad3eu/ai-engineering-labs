import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logger } from '@labs/shared-observability';
import { createMemoryStore } from './memory-store.js';
import { type CacheScope, createSemanticCache } from './semantic-cache.js';

// O embedding vem do provedor mock (determinístico): o teste não usa rede nem Redis.
process.env.LLM_PROVIDERS = 'mock';
logger.level = 'silent';

const GLOBAL: CacheScope = { kind: 'global' };
const privateOf = (userId: string): CacheScope => ({ kind: 'user-private', userId });

test('a primeira consulta não acerta e guarda; a segunda, igual, vem do cache', async () => {
  const { store, ttls } = createMemoryStore();
  const cache = createSemanticCache(store, { ttlSeconds: 120 });

  const first = await cache.probe('O que significa o erro ERR-4012?', GLOBAL);
  assert.equal(first.hit, undefined);
  assert.equal(first.similarity, 0);
  await first.save('Timeout no gateway de pagamento.');

  const second = await cache.probe('O que significa o erro ERR-4012?', GLOBAL);

  assert.deepEqual(second.hit, { answer: 'Timeout no gateway de pagamento.', scope: 'global' });
  assert.ok(second.similarity > 0.999);
  assert.deepEqual([...ttls.values()], [120]);
});

test('o limiar padrão é 0,95: a mesma pergunta com outra redação acerta, outro assunto não', async () => {
  const { store } = createMemoryStore();
  const cache = createSemanticCache(store);

  await (await cache.probe('O que significa o erro ERR-4012?', GLOBAL)).save('resposta');
  const reworded = await cache.probe('O erro ERR-4012 significa o quê?', GLOBAL);
  const unrelated = await cache.probe('Como funciona o plantão de incidentes?', GLOBAL);

  assert.ok(reworded.hit);
  assert.ok(reworded.similarity >= 0.95);
  assert.equal(unrelated.hit, undefined);
  assert.ok(unrelated.similarity < 0.95);
});

test('o limiar é configurável: a mesma dupla de perguntas acerta com 0,80 e erra com 0,95', async () => {
  const { store } = createMemoryStore();
  const question = 'O que significa o erro ERR-4012?';
  const nearMiss = 'O que quer dizer o erro ERR-4012?'; // duas palavras trocadas

  await (await createSemanticCache(store).probe(question, GLOBAL)).save('resposta');

  const strict = await createSemanticCache(store, { threshold: 0.95 }).probe(nearMiss, GLOBAL);
  const loose = await createSemanticCache(store, { threshold: 0.8 }).probe(nearMiss, GLOBAL);

  assert.equal(strict.hit, undefined);
  assert.ok(loose.hit);
  assert.equal(strict.similarity, loose.similarity);
  assert.ok(strict.similarity > 0.8 && strict.similarity < 0.95);
});

test('escopo user-private: a resposta de um usuário não volta para outro', async () => {
  const { store } = createMemoryStore();
  const cache = createSemanticCache(store);
  const question = 'Qual é o saldo da minha conta?';

  await (await cache.probe(question, privateOf('ana'))).save('O saldo da Ana é 1.200.');

  const sameUser = await cache.probe(question, privateOf('ana'));
  const otherUser = await cache.probe(question, privateOf('bruno'));

  assert.deepEqual(sameUser.hit, { answer: 'O saldo da Ana é 1.200.', scope: 'user-private' });
  assert.equal(otherUser.hit, undefined);
  assert.equal(otherUser.similarity, 0); // nem a similaridade da entrada alheia aparece
});

test('escopo global: serve a todos, inclusive dentro de uma conversa privada', async () => {
  const { store } = createMemoryStore();
  const cache = createSemanticCache(store);
  const question = 'O que significa o erro ERR-4012?';

  await (await cache.probe(question, GLOBAL)).save('Timeout no gateway.');

  assert.equal((await cache.probe(question, GLOBAL)).hit?.scope, 'global');
  assert.equal((await cache.probe(question, privateOf('bruno'))).hit?.scope, 'global');
});

test('uma consulta global nunca enxerga entrada privada, nem a do próprio usuário', async () => {
  const { store } = createMemoryStore();
  const cache = createSemanticCache(store);
  const question = 'Qual é o saldo da minha conta?';

  await (await cache.probe(question, privateOf('ana'))).save('O saldo da Ana é 1.200.');

  assert.equal((await cache.probe(question, GLOBAL)).hit, undefined);
});

test('id de usuário com curinga não casa com as entradas dos outros', async () => {
  const { store, data } = createMemoryStore();
  const cache = createSemanticCache(store);
  const question = 'Qual é o saldo da minha conta?';

  await (await cache.probe(question, privateOf('ana'))).save('O saldo da Ana é 1.200.');

  for (const hostile of ['*', '?'.repeat(64), 'a*', '*:*']) {
    assert.equal((await cache.probe(question, privateOf(hostile))).hit, undefined, `vazou para o id "${hostile}"`);
  }
  // O id nunca aparece cru na chave.
  assert.ok([...data.keys()].every((key) => !key.includes('ana')));
});

test('escopo user-private sem userId é recusado', async () => {
  const cache = createSemanticCache(createMemoryStore().store);

  await assert.rejects(cache.probe('pergunta', privateOf('')), /exige um userId/);
});

test('namespaces não se enxergam', async () => {
  const { store } = createMemoryStore();

  await (await createSemanticCache(store, { namespace: 'producao' }).probe('pergunta repetida', GLOBAL)).save('r');
  const other = await createSemanticCache(store, { namespace: 'homologacao' }).probe('pergunta repetida', GLOBAL);

  assert.equal(other.hit, undefined);
});

test('entrada corrompida no Redis é ignorada, sem derrubar a consulta', async () => {
  const { store, data } = createMemoryStore();
  const cache = createSemanticCache(store);

  await (await cache.probe('pergunta válida', GLOBAL)).save('resposta');
  const [validKey = ''] = data.keys();
  const prefix = validKey.slice(0, validKey.lastIndexOf(':') + 1);
  data.set(`${prefix}lixo-1`, 'isto não é json');
  data.set(`${prefix}lixo-2`, JSON.stringify({ query: 'x', answer: 42 }));

  const result = await cache.probe('pergunta válida', GLOBAL);

  assert.equal(result.hit?.answer, 'resposta');
});
