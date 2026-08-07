import { AppError } from '../errors';
import { safeFetchWithRedirects } from '../ssrf';
import { SearchResultSchema, type SearchBackend, type SearchResult } from '../../shared/types';

/**
 * Backends de busca.
 *
 * Só trechos, nunca a página. Buscar o conteúdo de cada resultado seria a
 * evolução natural, e é exatamente por isso que fica de fora aqui: os
 * endereços vêm de um buscador, ou seja, de terceiros escolhidos por um
 * modelo, e passariam a ser alvos de fetch a partir do servidor. Ficar no
 * snippet mantém a superfície de SSRF restrita ao endpoint do próprio
 * buscador — que é configurado pelo usuário e já passa por `ssrf.ts`.
 *
 * Os três cobrem faixas diferentes do produto: `brave` e `tavily` são
 * serviços com chave e endpoint fixo; `searxng` é a opção auto-hospedada,
 * coerente com um app que já é self-hosted, e a única em que o usuário
 * informa a URL.
 */

export interface BackendRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly apiKey: string | null;
  /** Só o searxng usa; os demais têm endpoint fixo. */
  readonly baseURL: string | null;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /**
   * Resolvedor DNS injetável, repassado ao ssrf.ts.
   *
   * Existe pelos testes: sem ele, verificar a normalização de um JSON de
   * buscador exigiria resolver `api.tavily.com` de verdade, e um teste de
   * unidade passaria a depender da rede — lento quando funciona, misterioso
   * quando não.
   */
  readonly lookup?: (hostname: string) => Promise<string[]>;
}

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const TIMEOUT_MS = 12_000;
const MAX_BODY = 512_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function texto(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Remove marcação e espaço redundante dos trechos.
 *
 * A Brave devolve o trecho com `<strong>` em volta dos termos casados. Essas
 * tags iriam para dentro do prompt do modelo, onde não significam nada e
 * ainda parecem começo de um marcador do nosso próprio protocolo.
 */
function limparTrecho(value: string): string {
  return value.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 1200);
}

/**
 * Descarta o que não couber no schema em vez de derrubar a busca inteira.
 * Um resultado sem URL válida é lixo do backend, não motivo para o usuário
 * ficar sem resposta.
 */
function normalizar(candidatos: unknown[], maxResults: number): SearchResult[] {
  const resultados: SearchResult[] = [];
  for (const candidato of candidatos) {
    if (resultados.length >= maxResults) break;
    const parsed = SearchResultSchema.safeParse(candidato);
    if (parsed.success) resultados.push(parsed.data);
  }
  return resultados;
}

async function lerJson(response: Response, backend: SearchBackend): Promise<unknown> {
  const texto = (await response.text()).slice(0, MAX_BODY);
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    throw new AppError('UNKNOWN', { status: 502, message: `O buscador (${backend}) devolveu uma resposta ilegível.` });
  }
}

function erroDeStatus(status: number, backend: SearchBackend): AppError {
  if (status === 401 || status === 403) {
    return new AppError('INVALID_API_KEY', {
      status: 400,
      message: `A chave da busca (${backend}) foi recusada. Revise em Configurações → Busca.`,
    });
  }
  if (status === 429) {
    return new AppError('RATE_LIMIT', { status: 429, message: `O buscador (${backend}) recusou por limite de uso.` });
  }
  return new AppError('UNKNOWN', { status: 502, message: `O buscador (${backend}) respondeu ${status}.` });
}

/**
 * Prazo próprio da busca, somado ao do chamador.
 *
 * Sem isto, um buscador lento seguraria o round inteiro do chat até o timeout
 * do upstream — o usuário veria a resposta congelada sem saber por quê.
 */
function comPrazo(signal: AbortSignal): { signal: AbortSignal; cancelar: () => void } {
  const controller = new AbortController();
  const temporizador = setTimeout(() => controller.abort(new AppError('UPSTREAM_TIMEOUT')), TIMEOUT_MS);
  const repassar = () => controller.abort(signal.reason);
  if (signal.aborted) repassar();
  else signal.addEventListener('abort', repassar, { once: true });
  return {
    signal: controller.signal,
    cancelar: () => {
      clearTimeout(temporizador);
      signal.removeEventListener('abort', repassar);
    },
  };
}

async function brave(request: BackendRequest): Promise<SearchResult[]> {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', request.query);
  url.searchParams.set('count', String(request.maxResults));
  const prazo = comPrazo(request.signal);
  try {
    const response = await safeFetchWithRedirects(
      url.toString(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip',
          'x-subscription-token': request.apiKey ?? '',
        },
        signal: prazo.signal,
      },
      { fetchImpl: request.fetchImpl, lookup: request.lookup },
    );
    if (!response.ok) throw erroDeStatus(response.status, 'brave');
    const payload = await lerJson(response, 'brave');
    const web = isRecord(payload) && isRecord(payload.web) ? payload.web : null;
    const itens = web && Array.isArray(web.results) ? web.results : [];
    return normalizar(
      itens.map((item) => (isRecord(item) ? {
        title: texto(item.title).slice(0, 300),
        url: texto(item.url),
        snippet: limparTrecho(texto(item.description)),
        publishedAt: texto(item.age) || null,
      } : null)).filter((item) => item !== null),
      request.maxResults,
    );
  } finally {
    prazo.cancelar();
  }
}

async function tavily(request: BackendRequest): Promise<SearchResult[]> {
  const prazo = comPrazo(request.signal);
  try {
    const response = await safeFetchWithRedirects(
      TAVILY_ENDPOINT,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          api_key: request.apiKey,
          query: request.query,
          max_results: request.maxResults,
          search_depth: 'basic',
        }),
        signal: prazo.signal,
      },
      { fetchImpl: request.fetchImpl, lookup: request.lookup },
    );
    if (!response.ok) throw erroDeStatus(response.status, 'tavily');
    const payload = await lerJson(response, 'tavily');
    const itens = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
    return normalizar(
      itens.map((item) => (isRecord(item) ? {
        title: texto(item.title).slice(0, 300),
        url: texto(item.url),
        snippet: limparTrecho(texto(item.content)),
        publishedAt: texto(item.published_date) || null,
      } : null)).filter((item) => item !== null),
      request.maxResults,
    );
  } finally {
    prazo.cancelar();
  }
}

async function searxng(request: BackendRequest): Promise<SearchResult[]> {
  if (!request.baseURL) {
    throw new AppError('UNKNOWN', { status: 400, message: 'Informe a URL da sua instância SearXNG em Configurações → Busca.' });
  }
  const url = new URL(`${request.baseURL.replace(/\/+$/u, '')}/search`);
  url.searchParams.set('q', request.query);
  url.searchParams.set('format', 'json');
  const prazo = comPrazo(request.signal);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // Instâncias atrás de proxy autenticado; a maioria não usa chave nenhuma.
    if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
    const response = await safeFetchWithRedirects(
      url.toString(),
      { method: 'GET', headers, signal: prazo.signal },
      { fetchImpl: request.fetchImpl, lookup: request.lookup },
    );
    if (!response.ok) {
      // A causa mais comum de 403 aqui não é chave: é a instância sem o
      // formato JSON habilitado, que precisa ser ligado no settings.yml.
      if (response.status === 403) {
        throw new AppError('UNKNOWN', {
          status: 400,
          message: 'A instância SearXNG recusou. Habilite o formato "json" em search.formats no settings.yml dela.',
        });
      }
      throw erroDeStatus(response.status, 'searxng');
    }
    const payload = await lerJson(response, 'searxng');
    const itens = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
    return normalizar(
      itens.map((item) => (isRecord(item) ? {
        title: texto(item.title).slice(0, 300),
        url: texto(item.url),
        snippet: limparTrecho(texto(item.content)),
        publishedAt: texto(item.publishedDate) || null,
      } : null)).filter((item) => item !== null),
      request.maxResults,
    );
  } finally {
    prazo.cancelar();
  }
}

const BACKENDS: Record<SearchBackend, (request: BackendRequest) => Promise<SearchResult[]>> = {
  brave,
  tavily,
  searxng,
};

/** Rótulos da interface, num lugar só para os dois lados dizerem o mesmo. */
export const BACKEND_LABEL: Record<SearchBackend, string> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
  searxng: 'SearXNG (auto-hospedado)',
};

export const BACKEND_REQUIRES_KEY: Record<SearchBackend, boolean> = {
  brave: true,
  tavily: true,
  searxng: false,
};

export const BACKEND_REQUIRES_URL: Record<SearchBackend, boolean> = {
  brave: false,
  tavily: false,
  searxng: true,
};

export function runBackend(backend: SearchBackend, request: BackendRequest): Promise<SearchResult[]> {
  return BACKENDS[backend](request);
}
