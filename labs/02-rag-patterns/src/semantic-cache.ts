import { createHash } from 'node:crypto';
import { embed } from '@labs/shared-llm';
import { logLlmCall } from '@labs/shared-observability';
import { z } from 'zod';

// Cache semântico: em vez de comparar o texto da pergunta, compara o embedding. Duas
// perguntas com palavras diferentes e o mesmo sentido caem na mesma resposta guardada,
// e a chamada ao modelo (a parte cara e lenta) não acontece.

/**
 * O subconjunto do cliente Redis que o cache usa. Declarado aqui para o teste poder
 * trocar o Redis por um Map; o cliente do pacote `redis` atende a esta interface.
 */
export interface CacheStore {
  set(key: string, value: string, options: { expiration: { type: 'EX'; value: number } }): Promise<unknown>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string[]>;
}

export interface SemanticCacheOptions {
  /**
   * Similaridade de cosseno mínima para considerar "a mesma pergunta". É o botão do
   * trade-off: baixo demais devolve resposta de outra pergunta; alto demais quase não acerta.
   * O valor certo depende do modelo de embedding: calibre com perguntas reais.
   */
  threshold?: number;
  /** Validade de cada entrada. Resposta guardada envelhece junto com os documentos. */
  ttlSeconds?: number;
  /**
   * Separa caches que não podem se misturar.
   * PONTO DE EXTENSÃO: em sistema multiusuário, coloque aqui o cliente ou o nível de
   * permissão. Sem isso, a resposta montada com documentos de um usuário pode ser servida
   * a outro que não tem acesso a eles.
   */
  namespace?: string;
}

export interface CachedAnswer {
  answer: string;
  cacheHit: boolean;
  /** Similaridade com a entrada mais próxima encontrada (0 quando o cache está vazio). */
  similarity: number;
}

// O conteúdo do Redis também é entrada externa: entrada corrompida é ignorada, não derruba a busca.
const Entry = z.object({ query: z.string(), answer: z.string(), embedding: z.array(z.number()) });

function parseEntry(raw: string | null): z.infer<typeof Entry> | undefined {
  if (!raw) return undefined;
  try {
    return Entry.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

export function createSemanticCache(store: CacheStore, options: SemanticCacheOptions = {}) {
  const { threshold = 0.92, ttlSeconds = 3600, namespace = 'default' } = options;

  return {
    /** Devolve a resposta guardada para uma pergunta equivalente, ou calcula, guarda e devolve. */
    async getOrCompute(query: string, compute: () => Promise<string>): Promise<CachedAnswer> {
      const start = performance.now();
      // Custo fixo do cache: toda consulta paga um embedding, acerte ou não.
      const { vectors, model } = await embed([query], { label: 'cache:embedding' });
      const [vector] = vectors;
      if (!vector) throw new Error('O provedor não devolveu embedding para a consulta.');

      // O modelo de embedding entra na chave: vetores de modelos diferentes não se comparam,
      // então trocar de modelo começa um cache novo em vez de devolver acerto falso.
      const prefix = `semcache:${namespace}:${model}:`;

      // shortcut: varredura linear, lê todas as entradas a cada consulta. Serve até alguns
      // milhares. Acima disso, troque por um índice vetorial: vector sets do Redis 8,
      // RediSearch, ou uma tabela com pgvector.
      let best: { answer: string; similarity: number } | undefined;
      for await (const keys of store.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
        if (keys.length === 0) continue;
        for (const raw of await store.mGet(keys)) {
          const entry = parseEntry(raw);
          if (!entry) continue;
          const similarity = cosine(vector, entry.embedding);
          if (similarity > (best?.similarity ?? -1)) best = { answer: entry.answer, similarity };
        }
      }

      if (best && best.similarity >= threshold) {
        // Um acerto não passa por @labs/shared-llm, então é registrado aqui: é esta linha
        // que aparece com [CACHE_HIT] true.
        logLlmCall({
          model: 'semantic-cache',
          provider: 'redis',
          label: 'cache:hit',
          latencyMs: performance.now() - start,
          tokensIn: 0,
          tokensOut: 0,
          estimatedCostUsd: 0,
          cacheHit: true,
        });
        return { answer: best.answer, cacheHit: true, similarity: best.similarity };
      }

      const answer = await compute();
      const key = prefix + createHash('sha256').update(query).digest('hex');
      await store.set(key, JSON.stringify({ query, answer, embedding: vector }), {
        expiration: { type: 'EX', value: ttlSeconds },
      });
      return { answer, cacheHit: false, similarity: best?.similarity ?? 0 };
    },
  };
}

export type SemanticCache = ReturnType<typeof createSemanticCache>;
