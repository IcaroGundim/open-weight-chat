import type {
  Artifact,
  ArtifactVersion,
  Conversation,
  ConversationSummary,
  CostAnalyticsResponse,
  Message,
} from '../../shared/types';
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

export type Awaitable<T> = T | Promise<T>;

/**
 * Contrato comum ao SQLite local e ao Neon assíncrono da Vercel.
 *
 * Multiusuário (BYOK): toda operação recebe `userId` como primeiro parâmetro
 * (o id externo do Clerk, ex.: `user_...`). A propriedade é verificada no SQL
 * via `conversations.user_id` — recursos de outro usuário NÃO existem para
 * quem pergunta (retornam null/vazio, nunca erro de permissão).
 */
export interface ChatDatabaseAdapter {
  /** Garante a existência do usuário na tabela `users` (upsert idempotente). */
  ensureUser(userId: string): Awaitable<void>;
  createConversation(userId: string, data: CreateConversationData): Awaitable<Conversation>;
  listConversations(userId: string, options?: { includeArchived?: boolean }): Awaitable<ConversationSummary[]>;
  getConversation(userId: string, id: string): Awaitable<Conversation | null>;
  updateConversation(userId: string, id: string, data: UpdateConversationData): Awaitable<Conversation | null>;
  deleteConversation(userId: string, id: string): Awaitable<boolean>;
  getMessages(userId: string, conversationId: string): Awaitable<Message[]>;
  insertMessage(userId: string, data: CreateMessageData): Awaitable<Message>;
  updateMessage(userId: string, id: string, data: UpdateMessageData): Awaitable<Message | null>;
  upsertArtifact(userId: string, data: UpsertArtifactData): Awaitable<Artifact>;
  insertArtifactVersion(userId: string, data: InsertArtifactVersionData): Awaitable<ArtifactVersion>;
  getArtifacts(userId: string, conversationId: string): Awaitable<Artifact[]>;
  getArtifactVersion(userId: string, conversationId: string, slug: string, version: number): Awaitable<ArtifactVersion | null>;
  updateArtifactVersionCost(userId: string, conversationId: string, slug: string, version: number, outputTokens: number | null, costUsd: number | null): Awaitable<boolean>;
  listProviderSettings(userId: string): Awaitable<ProviderSettingsRecord[]>;
  upsertProviderSettings(userId: string, data: UpsertProviderSettingsData): Awaitable<ProviderSettingsRecord>;
  deleteProviderSettings(userId: string, id: string): Awaitable<boolean>;
  searchConversations(userId: string, query: string): Awaitable<ConversationSummary[]>;
  getCostAnalytics(userId: string, days?: number): Awaitable<CostAnalyticsResponse>;
}
