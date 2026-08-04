import type {
  ChatMessage,
  ChatRequest,
  CostAnalytics,
  Conversation,
  Artifact,
  ArtifactDeltaEnvelope,
  ArtifactEndEnvelope,
  ArtifactStartEnvelope,
  ArtifactKind,
  ArtifactOperation,
  ModelOption,
  ProviderModelInput,
  ProviderSettings,
  SecretStorageStatus,
  StreamEnvelope,
  StreamErrorEnvelope,
  StreamUsageEnvelope,
  Usage,
} from './types';

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: string;

  constructor(message: string, status = 0, code?: string, details?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function contentToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      return asString(part.text) || asString(part.content);
    })
    .join('');
}

function firstRecord(...values: unknown[]): JsonRecord | undefined {
  return values.find(isRecord);
}

function stableId(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

function normalizeUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const cost = isRecord(value.cost) ? value.cost : undefined;
  const promptTokens = asNumber(value.prompt_tokens ?? value.promptTokens ?? value.input_tokens);
  const cachedPromptTokens = asNumber(
    value.cached_tokens ?? value.cachedTokens ?? value.prompt_cache_hit_tokens ?? value.promptCacheHitTokens,
  );
  const completionTokens = asNumber(
    value.completion_tokens ?? value.completionTokens ?? value.output_tokens,
  );
  const reasoningTokens = asNumber(value.reasoning_tokens ?? value.reasoningTokens);
  const totalTokens = asNumber(value.total_tokens ?? value.totalTokens);
  const costUsd = asNumber(value.cost_usd ?? value.costUsd ?? cost?.usd);
  const costEstimated = asBoolean(value.cost_estimated ?? value.costEstimated ?? value.estimated ?? cost?.estimated);

  if (
    promptTokens === undefined &&
    cachedPromptTokens === undefined &&
    completionTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined &&
    costUsd === undefined &&
    costEstimated === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    cachedPromptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    costUsd,
    costEstimated,
  };
}

function normalizeMessage(value: unknown, index: number, conversationId?: string): ChatMessage | null {
  if (!isRecord(value)) return null;
  const role = asString(value.role, 'assistant');
  const safeRole = role === 'user' || role === 'system' ? role : 'assistant';
  const usage = normalizeUsage(value.usage);
  const messageCost = isRecord(value.cost) ? value.cost : undefined;
  const costUsd = asNumber(value.cost_usd ?? value.costUsd ?? messageCost?.usd ?? usage?.costUsd);

  return {
    id: asString(value.id ?? value.messageId, stableId('message', index)),
    conversationId: asString(value.conversation_id ?? value.conversationId, conversationId),
    role: safeRole,
    content: contentToString(value.content ?? value.text),
    reasoning: contentToString(value.reasoning ?? value.reasoning_content),
    usage,
    costUsd,
    costEstimated: asBoolean(value.cost_estimated ?? value.costEstimated ?? messageCost?.estimated ?? usage?.costEstimated),
    status: value.error_code || value.errorCode ? 'error' : (value.finish_reason ?? value.finishReason) === 'aborted' ? 'aborted' : 'complete',
    errorCode: asString(value.error_code ?? value.errorCode) || undefined,
    errorMessage: asString(value.error_message ?? value.errorMessage) || undefined,
    finishReason: asString(value.finish_reason ?? value.finishReason) || undefined,
    createdAt: (value.created_at ?? value.createdAt) as string | number | undefined,
  };
}

function normalizeConversation(value: unknown, index: number): Conversation | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id ?? value.conversationId);
  if (!id) return null;

  return {
    id,
    title: asString(value.title, 'Nova conversa'),
    providerId: asString(value.provider_id ?? value.providerId) || undefined,
    modelId: asString(value.model_id ?? value.modelId) || undefined,
    createdAt: (value.created_at ?? value.createdAt) as string | number | undefined,
    updatedAt: (value.updated_at ?? value.updatedAt) as string | number | undefined,
    totalCostUsd: asNumber(value.total_cost_usd ?? value.totalCostUsd ?? value.cost_usd),
    messageCount: asNumber(value.message_count ?? value.messageCount),
    archived: typeof value.archived === 'boolean' ? value.archived : undefined,
  };
}

const artifactKinds: ArtifactKind[] = ['markdown', 'code', 'svg', 'mermaid'];
const artifactOperations: ArtifactOperation[] = ['create', 'rewrite', 'update'];

function normalizeArtifactVersion(value: unknown): Artifact['versions'][number] | null {
  if (!isRecord(value)) return null;
  const version = asNumber(value.version);
  if (!version || version < 1) return null;
  return {
    version,
    content: asString(value.content),
    operation: artifactOperations.includes(value.operation as ArtifactOperation)
      ? value.operation as ArtifactOperation
      : 'create',
    messageId: asString(value.message_id ?? value.messageId) || null,
    outputTokens: asNumber(value.output_tokens ?? value.outputTokens) ?? null,
    costUsd: asNumber(value.cost_usd ?? value.costUsd) ?? null,
    truncated: value.truncated === true || value.truncated === 1,
    createdAt: (value.created_at ?? value.createdAt) as string | number | undefined ?? Date.now(),
  };
}

export function normalizeArtifact(value: unknown, conversationId?: string): Artifact | null {
  if (!isRecord(value)) return null;
  const slug = asString(value.slug);
  const id = asString(value.id ?? value.artifactId);
  const kind = asString(value.kind) as ArtifactKind;
  const title = asString(value.title);
  if (!id || !slug || !title || !artifactKinds.includes(kind)) return null;
  const versionsValue = Array.isArray(value.versions) ? value.versions : [];
  const versions = versionsValue
    .map(normalizeArtifactVersion)
    .filter((version): version is Artifact['versions'][number] => Boolean(version));
  const currentVersion = asNumber(value.current_version ?? value.currentVersion)
    ?? versions.at(-1)?.version
    ?? 1;
  return {
    id,
    conversationId: asString(value.conversation_id ?? value.conversationId, conversationId),
    slug,
    kind,
    language: asString(value.language) || null,
    title,
    currentVersion,
    createdAt: (value.created_at ?? value.createdAt) as string | number | undefined ?? Date.now(),
    updatedAt: (value.updated_at ?? value.updatedAt) as string | number | undefined ?? Date.now(),
    versions: versions.sort((a, b) => a.version - b.version),
  };
}

export function normalizeArtifacts(payload: unknown, conversationId?: string): Artifact[] {
  const root = unwrapPayload(payload, ['artifacts', 'data']);
  const values = Array.isArray(root) ? root : isRecord(root) ? [root] : [];
  return values
    .map((value) => normalizeArtifact(value, conversationId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
}

function unwrapPayload(payload: unknown, keys: string[]): unknown {
  if (!isRecord(payload)) return payload;
  for (const key of keys) {
    if (key in payload) return payload[key];
  }
  return payload;
}

export function normalizeModels(payload: unknown): ModelOption[] {
  const root = unwrapPayload(payload, ['models', 'data', 'providers']);
  const rows: Array<{ value: unknown; providerId?: string; providerLabel?: string }> = [];

  if (Array.isArray(root)) {
    root.forEach((value) => rows.push({ value }));
  } else if (isRecord(root)) {
    Object.entries(root).forEach(([providerId, value]) => {
      if (Array.isArray(value)) {
        value.forEach((model) => rows.push({ value: model, providerId }));
      }
    });
  }

  const expanded: ModelOption[] = [];
  rows.forEach(({ value, providerId: inheritedProviderId, providerLabel: inheritedProviderLabel }, index) => {
    if (!isRecord(value)) return;
    const nestedModels = value.models;
    if (Array.isArray(nestedModels)) {
      const groupId = asString(value.id ?? value.provider_id ?? value.providerId, inheritedProviderId || `provider-${index}`);
      const groupLabel = asString(value.label ?? value.name, groupId);
      nestedModels.forEach((model, nestedIndex) => {
        const normalized = normalizeModel(
          model,
          nestedIndex,
          groupId,
          groupLabel,
          typeof value.configured === 'boolean' ? value.configured : undefined,
          typeof value.stale === 'boolean' ? value.stale : undefined,
        );
        if (normalized) expanded.push(normalized);
      });
      return;
    }

    const normalized = normalizeModel(value, index, inheritedProviderId, inheritedProviderLabel);
    if (normalized) expanded.push(normalized);
  });

  return expanded;
}

function normalizeModel(
  value: JsonRecord,
  index: number,
  inheritedProviderId?: string,
  inheritedProviderLabel?: string,
  inheritedConfigured?: boolean,
  inheritedStale?: boolean,
): ModelOption | null {
  const id = asString(value.id ?? value.model_id ?? value.modelId);
  if (!id) return null;
  const providerValue = firstRecord(value.provider);
  const providerId = asString(
    value.provider_id ?? value.providerId ?? (typeof value.provider === 'string' ? value.provider : undefined),
    inheritedProviderId || 'default',
  );
  const providerLabel = asString(
    value.provider_label ?? value.providerLabel ?? providerValue?.label ?? value.provider_name,
    inheritedProviderLabel || providerId,
  );

  return {
    id,
    providerId,
    providerLabel,
    label: asString(value.label ?? value.name, id),
    contextWindow: asNumber(value.ctx ?? value.context_window ?? value.contextWindow),
    inputPriceUsdPerMillion: asNumber(value.in ?? value.input_price ?? value.inputPriceUsdPerMillion ?? (isRecord(value.pricing) ? value.pricing.inputPerMillion : undefined)),
    outputPriceUsdPerMillion: asNumber(value.out ?? value.output_price ?? value.outputPriceUsdPerMillion ?? (isRecord(value.pricing) ? value.pricing.outputPerMillion : undefined)),
    reasoning: typeof value.reasoning === 'boolean' ? value.reasoning : undefined,
    verifiedAt: asString(value.verifiedAt ?? value.verified_at) || undefined,
    configured: typeof value.configured === 'boolean' ? value.configured : inheritedConfigured,
    stale: typeof value.stale === 'boolean' ? value.stale : inheritedStale,
  };
}

export function normalizeConversations(payload: unknown): Conversation[] {
  const root = unwrapPayload(payload, ['conversations', 'data']);
  const values = Array.isArray(root) ? root : isRecord(root) ? [root] : [];
  return values
    .map((value, index) => normalizeConversation(value, index))
    .filter((value): value is Conversation => Boolean(value));
}

export function normalizeMessages(payload: unknown, conversationId?: string): ChatMessage[] {
  const conversation = isRecord(payload) && isRecord(payload.conversation) ? payload.conversation : undefined;
  const root = isRecord(payload) && 'messages' in payload
    ? payload.messages
    : isRecord(payload) && 'data' in payload
      ? payload.data
      : conversation?.messages;
  const values = Array.isArray(root) ? root : isRecord(root) && 'message' in root ? [root.message] : [];
  return values
    .map((value, index) => normalizeMessage(value, index, conversationId))
    .filter((value): value is ChatMessage => Boolean(value));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function requestJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Não foi possível conectar ao servidor.');
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const record = isRecord(payload) ? payload : undefined;
    const errorRecord = firstRecord(record?.error, record?.details);
    throw new ApiError(
      asString(record?.message ?? errorRecord?.message, `Falha na requisição (${response.status}).`),
      response.status,
      asString(record?.code ?? errorRecord?.code) || undefined,
      asString(record?.details ?? errorRecord?.details) || undefined,
    );
  }
  return payload as T;
}

export async function getModels(): Promise<{ models: ModelOption[]; configErrors: string[] }> {
  const payload = await requestJson('/api/models', { headers: { Accept: 'application/json' } });
  const models = normalizeModels(payload);
  const rawErrors = isRecord(payload) && Array.isArray(payload.configErrors) ? payload.configErrors : [];
  const configErrors = rawErrors.map((value) => asString(value)).filter((value) => value.length > 0);
  const defaultModelId = isRecord(payload) ? asString(payload.defaultModelId) : '';
  const defaultIndex = defaultModelId ? models.findIndex((model) => model.id === defaultModelId) : -1;
  const ordered = defaultIndex > 0
    ? [models[defaultIndex], ...models.slice(0, defaultIndex), ...models.slice(defaultIndex + 1)]
    : models;
  return { models: ordered, configErrors };
}

export async function getProviderSettings(): Promise<{ providers: ProviderSettings[]; secretStorage: SecretStorageStatus }> {
  const payload = await requestJson('/api/providers', { headers: { Accept: 'application/json' } });
  const record = isRecord(payload) ? payload : {};
  const storage = isRecord(record.secretStorage) ? record.secretStorage : {};
  return {
    providers: Array.isArray(record.providers) ? (record.providers as ProviderSettings[]) : [],
    secretStorage: {
      available: storage.available === true,
      reason: typeof storage.reason === 'string' ? storage.reason : null,
    },
  };
}

/**
 * `apiKey` ausente mantém a chave já gravada; `null` apaga; string grava.
 * A chave sobe uma vez e nunca volta — o servidor só informa se ela existe.
 */
export async function saveProviderSettings(
  id: string,
  input: { label: string; baseURL: string; models: ProviderModelInput[]; verifiedAt?: string | null; apiKey?: string | null },
): Promise<ProviderSettings> {
  const payload = await requestJson(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { ...JSON_HEADERS, Accept: 'application/json' },
    body: JSON.stringify(input),
  });
  const record = isRecord(payload) && isRecord(payload.provider) ? payload.provider : {};
  return record as unknown as ProviderSettings;
}

export async function deleteProviderSettings(id: string): Promise<void> {
  await requestJson(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: JSON_HEADERS });
}

export async function getCostAnalytics(days = 30): Promise<CostAnalytics> {
  const payload = await requestJson(`/api/analytics/costs?days=${encodeURIComponent(String(days))}`, {
    headers: { Accept: 'application/json' },
  });
  const record = isRecord(payload) ? payload : {};
  const daily = Array.isArray(record.daily) ? record.daily : [];
  const byModel = Array.isArray(record.byModel) ? record.byModel : [];
  return {
    totalCostUsd: asNumber(record.totalCostUsd) ?? 0,
    daily: daily.flatMap((value) => {
      if (!isRecord(value)) return [];
      const day = asString(value.day);
      if (!day) return [];
      return [{ day, costUsd: asNumber(value.costUsd) ?? 0, messageCount: asNumber(value.messageCount) ?? 0 }];
    }),
    byModel: byModel.flatMap((value) => {
      if (!isRecord(value)) return [];
      const providerId = asString(value.providerId);
      const modelId = asString(value.modelId);
      if (!providerId || !modelId) return [];
      return [{ providerId, modelId, costUsd: asNumber(value.costUsd) ?? 0, messageCount: asNumber(value.messageCount) ?? 0 }];
    }),
  };
}

export async function searchConversations(query: string): Promise<Conversation[]> {
  const payload = await requestJson(`/api/conversations/search?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json' },
  });
  return normalizeConversations({ conversations: isRecord(payload) && Array.isArray(payload.results) ? payload.results : [] });
}

export async function getConversations(): Promise<Conversation[]> {
  const payload = await requestJson('/api/conversations', { headers: { Accept: 'application/json' } });
  return normalizeConversations(payload);
}

export async function getConversation(id: string): Promise<{ conversation?: Conversation; messages: ChatMessage[] }> {
  try {
    const payload = await requestJson(`/api/conversations/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
    const conversationPayload = unwrapPayload(payload, ['conversation']);
    return {
      conversation: normalizeConversation(conversationPayload, 0) ?? undefined,
      messages: normalizeMessages(payload, id),
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const payload = await requestJson(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      headers: { Accept: 'application/json' },
    });
    return { messages: normalizeMessages(payload, id) };
  }
}

export async function getArtifacts(conversationId: string): Promise<Artifact[]> {
  const payload = await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/artifacts`, {
    headers: { Accept: 'application/json' },
  });
  return normalizeArtifacts(payload, conversationId);
}

export async function getArtifactVersion(
  conversationId: string,
  slug: string,
  version: number,
): Promise<Artifact['versions'][number] | undefined> {
  const payload = await requestJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(slug)}/versions/${version}`,
    { headers: { Accept: 'application/json' } },
  );
  const root = unwrapPayload(payload, ['version', 'artifactVersion', 'data']);
  return normalizeArtifactVersion(root) ?? undefined;
}

export async function createConversation(input: {
  title?: string;
  providerId?: string;
  modelId?: string;
}): Promise<Conversation> {
  const payload = await requestJson('/api/conversations', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      title: input.title,
      providerId: input.providerId,
      modelId: input.modelId,
    }),
  });
  const conversation = normalizeConversation(unwrapPayload(payload, ['conversation', 'data']), 0);
  if (!conversation) throw new ApiError('O servidor não retornou uma conversa válida.');
  return conversation;
}

export async function renameConversation(id: string, title: string): Promise<Conversation | undefined> {
  const payload = await requestJson(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  });
  return normalizeConversation(unwrapPayload(payload, ['conversation', 'data']), 0) ?? undefined;
}

export async function deleteConversation(id: string): Promise<void> {
  await requestJson(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
}

function normalizeStreamUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = isRecord(value.usage) ? value.usage : value;
  return normalizeUsage({
    ...usage,
    cost: value.cost,
    cost_usd: value.cost_usd,
    cost_estimated: value.cost_estimated,
  });
}

function normalizeStreamError(value: unknown): StreamErrorEnvelope {
  if (isRecord(value)) {
    return {
      code: asString(value.code ?? value.error_code) || undefined,
      message: asString(value.message ?? value.error) || undefined,
      details: asString(value.details) || undefined,
    };
  }
  return { message: asString(value) || 'O servidor encerrou o stream com erro.' };
}

function readTextDelta(value: JsonRecord): string {
  const direct = value.text ?? value.delta ?? value.content;
  if (typeof direct === 'string') return direct;
  if (isRecord(direct)) return asString(direct.text ?? direct.content ?? direct.value);
  if (Array.isArray(direct)) return contentToString(direct);
  return '';
}

export interface ChatStreamHandlers {
  onText?: (text: string) => void;
  onReasoning?: (reasoning: string) => void;
  onArtifactStart?: (artifact: ArtifactStartEnvelope) => void;
  onArtifactDelta?: (artifact: ArtifactDeltaEnvelope) => void;
  onArtifactEnd?: (artifact: ArtifactEndEnvelope) => void;
  onUsage?: (usage: Usage) => void;
  onError?: (error: StreamErrorEnvelope) => void;
  onDone?: (envelope: StreamEnvelope) => void;
}

function asStreamEnvelope(value: unknown): StreamEnvelope | null {
  if (!isRecord(value)) return null;
  const type = asString(value.type ?? value.event ?? 'text');
  const nested = isRecord(value.data) ? value.data : undefined;
  const source = nested ? { ...value, ...nested } : value;
  return { ...(source as StreamEnvelope), type };
}

export async function streamChat(
  request: ChatRequest,
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { ...JSON_HEADERS, Accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const payload = await readJson(response);
    const record = isRecord(payload) ? payload : undefined;
    const error = normalizeStreamError(record?.error ?? record ?? payload);
    throw new ApiError(error.message || `Falha no chat (${response.status}).`, response.status, error.code, error.details);
  }
  if (!response.body) throw new ApiError('O servidor não iniciou um stream de resposta.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData: string[] = [];
  let ended = false;
  let textBatch = '';
  let reasoningBatch = '';
  const artifactBatches: Record<string, string> = {};
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (textBatch) {
      const value = textBatch;
      textBatch = '';
      handlers.onText?.(value);
    }
    if (reasoningBatch) {
      const value = reasoningBatch;
      reasoningBatch = '';
      handlers.onReasoning?.(value);
    }
    for (const [slug, text] of Object.entries(artifactBatches)) {
      if (!text) continue;
      artifactBatches[slug] = '';
      handlers.onArtifactDelta?.({ type: 'artifact_delta', slug, text });
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, 50);
  };

  const handleEvent = (raw: string) => {
    const payload = raw.trim();
    eventData = [];
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]' && !ended) {
        flush();
        ended = true;
        handlers.onDone?.({ type: 'done' });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      parsed = { type: 'text', text: payload };
    }
    const envelope = asStreamEnvelope(parsed);
    if (!envelope || ended) return;

    const type = envelope.type.toLowerCase();
    if (type === 'text' || type === 'chunk' || type === 'delta') {
      const text = readTextDelta(envelope);
      if (text) {
        textBatch += text;
        scheduleFlush();
      }
      const reasoning = asString(envelope.reasoning ?? envelope.reasoning_content);
      if (reasoning) {
        reasoningBatch += reasoning;
        scheduleFlush();
      }
      return;
    }
    if (type === 'reasoning' || type === 'thinking') {
      const reasoning = asString(envelope.reasoning ?? envelope.reasoning_content ?? readTextDelta(envelope));
      if (reasoning) {
        reasoningBatch += reasoning;
        scheduleFlush();
      }
      return;
    }
    if (type === 'artifact_start') {
      flush();
      const kind = asString(envelope.kind) as ArtifactKind;
      const operation = asString(envelope.operation) as ArtifactOperation;
      const slug = asString(envelope.slug);
      const version = asNumber(envelope.version);
      if (slug && artifactKinds.includes(kind) && artifactOperations.includes(operation) && version) {
        handlers.onArtifactStart?.({
          type: 'artifact_start',
          slug,
          kind,
          language: asString(envelope.language) || null,
          title: asString(envelope.title, slug),
          version,
          operation,
        });
      }
      return;
    }
    if (type === 'artifact_delta') {
      const slug = asString(envelope.slug);
      const text = readTextDelta(envelope);
      if (slug && text) {
        artifactBatches[slug] = (artifactBatches[slug] ?? '') + text;
        scheduleFlush();
      }
      return;
    }
    if (type === 'artifact_end') {
      flush();
      const slug = asString(envelope.slug);
      const version = asNumber(envelope.version);
      if (slug && version) {
        handlers.onArtifactEnd?.({
          type: 'artifact_end',
          slug,
          version,
          truncated: envelope.truncated === true,
          outputTokens: asNumber(envelope.outputTokens ?? envelope.output_tokens) ?? null,
          costUsd: asNumber(envelope.costUsd ?? envelope.cost_usd) ?? null,
        });
      }
      return;
    }
    if (type === 'usage') {
      flush();
      const usage = normalizeStreamUsage(envelope);
      if (usage) handlers.onUsage?.(usage);
      return;
    }
    if (type === 'error') {
      flush();
      ended = true;
      handlers.onError?.(normalizeStreamError(envelope.error ?? envelope));
      return;
    }
    if (type === 'done' || type === 'complete') {
      flush();
      ended = true;
      handlers.onDone?.(envelope);
    }
  };

  const handleLine = (line: string) => {
    if (line === '') {
      if (eventData.length) handleEvent(eventData.join('\n'));
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
  };

  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd >= 0) {
        handleLine(buffer.slice(0, lineEnd));
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
    if (eventData.length && !ended) handleEvent(eventData.join('\n'));
    flush();
    if (!ended) {
      ended = true;
      handlers.onDone?.({ type: 'done' });
    }
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    reader.releaseLock();
  }
}
