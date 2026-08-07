import { AppError, UpstreamHttpError, isAbortError, normalizeError } from './errors';
import { safeFetchWithRedirects } from './ssrf';
import { type EffortRequestParams, effortRequestParams, isEffortRejection } from './effort';
import type { EffortLevel, ProviderId } from '../shared/types';
import { isOpenRouterBaseUrl, parseCitations, webPluginBody, type OpenRouterCitation } from './openrouter';
import type { ProviderUsageLike } from './cost';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Data URIs; presentes só quando o usuário anexou imagens. */
  images?: readonly string[];
}

/**
 * Serializa uma mensagem para o corpo da requisição.
 *
 * Sem imagem, `content` continua sendo uma string — que é o que todo endpoint
 * compatível aceita. O formato de partes só aparece quando há imagem, porque
 * há endpoint que recusa um array de partes mesmo para texto puro, e não vale
 * arriscar toda mensagem por um formato de que quase nenhuma precisa.
 */
function serializeMessage(message: LlmMessage): Record<string, unknown> {
  if (!message.images || message.images.length === 0) {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...message.images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

/**
 * O provedor recusou por causa das imagens?
 *
 * Mesma disciplina do 400 de raciocínio (ver effort.ts): o catálogo não diz
 * quais modelos enxergam — o `/models` padrão não informa capacidade — e
 * bloquear pelo flag erraria fechado, escondendo o recurso justamente no caso
 * BYOK. Melhor tentar e, se o endpoint reclamar, refazer sem as imagens com
 * um aviso no texto, para o usuário saber por que a resposta as ignorou.
 */
export function isVisionRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lowered = body.toLowerCase();
  return ['image_url', 'image', 'vision', 'multimodal', 'content parts', 'invalid content type']
    .some((termo) => lowered.includes(termo));
}

/** Aviso posto no lugar das imagens quando o modelo não as aceita. */
export const VISION_FALLBACK_NOTE =
  '[As imagens anexadas não puderam ser enviadas: este modelo não aceita imagens.]';

function withoutImages(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages.map((message) => {
    if (!message.images || message.images.length === 0) return message;
    const aviso = `${message.content}\n\n${VISION_FALLBACK_NOTE}`.trim();
    return { role: message.role, content: aviso };
  });
}

export type LlmStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; reasoning: string }
  | { kind: 'usage'; usage: ProviderUsageLike }
  | { kind: 'citations'; citations: readonly OpenRouterCitation[] }
  | { kind: 'finish'; finishReason: string | null };

export interface LlmStreamOptions {
  providerId: ProviderId;
  modelId: string;
  /**
   * URL base do provedor EFETIVO do usuário, resolvida dentro da requisição
   * via `resolveProvider(userId, providerId, db)` (provider-resolution.ts).
   * Nunca resolva provedor/chave aqui dentro — o chamador é o dono do contexto.
   */
  baseURL: string;
  /** Chave decifrada do usuário dono da requisição, ou null. */
  apiKey: string | null;
  /** O provedor exige chave? (vem de resolveProvider). */
  requiresApiKey: boolean;
  messages: readonly LlmMessage[];
  signal: AbortSignal;
  temperature?: number;
  /** Nível de raciocínio pedido. `auto`/ausente não envia parâmetro nenhum. */
  effort?: EffortLevel;
  /**
   * Quantidade de resultados da busca nativa, ou ausente para não buscar.
   *
   * Só vira campo quando a baseURL é da OpenRouter; o plugin é dela. Num
   * endpoint que não o conhece, mandá-lo arriscaria 400 na mensagem inteira —
   * então não se manda.
   */
  webSearchResults?: number;
  fetchImpl?: typeof fetch;
  connectionTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  maxAttempts?: number;
  /**
   * Diagnóstico das tentativas.
   *
   * As quedas deste módulo — 400 de raciocínio, 400 de imagem, 429, 5xx — são
   * silenciosas por desenho: elas existem para a mensagem não falhar. O efeito
   * colateral é que ninguém consegue explicar por que uma resposta demorou o
   * dobro ou saiu sem as imagens. Este gancho torna isso legível sem mudar o
   * comportamento.
   */
  onTrace?: (event: string, detail?: string) => void;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function abortError(): Error {
  return new DOMException('A requisição foi cancelada.', 'AbortError');
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function combineSignals(parent: AbortSignal, attempt: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason ?? abortError());
  };
  const parentListener = () => abortFrom(parent);
  const attemptListener = () => abortFrom(attempt);
  if (parent.aborted) abortFrom(parent);
  if (attempt.aborted) abortFrom(attempt);
  parent.addEventListener('abort', parentListener, { once: true });
  attempt.addEventListener('abort', attemptListener, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      parent.removeEventListener('abort', parentListener);
      attempt.removeEventListener('abort', attemptListener);
    },
  };
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - Date.now()));
  return undefined;
}

async function readLimitedText(response: Response, maxLength = 32_000): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, maxLength);
  } catch {
    return '';
  }
}

function extractChunkData(payload: unknown): {
  events: LlmStreamEvent[];
  hasToken: boolean;
} {
  if (!isRecord(payload)) return { events: [], hasToken: false };
  const events: LlmStreamEvent[] = [];
  let hasToken = false;
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  if (usage) events.push({ kind: 'usage', usage });

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
  if (!firstChoice) return { events, hasToken };
  const delta = isRecord(firstChoice.delta) ? firstChoice.delta : firstChoice;
  // As citações da busca nativa vêm nas anotações, que a OpenRouter manda no
  // delta ou na mensagem consolidada conforme o momento do stream. Ler os dois
  // lugares é mais barato do que descobrir a regra e depender dela.
  const citations = parseCitations(delta.annotations ?? (isRecord(firstChoice.message) ? firstChoice.message.annotations : undefined));
  if (citations.length > 0) events.push({ kind: 'citations', citations });
  const content = textFromContent(delta.content);
  const reasoning = textFromContent(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
  if (content) {
    events.push({ kind: 'text', text: content });
    hasToken = true;
  }
  if (reasoning) {
    events.push({ kind: 'reasoning', reasoning });
    hasToken = true;
  }
  if (typeof firstChoice.finish_reason === 'string' || firstChoice.finish_reason === null) {
    events.push({ kind: 'finish', finishReason: firstChoice.finish_reason as string | null });
  }
  return { events, hasToken };
}

export function parseProviderChunk(payload: unknown): LlmStreamEvent[] {
  return extractChunkData(payload).events;
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  inactivityTimeoutMs: number,
  onInactivityTimeout: () => void,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const emitData = function* (): Generator<unknown> {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return;
    try {
      yield JSON.parse(data) as unknown;
    } catch {
      throw new AppError('UNKNOWN', { message: 'O provedor enviou um evento de streaming inválido.' });
    }
  };

  const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (signal.aborted) throw signal.reason ?? abortError();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeout = setTimeout(() => {
            onInactivityTimeout();
            reject(new AppError('UPSTREAM_TIMEOUT'));
          }, inactivityTimeoutMs);
        }),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          abortListener = () => reject(signal.reason ?? abortError());
          signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  };

  try {
    while (true) {
      const result = await readWithTimeout();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          yield* emitData();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split(/\r?\n/u)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        if (line === '') yield* emitData();
      }
    }
    yield* emitData();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The fetch body may already have been cancelled by its AbortSignal.
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have been released by an aborted fetch.
    }
  }
}

function requestBody(
  options: LlmStreamOptions,
  effort: EffortRequestParams | null,
  messages: readonly LlmMessage[],
): string {
  const body: Record<string, unknown> = {
    model: options.modelId,
    messages: messages.map(serializeMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (effort) Object.assign(body, effort.body);
  if (options.webSearchResults && isOpenRouterBaseUrl(options.baseURL)) {
    Object.assign(body, webPluginBody(options.webSearchResults));
  }
  return JSON.stringify(body);
}

export class OpenAICompatibleClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async *stream(options: LlmStreamOptions): AsyncGenerator<LlmStreamEvent> {
    // O provedor/chave/baseURL já vêm resolvidos pelo chamador (resolveProvider);
    // este módulo só valida e usa. Sem chave num provedor que exige, o erro é
    // claro e aponta para a tela de configuração do usuário.
    if (!options.baseURL) {
      throw new AppError('MODEL_NOT_FOUND', { message: 'O provedor ou modelo selecionado não está configurado.' });
    }
    if (options.requiresApiKey && !options.apiKey) {
      throw new AppError('INVALID_API_KEY', {
        message: 'Configure a chave deste provedor em Configurações → Provedores.',
      });
    }

    const fetchImpl = options.fetchImpl ?? this.fetchImpl;
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    let emittedToken = false;
    // Vira null se o provedor rejeitar estes campos — ver o 400 tratado abaixo.
    let effort = effortRequestParams(options.effort, options.providerId);
    // Idem para as imagens: se o endpoint recusar, a tentativa seguinte vai
    // sem elas em vez de a mensagem inteira falhar.
    let mensagens: readonly LlmMessage[] = options.messages;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal.aborted) throw options.signal.reason ?? abortError();
      const attemptController = new AbortController();
      const combined = combineSignals(options.signal, attemptController.signal);
      let connectionTimedOut = false;
      const connectionTimer = setTimeout(() => {
        connectionTimedOut = true;
        attemptController.abort(new AppError('UPSTREAM_TIMEOUT'));
      }, connectionTimeoutMs);
      let response: Response;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
        if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
        if (options.providerId === 'openrouter') {
          if (process.env.OPENROUTER_HTTP_REFERER) headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
          if (process.env.OPENROUTER_APP_TITLE) headers['X-Title'] = process.env.OPENROUTER_APP_TITLE;
        }
        // O endpoint vem da configuração BYOK do usuário. Mesmo tendo sido
        // validado ao salvar, ele pode ter sido gravado antes da proteção ou
        // ter mudado via DNS; portanto toda tentativa de chat revalida URL,
        // DNS e redirecionamentos antes de abrir a conexão com o upstream.
        response = await safeFetchWithRedirects(
          `${options.baseURL.replace(/\/+$/u, '')}/chat/completions`,
          {
            method: 'POST',
            headers,
            body: requestBody(options, effort, mensagens),
            signal: combined.signal,
          },
          { fetchImpl },
        );
      } catch (error) {
        if (connectionTimedOut) throw new AppError('UPSTREAM_TIMEOUT');
        if (options.signal.aborted) throw options.signal.reason ?? error;
        if (isAbortError(error) && attemptController.signal.aborted) {
          throw attemptController.signal.reason ?? error;
        }
        throw error;
      } finally {
        clearTimeout(connectionTimer);
        combined.cleanup();
      }

      if (!response.ok) {
        const body = await readLimitedText(response);
        // O provedor rejeitou exatamente os campos de raciocínio que
        // injetamos: refaz a requisição sem eles. Os nomes desses parâmetros
        // variam entre provedores e nenhum deles é autoritativo (ver
        // effort.ts), então a alternativa seria a mensagem inteira falhar por
        // causa de uma preferência que este endpoint não conhece. Acontece no
        // máximo uma vez — `effort` vira null — e não gasta o orçamento de
        // retentativa de 429/5xx, que existe para outra coisa.
        if (effort && isEffortRejection(response.status, body, effort.keys)) {
          options.onTrace?.('esforço recusado pelo provedor', `400 · refazendo sem ${effort.keys.join(', ')}`);
          effort = null;
          attempt -= 1;
          continue;
        }
        // O endpoint reclamou das imagens: refaz sem elas, com o aviso no
        // texto. Acontece no máximo uma vez e não gasta o orçamento de
        // retentativa de 429/5xx, que existe para outra coisa.
        if (mensagens.some((message) => message.images?.length) && isVisionRejection(response.status, body)) {
          options.onTrace?.('imagens recusadas pelo provedor', '400 · refazendo sem as imagens');
          mensagens = withoutImages(mensagens);
          attempt -= 1;
          continue;
        }
        const upstreamError = new UpstreamHttpError(response.status, body);
        const retryable = response.status === 429 || response.status >= 500;
        if (!emittedToken && retryable && attempt < maxAttempts) {
          const retryAfter = parseRetryAfter(response);
          const backoff = retryAfter ?? Math.min(2_000, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
          options.onTrace?.('retentativa', `HTTP ${response.status} · esperando ${backoff}ms · tentativa ${attempt + 1}/${maxAttempts}`);
          await sleepWithAbort(backoff, options.signal);
          continue;
        }
        options.onTrace?.('provedor recusou', `HTTP ${response.status}`);
        throw upstreamError;
      }
      if (!response.body) throw new AppError('UNKNOWN', { message: 'O provedor retornou um stream vazio.' });

      const streamController = new AbortController();
      const streamCombined = combineSignals(options.signal, streamController.signal);
      const idleTimeout = () => streamController.abort(new AppError('UPSTREAM_TIMEOUT'));
      try {
        for await (const payload of readSseEvents(response.body, streamCombined.signal, inactivityTimeoutMs, idleTimeout)) {
          const parsed = extractChunkData(payload);
          for (const event of parsed.events) {
            if (event.kind === 'text' || event.kind === 'reasoning') emittedToken = true;
            yield event;
          }
        }
        return;
      } catch (error) {
        if (options.signal.aborted) throw options.signal.reason ?? error;
        if (streamController.signal.aborted) {
          throw streamController.signal.reason ?? new AppError('UPSTREAM_TIMEOUT');
        }
        // A retry after a response body has started is intentionally forbidden.
        throw normalizeError(error);
      } finally {
        streamCombined.cleanup();
        streamController.abort();
      }
    }
  }
}

export async function* streamOpenAICompatible(options: LlmStreamOptions): AsyncGenerator<LlmStreamEvent> {
  yield* new OpenAICompatibleClient(options.fetchImpl).stream(options);
}
