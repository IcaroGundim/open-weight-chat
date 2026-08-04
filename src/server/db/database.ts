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

/** Contrato comum ao SQLite local e ao Neon assíncrono da Vercel. */
export interface ChatDatabaseAdapter {
  createConversation(data: CreateConversationData): Awaitable<Conversation>;
  listConversations(options?: { includeArchived?: boolean }): Awaitable<ConversationSummary[]>;
  getConversation(id: string): Awaitable<Conversation | null>;
  updateConversation(id: string, data: UpdateConversationData): Awaitable<Conversation | null>;
  deleteConversation(id: string): Awaitable<boolean>;
  getMessages(conversationId: string): Awaitable<Message[]>;
  insertMessage(data: CreateMessageData): Awaitable<Message>;
  updateMessage(id: string, data: UpdateMessageData): Awaitable<Message | null>;
  upsertArtifact(data: UpsertArtifactData): Awaitable<Artifact>;
  insertArtifactVersion(data: InsertArtifactVersionData): Awaitable<ArtifactVersion>;
  getArtifacts(conversationId: string): Awaitable<Artifact[]>;
  getArtifactVersion(conversationId: string, slug: string, version: number): Awaitable<ArtifactVersion | null>;
  updateArtifactVersionCost(conversationId: string, slug: string, version: number, outputTokens: number | null, costUsd: number | null): Awaitable<boolean>;
  listProviderSettings(): Awaitable<ProviderSettingsRecord[]>;
  upsertProviderSettings(data: UpsertProviderSettingsData): Awaitable<ProviderSettingsRecord>;
  deleteProviderSettings(id: string): Awaitable<boolean>;
  searchConversations(query: string): Awaitable<ConversationSummary[]>;
  getCostAnalytics(days?: number): Awaitable<CostAnalyticsResponse>;
}
