-- Migração 005 — configuração de busca na web por usuário (Postgres / Neon).
--
-- Uma linha por usuário: qual buscador, a URL (só o SearXNG usa), a chave
-- cifrada e quantos resultados pedir.
--
-- Tabela própria, e não uma linha reservada em `provider_settings`, embora
-- aquela tabela já tenha id livre e chave cifrada. O motivo é de isolamento:
-- `provider_settings` alimenta `resolveProvider` e o catálogo de modelos, e
-- uma linha de busca ali passaria a depender de um filtro por id em cada
-- consumidor. Esquecer o filtro em um só ponto faria um buscador aparecer
-- como provedor de chat — e o custo de evitar isso é uma tabela.
--
-- `enabled` existe separado da presença da chave porque desligar a busca por
-- um tempo não deve obrigar o usuário a apagar e recadastrar a chave.

CREATE TABLE IF NOT EXISTS search_settings (
  user_id text NOT NULL,
  backend text NOT NULL,
  base_url text,
  api_key_cipher text,
  max_results integer NOT NULL DEFAULT 5,
  enabled boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (user_id)
);
