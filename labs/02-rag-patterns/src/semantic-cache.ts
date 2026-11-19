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

/**
 * De quem é uma resposta guardada, e quem pode recebê-la de volta.
 *
 * - `global`: montada só com informação que todos podem ver. Serve a qualquer usuário.
 * - `user-private`: montada dentro de uma conversa privada. Só volta para o mesmo usuário.
 *
 * Um cache sem escopo é um vazamento esperando acontecer: a resposta escrita com os dados
 * de uma pessoa seria servida à próxima que fizesse uma pergunta parecida.
 */
export type CacheScope = { kind: 'global' } | { kind: 'user-private'; userId: string };

export interface SemanticCacheOptions {
  /**
   * Similaridade de cosseno mínima para considerar "a mesma pergunta". Padrão: 0,95.
   * É o botão do trade-off: baixo demais devolve a resposta de outra pergunta, que é um
   * erro silencioso; alto demais quase não acerta. O valor certo depende do modelo de
   * embedding: calibre com perguntas reais antes de mexer.
   */
  threshold?: number;
  /** Validade de cada entrada. Resposta guardada envelhece junto com os documentos. */
  ttlSeconds?: number;
  /** Separa instalações que dividem o mesmo Redis (ambiente, aplicação, execução de benchmark). */
  namespace?: string;
}

export interface CacheProbe {
  /** Preenchido quando existe uma resposta guardada, visível neste escopo, acima do limiar. */
  hit?: { answer: string; scope: CacheScope['kind'] };
  /** Similaridade com a entrada visível mais próxima (0 quando não há nenhuma). */
  similarity: number;
  /**
   * Guarda a resposta calculada, no escopo da consulta. Reaproveita o embedding já pago na
   * consulta. Quem chama decide se guarda: resposta de fallback, por exemplo, não deve entrar.
   */
  save(answer: string): Promise<void>;
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Onde uma consulta grava e de onde ela pode ler.
 *
 *   consulta global         grava em global         lê só global
 *   consulta user-private   grava no próprio usuário  lê o próprio usuário e global
 *
 * Ler global de dentro de uma conversa privada não vaza nada. O contrário vazaria: uma
 * consulta global nunca enxerga entrada privada, nem do próprio usuário, porque a resposta
 * pode ir para uma tela que outras pessoas veem.
 *
 * O id do usuário entra na chave como hash. Ele é o único pedaço da chave que vem de fora,
 * e o SCAN usa padrão glob: um id "*" cru faria a busca casar com as entradas de todos.
 */
function scopePrefixes(namespace: string, model: string, scope: CacheScope) {
  const global = { kind: 'global' as const, prefix: `semcache:${namespace}:global:${model}:` };
  if (scope.kind === 'global') return { write: global, read: [global] };

  if (!scope.userId) {
    // Sem dono, todas as conversas "privadas" cairiam no mesmo balde e se enxergariam.
    throw new Error('Cache semântico: o escopo user-private exige um userId.');
  }
  const own = {
    kind: 'user-private' as const,
    prefix: `semcache:${namespace}:user:${sha256(scope.userId)}:${model}:`,
  };
  return { write: own, read: [own, global] };
}

export function createSemanticCache(store: CacheStore, options: SemanticCacheOptions = {}) {
  const { threshold = 0.95, ttlSeconds = 3600, namespace = 'default' } = options;

  return {
    /**
     * Procura uma resposta guardada para uma pergunta equivalente, dentro do que o escopo
     * permite ler. Devolve também o `save` para gravar a resposta nova quando não houver acerto.
     */
    async probe(query: string, scope: CacheScope): Promise<CacheProbe> {
      const start = performance.now();
      // Custo fixo do cache: toda consulta paga um embedding, acerte ou não.
      const { vectors, model } = await embed([query], { label: 'cache:embedding' });
      const [vector] = vectors;
      if (!vector) throw new Error('O provedor não devolveu embedding para a consulta.');

      // O modelo de embedding entra na chave: vetores de modelos diferentes não se comparam,
      // então trocar de modelo começa um cache novo em vez de devolver acerto falso.
      const { read, write } = scopePrefixes(namespace, model, scope);

      // shortcut: varredura linear, lê todas as entradas visíveis a cada consulta. Serve até
      // alguns milhares. Acima disso, troque por um índice vetorial: vector sets do Redis 8,
      // RediSearch, ou uma tabela com pgvector (com o escopo como filtro).
      let best: { answer: string; similarity: number; scope: CacheScope['kind'] } | undefined;
      for (const { kind, prefix } of read) {
        for await (const keys of store.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
          if (keys.length === 0) continue;
          for (const raw of await store.mGet(keys)) {
            const entry = parseEntry(raw);
            if (!entry) continue;
            const similarity = cosine(vector, entry.embedding);
            if (similarity > (best?.similarity ?? -1)) best = { answer: entry.answer, similarity, scope: kind };
          }
        }
      }

      const save = async (answer: string) => {
        await store.set(write.prefix + sha256(query), JSON.stringify({ query, answer, embedding: vector }), {
          expiration: { type: 'EX', value: ttlSeconds },
        });
      };

      if (!best || best.similarity < threshold) return { similarity: best?.similarity ?? 0, save };

      // Um acerto não passa por @labs/shared-llm, então é registrado aqui: é esta linha
      // que aparece com [CACHE_HIT] true.
      logLlmCall({
        model: 'semantic-cache',
        provider: 'redis',
        label: `cache:hit:${best.scope}`,
        latencyMs: performance.now() - start,
        tokensIn: 0,
        tokensOut: 0,
        estimatedCostUsd: 0,
        cacheHit: true,
      });
      return { hit: { answer: best.answer, scope: best.scope }, similarity: best.similarity, save };
    },
  };
}

export type SemanticCache = ReturnType<typeof createSemanticCache>;
