import { ApiError, authHeaders } from './token-provider';
import { isEffortLevel } from './types';
import type {
  Attachment,
  ScienceDraft,
  ScienceStageEvent,
  TraceEvent,
  ChatMessage,
  ChatRequest,
  EffortLevel,
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
  SearchEndEnvelope,
  SearchResult,
  SearchSettings,
  SearchStartEnvelope,
  SecretStorageStatus,
  StreamEnvelope,
  StreamErrorEnvelope,
  StreamUsageEnvelope,
  SpreadsheetWorkbook,
  SpreadsheetReadyEnvelope,
  Usage,
} from './types';

export { ApiError };

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

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

function normalizeAttachment(value: unknown): Attachment | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const kind = asString(value.kind);
  if (!id || (kind !== 'image' && kind !== 'document' && kind !== 'spreadsheet')) return null;
  const spreadsheet = isRecord(value.spreadsheet) ? value.spreadsheet : undefined;
  return {
    id,
    kind,
    filename: asString(value.filename, 'arquivo'),
    mime: asString(value.mime, 'application/octet-stream'),
    sizeBytes: asNumber(value.sizeBytes ?? value.size_bytes) ?? 0,
    textChars: asNumber(value.textChars ?? value.text_chars) ?? null,
    truncated: asBoolean(value.truncated) ?? false,
    ...(spreadsheet ? { spreadsheet: {
      sheetNames: Array.isArray(spreadsheet.sheetNames) ? spreadsheet.sheetNames.filter((name): name is string => typeof name === 'string') : [],
      version: asNumber(spreadsheet.version) ?? 1,
    } } : {}),
    createdAt: asNumber(value.createdAt ?? value.created_at) ?? 0,
  };
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
    attachments: Array.isArray(value.attachments)
      ? value.attachments.map(normalizeAttachment).filter((attachment): attachment is Attachment => Boolean(attachment))
      : undefined,
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
    effort: isEffortLevel(value.effort) ? value.effort : undefined,
  };
}

const artifactKinds: ArtifactKind[] = ['markdown', 'code', 'svg', 'mermaid', 'mindmap', 'chart'];
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
    response = await fetch(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(await authHeaders()) },
    });
  } catch (error) {
    // ApiError já carrega a mensagem certa (ex.: 401 de sessão expirada) —
    // não embrulhar em "Não foi possível conectar ao servidor".
    if (error instanceof ApiError) throw error;
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

/** Pede ao servidor para consultar /models usando a chave que ele guarda. */
export async function discoverProviderModels(id: string): Promise<ProviderSettings> {
  const payload = await requestJson(`/api/providers/${encodeURIComponent(id)}/discover-models`, {
    method: 'POST',
    headers: JSON_HEADERS,
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
    let messages = normalizeMessages(payload, id);
    // A API atual separa metadados e mensagens. O fallback acima continua
    // aceitando servidores antigos que devolviam tudo no primeiro endpoint.
    try {
      const messagePayload = await requestJson(`/api/conversations/${encodeURIComponent(id)}/messages`, {
        headers: { Accept: 'application/json' },
      });
      messages = normalizeMessages(messagePayload, id);
    } catch (messageError) {
      if (!(messageError instanceof ApiError) || messageError.status !== 404) throw messageError;
    }
    return {
      conversation: normalizeConversation(conversationPayload, 0) ?? undefined,
      messages,
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

/**
 * Grava a fonte editada à mão e devolve a versão criada.
 *
 * Sempre uma versão nova: o histórico é o que torna seguro editar, porque
 * permite voltar ao que o modelo escreveu.
 */
export async function saveArtifactContent(
  conversationId: string,
  slug: string,
  content: string,
): Promise<Artifact['versions'][number] | undefined> {
  const payload = await requestJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(slug)}`,
    { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ content }) },
  );
  const root = unwrapPayload(payload, ['version', 'artifactVersion', 'data']);
  return normalizeArtifactVersion(root) ?? undefined;
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
  effort?: EffortLevel;
}): Promise<Conversation> {
  const payload = await requestJson('/api/conversations', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      title: input.title,
      providerId: input.providerId,
      modelId: input.modelId,
      effort: input.effort,
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

/**
 * Grava o nível de esforço na conversa assim que o usuário troca, sem esperar
 * o próximo envio: quem mexe no seletor e recarrega a página precisa
 * reencontrar o que escolheu.
 */
export async function setConversationEffort(id: string, effort: EffortLevel): Promise<Conversation | undefined> {
  const payload = await requestJson(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ effort }),
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
  onSpreadsheetReady?: (event: SpreadsheetReadyEnvelope) => void;
  onScienceStage?: (stage: ScienceStageEvent) => void;
  onTrace?: (event: TraceEvent) => void;
  onScienceDelta?: (draft: ScienceDraft) => void;
  onSearchStart?: (search: SearchStartEnvelope) => void;
  onSearchEnd?: (search: SearchEndEnvelope) => void;
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

/** Configuração de busca do usuário. A chave nunca volta — só `hasKey`. */
export async function getSearchSettings(): Promise<{ settings: SearchSettings | null; secretStorage: SecretStorageStatus }> {
  const payload = await requestJson('/api/search-settings', { headers: JSON_HEADERS });
  const record = isRecord(payload) ? payload : {};
  return {
    settings: (record.settings ?? null) as SearchSettings | null,
    secretStorage: (record.secretStorage ?? { available: false, reason: null }) as SecretStorageStatus,
  };
}

export async function putSearchSettings(input: {
  backend: SearchSettings['backend'];
  baseURL?: string;
  /** null apaga a chave; undefined mantém a que já está guardada. */
  apiKey?: string | null;
  maxResults?: number;
  enabled?: boolean;
}): Promise<SearchSettings | null> {
  const payload = await requestJson('/api/search-settings', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  return (isRecord(payload) ? payload.settings : null) as SearchSettings | null;
}

export async function deleteSearchSettings(): Promise<void> {
  await requestJson('/api/search-settings', { method: 'DELETE', headers: JSON_HEADERS });
}

/**
 * Prova a configuração com uma consulta real.
 *
 * Sem isto, um erro de chave ou de URL só apareceria no meio de uma conversa,
 * quando o modelo já parou para esperar.
 */
export async function testSearchSettings(): Promise<SearchResult[]> {
  const payload = await requestJson('/api/search-settings/test', { method: 'POST', headers: JSON_HEADERS });
  const record = isRecord(payload) ? payload : {};
  return Array.isArray(record.results) ? (record.results as SearchResult[]) : [];
}

/**
 * Sobe um arquivo e devolve o anexo já reconhecido pelo servidor.
 *
 * Base64 em JSON, e não multipart: na Vercel o corpo da requisição é
 * reconstruído a partir do que a plataforma já leu, e esse caminho só é
 * confiável para JSON — binário de multipart seria corrompido no caminho
 * (ver requestWithRestoredBody em vercel-handler.ts). O custo é ~33% de
 * volume a mais, já embutido no limite por arquivo.
 */
export async function uploadAttachment(file: File): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Em blocos: `String.fromCharCode(...bytes)` estoura a pilha em arquivos de
  // alguns megabytes, e o erro aparece como "Maximum call stack size exceeded"
  // sem nenhuma relação aparente com upload.
  let binario = '';
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) {
    binario += String.fromCharCode(...bytes.subarray(i, i + BLOCO));
  }
  const payload = await requestJson('/api/attachments', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      filename: file.name || 'arquivo',
      mime: file.type || 'application/octet-stream',
      data: btoa(binario),
    }),
  });
  const record = isRecord(payload) && isRecord(payload.attachment) ? payload.attachment : {};
  return record as unknown as Attachment;
}

export async function deleteAttachment(id: string): Promise<void> {
  await requestJson(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** URL dos bytes da imagem. Autenticada pela mesma sessão das demais rotas. */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

export async function getSpreadsheet(id: string, version?: number): Promise<{ attachment: Attachment; workbook: SpreadsheetWorkbook; version: number; currentVersion: number }> {
  const query = version === undefined ? '' : `?version=${version}`;
  const payload = await requestJson(`/api/attachments/${encodeURIComponent(id)}/spreadsheet${query}`);
  if (!isRecord(payload) || !isRecord(payload.attachment) || !isRecord(payload.workbook) || typeof payload.version !== 'number' || typeof payload.currentVersion !== 'number') {
    throw new ApiError('A resposta da planilha veio em formato inválido.', 500);
  }
  return {
    attachment: payload.attachment as unknown as Attachment,
    workbook: payload.workbook as unknown as SpreadsheetWorkbook,
    version: payload.version,
    currentVersion: payload.currentVersion,
  };
}

export async function saveSpreadsheet(
  id: string,
  workbook: SpreadsheetWorkbook,
  baseVersion: number,
): Promise<{ workbook: SpreadsheetWorkbook; version: number }> {
  const payload = await requestJson(`/api/attachments/${encodeURIComponent(id)}/spreadsheet`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ workbook, baseVersion }),
  });
  if (!isRecord(payload) || !isRecord(payload.workbook) || typeof payload.version !== 'number') {
    throw new ApiError('A resposta ao salvar a planilha veio em formato inválido.', 500);
  }
  return { workbook: payload.workbook as unknown as SpreadsheetWorkbook, version: payload.version };
}

export async function downloadSpreadsheet(id: string, format: 'xlsx' | 'csv', sheet?: string, version?: number): Promise<void> {
  const query = new URLSearchParams({ format });
  if (sheet) query.set('sheet', sheet);
  if (version !== undefined) query.set('version', String(version));
  const response = await fetch(`/api/attachments/${encodeURIComponent(id)}/spreadsheet/export?${query}`, {
    headers: await authHeaders(),
  });
  if (!response.ok) {
    const payload = await readJson(response);
    const record = isRecord(payload) ? payload : undefined;
    throw new ApiError(asString(firstRecord(record?.error, record)?.message, 'Não consegui exportar a planilha.'), response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/u)?.[1] ?? `planilha.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function streamChat(
  request: ChatRequest,
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { ...JSON_HEADERS, Accept: 'text/event-stream', ...(await authHeaders()) },
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
    if (type === 'trace') {
      const scope = asString(envelope.scope);
      const evento = asString(envelope.event);
      if (!scope || !evento) return;
      handlers.onTrace?.({
        scope,
        event: evento,
        detail: asString(envelope.detail) || undefined,
        at: asNumber(envelope.at) ?? 0,
      });
      return;
    }
    if (type === 'science_delta') {
      const role = asString(envelope.role) as ScienceDraft['role'];
      const text = asString(envelope.text);
      if (!role || !text) return;
      // `StreamEnvelope.reasoning` já é declarado como string (o campo do
      // envelope de raciocínio comum), então a leitura precisa ignorar esse
      // tipo em vez de comparar contra ele.
      const ehRaciocinio = (envelope as Record<string, unknown>).reasoning === true;
      handlers.onScienceDelta?.({
        role,
        index: asNumber(envelope.index) ?? 1,
        text: ehRaciocinio ? '' : text,
        reasoning: ehRaciocinio ? text : '',
      });
      return;
    }
    if (type === 'science_stage') {
      // `flush()` antes, como na busca: o progresso não pode aparecer acima do
      // texto que já tinha sido escrito.
      flush();
      const label = asString(envelope.label);
      const role = asString(envelope.role) as ScienceStageEvent['role'];
      if (!label || !role) return;
      handlers.onScienceStage?.({
        role,
        label,
        index: asNumber(envelope.index) ?? 1,
        total: asNumber(envelope.total) ?? 1,
        status: envelope.status === 'done' ? 'done' : 'start',
      });
      return;
    }
    if (type === 'search_start' || type === 'search_end') {
      // `flush()` antes: o texto que o modelo escreveu ANTES de pedir a busca
      // precisa aparecer primeiro, senão o cartão da busca surge acima de uma
      // frase que já tinha sido digitada.
      flush();
      const query = asString(envelope.query);
      const round = asNumber(envelope.round) ?? 1;
      if (!query) return;
      if (type === 'search_start') {
        handlers.onSearchStart?.({ type: 'search_start', query, round });
        return;
      }
      const brutos = Array.isArray(envelope.results) ? envelope.results : [];
      const results = brutos.flatMap((item) => {
        if (!isRecord(item)) return [];
        const url = asString(item.url);
        if (!url) return [];
        return [{
          title: asString(item.title, url),
          url,
          snippet: asString(item.snippet),
          publishedAt: asString(item.publishedAt) || null,
        }];
      });
      handlers.onSearchEnd?.({
        type: 'search_end',
        query,
        round,
        results,
        failure: asString(envelope.failure) || null,
      });
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
    if (type === 'spreadsheet_ready') {
      flush();
      const attachment = normalizeAttachment(envelope.attachment);
      if (attachment?.kind === 'spreadsheet') {
        handlers.onSpreadsheetReady?.({ type: 'spreadsheet_ready', attachment });
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
