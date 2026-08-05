-- Migração 003 — tabelas de rate limit por usuário (Postgres / Neon).
--
-- Contadores de janela fixa de 60s e slots de stream ativo, compartilhados
-- entre instâncias (ver src/server/rate-limit.ts). O schema fica versionado
-- aqui e é aplicado com pnpm db:migrate antes do deploy.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket text NOT NULL,
  user_id text NOT NULL,
  count integer NOT NULL,
  window_start bigint NOT NULL,
  PRIMARY KEY (bucket, user_id, window_start)
);

CREATE TABLE IF NOT EXISTS rate_limit_streams (
  id text NOT NULL,
  user_id text NOT NULL,
  started_at bigint NOT NULL,
  last_active bigint NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_streams_user ON rate_limit_streams(user_id, started_at);
