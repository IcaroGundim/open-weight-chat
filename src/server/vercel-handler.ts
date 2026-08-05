import { getApp } from './index';
import { errorPayload, normalizeError } from './errors';

/** Tempo para modelos de raciocínio e respostas longas com streaming. */
export const maxDuration = 300;

/**
 * Entrada da Function da Vercel.
 *
 * O build gera api/[...route].js com esbuild e incorpora todos os módulos
 * internos. A Function não depende de arquivos src/ fora do pacote publicado.
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
