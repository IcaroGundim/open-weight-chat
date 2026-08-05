import { handle } from '@hono/node-server/vercel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { getApp } from './index';
import { errorPayload, normalizeError } from './errors';

/** Tempo para modelos de raciocínio e respostas longas com streaming. */
export const maxDuration = 300;

/**
 * Pedido para a plataforma não consumir o JSON antes do adaptador do Hono.
 *
 * ATENÇÃO: isto sozinho não basta. `config.api.bodyParser` é uma convenção do
 * Next.js; uma Function Node avulsa como esta (gerada por esbuild, sem Next.js
 * no projeto) NÃO tem esse export honrado pela Vercel, que aplica os helpers
 * de request e popula `req.body` de qualquer maneira. O export continua aqui
 * porque é inofensivo e cobre plataformas que o respeitem — mas a garantia real
 * é `requestWithRestoredBody`, abaixo.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Entrada da Function da Vercel.
 *
 * O build gera api/entry.js com esbuild e incorpora todos os módulos
 * internos. A Function não depende de arquivos src/ fora do pacote publicado.
 *
 * A Vercel chama API Routes com `(req, res)`. O adaptador do Hono converte
 * essa entrada Node para `app.fetch()` e grava a Response no `res`, inclusive
 * nas respostas em streaming do chat.
 */
export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    restoreRewrittenApiPath(request);
    const incoming = requestWithRestoredBody(request);
    return handle(getApp())(incoming, response).catch((error) => writeStartupError(response, error));
  } catch (error) {
    return writeStartupError(response, error);
  }
}

/** Métodos que nunca carregam corpo — nada a restaurar. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/**
 * Devolve um IncomingMessage cujo stream ainda pode ser lido.
 *
 * Os request helpers da Vercel leem o stream para popular `req.body`. O
 * adaptador Node do Hono monta a Request Web com `Readable.toWeb(incoming)`,
 * então um stream já drenado vira um corpo que nunca chega: `c.req.json()`
 * aguarda para sempre, sem timeout, e a Function só morre no maxDuration de
 * 300s. Na interface isso aparecia como "Salvando e buscando…" eterno ao
 * cadastrar a chave de um provedor.
 *
 * A presença de `req.body` é o sinal de que a plataforma já consumiu o stream
 * (IncomingMessage não tem essa propriedade). Quando ela existe, reconstruímos
 * o corpo em um Readable novo e copiamos os metadados HTTP que o Hono lê.
 * Quando não existe, o stream está intacto e o pedido segue sem cópia.
 */
export function requestWithRestoredBody(request: IncomingMessage): IncomingMessage {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed === undefined || parsed === null) return request;
  if (BODYLESS_METHODS.has((request.method ?? 'GET').toUpperCase())) return request;

  const raw = Buffer.isBuffer(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? Buffer.from(parsed, 'utf8')
      : Buffer.from(JSON.stringify(parsed), 'utf8');

  const restored = Readable.from(raw.byteLength > 0 ? [raw] : []) as unknown as IncomingMessage;
  // `transfer-encoding` sai de cena: o corpo reconstruído tem tamanho conhecido
  // e anunciar chunked junto com content-length deixaria a Request ambígua.
  const headers = { ...request.headers, 'content-length': String(raw.byteLength) };
  delete headers['transfer-encoding'];
  restored.headers = headers;
  restored.rawHeaders = request.rawHeaders;
  restored.method = request.method;
  restored.url = request.url;
  restored.httpVersion = request.httpVersion;
  restored.httpVersionMajor = request.httpVersionMajor;
  restored.httpVersionMinor = request.httpVersionMinor;
  restored.socket = request.socket;
  return restored;
}

/**
 * `vercel.json` leva toda URL /api/* para a Function estática /api/entry.
 * O parâmetro interno guarda o caminho original para que o Hono continue
 * enxergando, por exemplo, /api/providers/openrouter.
 */
export function restoreRewrittenApiPath(request: Pick<IncomingMessage, 'url'>): void {
  if (!request.url) return;

  const url = new URL(request.url, 'http://vercel.internal');
  if (url.pathname !== '/api/entry' || !url.searchParams.has('__route')) return;

  const route = url.searchParams.get('__route') ?? '';
  url.searchParams.delete('__route');
  const segments = route
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment));
  const query = url.searchParams.toString();
  request.url = `/api/${segments.join('/')}${query ? `?${query}` : ''}`;
}

function writeStartupError(response: ServerResponse, error: unknown): Promise<void> {
  if (response.writableEnded) return Promise.resolve();

  const normalized = normalizeError(error);
  if (!response.headersSent) {
    response.statusCode = normalized.status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
  }
  response.end(JSON.stringify({ error: errorPayload(normalized) }));
  return Promise.resolve();
}
