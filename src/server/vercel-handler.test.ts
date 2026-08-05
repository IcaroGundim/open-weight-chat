import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import handler, { config, restoreRewrittenApiPath, requestWithRestoredBody } from './vercel-handler';
import { createApp } from './index';

/** Lê o corpo do jeito que o adaptador Node do Hono lê: Readable.toWeb(). */
async function readAsHonoWould(incoming: IncomingMessage): Promise<string> {
  return await new Response(Readable.toWeb(incoming) as ReadableStream).text();
}

/** IncomingMessage cujo stream a plataforma já drenou para popular `body`. */
function consumedRequest(body: unknown, method = 'PUT'): IncomingMessage {
  const drained = Readable.from([]) as unknown as IncomingMessage;
  drained.headers = { 'content-type': 'application/json', host: 'exemplo.vercel.app' };
  drained.rawHeaders = ['content-type', 'application/json', 'host', 'exemplo.vercel.app'];
  drained.method = method;
  drained.url = '/api/providers/openrouter';
  (drained as IncomingMessage & { body?: unknown }).body = body;
  return drained;
}

const serverDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('entrada da função na Vercel', () => {
  it('exporta uma função Node (req, res), não uma Response Web', () => {
    // API Routes da Vercel invocam a exportação padrão com req/res. Retornar
    // uma Response dela gera um warning e a resposta é ignorada.
    expect(typeof handler).toBe('function');
    expect(handler).toHaveLength(2);
    expect((handler as { fetch?: unknown }).fetch).toBeUndefined();
  });

  it('mantém o corpo bruto para o adaptador Node do Hono', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it('escreve uma falha de configuração no res da API Route', async () => {
    const written: { status?: number; type?: string; body?: string } = {};
    const response = {
      headersSent: false,
      writableEnded: false,
      setHeader: (name: string, value: string) => {
        if (name === 'content-type') written.type = value;
      },
      end: (body: string) => {
        written.body = body;
      },
      set statusCode(value: number) {
        written.status = value;
      },
    } as unknown as ServerResponse;

    await handler({} as IncomingMessage, response);

    expect(written.status).toBe(500);
    expect(written.type).toContain('application/json');
    expect(written.body).toContain('DATABASE_URL');
  });

  it('restaura o caminho /api/* após o rewrite para a Function estática', () => {
    const request = { url: '/api/entry?__route=providers/openrouter&source=settings' };

    restoreRewrittenApiPath(request);

    expect(request.url).toBe('/api/providers/openrouter?source=settings');
  });

  it('não arrasta node:sqlite para o grafo de módulos da função', () => {
    // `node:sqlite` exige Node >= 22.5 e, antes do 23.4, a flag
    // --experimental-sqlite. Um import de valor em index.ts fazia a função
    // falhar no carregamento, antes de qualquer código nosso rodar. O SQLite
    // pertence a main.ts, que é a entrada local.
    const source = readFileSync(join(serverDir, 'index.ts'), 'utf8');
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+'\.\/db\/queries'/mu;
    expect(source).not.toMatch(valueImport);
    expect(readFileSync(join(serverDir, 'main.ts'), 'utf8')).toMatch(/from '\.\/db\/queries'/u);
  });

  it('reconstrói o corpo que os helpers da Vercel consumiram', async () => {
    // Sintoma que isto corrige: `c.req.json()` esperava para sempre por bytes
    // que a plataforma já tinha lido, e o cadastro de provedor ficava preso em
    // "Salvando e buscando…" até o maxDuration de 300s derrubar a Function.
    const payload = { label: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-teste' };

    const restored = requestWithRestoredBody(consumedRequest(payload));

    expect(JSON.parse(await readAsHonoWould(restored))).toEqual(payload);
    expect(restored.headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(payload))));
    // Os metadados que o Hono usa para montar a Request Web sobrevivem à cópia.
    expect(restored.method).toBe('PUT');
    expect(restored.url).toBe('/api/providers/openrouter');
    expect(restored.headers.host).toBe('exemplo.vercel.app');
  });

  it('aceita corpo entregue como string ou Buffer', async () => {
    const raw = '{"label":"kimi"}';

    expect(await readAsHonoWould(requestWithRestoredBody(consumedRequest(raw)))).toBe(raw);
    expect(await readAsHonoWould(requestWithRestoredBody(consumedRequest(Buffer.from(raw))))).toBe(raw);
  });

  it('não toca na requisição quando o stream está intacto', () => {
    // Sem `body`, a plataforma não consumiu nada: copiar seria desperdício e
    // arriscaria perder o stream original do streaming SSE.
    const intact = Readable.from([Buffer.from('{"a":1}')]) as unknown as IncomingMessage;
    intact.method = 'POST';

    expect(requestWithRestoredBody(intact)).toBe(intact);
  });

  it('não reconstrói corpo em métodos que não carregam corpo', () => {
    const request = consumedRequest({}, 'GET');

    expect(requestWithRestoredBody(request)).toBe(request);
  });

  it('explica a falta de DATABASE_URL em vez de cair no SQLite', () => {
    // Em serverless o disco é somente leitura e /tmp não persiste: cair no
    // SQLite perderia o histórico a cada cold start.
    expect(() => createApp()).toThrowError(/DATABASE_URL/);
  });
});
