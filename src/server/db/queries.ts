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
  type Message,
  type MessageRole,
  type ProviderId,
  type Usage,
} from '../../shared/types';

const FALLBACK_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  system_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
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
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'code', 'svg', 'mermaid')),
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
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL,
  verified_at TEXT,
  api_key_cipher TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
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

export interface CreateConversationData {
  id?: string;
  title?: string | null;
  providerId: ProviderId;
  modelId: string;
  systemPrompt?: string | null;
  createdAt?: number;
}

export interface UpdateConversationData {
  title?: string | null;
  providerId?: ProviderId;
  modelId?: string;
  systemPrompt?: string | null;
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
  return {
    usd: hasCost ? asNumber(row.cost_usd) : null,
    estimated: asBoolean(row.cost_estimated),
    pricingAvailable: hasCost,
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
    this.db.exec(loadSchemaSql());
    // Keep external-content FTS consistent with databases created before the triggers existed.
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');");
    this.db.exec("INSERT INTO artifact_versions_fts(artifact_versions_fts) VALUES ('rebuild');");
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  createConversation(data: CreateConversationData): Conversation {
    const now = data.createdAt ?? Date.now();
    const id = data.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversations
          (id, title, provider_id, model_id, system_prompt, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        data.title ?? null,
        data.providerId,
        data.modelId,
        data.systemPrompt ?? null,
        now,
        now,
      );
    return this.getConversation(id) as Conversation;
  }

  listConversations(options: { includeArchived?: boolean } = {}): ConversationSummary[] {
    const includeArchived = options.includeArchived ?? false;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.model_id, c.system_prompt,
                c.created_at, c.updated_at, c.archived,
                COUNT(m.id) AS message_count,
                COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE (? = 1 OR c.archived = 0)
          GROUP BY c.id
          ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(includeArchived ? 1 : 0);
    return rows.map((row) => rowToSummary(row));
  }

  getConversation(id: string): Conversation | null {
    const summaryRow = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.model_id, c.system_prompt,
                c.created_at, c.updated_at, c.archived,
                COUNT(m.id) AS message_count,
                COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE c.id = ?
          GROUP BY c.id`,
      )
      .get(id);
    if (!summaryRow) return null;
    const summary = rowToSummary(summaryRow);
    return {
      ...summary,
      messages: this.getMessages(id),
    };
  }

  updateConversation(id: string, data: UpdateConversationData): Conversation | null {
    const current = this.getConversation(id);
    if (!current) return null;
    const title = data.title === undefined ? current.title : data.title;
    const providerId = data.providerId ?? current.providerId;
    const modelId = data.modelId ?? current.modelId;
    const systemPrompt = data.systemPrompt === undefined ? current.systemPrompt : data.systemPrompt;
    const archived = data.archived === undefined ? current.archived : data.archived;
    this.db
      .prepare(
        `UPDATE conversations
            SET title = ?, provider_id = ?, model_id = ?, system_prompt = ?, archived = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(title, providerId, modelId, systemPrompt, archived ? 1 : 0, Date.now(), id);
    return this.getConversation(id);
  }

  deleteConversation(id: string): boolean {
    const result = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return asNumber(result.changes) > 0;
  }

  getMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, reasoning, provider_id, model_id,
                prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens,
                cost_usd, cost_estimated, finish_reason, error_code, created_at, latency_ms
           FROM messages
          WHERE conversation_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(conversationId);
    return rows.map((row) => rowToMessage(row));
  }

  insertMessage(data: CreateMessageData): Message {
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

  updateMessage(id: string, data: UpdateMessageData): Message | null {
    const currentRow = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
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
          WHERE id = ?`,
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
      );
    this.touchConversation(current.conversationId, Date.now());
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? rowToMessage(row) : null;
  }

  upsertArtifact(data: UpsertArtifactData): Artifact {
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

  insertArtifactVersion(data: InsertArtifactVersionData): ArtifactVersion {
    const artifact = this.upsertArtifact(data);
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

  getArtifacts(conversationId: string): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts
          WHERE conversation_id = ? AND current_version > 0
          ORDER BY updated_at DESC, id DESC`,
      )
      .all(conversationId);
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

  getArtifactVersion(conversationId: string, slug: string, version: number): ArtifactVersion | null {
    const row = this.db
      .prepare(
        `SELECT av.*
           FROM artifact_versions av
           JOIN artifacts a ON a.id = av.artifact_id
          WHERE a.conversation_id = ? AND a.slug = ? AND av.version = ?`,
      )
      .get(conversationId, slug, version);
    return row ? rowToArtifactVersion(row) : null;
  }

  updateArtifactVersionCost(
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
          WHERE artifact_id = (
            SELECT id FROM artifacts WHERE conversation_id = ? AND slug = ?
          ) AND version = ?`,
      )
      .run(outputTokens, costUsd, conversationId, slug, version);
    return asNumber(result.changes) > 0;
  }

  listProviderSettings(): ProviderSettingsRecord[] {
    return this.db
      .prepare('SELECT * FROM provider_settings ORDER BY label ASC, id ASC')
      .all()
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

  upsertProviderSettings(data: UpsertProviderSettingsData): ProviderSettingsRecord {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM provider_settings WHERE id = ?').get(data.id);
    // `undefined` mantém a chave atual; `null` apaga; string grava a nova.
    const cipher = data.apiKeyCipher === undefined
      ? (existing ? asNullableString(existing.api_key_cipher) : null)
      : data.apiKeyCipher;

    this.db
      .prepare(
        `INSERT INTO provider_settings (id, label, base_url, models_json, verified_at, api_key_cipher, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           base_url = excluded.base_url,
           models_json = excluded.models_json,
           verified_at = excluded.verified_at,
           api_key_cipher = excluded.api_key_cipher,
           updated_at = excluded.updated_at`,
      )
      .run(
        data.id,
        data.label,
        data.baseURL,
        JSON.stringify(data.models),
        data.verifiedAt ?? null,
        cipher,
        existing ? asNumber(existing.created_at) : now,
        now,
      );

    const record = this.listProviderSettings().find((item) => item.id === data.id);
    if (!record) throw new Error('Provedor não encontrado após gravação.');
    return record;
  }

  deleteProviderSettings(id: string): boolean {
    return this.db.prepare('DELETE FROM provider_settings WHERE id = ?').run(id).changes > 0;
  }

  searchConversations(query: string): ConversationSummary[] {
    const ftsQuery = escapeFtsQuery(query);
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.model_id, c.system_prompt,
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
           JOIN conversations c ON c.id = matched_conversations.conversation_id
           LEFT JOIN messages m ON m.conversation_id = c.id
          GROUP BY c.id
          ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(ftsQuery, ftsQuery);
    return rows.map((row) => rowToSummary(row));
  }

  getCostAnalytics(days = 30): CostAnalyticsResponse {
    const limit = Math.min(365, Math.max(1, Math.trunc(days)));
    const dailyRows = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(*) AS message_count
           FROM messages
          WHERE role = 'assistant'
            AND cost_usd IS NOT NULL
            AND created_at >= ?
          GROUP BY day
          ORDER BY day DESC`,
      )
      .all(Date.now() - limit * 24 * 60 * 60 * 1_000);
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
          GROUP BY provider_id, model_id
          ORDER BY cost_usd DESC, model_id ASC`,
      )
      .all(Date.now() - limit * 24 * 60 * 60 * 1_000);
    const totalRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd
           FROM messages
          WHERE role = 'assistant' AND cost_usd IS NOT NULL AND created_at >= ?`,
      )
      .get(Date.now() - limit * 24 * 60 * 60 * 1_000);

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
