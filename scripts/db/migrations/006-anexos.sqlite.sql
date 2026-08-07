-- Migração 006 — anexos de mensagem (SQLite).
--
-- Uma linha por arquivo enviado. Duas naturezas convivem na mesma tabela
-- porque compartilham dono, ciclo de vida e limites: `image` guarda os bytes
-- (o modelo recebe a imagem e a interface a exibe) e `document` guarda apenas
-- o texto extraído — o PDF original não volta para lugar nenhum, e mantê-lo
-- dobraria o armazenamento sem uso.
--
-- `conversation_id` e `message_id` são NULOS até o envio: o arquivo sobe antes
-- de a mensagem existir, e numa conversa nova nem a conversa existe ainda. É o
-- que permite anexar, revisar e remover antes de mandar. A limpeza dos órfãos
-- (anexos que subiram e nunca foram enviados) é por idade, em
-- `deleteOrphanAttachments`.
--
-- ON DELETE CASCADE na conversa: apagar uma conversa apaga os anexos dela, do
-- mesmo jeito que já apaga mensagens e artefatos. Sem isso ficariam bytes
-- pagos e inalcançáveis no banco.

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'document')),
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
