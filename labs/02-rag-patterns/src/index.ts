// Lab 02: Padrões de RAG
//
//   1. Indexa um corpus pequeno no Postgres (pgvector + full-text search).
//   2. Benchmark de recuperação: Basic RAG (só vetorial) contra Hybrid Search (RRF explícito).
//   3. Pipeline completo, em uma bateria de 6 perguntas:
//        cache semântico (por escopo) → roteamento por intenção → modelo barato
//                                                               → Agentic RAG com relevance grader
//
// Precisa da infra local: docker compose up -d
// Rodar: pnpm --filter @labs/02-rag-patterns dev

import { activeProviders } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import { closePool, getPool } from '@labs/shared-vector';
import { createClient } from 'redis';
import { ingestCorpus, runPipelineBenchmark, runRetrievalBenchmark } from './benchmark.js';
import { PIPELINE_BATTERY } from './corpus.js';
import { installMockScript } from './mock.js';
import { createPipeline } from './pipeline.js';
import { hybridRetrieve } from './rag.js';
import { createSemanticCache } from './semantic-cache.js';

installMockScript(); // só tem efeito sem chave de API; veja mock.ts

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
  console.log('1. Recuperação: Basic RAG × Hybrid Search (RRF)');
  console.table(await runRetrievalBenchmark());

  // Namespace novo a cada execução: a bateria começa sempre com o cache vazio. As entradas
  // antigas somem sozinhas pelo TTL.
  // PONTO DE EXTENSÃO: mexa no `threshold` e veja a pergunta 2 trocar de caminho.
  const cache = createSemanticCache(redis, { namespace: `bench-${Date.now()}`, ttlSeconds: 600, threshold: 0.95 });
  const answer = createPipeline({ cache, retrieve: hybridRetrieve });

  console.log('\n2. Pipeline: cache → intenção → modelo barato ou Agentic RAG');
  for (const [index, testCase] of PIPELINE_BATTERY.entries()) {
    console.log(`   ${index + 1}. [${testCase.userId} · ${testCase.scope}] ${testCase.question}`);
    console.log(`      ${testCase.exercises}`);
  }
  // A tabela usa o número da pergunta como índice, para casar com a lista acima.
  const rows = await runPipelineBenchmark(answer);
  console.table(Object.fromEntries(rows.map((row, index) => [index + 1, row])));

  if (activeProviders().includes('mock')) {
    console.log(
      'Modo mock: o embedding é um hash de palavras e o roteador e o grader são regras de palavra-chave. ' +
        'A tabela mostra o fluxo de decisão; latência, custo e acertos de paráfrase só valem com um provedor real.',
    );
  }
} finally {
  await redis.close();
  await closePool();
}
