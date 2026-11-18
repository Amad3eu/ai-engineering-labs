-- Roda uma única vez, quando o volume do Postgres é criado (docker-entrypoint-initdb.d).
-- Mudou este arquivo? Recrie o volume: docker compose down -v && docker compose up -d

CREATE EXTENSION IF NOT EXISTS vector;

-- Um documento é a unidade que entra na indexação: um arquivo, uma página, um ticket.
CREATE TABLE IF NOT EXISTS documents (
  id         BIGSERIAL PRIMARY KEY,
  source     TEXT        NOT NULL UNIQUE,
  metadata   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um chunk é o trecho que a busca devolve. Cada um carrega os dois índices da busca híbrida.
CREATE TABLE IF NOT EXISTS chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  chunk_index     INT    NOT NULL,
  content         TEXT   NOT NULL,

  -- 1536 = text-embedding-3-small. Tem que bater com EMBEDDING_DIMENSIONS em
  -- packages/shared-vector/src/index.ts. Vetor menor é completado com zeros na aplicação.
  embedding       vector(1536) NOT NULL,

  -- Vetores de modelos diferentes não são comparáveis: a busca filtra por esta coluna.
  embedding_model TEXT   NOT NULL,

  -- Mantida pelo banco: a aplicação nunca esquece de atualizar o índice lexical.
  -- O idioma tem que bater com o usado nas consultas em packages/shared-vector.
  content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,

  UNIQUE (document_id, chunk_index)
);

-- Busca semântica: vizinhos aproximados por distância de cosseno.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Busca lexical: full-text search.
CREATE INDEX IF NOT EXISTS chunks_content_tsv_gin
  ON chunks USING gin (content_tsv);
