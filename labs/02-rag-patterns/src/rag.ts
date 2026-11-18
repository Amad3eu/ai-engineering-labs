import { generateText } from '@labs/shared-llm';
import { timed } from '@labs/shared-observability';
import { keywordSearch, type SearchHit, vectorSearch } from '@labs/shared-vector';
import { RAG_SYSTEM, ragPrompt } from './prompts.js';
import { reciprocalRankFusion } from './rrf.js';

// As duas estratégias diferem só na recuperação. A geração é a mesma: assim o benchmark
// mede o efeito da busca, e não de um prompt diferente.
//
//   basic   busca vetorial: os chunks mais próximos por distância de cosseno
//   hybrid  vetorial + lexical, fundidas por Reciprocal Rank Fusion (rrf.ts)
//
// PONTO DE EXTENSÃO: uma estratégia nova (reranker, expansão de consulta, HyDE) é uma
// função `(pergunta, k) => SearchHit[]` a mais neste registro.
export type Strategy = 'basic' | 'hybrid';

/** Quantos candidatos cada busca traz para a fusão. Mais que o k final: a fusão precisa de lista para cruzar. */
const FUSION_CANDIDATES = 20;

/**
 * Busca híbrida com a fusão feita aqui, na aplicação: as duas buscas rodam em paralelo e
 * `reciprocalRankFusion` junta as listas.
 *
 * `hybridSearch`, de @labs/shared-vector, faz a mesma fusão dentro do SQL, em uma ida só ao
 * banco. Aqui ela fica explícita de propósito: dá para testar sem banco, para inspecionar
 * a posição de cada chunk em cada lista e para trocar uma das buscas por outra fonte.
 */
export async function hybridRetrieve(question: string, k: number): Promise<SearchHit[]> {
  const [vector, lexical] = await Promise.all([
    vectorSearch(question, FUSION_CANDIDATES),
    keywordSearch(question, FUSION_CANDIDATES),
  ]);
  return reciprocalRankFusion(vector, lexical).slice(0, k);
}

const RETRIEVERS: Record<Strategy, (question: string, k: number) => Promise<SearchHit[]>> = {
  basic: vectorSearch,
  hybrid: hybridRetrieve,
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
