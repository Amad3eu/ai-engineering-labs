// Lab 02: Padrões de RAG
//
//   1. Indexa um corpus pequeno no Postgres (pgvector + full-text search).
//   2. Benchmark: Basic RAG (só vetorial) contra Hybrid Search (vetorial + lexical, RRF).
//   3. Cache semântico no Redis: quanto custo e latência ele tira das perguntas repetidas.
//
// Precisa da infra local: docker compose up -d
// Rodar: pnpm --filter @labs/02-rag-patterns dev

import { activeProviders } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import { closePool, getPool } from '@labs/shared-vector';
import { createClient } from 'redis';
import { ingestCorpus, runCacheBenchmark, runRetrievalBenchmark } from './benchmark.js';
import { createSemanticCache } from './semantic-cache.js';

const redis = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // Sem isto o cliente fica tentando reconectar para sempre e o laboratório trava em vez de avisar.
  socket: { reconnectStrategy: false, connectTimeout: 3000 },
});
// Evento 'error' sem ouvinte derruba o processo. O erro de conexão é tratado logo abaixo.
redis.on('error', (error: Error) => logger.debug(`[REDIS] ${error.message}`));

try {
  await getPool().query('SELECT 1');
  await redis.connect();
} catch (error) {
  const cause = error instanceof AggregateError ? error.errors.map(String).join('; ') : String(error);
  console.error(
    [
      `Infra indisponível: ${cause}`,
      'Este laboratório precisa do Postgres e do Redis locais.',
      '  1. cp .env.example .env    (na raiz, se ainda não existe)',
      '  2. docker compose up -d',
    ].join('\n'),
  );
  process.exit(1);
}

try {
  console.log(`Provedores ativos: ${activeProviders().join(' → ')}`);

  const { documents, chunks } = await ingestCorpus();
  console.log(`Corpus indexado: ${documents} documentos, ${chunks} chunks.\n`);

  // Estes são os números das tabelas "Trade-offs e Métricas Observadas" do README.
  console.log('Basic RAG × Hybrid Search:');
  console.table(await runRetrievalBenchmark());

  // Namespace novo a cada execução: a 1ª passada começa sempre com o cache vazio. As
  // entradas antigas somem sozinhas pelo TTL.
  // PONTO DE EXTENSÃO: mexa no `threshold` e veja a 3ª passada mudar.
  const cache = createSemanticCache(redis, { namespace: `bench-${Date.now()}`, ttlSeconds: 600, threshold: 0.92 });
  console.log('\nCache semântico (sobre o Hybrid Search):');
  console.table(await runCacheBenchmark(cache));

  if (activeProviders().includes('mock')) {
    console.log(
      'Modo mock: o embedding é um hash de palavras, que não entende sinônimo. Recall e acertos de paráfrase só valem com um provedor real.',
    );
  }
} finally {
  await redis.close();
  await closePool();
}
