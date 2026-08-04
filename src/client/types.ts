export type ThemeMode = 'light' | 'dark';

export type DensityMode = 'comfortable' | 'compact';

export type ArtifactKind = 'markdown' | 'code' | 'svg' | 'mermaid';

export type ArtifactOperation = 'create' | 'rewrite' | 'update';

export interface ArtifactVersion {
  version: number;
  content: string;
  operation: ArtifactOperation;
  messageId: string | null;
  outputTokens: number | null;
  costUsd: number | null;
  truncated: boolean;
  createdAt: string | number;
}

export interface Artifact {
  id: string;
  conversationId: string;
  slug: string;
  kind: ArtifactKind;
  language: string | null;
  title: string;
  currentVersion: number;
  createdAt: string | number;
  updatedAt: string | number;
  versions: ArtifactVersion[];
}

export interface ArtifactStartEnvelope {
  type: 'artifact_start';
  slug: string;
  kind: ArtifactKind;
  language: string | null;
  title: string;
  version: number;
  operation: ArtifactOperation;
}

export interface ArtifactDeltaEnvelope {
  type: 'artifact_delta';
  slug: string;
  text: string;
}

export interface ArtifactEndEnvelope {
  type: 'artifact_end';
  slug: string;
  version: number;
  truncated: boolean;
  outputTokens: number | null;
  costUsd: number | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'aborted';

export type StreamErrorCode =
  | 'RATE_LIMIT'
  | 'INSUFFICIENT_BALANCE'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'INVALID_API_KEY'
  | 'MODEL_NOT_FOUND'
  | 'UPSTREAM_TIMEOUT'
  | 'UNKNOWN';

export interface Usage {
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costEstimated?: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId?: string;
  role: MessageRole;
  content: string;
  reasoning?: string;
  usage?: Usage;
  costUsd?: number;
  costEstimated?: boolean;
  status?: MessageStatus;
  errorCode?: StreamErrorCode | string;
  errorMessage?: string;
  finishReason?: string;
  truncated?: boolean;
  createdAt?: string | number;
}

export interface Conversation {
  id: string;
  title: string;
  providerId?: string;
  modelId?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  totalCostUsd?: number;
  messageCount?: number;
  archived?: boolean;
}

export interface ModelOption {
  id: string;
  providerId: string;
  providerLabel: string;
  label: string;
  contextWindow?: number;
  inputPriceUsdPerMillion?: number;
  outputPriceUsdPerMillion?: number;
  reasoning?: boolean;
  verifiedAt?: string;
  configured?: boolean;
  stale?: boolean;
}

export interface StreamUsageEnvelope {
  prompt_tokens?: number;
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  cost_estimated?: boolean;
  [key: string]: unknown;
}

export interface StreamErrorEnvelope {
  code?: StreamErrorCode | string;
  message?: string;
  details?: string;
}

export interface StreamEnvelope {
  type: 'text' | 'reasoning' | 'usage' | 'error' | 'done' | string;
  text?: string;
  reasoning?: string;
  usage?: StreamUsageEnvelope;
  error?: StreamErrorEnvelope;
  code?: StreamErrorCode | string;
  message?: string;
  finish_reason?: string;
  truncated?: boolean;
  [key: string]: unknown;
}

export interface CostAnalytics {
  totalCostUsd: number;
  daily: Array<{ day: string; costUsd: number; messageCount: number }>;
  byModel: Array<{ providerId: string; modelId: string; costUsd: number; messageCount: number }>;
}

export interface ProviderModelInput {
  id: string;
  label?: string;
  ctx: number;
  reasoning?: boolean;
  pricing?: {
    inputPerMillion?: number | null;
    outputPerMillion?: number | null;
    cachedInputPerMillion?: number | null;
  };
}

/** O que o servidor devolve: nunca inclui a chave, só se ela existe. */
export interface ProviderSettings {
  id: string;
  label: string;
  baseURL: string;
  verifiedAt: string | null;
  models: ProviderModelInput[];
  hasKey: boolean;
  updatedAt: number;
}

export interface SecretStorageStatus {
  available: boolean;
  reason: string | null;
}

export interface ChatRequest {
  conversationId: string;
  content: string;
  providerId: string;
  modelId: string;
}

export const EMPTY_MESSAGES: ChatMessage[] = [];
/** Referência estável para seletores Zustand usados com React 19. */
export const EMPTY_ARTIFACTS: Artifact[] = [];
