import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatDatabase } from './db/queries';
import { createApp, resolveAppOrigin } from './index';
import { createAuthMiddleware } from './auth';

/**
 * Suíte do app Hono multiusuário: autenticação fake injetada via
 * createAuthMiddleware({ verifyToken }), operações por usuário e isolamento
 * entre usuários. O verificador fake ignora o token e devolve um userId fixo
 * por app — dois apps sobre o MESMO banco simulam dois usuários.
 */

const USER_A = 'user_test_1';
const USER_B = 'user_test_2';

const SSE_OK =
  'data: {"choices":[{"delta":{"content":"olá"}}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n' +
  'data: [DONE]\n\n';

function sseResponse(): Response {
  return new Response(SSE_OK, { headers: { 'content-type': 'text/event-stream' } });
}

function appFor(db: ChatDatabase, userId: string, fetchImpl?: typeof fetch) {
  return createApp({
    db,
    fetchImpl,
    auth: createAuthMiddleware({ verifyToken: async () => userId }),
  });
}

function authHeader(userId: string): Record<string, string> {
  return { Authorization: `Bearer token-fake-${userId}` };
}

function chatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ content: 'diga olá', providerId: 'ollama', modelId: 'llama3.2', ...overrides });
}

let database: ChatDatabase;

beforeEach(() => {
  // Catálogo determinístico: nenhuma chave de ambiente pode vazar para o teste.
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.KIMI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ALLOW_ENV_API_KEYS;
  delete process.env.DEFAULT_PROVIDER_ID;
  delete process.env.DEFAULT_MODEL_ID;
  delete process.env.APP_ORIGIN;
  database = new ChatDatabase(':memory:');
});

afterEach(() => {
  database.close();
});

describe('Hono API multiusuário', () => {
  it('serve /api/health sem autenticação, sem expor a configuração interna', async () => {
    const app = createApp({ db: database });
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('permite CORS somente para APP_ORIGIN', async () => {
    process.env.APP_ORIGIN = 'https://chat.exemplo.test/';
    const app = createApp({ db: database });

    const allowed = await app.request('/api/health', { headers: { Origin: 'https://chat.exemplo.test' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://chat.exemplo.test');
    expect(allowed.headers.get('vary')).toContain('Origin');

    const denied = await app.request('/api/health', { headers: { Origin: 'https://outro.exemplo.test' } });
    expect(denied.status).toBe(200);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await app.request('/api/models', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chat.exemplo.test',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://chat.exemplo.test');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('valida APP_ORIGIN e exige HTTPS em produção', () => {
    expect(resolveAppOrigin('https://chat.exemplo.test/', true)).toBe('https://chat.exemplo.test');
    expect(() => resolveAppOrigin('https://chat.exemplo.test/app', true)).toThrow(/somente a origem/);
    expect(() => resolveAppOrigin('http://chat.exemplo.test', true)).toThrow(/HTTPS em produção/);
    expect(() => resolveAppOrigin(undefined, true)).toThrow(/Configure APP_ORIGIN/);
  });

  it('exige autenticação em /api/models (401 sem token)', async () => {
    const app = appFor(database, USER_A);
    const response = await app.request('/api/models');
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.retryable).toBe(false);
  });

  it('serve o catálogo de modelos do usuário autenticado', async () => {
    const app = appFor(database, USER_A);
    const response = await app.request('/api/models', { headers: authHeader(USER_A) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers).toHaveLength(5);
    const ollama = body.providers.find((item: { id: string }) => item.id === 'ollama');
    // Ollama não exige chave → configurado sem chave.
    expect(ollama.configured).toBe(true);
    const deepseek = body.providers.find((item: { id: string }) => item.id === 'deepseek');
    // Sem chave do usuário (e sem chave de ambiente em teste) → não configurado.
    expect(deepseek.configured).toBe(false);
    expect(deepseek.hasKey).toBeUndefined();
    // Padrão do usuário: primeiro provedor configurado do catálogo dele.
    expect(body.defaultProviderId).toBe('ollama');
    expect(body.defaultModelId).toBe('llama3.2');
  });

  it('recusa Ollama local antes de criar conversa em produção', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAppOrigin = process.env.APP_ORIGIN;
    let fetchCalls = 0;
    process.env.NODE_ENV = 'production';
    process.env.APP_ORIGIN = 'https://chat.exemplo.test';
    try {
      const app = appFor(database, USER_A, async () => {
        fetchCalls += 1;
        return sseResponse();
      });
      const response = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
        body: chatBody(),
      });

      expect(response.status).toBe(400);
      expect(fetchCalls).toBe(0);
      expect(database.listConversations(USER_A)).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = originalAppOrigin;
    }
  });

  it('faz CRUD de conversa com autenticação', async () => {
    const app = appFor(database, USER_A);
    const created = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ providerId: 'ollama', modelId: 'llama3.2', title: 'CRUD' }),
    });
    expect(created.status).toBe(201);
    const conversation = (await created.json()).conversation;
    expect(conversation.title).toBe('CRUD');

    const fetched = await app.request(`/api/conversations/${conversation.id}`, { headers: authHeader(USER_A) });
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).conversation.id).toBe(conversation.id);

    const updated = await app.request(`/api/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ title: 'Atualizada', archived: true }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).conversation.title).toBe('Atualizada');

    const deleted = await app.request(`/api/conversations/${conversation.id}`, { method: 'DELETE', headers: authHeader(USER_A) });
    expect(deleted.status).toBe(200);

    const afterDelete = await app.request(`/api/conversations/${conversation.id}`, { headers: authHeader(USER_A) });
    expect(afterDelete.status).toBe(404);
  });

  it('leva o nível de esforço até o provedor e o guarda na conversa', async () => {
    const bodies: string[] = [];
    // qwen3 é o modelo do Ollama com reasoning: true no catálogo.
    const app = appFor(database, USER_A, async (_input, init) => {
      bodies.push(String(init?.body));
      return sseResponse();
    });
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ modelId: 'qwen3', effort: 'high' }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(JSON.parse(bodies[0]).reasoning_effort).toBe('high');
    // Persistido: recarregar a conversa reencontra o nível escolhido.
    expect(database.listConversations(USER_A)[0].effort).toBe('high');
  });

  it('não pede esforço a um modelo que não raciocina', async () => {
    const bodies: string[] = [];
    // llama3.2 tem reasoning: false — mandar o campo seria arriscar um 400
    // para configurar algo que o modelo não tem.
    const app = appFor(database, USER_A, async (_input, init) => {
      bodies.push(String(init?.body));
      return sseResponse();
    });
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ effort: 'high' }),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(JSON.parse(bodies[0])).not.toHaveProperty('reasoning_effort');
  });

  it('proxyia um stream SSE compatível e persiste a resposta do assistente', async () => {
    const app = appFor(database, USER_A, async () => sseResponse());
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"type":"text"');
    expect(body).toContain('"type":"done"');
    const conversations = database.listConversations(USER_A);
    expect(conversations).toHaveLength(1);
    const messages = database.getMessages(USER_A, conversations[0].id);
    expect(messages.at(-1)?.content).toBe('olá');
    expect(messages.at(-1)?.finishReason).toBe('stop');
  });

  it('parseia streams de artefatos em armazenamento versionado e aplica patch depois', async () => {
    let call = 0;
    const app = appFor(database, USER_A, async () => {
      call += 1;
      const content = call === 1
        ? '<artifact id="demo" type="code" language="ts" title="Demo">const value = 1;</artifact>'
        : '<artifact-update id="demo"><find>const value = 1;</find><replace>const value = 2;</replace></artifact-update>';
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":8,"total_tokens":11}}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const first = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'crie um artefato' }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).toContain('artifact_start');
    expect(firstBody).toContain('artifact_delta');
    expect(firstBody).toContain('artifact_end');
    const conversation = database.listConversations(USER_A)[0];
    const firstArtifacts = database.getArtifacts(USER_A, conversation.id);
    expect(firstArtifacts[0]?.versions[0]?.content).toBe('const value = 1;');
    expect(database.getMessages(USER_A, conversation.id).at(-1)?.content).toContain('[[artefato:demo@1]]');
    expect(database.getMessages(USER_A, conversation.id).at(-1)?.content).not.toContain('const value = 1;');

    const second = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ conversationId: conversation.id, content: 'mude para 2' }),
    });
    expect(second.status).toBe(200);
    await second.text();
    const versions = database.getArtifacts(USER_A, conversation.id)[0]?.versions ?? [];
    expect(versions).toHaveLength(2);
    expect(versions[1]?.operation).toBe('update');
    expect(versions[1]?.content).toBe('const value = 2;');
    expect(database.getMessages(USER_A, conversation.id).at(-1)?.content).toContain('[[artefato:demo@2]]');
  });

  it('isola conversas entre usuários: B nunca vê nem altera recursos de A', async () => {
    const appA = appFor(database, USER_A);
    const appB = appFor(database, USER_B);

    const created = await appA.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ providerId: 'ollama', modelId: 'llama3.2', title: 'Segredo de A' }),
    });
    expect(created.status).toBe(201);
    const conversationId = (await created.json()).conversation.id;

    // B não vê a conversa de A — 404, sem revelar que ela existe.
    const fetchedByB = await appB.request(`/api/conversations/${conversationId}`, { headers: authHeader(USER_B) });
    expect(fetchedByB.status).toBe(404);
    const messagesByB = await appB.request(`/api/conversations/${conversationId}/messages`, { headers: authHeader(USER_B) });
    expect(messagesByB.status).toBe(404);
    const patchedByB = await appB.request(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(USER_B) },
      body: JSON.stringify({ title: 'Invadida' }),
    });
    expect(patchedByB.status).toBe(404);
    const deletedByB = await appB.request(`/api/conversations/${conversationId}`, { method: 'DELETE', headers: authHeader(USER_B) });
    expect(deletedByB.status).toBe(404);

    // A lista de B é vazia e o recurso de A continua intacto.
    const listByB = await appB.request('/api/conversations', { headers: authHeader(USER_B) });
    expect((await listByB.json()).conversations).toHaveLength(0);
    const stillThere = await appA.request(`/api/conversations/${conversationId}`, { headers: authHeader(USER_A) });
    expect(stillThere.status).toBe(200);
  });

  it('limita inícios de chat a 20 por minuto, 429 antes de tocar o upstream', async () => {
    let upstreamCalls = 0;
    const app = appFor(database, USER_A, async () => {
      upstreamCalls += 1;
      return sseResponse();
    });

    for (let index = 0; index < 20; index += 1) {
      const response = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
        body: chatBody(),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(upstreamCalls).toBe(20);

    // O 21º início é recusado pelo limite ANTES de qualquer chamada ao upstream.
    const blocked = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error.code).toBe('RATE_LIMIT');
    expect(upstreamCalls).toBe(20);
  });

  it('devolve 401 sem token em todas as rotas privadas', async () => {
    const app = appFor(database, USER_A);
    const cases: Array<{ path: string; init?: RequestInit }> = [
      { path: '/api/models' },
      { path: '/api/providers' },
      { path: '/api/providers/opencode', init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x', baseURL: 'https://exemplo.invalido/v1' }) } },
      { path: '/api/providers/opencode/discover-models', init: { method: 'POST' } },
      { path: '/api/providers/opencode', init: { method: 'DELETE' } },
      { path: '/api/conversations' },
      { path: '/api/conversations', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) } },
      { path: '/api/conversations/qualquer-id' },
      { path: '/api/conversations/qualquer-id', init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) } },
      { path: '/api/conversations/qualquer-id', init: { method: 'DELETE' } },
      { path: '/api/conversations/qualquer-id/messages' },
      { path: '/api/conversations/qualquer-id/artifacts' },
      { path: '/api/conversations/search?q=termo' },
      { path: '/api/analytics/costs' },
      { path: '/api/chat', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody() } },
      { path: '/api/rota-inexistente' },
    ];
    for (const { path, init } of cases) {
      const response = await app.request(path, init);
      expect(response.status, path).toBe(401);
      const body = await response.json();
      expect(body.error.code, path).toBe('UNAUTHORIZED');
    }
  });
});
