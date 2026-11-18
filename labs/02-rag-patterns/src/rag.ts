import { generateText } from '@labs/shared-llm';
import { timed } from '@labs/shared-observability';
import { hybridSearch, type SearchHit, vectorSearch } from '@labs/shared-vector';
import { RAG_SYSTEM, ragPrompt } from './prompts.js';

// As duas estratégias diferem só na recuperação. A geração é a mesma: assim o benchmark
// mede o efeito da busca, e não de um prompt diferente.
//
//   basic   busca vetorial: os chunks mais próximos por distância de cosseno
//   hybrid  vetorial + lexical, fundidas por Reciprocal Rank Fusion
//
// PONTO DE EXTENSÃO: uma estratégia nova (reranker, expansão de consulta, HyDE) é uma
// função `(pergunta, k) => SearchHit[]` a mais neste registro.
export type Strategy = 'basic' | 'hybrid';

const RETRIEVERS: Record<Strategy, (question: string, k: number) => Promise<SearchHit[]>> = {
  basic: vectorSearch,
  hybrid: hybridSearch,
};

export interface RagAnswer {
  answer: string;
  hits: SearchHit[];
  retrievalMs: number;
}

export async function answerWithRag(question: string, strategy: Strategy, k = 3): Promise<RagAnswer> {
  const { value: hits, latencyMs: retrievalMs } = await timed(() => RETRIEVERS[strategy](question, k));

  // Faixa fixa em `fast`: o roteador automático escolheria pelo tamanho do prompt, e um
  // prompt de RAG é sempre longo por causa do contexto, não por ser difícil.
  const { text } = await generateText({
    system: RAG_SYSTEM,
    prompt: ragPrompt(question, hits),
    tier: 'fast',
    label: `rag:${strategy}`,
  });
  return { answer: text, hits, retrievalMs };
}
