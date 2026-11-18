import { resetLlmMetrics, summarizeLlmCalls, timed } from '@labs/shared-observability';
import { ingestDocument } from '@labs/shared-vector';
import { CORPUS, PIPELINE_BATTERY, QUESTIONS } from './corpus.js';
import type { Pipeline, PipelineAnswer } from './pipeline.js';
import { answerWithRag, type Strategy } from './rag.js';

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

/** O que decidiu o caminho de uma resposta, em poucas palavras, para a coluna "decisão". */
function describeDecision(result: PipelineAnswer): string {
  if (result.source === 'cache') return `similaridade ${result.cacheSimilarity.toFixed(2)}`;
  if (result.source === 'fast-tier') return `intenção ${result.intent}`;
  const { relevant = 0, retrieved = 0 } = result.retrieval ?? {};
  return `${relevant}/${retrieved} chunks aprovados${result.fallback ? ': aviso fixo' : ''}`;
}

/**
 * A bateria do pipeline: seis perguntas, cada uma mirando uma decisão (veja corpus.ts).
 * Para cada uma: por onde a resposta saiu, quanto demorou e quanto custou. Latência, tokens
 * e custo vêm do acumulado de @labs/shared-observability, zerado antes de cada pergunta.
 * As linhas saem na ordem da bateria.
 */
export async function runPipelineBenchmark(answer: Pipeline) {
  const rows = [];

  for (const testCase of PIPELINE_BATTERY) {
    resetLlmMetrics();
    const { value: result, latencyMs } = await timed(() => answer(testCase));
    const usage = summarizeLlmCalls();

    rows.push({
      fonte: result.source,
      // Quando a fonte não é a esperada, a linha mostra as duas. Com modelo real isso
      // acontece, e é um resultado: o limiar ou o roteador precisam de ajuste.
      esperada: result.source === testCase.expectedSource ? 'ok' : `≠ ${testCase.expectedSource}`,
      decisão: describeDecision(result),
      modelo: result.model ?? '—',
      'latência (ms)': Math.round(latencyMs),
      'tokens in/out': `${usage.tokensIn}/${usage.tokensOut}`,
      'custo estimado (USD)': usage.estimatedCostUsd.toFixed(6),
    });
  }
  return rows;
}
