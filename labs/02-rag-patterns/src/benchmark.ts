import { resetLlmMetrics, summarizeLlmCalls, timed } from '@labs/shared-observability';
import { ingestDocument } from '@labs/shared-vector';
import { CORPUS, QUESTIONS } from './corpus.js';
import { answerWithRag, type Strategy } from './rag.js';
import type { SemanticCache } from './semantic-cache.js';

const TOP_K = 3;

/** Indexa o corpus. Reindexar substitui os chunks antigos, então rodar de novo não duplica. */
export async function ingestCorpus(): Promise<{ documents: number; chunks: number }> {
  let chunks = 0;
  for (const document of CORPUS) {
    // Chunk pequeno porque os documentos são curtos: cada parágrafo vira uma unidade de busca.
    chunks += await ingestDocument(document, { maxChars: 300, overlapChars: 40 });
  }
  return { documents: CORPUS.length, chunks };
}

const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / (values.length || 1);

/**
 * Basic RAG contra Hybrid Search, nas mesmas perguntas.
 * - recall@k: em quantas perguntas o documento certo apareceu entre os k recuperados;
 * - MRR: quão perto do topo ele apareceu (1 = sempre em primeiro).
 * As duas medem a recuperação. A qualidade da resposta escrita não é medida aqui.
 * PONTO DE EXTENSÃO: um juiz (LLM com rubrica) sobre `answer` cobre fidelidade e completude.
 */
export async function runRetrievalBenchmark(strategies: Strategy[] = ['basic', 'hybrid']) {
  const rows = [];

  for (const strategy of strategies) {
    resetLlmMetrics();
    const reciprocalRanks: number[] = [];
    const retrievalMs: number[] = [];
    const totalMs: number[] = [];

    for (const { question, expectedSource } of QUESTIONS) {
      const { value, latencyMs } = await timed(() => answerWithRag(question, strategy, TOP_K));
      const rank = value.hits.findIndex((hit) => hit.source === expectedSource) + 1;
      reciprocalRanks.push(rank > 0 ? 1 / rank : 0);
      retrievalMs.push(value.retrievalMs);
      totalMs.push(latencyMs);
    }

    const usage = summarizeLlmCalls();
    rows.push({
      estratégia: strategy,
      [`recall@${TOP_K}`]: mean(reciprocalRanks.map((value) => (value > 0 ? 1 : 0))).toFixed(2),
      MRR: mean(reciprocalRanks).toFixed(2),
      'busca (ms)': Math.round(mean(retrievalMs)),
      'total por pergunta (ms)': Math.round(mean(totalMs)),
      'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
      'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
    });
  }
  return rows;
}

/**
 * Efeito do cache semântico, em três passadas:
 *   1ª  cache vazio: tudo é calculado e guardado;
 *   2ª  as mesmas perguntas: tudo deveria vir do cache;
 *   3ª  as perguntas com outras palavras: aqui aparece o limiar de similaridade.
 */
export async function runCacheBenchmark(cache: SemanticCache) {
  const passes: Array<[string, string[]]> = [
    ['1ª: cache vazio', QUESTIONS.map((q) => q.question)],
    ['2ª: mesmas perguntas', QUESTIONS.map((q) => q.question)],
    ['3ª: paráfrases', QUESTIONS.map((q) => q.paraphrase)],
  ];
  const rows = [];

  for (const [name, questions] of passes) {
    resetLlmMetrics();
    const latencies: number[] = [];
    const similarities: number[] = [];
    let hits = 0;

    for (const question of questions) {
      const { value, latencyMs } = await timed(() =>
        cache.getOrCompute(question, async () => (await answerWithRag(question, 'hybrid', TOP_K)).answer),
      );
      latencies.push(latencyMs);
      similarities.push(value.similarity);
      if (value.cacheHit) hits++;
    }

    const usage = summarizeLlmCalls();
    rows.push({
      passada: name,
      'cache hits': `${hits}/${questions.length}`,
      'similaridade média': mean(similarities).toFixed(2),
      'latência média (ms)': Math.round(mean(latencies)),
      'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
      'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
    });
  }
  return rows;
}
