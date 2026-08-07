-- Migração 005 — configuração de busca na web por usuário (SQLite).
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
  user_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  base_url TEXT,
  api_key_cipher TEXT,
  max_results INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);
