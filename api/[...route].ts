import { getApp } from '../src/server/index';
import { errorPayload, normalizeError } from '../src/server/errors';

/** Tempo para modelos de raciocínio e respostas longas com streaming. */
export const maxDuration = 300;

/**
 * A exportação padrão precisa ser uma FUNÇÃO.
 *
 * A versão anterior exportava `{ fetch }` — convenção de Cloudflare Workers,
 * Bun e Deno, que a Vercel não reconhece: toda requisição a /api/* voltava
 * FUNCTION_INVOCATION_FAILED antes de tocar no roteamento do Hono.
 *
 * O try/catch existe porque `getApp()` pode falhar na primeira invocação
 * (banco ausente ou mal configurado). Sem ele, a falha volta como o 500 opaco
 * da plataforma; com ele, o app responde o motivo e a interface o exibe.
 */
export default async function handler(request: Request): Promise<Response> {
  try {
    return await getApp().fetch(request);
  } catch (error) {
    const normalized = normalizeError(error);
    return new Response(JSON.stringify({ error: errorPayload(normalized) }), {
      status: normalized.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
