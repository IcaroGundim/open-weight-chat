import { handle } from '@hono/node-server/vercel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getApp } from './index';
import { errorPayload, normalizeError } from './errors';

/** Tempo para modelos de raciocínio e respostas longas com streaming. */
export const maxDuration = 300;

/**
 * Entrada da Function da Vercel.
 *
 * O build gera api/[...route].js com esbuild e incorpora todos os módulos
 * internos. A Function não depende de arquivos src/ fora do pacote publicado.
 *
 * A Vercel chama API Routes com `(req, res)`. O adaptador do Hono converte
 * essa entrada Node para `app.fetch()` e grava a Response no `res`, inclusive
 * nas respostas em streaming do chat.
 */
export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    return handle(getApp())(request, response).catch((error) => writeStartupError(response, error));
  } catch (error) {
    return writeStartupError(response, error);
  }
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
