import { embed } from '@labs/shared-llm';
import { logger } from '@labs/shared-observability';
import pg from 'pg';
import { type ChunkOptions, chunkText } from './chunking.js';

export { type ChunkOptions, chunkText } from './chunking.js';

/** Tem que bater com `vector(1536)` em infra/init.sql. */
export const EMBEDDING_DIMENSIONS = 1536;

// A busca lexical é a full-text search do Postgres: `ts_rank_cd` sobre um índice GIN.
// Faz o papel do BM25 na busca híbrida (acha o termo exato que o embedding dilui), mas
// não é BM25 de verdade: não satura a frequência do termo nem normaliza pelo tamanho do
// documento. PONTO DE EXTENSÃO: para BM25 real, troque por uma extensão como pg_search.
//
// `plainto_tsquery` junta os termos com E, e uma pergunta em linguagem natural quase nunca
// tem todas as palavras no mesmo chunk. Trocar o E por OU deixa o ranking decidir.
// O idioma ('portuguese') tem que bater com a coluna gerada `content_tsv` em infra/init.sql.
const OR_TSQUERY = `replace(plainto_tsquery('portuguese', $1)::text, '&', '|')::tsquery`;

export interface SearchHit {
  id: number;
  source: string;
  content: string;
  /** Não é comparável entre estratégias: similaridade de cosseno, ts_rank ou soma de RRF. */
  score: number;
}

export interface HybridOptions {
  /** Quantos candidatos cada busca traz antes da fusão. Padrão: 20. */
  candidates?: number;
  /** Constante do RRF: quanto maior, menos peso para o topo de cada lista. Padrão: 60. */
  rrfK?: number;
}

let pool: pg.Pool | undefined;

/** Pool único do processo, criado no primeiro uso a partir de DATABASE_URL. */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL não definida. Copie .env.example para .env e suba a infra: docker compose up -d');
    }
    pool = new pg.Pool({ connectionString });
    // Uma conexão ociosa que cai emite 'error' no pool; sem ouvinte, isso derruba o processo.
    pool.on('error', (error) => logger.warn(`[PG] conexão ociosa perdida: ${error.message}`));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** pgvector recebe o vetor como texto: '[0.1,0.2,…]'. */
function toVectorLiteral(vector: number[]): string {
  if (vector.length > EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding com ${vector.length} dimensões não cabe em vector(${EMBEDDING_DIMENSIONS}). ` +
        'Ajuste a coluna em infra/init.sql ou use um modelo que aceite reduzir as dimensões.',
    );
  }
  // Completar com zeros não muda a distância de cosseno: um modelo menor (768 dimensões,
  // comum no Ollama) cabe na mesma coluna sem recriar a tabela.
  const padding = new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0);
  return `[${[...vector, ...padding].join(',')}]`;
}

async function embedForStorage(texts: string[], label: string): Promise<{ vectors: string[]; model: string }> {
  const { vectors, model } = await embed(texts, { dimensions: EMBEDDING_DIMENSIONS, label });
  return { vectors: vectors.map(toVectorLiteral), model };
}

async function embedQuery(query: string): Promise<{ vector: string; model: string }> {
  const { vectors, model } = await embedForStorage([query], 'search:embedding');
  const [vector] = vectors;
  if (!vector) throw new Error('O provedor não devolveu embedding para a consulta.');
  return { vector, model };
}

/**
 * Indexa um documento: divide em chunks, gera os embeddings e grava tudo numa transação.
 * Reindexar a mesma `source` substitui os chunks antigos. Devolve o número de chunks.
 */
export async function ingestDocument(
  document: { source: string; text: string; metadata?: Record<string, unknown> },
  options?: ChunkOptions,
): Promise<number> {
  const chunks = chunkText(document.text, options);
  if (chunks.length === 0) return 0;
  const { vectors, model } = await embedForStorage(chunks, 'ingest:embedding');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (source, metadata) VALUES ($1, $2)
       ON CONFLICT (source) DO UPDATE SET metadata = EXCLUDED.metadata
       RETURNING id`,
      [document.source, document.metadata ?? {}],
    );
    const documentId = rows[0]?.id;
    if (!documentId) throw new Error(`Não foi possível gravar o documento "${document.source}".`);

    await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);
    await client.query(
      `INSERT INTO chunks (document_id, chunk_index, content, embedding, embedding_model)
       SELECT $1, t.position - 1, t.content, t.embedding::vector, $4
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(content, embedding, position)`,
      [documentId, chunks, vectors, model],
    );
    await client.query('COMMIT');
    return chunks.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Busca semântica: os `k` chunks mais próximos da consulta por distância de cosseno. */
export async function vectorSearch(query: string, k = 5): Promise<SearchHit[]> {
  const { vector, model } = await embedQuery(query);
  // O filtro por modelo impede comparar a consulta com vetores gerados por outro modelo,
  // o que acontece ao trocar de provedor sem reindexar: a busca devolveria ruído, sem erro.
  const { rows } = await getPool().query<SearchHit>(
    `SELECT c.id::int AS id, d.source, c.content, 1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.embedding_model = $2
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [vector, model, k],
  );
  return rows;
}

/** Busca lexical: os `k` chunks com mais termos da consulta, pelo ranking da full-text search. */
export async function keywordSearch(query: string, k = 5): Promise<SearchHit[]> {
  const { rows } = await getPool().query<SearchHit>(
    `WITH q AS (SELECT ${OR_TSQUERY} AS tsq)
     SELECT c.id::int AS id, d.source, c.content, ts_rank_cd(c.content_tsv, q.tsq)::float8 AS score
     FROM q, chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.content_tsv @@ q.tsq
     ORDER BY score DESC
     LIMIT $2`,
    [query, k],
  );
  return rows;
}

/**
 * Busca híbrida: roda a semântica e a lexical e funde as duas listas por Reciprocal Rank
 * Fusion. O RRF soma 1 / (k + posição) de cada lista, então não depende das escalas dos
 * scores, que não são comparáveis entre si.
 */
export async function hybridSearch(query: string, k = 5, options: HybridOptions = {}): Promise<SearchHit[]> {
  const { vector, model } = await embedQuery(query);
  const { rows } = await getPool().query<SearchHit>(
    `WITH q AS (SELECT ${OR_TSQUERY} AS tsq),
     semantic AS (
       SELECT c.id, RANK() OVER (ORDER BY c.embedding <=> $2::vector) AS rank
       FROM chunks c
       WHERE c.embedding_model = $3
       ORDER BY c.embedding <=> $2::vector
       LIMIT $4
     ),
     keyword AS (
       SELECT c.id, RANK() OVER (ORDER BY ts_rank_cd(c.content_tsv, q.tsq) DESC) AS rank
       FROM q, chunks c
       WHERE c.content_tsv @@ q.tsq
       ORDER BY ts_rank_cd(c.content_tsv, q.tsq) DESC
       LIMIT $4
     )
     SELECT c.id::int AS id, d.source, c.content,
            (COALESCE(1.0 / ($5::int + s.rank), 0) + COALESCE(1.0 / ($5::int + kw.rank), 0))::float8 AS score
     FROM semantic s
     FULL OUTER JOIN keyword kw ON kw.id = s.id
     JOIN chunks c ON c.id = COALESCE(s.id, kw.id)
     JOIN documents d ON d.id = c.document_id
     ORDER BY score DESC
     LIMIT $6`,
    [query, vector, model, options.candidates ?? 20, options.rrfK ?? 60, k],
  );
  return rows;
}
