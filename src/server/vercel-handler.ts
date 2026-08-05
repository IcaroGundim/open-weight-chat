import { handle } from '@hono/node-server/vercel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getApp } from './index';
import { errorPayload, normalizeError } from './errors';

/** Tempo para modelos de raciocínio e respostas longas com streaming. */
export const maxDuration = 300;

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
    return handle(getApp())(request, response).catch((error) => writeStartupError(response, error));
  } catch (error) {
    return writeStartupError(response, error);
  }
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
