import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
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
  type ProviderId,
  type Usage,
} from '../../shared/types';
import type { ChatDatabaseAdapter } from './database';
import type {
  CreateConversationData,
  CreateMessageData,
  InsertArtifactVersionData,
  ProviderSettingsRecord,
  UpdateConversationData,
  UpdateMessageData,
  UpsertArtifactData,
  UpsertProviderSettingsData,
} from './queries';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, created_at bigint NOT NULL, updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY, user_id text NOT NULL DEFAULT '', title text, provider_id text NOT NULL, model_id text NOT NULL,
  system_prompt text, created_at bigint NOT NULL, updated_at bigint NOT NULL,
  archived boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
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
CREATE TABLE IF NOT EXISTS provider_settings (
  id text NOT NULL, user_id text NOT NULL DEFAULT '', label text NOT NULL, base_url text NOT NULL,
  models_json jsonb NOT NULL DEFAULT '[]'::jsonb, verified_at text, api_key_cipher text,
  created_at bigint NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (user_id, id)
);
`;

const text = (value: unknown): string => typeof value === 'string' ? value : String(value ?? '');
const nullableText = (value: unknown): string | null => value == null ? null : String(value);
const number = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const nullableNumber = (value: unknown): number | null => value == null ? null : number(value);
const bool = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true';

function providerId(value: unknown): ProviderId | null {
  const parsed = ProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function usage(row: Row): Usage | null {
  if ([row.prompt_tokens, row.cached_tokens, row.completion_tokens, row.reasoning_tokens, row.total_tokens].every((value) => value == null)) return null;
  const promptTokens = number(row.prompt_tokens);
  const completionTokens = number(row.completion_tokens);
  return {
    promptTokens,
    cachedTokens: Math.min(number(row.cached_tokens), promptTokens),
    completionTokens,
    reasoningTokens: Math.min(number(row.reasoning_tokens), completionTokens || number(row.reasoning_tokens)),
    totalTokens: number(row.total_tokens, promptTokens + completionTokens),
    estimated: bool(row.cost_estimated),
  };
}

function cost(row: Row, value: Usage | null): Cost | null {
  if (row.cost_usd == null && !value) return null;
  return { usd: nullableNumber(row.cost_usd), estimated: bool(row.cost_estimated), pricingAvailable: row.cost_usd != null };
}

function message(row: Row): Message {
  const role = MessageRoleSchema.safeParse(row.role);
  const error = ErrorCodeSchema.safeParse(row.error_code);
  const rowUsage = usage(row);
  return {
    id: text(row.id), conversationId: text(row.conversation_id), role: role.success ? role.data : 'assistant',
    content: text(row.content), reasoning: nullableText(row.reasoning), providerId: providerId(row.provider_id),
    modelId: nullableText(row.model_id), usage: rowUsage, cost: cost(row, rowUsage),
    finishReason: nullableText(row.finish_reason), errorCode: error.success ? error.data : null,
    createdAt: number(row.created_at), latencyMs: nullableNumber(row.latency_ms),
  };
}

function version(row: Row): ArtifactVersion {
  return {
    version: Math.max(1, number(row.version)), content: text(row.content),
    operation: row.operation === 'update' || row.operation === 'rewrite' ? row.operation : 'create',
    messageId: nullableText(row.message_id), outputTokens: nullableNumber(row.output_tokens),
    costUsd: nullableNumber(row.cost_usd), truncated: bool(row.truncated), createdAt: number(row.created_at),
  };
}

function conversationBase(row: Row): Omit<ConversationSummary, 'messageCount' | 'totalCostUsd'> {
  const id = ProviderIdSchema.parse(row.provider_id);
  return {
    id: text(row.id), title: nullableText(row.title), providerId: id, modelId: text(row.model_id),
    systemPrompt: nullableText(row.system_prompt), createdAt: number(row.created_at),
    updatedAt: number(row.updated_at), archived: bool(row.archived),
  };
}

function summary(row: Row): ConversationSummary {
  return { ...conversationBase(row), messageCount: number(row.message_count), totalCostUsd: Math.max(0, number(row.total_cost_usd)) };
}

export class NeonChatDatabase implements ChatDatabaseAdapter {
  private readonly sql: ReturnType<typeof neon>;

  /**
   * Sem criação automática de schema: desde a migração multiusuário, o schema
   * é aplicado manualmente com `pnpm db:migrate` (scripts/db/migrations) — ver
   * PLANO-MULTIUSUARIO.md. Um banco não migrado falha com erro de relação
   * inexistente, de propósito: schema automático em requisições foi removido.
   */
  constructor(connectionString: string) {
    this.sql = neon(connectionString);
  }

  private async rows(query: string, params: unknown[] = []): Promise<Row[]> {
    return await this.sql.query(query, params) as Row[];
  }

  async ensureUser(userId: string): Promise<void> {
    const now = Date.now();
    await this.rows('INSERT INTO users (id,created_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT (id) DO NOTHING', [userId, now]);
    await this.rows('UPDATE users SET updated_at=$2 WHERE id=$1', [userId, now]);
  }

  async createConversation(userId: string, data: CreateConversationData): Promise<Conversation> {
    const id = data.id ?? randomUUID();
    const now = data.createdAt ?? Date.now();
    await this.rows(
      `INSERT INTO conversations (id,user_id,title,provider_id,model_id,system_prompt,created_at,updated_at,archived)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,false) RETURNING *`,
      [id, userId, data.title ?? 'Nova conversa', data.providerId, data.modelId, data.systemPrompt ?? null, now],
    );
    return await this.getConversation(userId, id) as Conversation;
  }

  async listConversations(userId: string, options: { includeArchived?: boolean } = {}): Promise<ConversationSummary[]> {
    const rows = await this.rows(
      `SELECT c.*, COUNT(m.id)::int AS message_count, COALESCE(SUM(m.cost_usd),0) AS total_cost_usd
         FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
        WHERE c.user_id=$1 AND ($2::boolean OR NOT c.archived) GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC`,
      [userId, options.includeArchived === true],
    );
    return rows.map(summary);
  }

  async getConversation(userId: string, id: string): Promise<Conversation | null> {
    const [row] = await this.rows(`SELECT c.*,COUNT(m.id)::int AS message_count,COALESCE(SUM(m.cost_usd),0) AS total_cost_usd
      FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.id=$2 AND c.user_id=$1 GROUP BY c.id`, [userId, id]);
    return row ? { ...summary(row), messages: await this.getMessages(userId, id) } : null;
  }

  async updateConversation(userId: string, id: string, data: UpdateConversationData): Promise<Conversation | null> {
    const current = await this.getConversation(userId, id);
    if (!current) return null;
    await this.rows(
      `UPDATE conversations SET title=$3,provider_id=$4,model_id=$5,system_prompt=$6,archived=$7,updated_at=$8
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, data.title === undefined ? current.title : data.title, data.providerId ?? current.providerId,
        data.modelId ?? current.modelId, data.systemPrompt === undefined ? current.systemPrompt : data.systemPrompt,
        data.archived ?? current.archived, Date.now()],
    );
    return this.getConversation(userId, id);
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    return (await this.rows('DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId])).length > 0;
  }

  async getMessages(userId: string, conversationId: string): Promise<Message[]> {
    return (await this.rows(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.user_id=$1
      WHERE m.conversation_id=$2 ORDER BY m.created_at ASC,m.id ASC`, [userId, conversationId])).map(message);
  }

  async insertMessage(userId: string, data: CreateMessageData): Promise<Message> {
    const id = data.id ?? randomUUID();
    const now = data.createdAt ?? Date.now();
    const [row] = await this.rows(
      `INSERT INTO messages (id,conversation_id,role,content,reasoning,provider_id,model_id,prompt_tokens,cached_tokens,
       completion_tokens,reasoning_tokens,total_tokens,cost_usd,cost_estimated,finish_reason,error_code,created_at,latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [id, data.conversationId, data.role, data.content ?? '', data.reasoning ?? null, data.providerId ?? null,
        data.modelId ?? null, data.usage?.promptTokens ?? null, data.usage?.cachedTokens ?? null,
        data.usage?.completionTokens ?? null, data.usage?.reasoningTokens ?? null, data.usage?.totalTokens ?? null,
        data.cost?.usd ?? null, Boolean(data.cost?.estimated || data.usage?.estimated), data.finishReason ?? null,
        data.errorCode ?? null, now, data.latencyMs ?? null],
    );
    await this.rows('UPDATE conversations SET updated_at=$2 WHERE id=$1', [data.conversationId, now]);
    return message(row);
  }

  async updateMessage(userId: string, id: string, data: UpdateMessageData): Promise<Message | null> {
    const [currentRow] = await this.rows(`SELECT m.* FROM messages m
      WHERE m.id=$1 AND m.conversation_id IN (SELECT id FROM conversations WHERE user_id=$2)`, [id, userId]);
    if (!currentRow) return null;
    const current = message(currentRow);
    const nextUsage = data.usage === undefined ? current.usage : data.usage;
    const nextCost = data.cost === undefined ? current.cost : data.cost;
    const [row] = await this.rows(
      `UPDATE messages SET content=$2,reasoning=$3,prompt_tokens=$4,cached_tokens=$5,completion_tokens=$6,
       reasoning_tokens=$7,total_tokens=$8,cost_usd=$9,cost_estimated=$10,finish_reason=$11,error_code=$12,latency_ms=$13
       WHERE id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE user_id=$14) RETURNING *`,
      [id, data.content ?? current.content, data.reasoning === undefined ? current.reasoning : data.reasoning,
        nextUsage?.promptTokens ?? null, nextUsage?.cachedTokens ?? null, nextUsage?.completionTokens ?? null,
        nextUsage?.reasoningTokens ?? null, nextUsage?.totalTokens ?? null, nextCost?.usd ?? null,
        Boolean(nextCost?.estimated || nextUsage?.estimated), data.finishReason === undefined ? current.finishReason : data.finishReason,
        data.errorCode === undefined ? current.errorCode : data.errorCode, data.latencyMs === undefined ? current.latencyMs : data.latencyMs,
        userId],
    );
    await this.rows('UPDATE conversations SET updated_at=$2 WHERE id=$1', [current.conversationId, Date.now()]);
    return row ? message(row) : null;
  }

  async upsertArtifact(userId: string, data: UpsertArtifactData): Promise<Artifact> {
    const now = data.createdAt ?? Date.now();
    const [row] = await this.rows(
      `INSERT INTO artifacts (id,conversation_id,slug,kind,language,title,current_version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$7)
       ON CONFLICT (conversation_id,slug) DO UPDATE SET kind=EXCLUDED.kind,language=EXCLUDED.language,title=EXCLUDED.title,updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [randomUUID(), data.conversationId, data.slug, data.kind, data.language ?? null, data.title, now],
    );
    const kind = ArtifactKindSchema.parse(row.kind);
    return { id: text(row.id), conversationId: text(row.conversation_id), slug: text(row.slug), kind,
      language: nullableText(row.language), title: text(row.title), currentVersion: number(row.current_version),
      createdAt: number(row.created_at), updatedAt: number(row.updated_at), versions: [] };
  }

  async insertArtifactVersion(userId: string, data: InsertArtifactVersionData): Promise<ArtifactVersion> {
    const artifact = await this.upsertArtifact(userId, data);
    const nextVersion = data.version ?? artifact.currentVersion + 1;
    const now = data.createdAt ?? Date.now();
    const [row] = await this.rows(
      `INSERT INTO artifact_versions (artifact_id,version,content,operation,message_id,output_tokens,cost_usd,truncated,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [artifact.id, nextVersion, data.content, data.operation, data.messageId ?? null, data.outputTokens ?? null,
        data.costUsd ?? null, data.truncated === true, now],
    );
    await this.rows('UPDATE artifacts SET current_version=GREATEST(current_version,$2),updated_at=$3 WHERE id=$1', [artifact.id, nextVersion, now]);
    return version(row);
  }

  async getArtifacts(userId: string, conversationId: string): Promise<Artifact[]> {
    const artifactRows = await this.rows(`SELECT a.* FROM artifacts a JOIN conversations c ON c.id=a.conversation_id AND c.user_id=$1
      WHERE a.conversation_id=$2 AND a.current_version>0 ORDER BY a.updated_at DESC,a.id DESC`, [userId, conversationId]);
    const result: Artifact[] = [];
    for (const row of artifactRows) {
      const parsed = ArtifactKindSchema.safeParse(row.kind);
      if (!parsed.success) continue;
      const versions = (await this.rows('SELECT * FROM artifact_versions WHERE artifact_id=$1 ORDER BY version ASC', [row.id])).map(version);
      result.push({ id: text(row.id), conversationId: text(row.conversation_id), slug: text(row.slug), kind: parsed.data,
        language: nullableText(row.language), title: text(row.title), currentVersion: Math.max(1, number(row.current_version)),
        createdAt: number(row.created_at), updatedAt: number(row.updated_at), versions });
    }
    return result;
  }

  async getArtifactVersion(userId: string, conversationId: string, slug: string, versionNumber: number): Promise<ArtifactVersion | null> {
    const [row] = await this.rows(`SELECT av.* FROM artifact_versions av JOIN artifacts a ON a.id=av.artifact_id
      JOIN conversations c ON c.id=a.conversation_id AND c.user_id=$1
      WHERE a.conversation_id=$2 AND a.slug=$3 AND av.version=$4`, [userId, conversationId, slug, versionNumber]);
    return row ? version(row) : null;
  }

  async updateArtifactVersionCost(userId: string, conversationId: string, slug: string, versionNumber: number, outputTokens: number | null, costUsd: number | null): Promise<boolean> {
    return (await this.rows(`UPDATE artifact_versions SET output_tokens=$5,cost_usd=$6 WHERE version=$4 AND artifact_id IN (
      SELECT a.id FROM artifacts a JOIN conversations c ON c.id=a.conversation_id AND c.user_id=$1
      WHERE a.conversation_id=$2 AND a.slug=$3) RETURNING version`,
    [userId, conversationId, slug, versionNumber, outputTokens, costUsd])).length > 0;
  }

  async listProviderSettings(userId: string): Promise<ProviderSettingsRecord[]> {
    return (await this.rows('SELECT * FROM provider_settings WHERE user_id=$1 ORDER BY label ASC,id ASC', [userId])).map((row) => ({
      id: text(row.id), label: text(row.label), baseURL: text(row.base_url),
      models: Array.isArray(row.models_json) ? row.models_json : [], verifiedAt: nullableText(row.verified_at),
      apiKeyCipher: nullableText(row.api_key_cipher), createdAt: number(row.created_at), updatedAt: number(row.updated_at),
    }));
  }

  async upsertProviderSettings(userId: string, data: UpsertProviderSettingsData): Promise<ProviderSettingsRecord> {
    const now = Date.now();
    const [row] = await this.rows(
      `INSERT INTO provider_settings (id,user_id,label,base_url,models_json,verified_at,api_key_cipher,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8)
       ON CONFLICT (user_id,id) DO UPDATE SET label=EXCLUDED.label,base_url=EXCLUDED.base_url,models_json=EXCLUDED.models_json,
       verified_at=EXCLUDED.verified_at,api_key_cipher=CASE WHEN $9::boolean THEN EXCLUDED.api_key_cipher ELSE provider_settings.api_key_cipher END,
       updated_at=EXCLUDED.updated_at RETURNING *`,
      [data.id, userId, data.label, data.baseURL, JSON.stringify(data.models), data.verifiedAt ?? null,
        data.apiKeyCipher ?? null, now, data.apiKeyCipher !== undefined],
    );
    return { id: text(row.id), label: text(row.label), baseURL: text(row.base_url), models: Array.isArray(row.models_json) ? row.models_json : [],
      verifiedAt: nullableText(row.verified_at), apiKeyCipher: nullableText(row.api_key_cipher),
      createdAt: number(row.created_at), updatedAt: number(row.updated_at) };
  }

  async deleteProviderSettings(userId: string, id: string): Promise<boolean> {
    return (await this.rows('DELETE FROM provider_settings WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId])).length > 0;
  }

  async searchConversations(userId: string, query: string): Promise<ConversationSummary[]> {
    const pattern = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = await this.rows(
      `SELECT c.*,COUNT(m.id)::int AS message_count,COALESCE(SUM(m.cost_usd),0) AS total_cost_usd
       FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
       WHERE c.user_id=$2 AND (
          EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id=c.id AND sm.content ILIKE $1 ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM artifacts a JOIN artifact_versions av ON av.artifact_id=a.id AND av.version=a.current_version
                     WHERE a.conversation_id=c.id AND av.content ILIKE $1 ESCAPE '\\'))
       GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC`, [pattern, userId]);
    return rows.map(summary);
  }

  async getCostAnalytics(userId: string, days = 30): Promise<CostAnalyticsResponse> {
    const since = Date.now() - Math.min(365, Math.max(1, Math.trunc(days))) * 86_400_000;
    const [daily, byModel] = await Promise.all([
      this.rows(`SELECT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD') AS day,COALESCE(SUM(cost_usd),0) AS cost_usd,COUNT(*)::int AS message_count
        FROM messages WHERE role='assistant' AND cost_usd IS NOT NULL AND created_at >= $1
        AND conversation_id IN (SELECT id FROM conversations WHERE user_id=$2) GROUP BY day ORDER BY day DESC`, [since, userId]),
      this.rows(`SELECT provider_id,model_id,COALESCE(SUM(cost_usd),0) AS cost_usd,COUNT(*)::int AS message_count
        FROM messages WHERE role='assistant' AND cost_usd IS NOT NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL AND created_at >= $1
        AND conversation_id IN (SELECT id FROM conversations WHERE user_id=$2)
        GROUP BY provider_id,model_id ORDER BY cost_usd DESC`, [since, userId]),
    ]);
    return {
      totalCostUsd: daily.reduce((sum, row) => sum + number(row.cost_usd), 0),
      daily: daily.map((row) => ({ day: text(row.day), costUsd: number(row.cost_usd), messageCount: number(row.message_count) })),
      byModel: byModel.flatMap((row) => {
        const id = providerId(row.provider_id);
        return id ? [{ providerId: id, modelId: text(row.model_id), costUsd: number(row.cost_usd), messageCount: number(row.message_count) }] : [];
      }),
    };
  }
}
