import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logger } from '@labs/shared-observability';
import { type CacheStore, createSemanticCache } from './semantic-cache.js';

// O embedding vem do provedor mock (determinístico): o teste não usa rede nem Redis.
process.env.LLM_PROVIDERS = 'mock';
logger.level = 'silent';

/** Um Map com a interface do Redis que o cache usa. */
function memoryStore() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const store: CacheStore = {
    async set(key, value, options) {
      data.set(key, value);
      ttls.set(key, options.expiration.value);
    },
    async mGet(keys) {
      return keys.map((key) => data.get(key) ?? null);
    },
    async *scanIterator({ MATCH }) {
      const prefix = MATCH.slice(0, -1); // o padrão é sempre "<prefixo>*"
      yield [...data.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  return { store, data, ttls };
}

/** Uma função de cálculo que conta quantas vezes foi chamada. */
function counter(answer: string) {
  const state = { calls: 0 };
  return {
    state,
    compute: async () => {
      state.calls++;
      return answer;
    },
  };
}

test('a primeira consulta calcula e guarda; a segunda, igual, vem do cache', async () => {
  const { store, ttls } = memoryStore();
  const cache = createSemanticCache(store, { ttlSeconds: 120 });
  const { compute, state } = counter('Timeout no gateway de pagamento.');

  const first = await cache.getOrCompute('O que significa o erro ERR-4012?', compute);
  const second = await cache.getOrCompute('O que significa o erro ERR-4012?', compute);

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.answer, 'Timeout no gateway de pagamento.');
  assert.ok(second.similarity > 0.999);
  assert.equal(state.calls, 1);
  assert.deepEqual([...ttls.values()], [120]);
});

test('pergunta com as mesmas palavras em outra ordem acerta; pergunta sobre outro assunto, não', async () => {
  const { store } = memoryStore();
  const cache = createSemanticCache(store, { threshold: 0.9 });
  const { compute, state } = counter('resposta');

  await cache.getOrCompute('qual o limite de requisições do plano Pro', compute);
  const reordered = await cache.getOrCompute('do plano Pro, qual o limite de requisições', compute);
  const unrelated = await cache.getOrCompute('como funciona o plantão de incidentes', compute);

  assert.equal(reordered.cacheHit, true);
  assert.equal(unrelated.cacheHit, false);
  assert.ok(unrelated.similarity < 0.9);
  assert.equal(state.calls, 2);
});

test('o limiar decide: com limiar inalcançável, nem a pergunta idêntica acerta', async () => {
  const { store } = memoryStore();
  const cache = createSemanticCache(store, { threshold: 1.01 });
  const { compute, state } = counter('resposta');

  await cache.getOrCompute('pergunta repetida', compute);
  const again = await cache.getOrCompute('pergunta repetida', compute);

  assert.equal(again.cacheHit, false);
  assert.equal(state.calls, 2);
});

test('namespaces não se enxergam', async () => {
  const { store } = memoryStore();
  const { compute, state } = counter('resposta do cliente A');

  await createSemanticCache(store, { namespace: 'cliente-a' }).getOrCompute('qual é o meu saldo', compute);
  const other = await createSemanticCache(store, { namespace: 'cliente-b' }).getOrCompute(
    'qual é o meu saldo',
    compute,
  );

  assert.equal(other.cacheHit, false);
  assert.equal(state.calls, 2);
});

test('entrada corrompida no Redis é ignorada, sem derrubar a consulta', async () => {
  const { store, data } = memoryStore();
  const cache = createSemanticCache(store);
  const { compute } = counter('resposta');

  await cache.getOrCompute('pergunta válida', compute);
  const [validKey = ''] = data.keys();
  const prefix = validKey.slice(0, validKey.lastIndexOf(':') + 1);
  data.set(`${prefix}lixo-1`, 'isto não é json');
  data.set(`${prefix}lixo-2`, JSON.stringify({ query: 'x', answer: 42 }));

  const result = await cache.getOrCompute('pergunta válida', compute);

  assert.equal(result.cacheHit, true);
});
