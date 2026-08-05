-- Migração 001 — schema base (Postgres / Neon).
--
-- Cópia fiel do SCHEMA embutido em src/server/db/neon.ts, com duas
-- diferenças intencionais:
--   1. Sem idx_conversations_user: em bancos legados (pré-multiusuário) a
--      coluna user_id não existe e o CREATE INDEX falharia; a coluna e o
--      índice são criados na migração 002.
--   2. Tudo aqui é idempotente (IF NOT EXISTS / ON CONFLICT nunca), então a
--      migração roda sem efeito sobre bancos que já têm o schema antigo.
--
-- Bancos novos: a 001 cria tudo e a 002 apenas confirma o que já existe.
-- Bancos legados (Neon de produção): a 001 só cria o que falta (users) e a
-- 002 transforma o schema antigo no novo (user_id, PK composta, dono, v2).

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, created_at bigint NOT NULL, updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY, user_id text NOT NULL DEFAULT '', title text, provider_id text NOT NULL, model_id text NOT NULL,
  system_prompt text, created_at bigint NOT NULL, updated_at bigint NOT NULL,
  archived boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('system','user','assistant')), content text NOT NULL DEFAULT '',
  reasoning text, provider_id text, model_id text, prompt_tokens integer, cached_tokens integer,
  completion_tokens integer, reasoning_tokens integer, total_tokens integer, cost_usd double precision,
  cost_estimated boolean NOT NULL DEFAULT false, finish_reason text, error_code text,
  created_at bigint NOT NULL, latency_ms integer
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  slug text NOT NULL, kind text NOT NULL CHECK (kind IN ('markdown','code','svg','mermaid')),
  language text, title text NOT NULL, current_version integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL, updated_at bigint NOT NULL, UNIQUE (conversation_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, version integer NOT NULL,
  content text NOT NULL, operation text NOT NULL CHECK (operation IN ('create','rewrite','update')),
  message_id text REFERENCES messages(id) ON DELETE SET NULL, output_tokens integer,
  cost_usd double precision, truncated boolean NOT NULL DEFAULT false, created_at bigint NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

-- Provedores cadastrados pela interface. A chave de API vai em api_key_cipher,
-- cifrada com AES-256-GCM (src/server/secrets.ts) — nunca em texto puro. A
-- chave primária é composta (user_id, id): cada usuário tem o próprio
-- catálogo de provedores BYOK.
CREATE TABLE IF NOT EXISTS provider_settings (
  id text NOT NULL, user_id text NOT NULL DEFAULT '', label text NOT NULL, base_url text NOT NULL,
  models_json jsonb NOT NULL DEFAULT '[]'::jsonb, verified_at text, api_key_cipher text,
  created_at bigint NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (user_id, id)
);
