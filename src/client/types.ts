export type ThemeMode = 'light' | 'dark';

export type DensityMode = 'comfortable' | 'compact';

/** Espelha EffortLevelSchema de shared/types.ts. */
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Rótulos e explicações dos níveis, num lugar só: o seletor do cabeçalho e a
 * tela de Configurações precisam dizer exatamente a mesma coisa, senão o
 * usuário lê duas descrições diferentes do mesmo controle.
 */
export const EFFORT_LABEL: Record<EffortLevel, string> = {
  auto: 'Automático',
  off: 'Desligado',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
};

export const EFFORT_HINT: Record<EffortLevel, string> = {
  auto: 'Deixa o provedor decidir — nenhum parâmetro é enviado.',
  off: 'Pede para não raciocinar. Onde o provedor não sabe desligar, usa o menor esforço.',
  low: 'Menos raciocínio: respostas mais rápidas e mais baratas.',
  medium: 'Equilíbrio entre profundidade e custo.',
  high: 'Mais raciocínio: melhor em problemas difíceis, e mais caro.',
  xhigh: 'Um degrau acima do Alto. Onde o modelo não oferecer, vira Alto.',
  max: 'O teto que o modelo permitir. Onde não existir, vira Alto.',
};

/** Espelha RoutingModeSchema de shared/types.ts. */
export type RoutingMode = 'auto' | 'fast';

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as string[]).includes(value);
}

export type AttachmentKind = 'image' | 'document' | 'spreadsheet';

export type SpreadsheetCellValue = string | number | boolean | null;

export interface SpreadsheetCell {
  row: number;
  column: number;
  value: SpreadsheetCellValue;
  formula?: string;
}

export interface SpreadsheetSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  cells: SpreadsheetCell[];
}

export interface SpreadsheetWorkbook {
  sheets: SpreadsheetSheet[];
}

export interface SpreadsheetSelection {
  attachmentId: string;
  version: number;
  filename?: string;
  sheet: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

/** Espelha AttachmentSchema de shared/types.ts. */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Só documentos: quantos caracteres de texto o servidor conseguiu ler. */
  textChars: number | null;
  truncated: boolean;
  spreadsheet?: { sheetNames: string[]; version: number } | null;
  createdAt: number;
}

/** Limites espelhados do servidor, para a interface recusar antes de subir. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export type ScienceLevel = 'off' | 'basic' | 'intermediate' | 'advanced';
export type ScienceFormat = 'markdown' | 'latex';
export type ScienceRole = 'pesquisa' | 'aprofundamento' | 'sintese' | 'ilustracao' | 'revisao';

/** Rótulos e contagem de agentes, num lugar só para os dois textos baterem. */
/**
 * Um nível só.
 *
 * Havia três (2, 3 e 5 agentes). Os dois maiores foram retirados depois de
 * rodarem: cada agente reescreve o documento inteiro, então custavam o dobro e
 * o triplo sem entregar texto melhor. Os valores antigos seguem no schema por
 * causa das conversas já gravadas.
 */
export const SCIENCE_LEVELS: Array<{ id: 'basic'; label: string; agentes: number; hint: string }> = [
  { id: 'basic', label: 'Ligado', agentes: 2, hint: 'Um levanta e detalha o assunto; o outro revisa a coesão e ilustra.' },
];

/** Uma linha do log de diagnóstico. Eventos, nunca conteúdo. */
export interface TraceEvent {
  scope: string;
  event: string;
  detail?: string;
  /** Milissegundos desde o início do turno. */
  at: number;
}

/** Rascunho do agente em curso. Some quando a resposta final começa. */
export interface ScienceDraft {
  role: ScienceRole;
  index: number;
  /** O documento sendo escrito. */
  text: string;
  /** O modelo pensando antes de escrever. Separado — não é o texto. */
  reasoning: string;
}

export interface ScienceStageEvent {
  role: ScienceRole;
  label: string;
  index: number;
  total: number;
  status: 'start' | 'done';
}

export type ArtifactKind = 'markdown' | 'code' | 'svg' | 'mermaid' | 'mindmap' | 'chart';

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

export interface SpreadsheetReadyEnvelope {
  type: 'spreadsheet_ready';
  attachment: Attachment;
}

/** Espelha SearchResultSchema de shared/types.ts. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
}

export type SearchBackend = 'brave' | 'tavily' | 'searxng';

export interface SearchSettings {
  backend: SearchBackend;
  baseURL: string | null;
  hasKey: boolean;
  maxResults: number;
  enabled: boolean;
  updatedAt: number;
}

/**
 * Uma busca feita durante uma resposta. Fica na mensagem porque é parte do
 * que aquela resposta é: sem as fontes, o usuário não tem como conferir de
 * onde veio o que está lendo.
 */
export interface MessageSearch {
  query: string;
  round: number;
  results: SearchResult[];
  /** Preenchido quando a busca falhou; a resposta segue mesmo assim. */
  failure?: string | null;
  /** Falso enquanto o resultado não voltou — o cartão mostra "buscando". */
  done: boolean;
}

export interface SearchStartEnvelope {
  type: 'search_start';
  query: string;
  round: number;
}

export interface SearchEndEnvelope {
  type: 'search_end';
  query: string;
  round: number;
  results: SearchResult[];
  failure?: string | null;
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
  /** O custo foi informado pelo provedor (OpenRouter), não calculado aqui. */
  costReported?: boolean;
}

export interface ChatMessage {
  id: string;
  /** Estágios da cadeia Science, guardados NA mensagem: quem reabre a conversa
   *  precisa saber por quantas mãos aquele texto passou. */
  scienceStages?: ScienceStageEvent[];
  /** Início e fim do turno, para o velocímetro medir a velocidade exata. */
  startedAt?: number;
  finishedAt?: number;
  /** Log do turno. Só do cliente: é diagnóstico da sessão, não histórico. */
  trace?: TraceEvent[];
  /** Só durante a geração: não é persistido, é processo e não produto. */
  scienceDraft?: ScienceDraft;
  attachments?: Attachment[];
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
  /** Buscas feitas durante esta resposta, na ordem em que aconteceram. */
  searches?: MessageSearch[];
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
  effort?: EffortLevel;
  scienceLevel?: ScienceLevel;
  scienceFormat?: ScienceFormat;
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
  effort?: EffortLevel;
  routing?: RoutingMode;
  attachmentIds?: string[];
  spreadsheetSelection?: Omit<SpreadsheetSelection, 'filename'>;
  scienceLevel?: ScienceLevel;
  scienceFormat?: ScienceFormat;
}

export const EMPTY_MESSAGES: ChatMessage[] = [];
/** Referência estável para seletores Zustand usados com React 19. */
export const EMPTY_ARTIFACTS: Artifact[] = [];
