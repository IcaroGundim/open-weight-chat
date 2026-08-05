-- Migração 003 — tabelas de rate limit por usuário (SQLite).
--
-- Contadores de janela fixa de 60s e slots de stream ativo, compartilhados
-- entre instâncias no Postgres (ver src/server/rate-limit.ts — em runtime o
-- store cria com CREATE TABLE IF NOT EXISTS; aqui ficam versionadas para o
-- pnpm db:migrate, idempotente sobre bancos que já as têm).

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (bucket, user_id, window_start)
);

CREATE TABLE IF NOT EXISTS rate_limit_streams (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_streams_user ON rate_limit_streams(user_id, started_at);
