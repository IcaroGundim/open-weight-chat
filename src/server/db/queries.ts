import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  ArtifactKindSchema,
  ErrorCodeSchema,
  MessageRoleSchema,
  ProviderIdSchema,
  type Artifact,
  type ArtifactKind,
  type ArtifactVersion,
  type Conversation,
  type ConversationSummary,
  type Cost,
  type CostAnalyticsResponse,
  type EffortLevel,
  type Message,
  type MessageRole,
  type ProviderId,
  type SkillSelections,
  type Usage,
} from '../../shared/types';
import { parseEffortColumn } from '../effort';
import { SkillSelectionsSchema } from '../../shared/types';

/**
 * Lê a seleção serializada e mantém conversas antigas de Science funcionais.
 * Depois da primeira alteração, a conversa é gravada apenas em `skills_json`.
 */
function parseSkills(value: unknown, legacyLevel?: unknown, legacyFormat?: unknown): SkillSelections {
  if (typeof value === 'string') {
    try {
      const parsed = SkillSelectionsSchema.safeParse(JSON.parse(value));
      if (parsed.success) return parsed.data;
    } catch {
      // JSON inválido cai no estado seguro abaixo.
    }
  }
  if (legacyLevel != null && legacyLevel !== 'off') {
    return [{ id: 'science', settings: { format: legacyFormat === 'latex' ? 'latex' : 'markdown' } }];
  }
  return [];
}

const FALLBACK_SCHEMA_SQL = `
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
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid');
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
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_versions_fts USING fts5(content, content='artifact_versions', content_rowid='rowid');
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
CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_attachment ON spreadsheet_versions(attachment_id, version DESC);
`;

export interface ProviderSettingsRecord {
  id: string;
  label: string;
  baseURL: string;
  models: unknown[];
  verifiedAt: string | null;
  /** Sempre cifrado. Nunca sai desta camada em claro. */
  apiKeyCipher: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertProviderSettingsData {
  id: string;
  label: string;
  baseURL: string;
  models: unknown[];
  verifiedAt?: string | null;
  /** undefined mantém a chave atual; null apaga; string grava a nova. */
  apiKeyCipher?: string | null;
}

/**
 * Configuração de busca do usuário. `apiKeyCipher` sempre cifrado, como em
 * `ProviderSettingsRecord` — a chave em claro nunca sai desta camada.
 */
export interface SearchSettingsRecord {
  backend: string;
  baseURL: string | null;
  apiKeyCipher: string | null;
  maxResults: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSearchSettingsData {
  backend: string;
  baseURL?: string | null;
  /** undefined mantém a chave atual; null apaga; string grava a nova. */
  apiKeyCipher?: string | null;
  maxResults?: number;
  enabled?: boolean;
}

/**
 * Anexo guardado. `dataBase64` só em imagem; `extractedText` só em documento —
 * ver a migração 006 para o porquê de guardar um e não o outro.
 */
export interface AttachmentRecord {
  id: string;
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: 'image' | 'document' | 'spreadsheet';
  filename: string;
  mime: string;
  sizeBytes: number;
  dataBase64: string | null;
  extractedText: string | null;
  truncated: boolean;
  createdAt: number;
}

export interface CreateAttachmentData {
  id?: string;
  kind: 'image' | 'document' | 'spreadsheet';
  filename: string;
  mime: string;
  sizeBytes: number;
  dataBase64: string | null;
  extractedText: string | null;
  truncated: boolean;
}

function attachmentFromRow(row: Record<string, unknown>): AttachmentRecord {
  const rawKind = asString(row.kind);
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    conversationId: row.conversation_id == null ? null : asString(row.conversation_id),
    messageId: row.message_id == null ? null : asString(row.message_id),
    kind: rawKind === 'image' ? 'image' : rawKind === 'spreadsheet' ? 'spreadsheet' : 'document',
    filename: asString(row.filename),
    mime: asString(row.mime),
    sizeBytes: Number(row.size_bytes),
    dataBase64: row.data_base64 == null ? null : asString(row.data_base64),
    extractedText: row.extracted_text == null ? null : asString(row.extracted_text),
    truncated: Number(row.truncated) === 1,
    createdAt: Number(row.created_at),
  };
}

export interface SpreadsheetVersionRecord {
  attachmentId: string;
  version: number;
  workbookJson: string;
  createdAt: number;
}

export interface CreateConversationData {
  id?: string;
  title?: string | null;
  providerId: ProviderId;
  modelId: string;
  systemPrompt?: string | null;
  effort?: EffortLevel;
  skills?: SkillSelections;
  createdAt?: number;
}

export interface UpdateConversationData {
  title?: string | null;
  providerId?: ProviderId;
  modelId?: string;
  systemPrompt?: string | null;
  effort?: EffortLevel;
  skills?: SkillSelections;
  archived?: boolean;
}

export interface CreateMessageData {
  id?: string;
  conversationId: string;
  role: MessageRole;
  content?: string;
  reasoning?: string | null;
  providerId?: ProviderId | null;
  modelId?: string | null;
  usage?: Usage | null;
  cost?: Cost | null;
  finishReason?: string | null;
  errorCode?: string | null;
  createdAt?: number;
  latencyMs?: number | null;
}

export interface UpdateMessageData {
  content?: string;
  reasoning?: string | null;
  usage?: Usage | null;
  cost?: Cost | null;
  finishReason?: string | null;
  errorCode?: string | null;
  latencyMs?: number | null;
}

export interface UpsertArtifactData {
  conversationId: string;
  slug: string;
  kind: ArtifactKind;
  language?: string | null;
  title: string;
  createdAt?: number;
}

export interface InsertArtifactVersionData extends UpsertArtifactData {
  content: string;
  operation: ArtifactVersion['operation'];
  messageId?: string | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  truncated?: boolean;
  version?: number;
}

type UnknownRow = Record<string, unknown>;

function asRow(row: Record<string, unknown>): UnknownRow {
  return row;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asBoolean(value: unknown): boolean {
  return asNumber(value) !== 0;
}

function optionalProviderId(value: unknown): ProviderId | null {
  const result = ProviderIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

function optionalErrorCode(value: unknown): Message['errorCode'] {
  const result = ErrorCodeSchema.safeParse(value);
  return result.success ? result.data : null;
}

function usageFromRow(row: UnknownRow): Usage | null {
  const rawValues = [
    row.prompt_tokens,
    row.cached_tokens,
    row.completion_tokens,
    row.reasoning_tokens,
    row.total_tokens,
  ];
  if (rawValues.every((value) => value === null || value === undefined)) return null;
  const promptTokens = asNumber(row.prompt_tokens);
  const cachedTokens = Math.min(asNumber(row.cached_tokens), promptTokens);
  const completionTokens = asNumber(row.completion_tokens);
  const reasoningTokens = Math.min(asNumber(row.reasoning_tokens), completionTokens || asNumber(row.reasoning_tokens));
  const totalTokens = asNumber(row.total_tokens, promptTokens + completionTokens);
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    estimated: asBoolean(row.cost_estimated),
  };
}

function costFromRow(row: UnknownRow, usage: Usage | null): Cost | null {
  const hasCost = row.cost_usd !== null && row.cost_usd !== undefined;
  if (!hasCost && !usage) return null;
  // `reported` não é gravado: não há coluna para ele, e o que muda uma decisão
  // — o número não ser projeção nossa — já viaja em `cost_estimated = false`.
  // Ao recarregar a conversa, o custo continua exato; some só a etiqueta que
  // diz de onde ele veio.
  return {
    usd: hasCost ? asNumber(row.cost_usd) : null,
    estimated: asBoolean(row.cost_estimated),
    pricingAvailable: hasCost,
    reported: false,
  };
}

function rowToMessage(input: Record<string, unknown>): Message {
  const row = asRow(input);
  const roleResult = MessageRoleSchema.safeParse(row.role);
  const role = roleResult.success ? roleResult.data : 'assistant';
  const usage = usageFromRow(row);
  return {
    id: asString(row.id),
    conversationId: asString(row.conversation_id),
    role,
    content: asString(row.content),
    reasoning: asNullableString(row.reasoning),
    providerId: optionalProviderId(row.provider_id),
    modelId: asNullableString(row.model_id),
    usage,
    cost: costFromRow(row, usage),
    finishReason: asNullableString(row.finish_reason),
    errorCode: optionalErrorCode(row.error_code),
    createdAt: asNumber(row.created_at),
    latencyMs: asNullableNumber(row.latency_ms),
  };
}

function rowToArtifactVersion(input: Record<string, unknown>): ArtifactVersion {
  return {
    version: Math.max(1, asNumber(input.version)),
    content: asString(input.content),
    operation: input.operation === 'update' || input.operation === 'rewrite' ? input.operation : 'create',
    messageId: asNullableString(input.message_id),
    outputTokens: asNullableNumber(input.output_tokens),
    costUsd: asNullableNumber(input.cost_usd),
    truncated: asBoolean(input.truncated),
    createdAt: asNumber(input.created_at),
  };
}

function artifactKind(value: unknown): ArtifactKind | null {
  const parsed = ArtifactKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function rowToSummary(input: Record<string, unknown>): ConversationSummary {
  const row = asRow(input);
  const providerId = ProviderIdSchema.safeParse(row.provider_id);
  if (!providerId.success) {
    throw new Error(`Banco contém provider_id inválido: ${asString(row.provider_id)}`);
  }
  return {
    id: asString(row.id),
    title: asNullableString(row.title),
    providerId: providerId.data,
    modelId: asString(row.model_id),
    systemPrompt: asNullableString(row.system_prompt),
    effort: parseEffortColumn(row.effort),
    skills: parseSkills(row.skills_json, row.science_level, row.science_format),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
    archived: asBoolean(row.archived),
    messageCount: asNumber(row.message_count),
    totalCostUsd: Math.max(0, asNumber(row.total_cost_usd)),
  };
}

function schemaCandidates(): string[] {
  let moduleDirectory = process.cwd();
  try {
    moduleDirectory = dirname(fileURLToPath(import.meta.url));
  } catch {
    // A bundled runtime can have no useful import.meta URL; cwd is still checked.
  }
  return [
    join(moduleDirectory, 'schema.sql'),
    join(process.cwd(), 'src/server/db/schema.sql'),
    join(process.cwd(), 'dist/schema.sql'),
  ];
}

function loadSchemaSql(): string {
  for (const candidate of schemaCandidates()) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // Use the embedded copy when the SQL asset was not copied by the bundler.
    }
  }
  return FALLBACK_SCHEMA_SQL;
}

export function escapeFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/u)
    .map((term) => term.replaceAll('"', '""'))
    .filter((term) => /[\p{L}\p{N}_]/u.test(term))
    .slice(0, 20);
  return terms.length > 0 ? terms.map((term) => `"${term}"`).join(' AND ') : '*';
}

export class ChatDatabase {
  readonly db: DatabaseSync;

  constructor(filename = process.env.CHAT_DB_PATH || join(process.cwd(), 'chat.db')) {
    this.db = new DatabaseSync(filename, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    // Bancos criados antes do multiusuário: adiciona as colunas que faltam
    // ANTES de executar o schema (CREATE TABLE IF NOT EXISTS não altera
    // tabelas existentes, e o CREATE INDEX em user_id falharia sem a coluna).
    this.ensureColumn('conversations', 'user_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('provider_settings', 'user_id', "TEXT NOT NULL DEFAULT ''");
    // Bancos criados antes do nível de esforço: NULL lê como `auto`, então a
    // conversa antiga segue sem enviar parâmetro de raciocínio nenhum.
    this.ensureColumn('conversations', 'effort', 'TEXT');
    this.ensureColumn('conversations', 'science_level', 'TEXT');
    this.ensureColumn('conversations', 'science_format', 'TEXT');
    this.ensureColumn('conversations', 'skills_json', "TEXT NOT NULL DEFAULT '[]'");
    this.db.exec(loadSchemaSql());
    // Keep external-content FTS consistent with databases created before the triggers existed.
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');");
    this.db.exec("INSERT INTO artifact_versions_fts(artifact_versions_fts) VALUES ('rebuild');");
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Adiciona uma coluna a uma tabela existente se ela ainda não existir. */
  private ensureColumn(table: string, column: string, definition: string): void {
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!tableExists) return;
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  ensureUser(userId: string): void {
    const now = Date.now();
    this.db.prepare('INSERT OR IGNORE INTO users (id, created_at, updated_at) VALUES (?, ?, ?)').run(userId, now, now);
    this.db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(now, userId);
  }

  createConversation(userId: string, data: CreateConversationData): Conversation {
    const now = data.createdAt ?? Date.now();
    const id = data.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversations
          (id, user_id, title, provider_id, model_id, system_prompt, effort, skills_json, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        userId,
        data.title ?? null,
        data.providerId,
        data.modelId,
        data.systemPrompt ?? null,
        data.effort ?? 'auto',
        JSON.stringify(data.skills ?? []),
        now,
        now,
      );
    return this.getConversation(userId, id) as Conversation;
  }

  listConversations(userId: string, options: { includeArchived?: boolean } = {}): ConversationSummary[] {
    const includeArchived = options.includeArchived ?? false;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.model_id, c.system_prompt, c.effort, c.skills_json, c.science_level, c.science_format,
                c.created_at, c.updated_at, c.archived,
                COUNT(m.id) AS message_count,
                COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE c.user_id = ? AND (? = 1 OR c.archived = 0)
          GROUP BY c.id
          ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(userId, includeArchived ? 1 : 0);
    return rows.map((row) => rowToSummary(row));
  }

  getConversation(userId: string, id: string): Conversation | null {
    const summaryRow = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.model_id, c.system_prompt, c.effort, c.skills_json, c.science_level, c.science_format,
                c.created_at, c.updated_at, c.archived,
                COUNT(m.id) AS message_count,
                COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE c.id = ? AND c.user_id = ?
          GROUP BY c.id`,
      )
      .get(id, userId);
    if (!summaryRow) return null;
    const summary = rowToSummary(summaryRow);
    return {
      ...summary,
      messages: this.getMessages(userId, id),
    };
  }

  updateConversation(userId: string, id: string, data: UpdateConversationData): Conversation | null {
    const current = this.getConversation(userId, id);
    if (!current) return null;
    const title = data.title === undefined ? current.title : data.title;
    const providerId = data.providerId ?? current.providerId;
    const modelId = data.modelId ?? current.modelId;
    const systemPrompt = data.systemPrompt === undefined ? current.systemPrompt : data.systemPrompt;
    const effort = data.effort ?? current.effort;
    const skills = data.skills ?? current.skills;
    const archived = data.archived === undefined ? current.archived : data.archived;
    this.db
      .prepare(
        `UPDATE conversations
            SET title = ?, provider_id = ?, model_id = ?, system_prompt = ?, effort = ?, skills_json = ?, archived = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
      )
      .run(title, providerId, modelId, systemPrompt, effort, JSON.stringify(skills), archived ? 1 : 0, Date.now(), id, userId);
    return this.getConversation(userId, id);
  }

  deleteConversation(userId: string, id: string): boolean {
    const result = this.db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId);
    return asNumber(result.changes) > 0;
  }

  getMessages(userId: string, conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.role, m.content, m.reasoning, m.provider_id, m.model_id,
                m.prompt_tokens, m.cached_tokens, m.completion_tokens, m.reasoning_tokens, m.total_tokens,
                m.cost_usd, m.cost_estimated, m.finish_reason, m.error_code, m.created_at, m.latency_ms
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.user_id = ?
          WHERE m.conversation_id = ?
          ORDER BY m.created_at ASC, m.rowid ASC`,
      )
      .all(userId, conversationId);
    return rows.map((row) => rowToMessage(row));
  }

  insertMessage(userId: string, data: CreateMessageData): Message {
    const id = data.id ?? randomUUID();
    const createdAt = data.createdAt ?? Date.now();
    const usage = data.usage;
    const cost = data.cost;
    this.db
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, role, content, reasoning, provider_id, model_id,
           prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens,
           cost_usd, cost_estimated, finish_reason, error_code, created_at, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.conversationId,
        data.role,
        data.content ?? '',
        data.reasoning ?? null,
        data.providerId ?? null,
        data.modelId ?? null,
        usage?.promptTokens ?? null,
        usage?.cachedTokens ?? null,
        usage?.completionTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.totalTokens ?? null,
        cost?.usd ?? null,
        cost?.estimated || usage?.estimated ? 1 : 0,
        data.finishReason ?? null,
        data.errorCode ?? null,
        createdAt,
        data.latencyMs ?? null,
      );
    this.touchConversation(data.conversationId, createdAt);
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!row) throw new Error('Mensagem inserida não foi encontrada.');
    return rowToMessage(row);
  }

  updateMessage(userId: string, id: string, data: UpdateMessageData): Message | null {
    // Defesa em profundidade: a mensagem só existe para o dono da conversa.
    const currentRow = this.db
      .prepare(
        `SELECT m.* FROM messages m
          WHERE m.id = ? AND m.conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
      )
      .get(id, userId);
    if (!currentRow) return null;
    const current = rowToMessage(currentRow);
    const usage = data.usage === undefined ? current.usage : data.usage;
    const cost = data.cost === undefined ? current.cost : data.cost;
    const content = data.content === undefined ? current.content : data.content;
    const reasoning = data.reasoning === undefined ? current.reasoning : data.reasoning;
    const finishReason = data.finishReason === undefined ? current.finishReason : data.finishReason;
    const errorCode = data.errorCode === undefined ? current.errorCode : data.errorCode;
    const latencyMs = data.latencyMs === undefined ? current.latencyMs : data.latencyMs;
    this.db
      .prepare(
        `UPDATE messages
            SET content = ?, reasoning = ?, prompt_tokens = ?, cached_tokens = ?,
                completion_tokens = ?, reasoning_tokens = ?, total_tokens = ?,
                cost_usd = ?, cost_estimated = ?, finish_reason = ?, error_code = ?, latency_ms = ?
          WHERE id = ? AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
      )
      .run(
        content,
        reasoning,
        usage?.promptTokens ?? null,
        usage?.cachedTokens ?? null,
        usage?.completionTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.totalTokens ?? null,
        cost?.usd ?? null,
        cost?.estimated || usage?.estimated ? 1 : 0,
        finishReason,
        errorCode,
        latencyMs,
        id,
        userId,
      );
    this.touchConversation(current.conversationId, Date.now());
    const row = this.db
      .prepare(
        `SELECT m.* FROM messages m
          WHERE m.id = ? AND m.conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
      )
      .get(id, userId);
    return row ? rowToMessage(row) : null;
  }

  upsertArtifact(userId: string, data: UpsertArtifactData): Artifact {
    const now = data.createdAt ?? Date.now();
    const existing = this.db
      .prepare('SELECT * FROM artifacts WHERE conversation_id = ? AND slug = ?')
      .get(data.conversationId, data.slug);
    if (existing) {
      this.db
        .prepare(
          `UPDATE artifacts
              SET kind = ?, language = ?, title = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(data.kind, data.language ?? null, data.title, now, asString(existing.id));
    } else {
      this.db
        .prepare(
          `INSERT INTO artifacts
            (id, conversation_id, slug, kind, language, title, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(randomUUID(), data.conversationId, data.slug, data.kind, data.language ?? null, data.title, now, now);
    }
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE conversation_id = ? AND slug = ?')
      .get(data.conversationId, data.slug);
    if (!row) throw new Error('Artefato não foi encontrado após upsert.');
    const kind = artifactKind(row.kind);
    if (!kind) throw new Error('Tipo de artefato inválido no banco.');
    return {
      id: asString(row.id),
      conversationId: asString(row.conversation_id),
      slug: asString(row.slug),
      kind,
      language: asNullableString(row.language),
      title: asString(row.title),
      currentVersion: Math.max(0, asNumber(row.current_version)),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
      versions: [],
    };
  }

  insertArtifactVersion(userId: string, data: InsertArtifactVersionData): ArtifactVersion {
    const artifact = this.upsertArtifact(userId, data);
    const version = data.version ?? artifact.currentVersion + 1;
    const createdAt = data.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO artifact_versions
          (artifact_id, version, content, operation, message_id, output_tokens, cost_usd, truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        version,
        data.content,
        data.operation,
        data.messageId ?? null,
        data.outputTokens ?? null,
        data.costUsd ?? null,
        data.truncated ? 1 : 0,
        createdAt,
      );
    this.db
      .prepare('UPDATE artifacts SET current_version = ?, updated_at = ? WHERE id = ?')
      .run(Math.max(artifact.currentVersion, version), createdAt, artifact.id);
    const row = this.db
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(artifact.id, version);
    if (!row) throw new Error('Versão de artefato inserida não foi encontrada.');
    return rowToArtifactVersion(row);
  }

  getArtifacts(userId: string, conversationId: string): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM artifacts a
          JOIN conversations c ON c.id = a.conversation_id AND c.user_id = ?
          WHERE a.conversation_id = ? AND a.current_version > 0
          ORDER BY a.updated_at DESC, a.id DESC`,
      )
      .all(userId, conversationId);
    return rows.flatMap((row) => {
      const kind = artifactKind(row.kind);
      if (!kind) return [];
      const versions = this.db
        .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC')
        .all(asString(row.id))
        .map((version) => rowToArtifactVersion(version));
      return [{
        id: asString(row.id),
        conversationId: asString(row.conversation_id),
        slug: asString(row.slug),
        kind,
        language: asNullableString(row.language),
        title: asString(row.title),
        currentVersion: Math.max(1, asNumber(row.current_version)),
        createdAt: asNumber(row.created_at),
        updatedAt: asNumber(row.updated_at),
        versions,
      } satisfies Artifact];
    });
  }

  getArtifactVersion(userId: string, conversationId: string, slug: string, version: number): ArtifactVersion | null {
    const row = this.db
      .prepare(
        `SELECT av.*
           FROM artifact_versions av
           JOIN artifacts a ON a.id = av.artifact_id
           JOIN conversations c ON c.id = a.conversation_id AND c.user_id = ?
          WHERE a.conversation_id = ? AND a.slug = ? AND av.version = ?`,
      )
      .get(userId, conversationId, slug, version);
    return row ? rowToArtifactVersion(row) : null;
  }

  updateArtifactVersionCost(
    userId: string,
    conversationId: string,
    slug: string,
    version: number,
    outputTokens: number | null,
    costUsd: number | null,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE artifact_versions
            SET output_tokens = ?, cost_usd = ?
          WHERE version = ?
            AND artifact_id IN (
              SELECT a.id FROM artifacts a
              JOIN conversations c ON c.id = a.conversation_id AND c.user_id = ?
              WHERE a.conversation_id = ? AND a.slug = ?
            )`,
      )
      .run(outputTokens, costUsd, version, userId, conversationId, slug);
    return asNumber(result.changes) > 0;
  }

  // --- Anexos -------------------------------------------------------------

  createAttachment(userId: string, data: CreateAttachmentData): AttachmentRecord {
    const record: AttachmentRecord = {
      id: data.id ?? randomUUID(),
      userId,
      conversationId: null,
      messageId: null,
      kind: data.kind,
      filename: data.filename,
      mime: data.mime,
      sizeBytes: data.sizeBytes,
      dataBase64: data.dataBase64,
      extractedText: data.extractedText,
      truncated: data.truncated,
      createdAt: Date.now(),
    };
    this.db.prepare(
      `INSERT INTO attachments (id, user_id, conversation_id, message_id, kind, filename, mime, size_bytes, data_base64, extracted_text, truncated, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(record.id, userId, record.kind, record.filename, record.mime, record.sizeBytes,
      record.dataBase64, record.extractedText, record.truncated ? 1 : 0, record.createdAt);
    return record;
  }

  /** Sempre por dono: anexo de outro usuário não existe para quem pergunta. */
  getAttachment(userId: string, id: string): AttachmentRecord | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE user_id = ? AND id = ?').get(userId, id) as
      | Record<string, unknown>
      | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  getAttachments(userId: string, ids: readonly string[]): AttachmentRecord[] {
    if (ids.length === 0) return [];
    const marcadores = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM attachments WHERE user_id = ? AND id IN (${marcadores}) ORDER BY created_at ASC`)
      .all(userId, ...ids) as Record<string, unknown>[];
    return rows.map(attachmentFromRow);
  }

  /** Liga os anexos à mensagem no momento do envio. */
  attachToMessage(userId: string, ids: readonly string[], conversationId: string, messageId: string): void {
    if (ids.length === 0) return;
    const marcadores = ids.map(() => '?').join(', ');
    this.db.prepare(
      `UPDATE attachments SET conversation_id = ?, message_id = ?
       WHERE user_id = ? AND id IN (${marcadores}) AND message_id IS NULL`,
    ).run(conversationId, messageId, userId, ...ids);
  }

  listAttachmentsForConversation(userId: string, conversationId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE user_id = ? AND conversation_id = ? ORDER BY created_at ASC')
      .all(userId, conversationId) as Record<string, unknown>[];
    return rows.map(attachmentFromRow);
  }

  deleteAttachment(userId: string, id: string): boolean {
    // Só o que ainda não foi enviado: apagar um anexo já usado deixaria a
    // mensagem falando de um arquivo que não existe mais.
    return this.db.prepare('DELETE FROM attachments WHERE user_id = ? AND id = ? AND message_id IS NULL')
      .run(userId, id).changes > 0;
  }

  /** Anexos que subiram e nunca foram enviados ocupam espaço para sempre. */
  deleteOrphanAttachments(userId: string, olderThanMs: number): number {
    // `changes` do node:sqlite pode vir como bigint; o chamador só conta.
    return Number(
      this.db.prepare('DELETE FROM attachments WHERE user_id = ? AND message_id IS NULL AND created_at < ?')
        .run(userId, Date.now() - olderThanMs).changes,
    );
  }

  getSpreadsheetVersion(userId: string, attachmentId: string, version?: number): SpreadsheetVersionRecord | null {
    const row = this.db.prepare(
      `SELECT sv.* FROM spreadsheet_versions sv
       JOIN attachments a ON a.id = sv.attachment_id AND a.user_id = ? AND a.kind = 'spreadsheet'
       WHERE sv.attachment_id = ? ${version === undefined ? '' : 'AND sv.version = ?'}
       ORDER BY sv.version DESC LIMIT 1`,
    ).get(...(version === undefined ? [userId, attachmentId] : [userId, attachmentId, version])) as Record<string, unknown> | undefined;
    return row ? {
      attachmentId: asString(row.attachment_id),
      version: asNumber(row.version),
      workbookJson: asString(row.workbook_json),
      createdAt: asNumber(row.created_at),
    } : null;
  }

  insertSpreadsheetVersion(userId: string, attachmentId: string, workbookJson: string, baseVersion?: number): SpreadsheetVersionRecord | null {
    const expected = baseVersion ?? 0;
    const next = expected + 1;
    const createdAt = Date.now();
    const result = this.db.prepare(
      `INSERT INTO spreadsheet_versions (attachment_id, version, workbook_json, created_at)
       SELECT id, ?, ?, ? FROM attachments
       WHERE id = ? AND user_id = ? AND kind = 'spreadsheet'
         AND COALESCE((SELECT MAX(version) FROM spreadsheet_versions WHERE attachment_id = ?), 0) = ?`,
    ).run(next, workbookJson, createdAt, attachmentId, userId, attachmentId, expected);
    return Number(result.changes) > 0 ? { attachmentId, version: next, workbookJson, createdAt } : null;
  }

  listProviderSettings(userId: string): ProviderSettingsRecord[] {
    return this.db
      .prepare('SELECT * FROM provider_settings WHERE user_id = ? ORDER BY label ASC, id ASC')
      .all(userId)
      .flatMap((row) => {
        let models: unknown;
        try {
          models = JSON.parse(asString(row.models_json)) as unknown;
        } catch {
          // Registro corrompido não derruba o catálogo: ele some da lista.
          return [];
        }
        return [{
          id: asString(row.id),
          label: asString(row.label),
          baseURL: asString(row.base_url),
          models: Array.isArray(models) ? models : [],
          verifiedAt: asNullableString(row.verified_at),
          apiKeyCipher: asNullableString(row.api_key_cipher),
          createdAt: asNumber(row.created_at),
          updatedAt: asNumber(row.updated_at),
        }];
      });
  }

  upsertProviderSettings(userId: string, data: UpsertProviderSettingsData): ProviderSettingsRecord {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM provider_settings WHERE id = ? AND user_id = ?').get(data.id, userId);
    // `undefined` mantém a chave atual; `null` apaga; string grava a nova.
    const cipher = data.apiKeyCipher === undefined
      ? (existing ? asNullableString(existing.api_key_cipher) : null)
      : data.apiKeyCipher;

    this.db
      .prepare(
        `INSERT INTO provider_settings (id, user_id, label, base_url, models_json, verified_at, api_key_cipher, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
          label = excluded.label,
          base_url = excluded.base_url,
          models_json = excluded.models_json,
          verified_at = excluded.verified_at,
          api_key_cipher = excluded.api_key_cipher,
          updated_at = excluded.updated_at`,
      )
      .run(
        data.id,
        userId,
        data.label,
        data.baseURL,
        JSON.stringify(data.models),
        data.verifiedAt ?? null,
        cipher,
        existing ? asNumber(existing.created_at) : now,
        now,
      );

    const record = this.listProviderSettings(userId).find((item) => item.id === data.id);
    if (!record) throw new Error('Provedor não encontrado após gravação.');
    return record;
  }

  deleteProviderSettings(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM provider_settings WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  getSearchSettings(userId: string): SearchSettingsRecord | null {
    const row = this.db.prepare('SELECT * FROM search_settings WHERE user_id = ?').get(userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      backend: asString(row.backend),
      baseURL: row.base_url === null || row.base_url === undefined ? null : asString(row.base_url),
      apiKeyCipher: row.api_key_cipher === null || row.api_key_cipher === undefined ? null : asString(row.api_key_cipher),
      maxResults: Number(row.max_results),
      enabled: Number(row.enabled) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertSearchSettings(userId: string, data: UpsertSearchSettingsData): SearchSettingsRecord {
    const existing = this.getSearchSettings(userId);
    const now = Date.now();
    // `apiKeyCipher: undefined` preserva a chave gravada — é o que permite ao
    // usuário trocar de buscador ou mexer no limite sem redigitar a chave.
    const cipher = data.apiKeyCipher === undefined ? existing?.apiKeyCipher ?? null : data.apiKeyCipher;
    const record: SearchSettingsRecord = {
      backend: data.backend,
      baseURL: data.baseURL === undefined ? existing?.baseURL ?? null : data.baseURL,
      apiKeyCipher: cipher,
      maxResults: data.maxResults ?? existing?.maxResults ?? 5,
      enabled: data.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO search_settings (user_id, backend, base_url, api_key_cipher, max_results, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           backend = excluded.backend, base_url = excluded.base_url, api_key_cipher = excluded.api_key_cipher,
           max_results = excluded.max_results, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        record.backend,
        record.baseURL,
        record.apiKeyCipher,
        record.maxResults,
        record.enabled ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  deleteSearchSettings(userId: string): boolean {
    return this.db.prepare('DELETE FROM search_settings WHERE user_id = ?').run(userId).changes > 0;
  }

  searchConversations(userId: string, query: string): ConversationSummary[] {
    const ftsQuery = escapeFtsQuery(query);
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.model_id, c.system_prompt, c.effort, c.skills_json, c.science_level, c.science_format,
                c.created_at, c.updated_at, c.archived,
                COUNT(m.id) AS message_count,
                COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd
           FROM (
             SELECT matched.conversation_id
               FROM messages_fts f
               JOIN messages matched ON matched.rowid = f.rowid
              WHERE f.messages_fts MATCH ?
             UNION
             SELECT a.conversation_id
               FROM artifact_versions_fts f
               JOIN artifact_versions av ON av.rowid = f.rowid
               JOIN artifacts a ON a.id = av.artifact_id AND av.version = a.current_version
              WHERE f.artifact_versions_fts MATCH ?
           ) matched_conversations
           JOIN conversations c ON c.id = matched_conversations.conversation_id AND c.user_id = ?
           LEFT JOIN messages m ON m.conversation_id = c.id
          GROUP BY c.id
          ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(ftsQuery, ftsQuery, userId);
    return rows.map((row) => rowToSummary(row));
  }

  getCostAnalytics(userId: string, days = 30): CostAnalyticsResponse {
    const limit = Math.min(365, Math.max(1, Math.trunc(days)));
    const since = Date.now() - limit * 24 * 60 * 60 * 1_000;
    const dailyRows = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(*) AS message_count
           FROM messages
          WHERE role = 'assistant'
            AND cost_usd IS NOT NULL
            AND created_at >= ?
            AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)
          GROUP BY day
          ORDER BY day DESC`,
      )
      .all(since, userId);
    const modelRows = this.db
      .prepare(
        `SELECT provider_id, model_id,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(*) AS message_count
           FROM messages
          WHERE role = 'assistant'
            AND cost_usd IS NOT NULL
            AND provider_id IS NOT NULL
            AND model_id IS NOT NULL
            AND created_at >= ?
            AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)
          GROUP BY provider_id, model_id
          ORDER BY cost_usd DESC, model_id ASC`,
      )
      .all(since, userId);
    const totalRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd
           FROM messages
          WHERE role = 'assistant' AND cost_usd IS NOT NULL AND created_at >= ?
            AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
      )
      .get(since, userId);

    return {
      totalCostUsd: Math.max(0, asNumber(totalRow?.total_cost_usd)),
      daily: dailyRows.map((row) => ({
        day: asString(row.day),
        costUsd: Math.max(0, asNumber(row.cost_usd)),
        messageCount: Math.max(0, asNumber(row.message_count)),
      })),
      byModel: modelRows.flatMap((row) => {
        const providerId = ProviderIdSchema.safeParse(row.provider_id);
        const modelId = asString(row.model_id);
        if (!providerId.success || !modelId) return [];
        return [{
          providerId: providerId.data,
          modelId,
          costUsd: Math.max(0, asNumber(row.cost_usd)),
          messageCount: Math.max(0, asNumber(row.message_count)),
        }];
      }),
    };
  }

  private touchConversation(conversationId: string, timestamp: number): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(timestamp, conversationId);
  }
}
