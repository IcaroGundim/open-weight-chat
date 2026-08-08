PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  title TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  system_prompt TEXT,
  effort TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  science_level TEXT,
  science_format TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT,
  provider_id TEXT,
  model_id TEXT,
  prompt_tokens INTEGER,
  cached_tokens INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  cost_estimated INTEGER NOT NULL DEFAULT 0 CHECK (cost_estimated IN (0, 1)),
  finish_reason TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  latency_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'code', 'svg', 'mermaid', 'mindmap', 'chart')),
  language TEXT,
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, slug)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'rewrite', 'update')),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  output_tokens INTEGER,
  cost_usd REAL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_versions_fts USING fts5(
  content,
  content='artifact_versions',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS artifact_versions_ai AFTER INSERT ON artifact_versions BEGIN
  INSERT INTO artifact_versions_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS artifact_versions_ad AFTER DELETE ON artifact_versions BEGIN
  INSERT INTO artifact_versions_fts(artifact_versions_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS artifact_versions_au AFTER UPDATE OF content ON artifact_versions BEGIN
  INSERT INTO artifact_versions_fts(artifact_versions_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO artifact_versions_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Provedores cadastrados pela interface. A chave de API vai em api_key_cipher,
-- cifrada com AES-256-GCM (src/server/secrets.ts) — nunca em texto puro, e
-- nunca devolvida ao navegador. A chave primária é composta (user_id, id):
-- cada usuário tem o próprio catálogo de provedores BYOK.
CREATE TABLE IF NOT EXISTS provider_settings (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL,
  verified_at TEXT,
  api_key_cipher TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- Configuração de busca na web, uma linha por usuário. Tabela própria, e não
-- uma linha reservada em provider_settings, para que o buscador nunca entre no
-- caminho de resolveProvider nem no catálogo de modelos (ver migração 005).
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

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'document', 'spreadsheet')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  -- Base64 dos bytes originais; preenchido só em imagem.
  data_base64 TEXT,
  -- Texto para o prompt; preenchido só em documento.
  extracted_text TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at INTEGER NOT NULL
);

-- Consulta quente: os anexos de uma mensagem ao montar a conversa.
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
-- Varredura de órfãos: por dono e idade, sem mensagem.
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at);

CREATE TABLE IF NOT EXISTS spreadsheet_versions (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  workbook_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, version)
);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_attachment
  ON spreadsheet_versions(attachment_id, version DESC);
