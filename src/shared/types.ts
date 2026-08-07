import { z } from 'zod';

export const BUILTIN_PROVIDER_IDS = ['deepseek', 'glm', 'kimi', 'openrouter', 'ollama'] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

/**
 * Provedores personalizados são declarados em tempo de execução, então o id é
 * validado por formato e não por lista fechada. Conversas antigas continuam
 * válidas mesmo que o provedor que as criou saia da configuração.
 */
export const ProviderIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/u,
    'O id do provedor deve ter de 1 a 32 caracteres: minúsculas, dígitos e hífen.',
  );
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ErrorCodeSchema = z.enum([
  'RATE_LIMIT',
  'INSUFFICIENT_BALANCE',
  'CONTEXT_LENGTH_EXCEEDED',
  'INVALID_API_KEY',
  'MODEL_NOT_FOUND',
  'UPSTREAM_TIMEOUT',
  'UNAUTHORIZED',
  'UNKNOWN',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Nível de raciocínio pedido ao modelo.
 *
 * `auto` é o padrão e significa "não envie parâmetro nenhum": o provedor
 * decide, que é exatamente o comportamento anterior a esta funcionalidade.
 * Isso importa porque cada provedor nomeia o parâmetro de um jeito e um
 * campo desconhecido pode virar 400 — quem não escolhe, não arrisca.
 *
 * `off` pede para suprimir o raciocínio; onde o provedor não sabe desligar,
 * o mapeamento cai no menor esforço possível (ver `src/server/effort.ts`).
 *
 * `xhigh` e `max` são degraus acima de `high` que a OpenRouter declara em
 * `supported_efforts` — 60 e 41 modelos do catálogo dela, respectivamente. Não
 * existem na convenção da OpenAI (`minimal|low|medium|high`), e por isso o
 * mapeamento os fecha em `high` nos outros dialetos, em vez de deixar o 400
 * derrubar tudo para o padrão do provedor.
 */
export const EffortLevelSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const ArtifactKindSchema = z.enum(['markdown', 'code', 'svg', 'mermaid']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const ArtifactVersionSchema = z.object({
  version: z.number().int().positive(),
  content: z.string(),
  operation: z.enum(['create', 'rewrite', 'update']),
  messageId: z.string().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  truncated: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  slug: ArtifactSlugSchema,
  kind: ArtifactKindSchema,
  language: z.string().max(32).nullable(),
  title: z.string().min(1).max(120),
  currentVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  versions: z.array(ArtifactVersionSchema),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const CostSchema = z.object({
  usd: z.number().nonnegative().nullable(),
  estimated: z.boolean(),
  pricingAvailable: z.boolean(),
});
export type Cost = z.infer<typeof CostSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

const SseBaseSchema = z.object({
  conversationId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
});

export const SseTextSchema = SseBaseSchema.extend({
  type: z.literal('text'),
  text: z.string(),
});

export const SseReasoningSchema = SseBaseSchema.extend({
  type: z.literal('reasoning'),
  reasoning: z.string(),
});

export const SseUsageSchema = SseBaseSchema.extend({
  type: z.literal('usage'),
  usage: UsageSchema,
  cost: CostSchema,
});

export const SseErrorSchema = SseBaseSchema.extend({
  type: z.literal('error'),
  error: ApiErrorSchema,
});

export const SseDoneSchema = SseBaseSchema.extend({
  type: z.literal('done'),
  done: z.literal(true),
  finishReason: z.string().optional(),
  truncated: z.boolean().optional(),
  usage: UsageSchema.optional(),
  cost: CostSchema.optional(),
});

export const SseArtifactStartSchema = SseBaseSchema.extend({
  type: z.literal('artifact_start'),
  slug: ArtifactSlugSchema,
  kind: ArtifactKindSchema,
  language: z.string().max(32).nullable(),
  title: z.string().min(1).max(120),
  version: z.number().int().positive(),
  operation: z.enum(['create', 'rewrite', 'update']),
});

export const SseArtifactDeltaSchema = SseBaseSchema.extend({
  type: z.literal('artifact_delta'),
  slug: ArtifactSlugSchema,
  text: z.string(),
});

export const SseArtifactEndSchema = SseBaseSchema.extend({
  type: z.literal('artifact_end'),
  slug: ArtifactSlugSchema,
  version: z.number().int().positive(),
  truncated: z.boolean(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});

export const SseEnvelopeSchema = z.discriminatedUnion('type', [
  SseTextSchema,
  SseReasoningSchema,
  SseUsageSchema,
  SseErrorSchema,
  SseDoneSchema,
  SseArtifactStartSchema,
  SseArtifactDeltaSchema,
  SseArtifactEndSchema,
]);
export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;

export const ModelPricingSchema = z.object({
  inputPerMillion: z.number().nonnegative().nullable(),
  cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
  outputPerMillion: z.number().nonnegative().nullable(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ModelCatalogItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  reasoning: z.boolean(),
  pricing: ModelPricingSchema,
});
export type ModelCatalogItem = z.infer<typeof ModelCatalogItemSchema>;

export const ProviderCatalogSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  configured: z.boolean(),
  verifiedAt: z.string(),
  stale: z.boolean(),
  /** 'custom' identifica provedores vindos da configuração do usuário. */
  source: z.enum(['builtin', 'custom']),
  models: z.array(ModelCatalogItemSchema),
});
export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

export const ModelsResponseSchema = z.object({
  providers: z.array(ProviderCatalogSchema),
  defaultProviderId: ProviderIdSchema,
  defaultModelId: z.string().min(1),
  /**
   * Erros de configuração de provedores personalizados. Nunca são silenciosos:
   * uma entrada inválida aparece aqui e a interface mostra ao usuário.
   */
  configErrors: z.array(z.string()),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export const ProviderModelInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(160).optional(),
  ctx: z
    .number({ error: 'Informe a janela de contexto do modelo, em tokens.' })
    .int('A janela precisa ser um número inteiro de tokens.')
    .positive('A janela precisa ser maior que zero.'),
  reasoning: z.boolean().optional(),
  pricing: z
    .object({
      inputPerMillion: z.number().nonnegative().nullable().optional(),
      cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
      outputPerMillion: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
});
export type ProviderModelInput = z.infer<typeof ProviderModelInputSchema>;

export const ProviderSettingsInputSchema = z.object({
  label: z.string().trim().min(1, 'Dê um nome ao provedor.').max(80),
  baseURL: z.string().url('A URL base precisa ser absoluta, incluindo https://'),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
  /** A lista é preenchida automaticamente pelo endpoint /models do provedor. */
  models: z.array(ProviderModelInputSchema).default([]),
  /** string grava a chave; null apaga; ausente mantém a que já existe. */
  apiKey: z.string().max(500).nullable().optional(),
});
export type ProviderSettingsInput = z.infer<typeof ProviderSettingsInputSchema>;

/** Forma devolvida ao navegador. Nunca inclui a chave — apenas `hasKey`. */
export const ProviderSettingsSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  baseURL: z.string().min(1),
  verifiedAt: z.string().nullable(),
  models: z.array(ProviderModelInputSchema),
  hasKey: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const ProviderSettingsResponseSchema = z.object({
  providers: z.array(ProviderSettingsSchema),
  secretStorage: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type ProviderSettingsResponse = z.infer<typeof ProviderSettingsResponseSchema>;

export const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).nullable().optional(),
  content: z.string().trim().min(1, 'A mensagem não pode ficar vazia.').max(200_000),
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  /** Ausente equivale a `auto`: nenhum parâmetro de raciocínio é enviado. */
  effort: EffortLevelSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  effort: EffortLevelSchema.optional(),
});
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  effort: EffortLevelSchema.optional(),
  archived: z.boolean().optional(),
});
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  reasoning: z.string().nullable(),
  providerId: ProviderIdSchema.nullable(),
  modelId: z.string().nullable(),
  usage: UsageSchema.nullable(),
  cost: CostSchema.nullable(),
  finishReason: z.string().nullable(),
  errorCode: ErrorCodeSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  providerId: ProviderIdSchema,
  modelId: z.string(),
  systemPrompt: z.string().nullable(),
  /** Conversas criadas antes desta coluna existir leem como `auto`. */
  effort: EffortLevelSchema.default('auto'),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationSchema = ConversationSummarySchema.extend({
  messages: z.array(MessageSchema),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});
export type ConversationsResponse = z.infer<typeof ConversationsResponseSchema>;

export const ConversationResponseSchema = z.object({
  conversation: ConversationSchema,
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(ConversationSummarySchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const DeleteResponseSchema = z.object({
  ok: z.literal(true),
});
export type DeleteResponse = z.infer<typeof DeleteResponseSchema>;

export const CostDailyAggregateSchema = z.object({
  day: z.string().min(1),
  costUsd: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});
export type CostDailyAggregate = z.infer<typeof CostDailyAggregateSchema>;

export const CostModelAggregateSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  costUsd: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});
export type CostModelAggregate = z.infer<typeof CostModelAggregateSchema>;

export const CostAnalyticsResponseSchema = z.object({
  totalCostUsd: z.number().nonnegative(),
  daily: z.array(CostDailyAggregateSchema),
  byModel: z.array(CostModelAggregateSchema),
});
export type CostAnalyticsResponse = z.infer<typeof CostAnalyticsResponseSchema>;
