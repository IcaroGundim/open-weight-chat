import type { ProviderModelInput } from '../shared/types';
import { AppError } from './errors';
import { safeFetchWithRedirects } from './ssrf';

/** Contexto conservador usado quando o endpoint /models não informa a janela. */
export const DEFAULT_DISCOVERED_CONTEXT_WINDOW = 131_072;
/**
 * Teto do catálogo descoberto: provedores agregadores (ex.: OpenRouter)
 * expõem listas enormes em /models; limitar a 500 modelos evita estourar a
 * interface, o banco e a própria requisição. Os primeiros 500 após a
 * deduplicação por id são mantidos.
 */
export const MAX_DISCOVERED_MODELS = 500;
const DISCOVERY_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed !== undefined && parsed >= 0) return parsed;
  }
  return undefined;
}

function modelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ['data', 'models', 'items', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function pricingFrom(row: JsonRecord): ProviderModelInput['pricing'] | undefined {
  const pricing = isRecord(row.pricing) ? row.pricing : undefined;
  const inputPerMillion = firstNumber(
    row.inputPerMillion,
    row.input_price_per_million,
    row.inputPriceUsdPerMillion,
    pricing?.inputPerMillion,
    pricing?.input_price_per_million,
    pricing?.inputPriceUsdPerMillion,
  ) ?? (() => {
    const perToken = firstNumber(row.prompt, row.input, pricing?.prompt, pricing?.input);
    return perToken === undefined ? undefined : perToken * 1_000_000;
  })();
  const outputPerMillion = firstNumber(
    row.outputPerMillion,
    row.output_price_per_million,
    row.outputPriceUsdPerMillion,
    pricing?.outputPerMillion,
    pricing?.output_price_per_million,
    pricing?.outputPriceUsdPerMillion,
  ) ?? (() => {
    const perToken = firstNumber(row.completion, row.output, pricing?.completion, pricing?.output);
    return perToken === undefined ? undefined : perToken * 1_000_000;
  })();

  if (inputPerMillion === undefined && outputPerMillion === undefined) return undefined;
  return { inputPerMillion: inputPerMillion ?? null, outputPerMillion: outputPerMillion ?? null };
}

function toModelInput(value: unknown): ProviderModelInput | null {
  if (typeof value === 'string' && value.trim()) {
    return { id: value.trim(), label: value.trim(), ctx: DEFAULT_DISCOVERED_CONTEXT_WINDOW };
  }
  if (!isRecord(value)) return null;

  const id = asText(value.id ?? value.model ?? value.model_id ?? value.name);
  if (!id) return null;
  const label = asText(value.name ?? value.display_name ?? value.label) || id;
  const context = firstNumber(
    value.context_length,
    value.context_window,
    value.contextWindow,
    value.max_context_length,
    value.max_tokens,
  );
  const reasoning = typeof value.reasoning === 'boolean'
    ? value.reasoning
    : typeof value.supports_reasoning === 'boolean'
      ? value.supports_reasoning
      : /reason|think|r1(?:$|[-.])|o[134](?:$|[-.])/iu.test(`${id} ${label}`);

  return {
    id,
    label,
    ctx: context && context > 0 ? Math.trunc(context) : DEFAULT_DISCOVERED_CONTEXT_WINDOW,
    reasoning,
    pricing: pricingFrom(value),
  };
}

function responseMessage(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const error = isRecord(payload.error) ? payload.error : undefined;
  return asText(payload.message ?? error?.message ?? payload.detail);
}

function discoveryError(status: number, payload: unknown): AppError {
  if (status === 401 || status === 403) {
    return new AppError('INVALID_API_KEY', {
      status: 400,
      providerStatus: status,
      message: 'A chave de API foi recusada pelo provedor. Confira a chave e tente novamente.',
    });
  }
  if (status === 404) {
    return new AppError('UNKNOWN', {
      status: 400,
      providerStatus: status,
      message: 'O provedor não expôs o endpoint /models. Confira a URL base (por exemplo, terminando em /v1).',
    });
  }
  if (status === 429) {
    return new AppError('RATE_LIMIT', {
      providerStatus: status,
      message: 'O provedor limitou a consulta de modelos. Aguarde alguns segundos e tente novamente.',
    });
  }
  const upstreamMessage = responseMessage(payload);
  return new AppError('UNKNOWN', {
    status: status >= 500 ? 502 : 400,
    providerStatus: status,
    message: upstreamMessage
      ? `O provedor não conseguiu listar os modelos: ${upstreamMessage.slice(0, 180)}`
      : `O provedor não conseguiu listar os modelos (HTTP ${status}).`,
  });
}

/** Consulta o catálogo OpenAI-compatible sem deixar a chave sair do servidor. */
export async function discoverProviderModels(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelInput[]> {
  const url = `${baseURL.replace(/\/+$/u, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  // Em produção (NODE_ENV/VERCEL) o SSRF exige HTTPS e bloqueia loopback;
  // em dev, http://localhost continua permitido para Ollama e afins.
  const production = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await safeFetchWithRedirects(
        url,
        { method: 'GET', headers, signal: controller.signal },
        { fetchImpl, production, allowLocalhost: !production },
      );
    } catch (error) {
      // Erros de SSRF/redirecionamento já são AppError com mensagem própria —
      // propagam como estão; o resto é falha de conexão ou timeout.
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) {
        throw new AppError('UPSTREAM_TIMEOUT', {
          message: 'A consulta de modelos demorou demais. Confira a URL e tente novamente.',
        });
      }
      throw new AppError('UNKNOWN', { status: 400, message: 'Não foi possível conectar ao endpoint /models do provedor.' });
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) throw discoveryError(response.status, payload);

    const discovered = modelRows(payload)
      .map(toModelInput)
      .filter((model): model is ProviderModelInput => Boolean(model));
    const unique = new Map(discovered.map((model) => [model.id, model]));
    // Teto de segurança: depois da deduplicação, mantém apenas os primeiros
    // MAX_DISCOVERED_MODELS (a ordem do provedor é preservada).
    const models = [...unique.values()].slice(0, MAX_DISCOVERED_MODELS);
    if (models.length === 0) {
      throw new AppError('UNKNOWN', {
        status: 400,
        message: 'O provedor respondeu, mas não informou nenhum modelo em /models.',
      });
    }
    return models;
  } finally {
    clearTimeout(timer);
  }
}
