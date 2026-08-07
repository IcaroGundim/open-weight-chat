import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatDatabase } from './db/queries';
import { createApp, resolveAppOrigin } from './index';
import { createAuthMiddleware } from './auth';
import { workbookToXlsx } from './spreadsheets';

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
    // deepseek, glm, kimi, openrouter, ollama, opencode, opencode-go.
    expect(body.providers).toHaveLength(7);
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

  it('envia o esforço mesmo em modelo marcado como sem raciocínio', async () => {
    const bodies: string[] = [];
    // llama3.2 tem reasoning: false no catálogo — e TODO modelo descoberto
    // pelo /models de um provedor real recebe esse mesmo false, porque o
    // endpoint padrão não informa a capacidade. Travar por aí desabilitava o
    // recurso inteiro no uso BYOK. Quem protege do 400 é a retentativa sem os
    // campos, exercitada em llm-client.test.ts.
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

    expect(JSON.parse(bodies[0]).reasoning_effort).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Busca na web
  // ---------------------------------------------------------------------------

  /**
   * SearXNG em localhost: o ssrf.ts permite loopback fora de produção, então a
   * suíte inteira roda sem resolver nome nenhum na internet.
   */
  const BUSCA_URL = 'http://localhost:9999';

  async function configurarBusca(app: ReturnType<typeof appFor>, overrides: Record<string, unknown> = {}) {
    return app.request('/api/search-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ backend: 'searxng', baseURL: BUSCA_URL, maxResults: 2, enabled: true, ...overrides }),
    });
  }

  function sseComTexto(texto: string): Response {
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: texto } }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
        + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  /**
   * O caminho inteiro da busca nativa, do banco ao SSE: a configuração diz
   * `openrouter`, o modelo é da OpenRouter, o corpo que sai leva o plugin, e
   * as citações que voltam viram o cartão de busca da interface.
   */
  it('a busca nativa vai no corpo e as citações viram cartão de busca', async () => {
    process.env.ALLOW_ENV_API_KEYS = 'true';
    process.env.OPENROUTER_API_KEY = 'chave-de-teste';
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return new Response(
        'data: {"choices":[{"delta":{"content":"o preço subiu"}}]}\n\n'
        + 'data: {"choices":[{"delta":{"annotations":[{"type":"url_citation",'
        + '"url_citation":{"url":"https://exemplo.com/cafe","title":"Café hoje","content":"subiu 3%"}}]}}]}\n\n'
        + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0071}}\n\n'
        + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const salva = await configurarBusca(app, { backend: 'openrouter', baseURL: undefined, maxResults: 4 });
    expect(salva.status).toBe(200);
    // Sem chave de buscador e sem URL: é a da OpenRouter que já está posta.
    expect(await salva.json()).toMatchObject({ settings: { backend: 'openrouter', enabled: true, hasKey: false } });

    const resposta = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' }),
    });
    expect(resposta.status).toBe(200);
    const texto = await resposta.text();

    // 1. O plugin saiu no corpo, com o limite configurado.
    expect(JSON.parse(corpos[0]).plugins).toEqual([{ id: 'web', max_results: 4 }]);
    // 2. O prompt de marcador NÃO foi injetado: as duas buscas não convivem.
    expect(corpos[0]).not.toContain('<search>');
    // 3. Uma chamada só — sem os rounds do protocolo de marcador.
    expect(corpos).toHaveLength(1);
    // 4. A citação virou cartão de busca para a interface.
    expect(texto).toContain('search_end');
    expect(texto).toContain('https://exemplo.com/cafe');
    // 5. O custo veio da OpenRouter, não da tabela, e não é estimativa.
    const usage = texto.split('\n').filter((linha) => linha.includes('"type":"usage"')).pop() ?? '';
    expect(usage).toContain('"reported":true');
    expect(usage).toContain('0.0071');
  });

  it('com um modelo de outro provedor, a busca nativa não promete nada ao modelo', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseComTexto('respondo com o que sei');
    });
    // Guarda contra um teste que passaria sozinho: se a configuração não
    // tivesse sido salva, "sem plugin e sem marcador" seria verdade à toa.
    const salva = await configurarBusca(app, { backend: 'openrouter', baseURL: undefined });
    expect(salva.status).toBe(200);
    expect(await salva.json()).toMatchObject({ settings: { backend: 'openrouter', enabled: true } });

    const resposta = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    expect(resposta.status).toBe(200);
    await resposta.text();

    // Nem o plugin (o endpoint não o conhece) nem o prompt de marcador (não há
    // buscador nosso configurado). O modelo não fica sabendo da busca.
    expect(JSON.parse(corpos[0])).not.toHaveProperty('plugins');
    expect(corpos[0]).not.toContain('<search>');
  });

  /**
   * A OpenRouter repete a lista inteira de anotações a cada chunk. Emitir um
   * cartão por chunk empilhava o mesmo resultado várias vezes na mensagem.
   */
  it('as citações repetidas viram um cartão só', async () => {
    process.env.ALLOW_ENV_API_KEYS = 'true';
    process.env.OPENROUTER_API_KEY = 'chave-de-teste';
    const anotacao = '{"type":"url_citation","url_citation":{"url":"https://a.com","title":"A","content":"x"}}';
    const app = appFor(database, USER_A, async () => new Response(
      `data: {"choices":[{"delta":{"content":"o preço ","annotations":[${anotacao}]}}]}\n\n`
      + `data: {"choices":[{"delta":{"content":"subiu.","annotations":[${anotacao}]}}]}\n\n`
      + `data: {"choices":[{"delta":{},"finish_reason":"stop","message":{"annotations":[${anotacao}]}}]}\n\n`
      + 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n'
      + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    expect((await configurarBusca(app, { backend: 'openrouter', baseURL: undefined })).status).toBe(200);

    const resposta = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' }),
    });
    const texto = await resposta.text();
    expect(texto.split('\n').filter((linha) => linha.includes('"type":"search_end"'))).toHaveLength(1);
  });

  /**
   * O marcador é uma convenção que ESTE servidor pede no prompt. Sem esse
   * pedido, um `<search>` no texto é o modelo *falando sobre* buscar — e
   * cortar a resposta ali jogava fora o resto e colava um "Limite de 3 buscas"
   * sem sentido. Vale para a busca nativa e para quem não configurou busca.
   */
  it('sem busca externa, um <search> no texto não trunca a resposta', async () => {
    const app = appFor(database, USER_A, async () => new Response(
      'data: {"choices":[{"delta":{"content":"Eu usaria "}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"<search>preço do café</search>"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":" mas já sei: subiu 3%."}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n'
      + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const resposta = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    const texto = await resposta.text();
    const entregue = texto.split('\n')
      .filter((linha) => linha.startsWith('data: ') && linha.includes('"type":"text"'))
      .map((linha) => (JSON.parse(linha.slice(6)) as { text: string }).text)
      .join('');
    expect(entregue).toBe('Eu usaria <search>preço do café</search> mas já sei: subiu 3%.');
    expect(texto).not.toContain('Limite de');
  });

  it('faz a busca pedida pelo modelo e devolve os resultados para ele responder', async () => {
    const corposDeChat: string[] = [];
    let consultaRecebida: string | null = null;
    const rodadas = [
      'Deixa eu verificar. <search>preço do café hoje</search> isto aqui é descartado',
      'Segundo a fonte, o preço subiu.',
    ];

    const app = appFor(database, USER_A, async (input, init) => {
      const url = String(input);
      if (url.includes('/chat/completions')) {
        corposDeChat.push(String(init?.body));
        return sseComTexto(rodadas[corposDeChat.length - 1] ?? 'fim');
      }
      consultaRecebida = new URL(url).searchParams.get('q');
      return new Response(
        JSON.stringify({ results: [{ title: 'Café em alta', url: 'https://exemplo.com/cafe', content: 'Alta de 12% no mês.' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    expect((await configurarBusca(app)).status).toBe(200);

    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'quanto está o café?' }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();

    // O usuário vê a busca acontecendo e recebe as fontes.
    expect(body).toContain('"type":"search_start"');
    expect(body).toContain('"type":"search_end"');
    expect(body).toContain('https://exemplo.com/cafe');
    // A consulta que chegou ao buscador é a que o modelo escreveu.
    expect(consultaRecebida).toBe('preço do café hoje');

    // Duas chamadas ao provedor: uma que pediu a busca, outra que respondeu.
    expect(corposDeChat).toHaveLength(2);
    // Os resultados chegaram ao modelo na segunda.
    expect(corposDeChat[1]).toContain('Alta de 12% no mês.');
    // E o marcador nunca aparece na resposta guardada.
    const conversa = database.listConversations(USER_A)[0];
    const mensagens = database.getMessages(USER_A, conversa.id);
    const resposta = mensagens.at(-1);
    expect(resposta?.content).toContain('o preço subiu');
    expect(resposta?.content).not.toContain('<search>');
    // O texto depois do marcador é descartado, como o prompt promete.
    expect(resposta?.content).not.toContain('descartado');
  });

  it('soma o uso dos dois rounds em vez de cobrar só o último', async () => {
    // Cada round é uma chamada cobrada. Ficar com o uso do último faria o custo
    // aparecer menor do que foi.
    const app = appFor(database, USER_A, async (input) => {
      const url = String(input);
      if (url.includes('/chat/completions')) return sseComTexto('<search>algo</search>');
      return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } });
    });
    await configurarBusca(app);
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    await response.text();

    const conversa = database.listConversations(USER_A)[0];
    const resposta = database.getMessages(USER_A, conversa.id).at(-1);
    // 4 rounds (1 + 3 buscas), 10 tokens de prompt cada.
    expect(resposta?.usage?.promptTokens).toBe(40);
    expect(resposta?.usage?.completionTokens).toBe(20);
  });

  it('para no limite de buscas em vez de rodar para sempre', async () => {
    let chamadasDeBusca = 0;
    const app = appFor(database, USER_A, async (input) => {
      const url = String(input);
      // Um modelo que pede busca em todo round: sem limite, o laço não pararia.
      if (url.includes('/chat/completions')) return sseComTexto('<search>de novo</search>');
      chamadasDeBusca += 1;
      return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } });
    });
    await configurarBusca(app);
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    const body = await response.text();
    expect(chamadasDeBusca).toBe(3);
    expect(body).toContain('Limite de 3 buscas');
  });

  it('não ensina o protocolo de busca a quem não tem busca configurada', async () => {
    // Prometer ao modelo uma ferramenta que não existe faz ele gastar o turno
    // pedindo algo que nunca chega.
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseResponse();
    });
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    // Ler o corpo é o que faz o callback do SSE rodar até o fim — sem isto o
    // provedor nem chega a ser chamado, e o slot de stream vaza para o
    // próximo teste.
    await response.text();
    expect(corpos[0]).not.toContain('<search>');
  });

  it('a resposta da busca falha sem derrubar a mensagem', async () => {
    const app = appFor(database, USER_A, async (input) => {
      const url = String(input);
      if (url.includes('/chat/completions')) {
        return sseComTexto(url.includes('completions') ? '<search>algo</search>' : 'x');
      }
      return new Response('erro do buscador', { status: 500 });
    });
    await configurarBusca(app);
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody(),
    });
    const body = await response.text();
    // O usuário fica sabendo da falha, e o turno termina normalmente.
    expect(body).toContain('"type":"search_end"');
    expect(body).toContain('"failure"');
    expect(body).toContain('"type":"done"');
  });

  it('isola a configuração de busca entre usuários', async () => {
    const appA = appFor(database, USER_A);
    const appB = appFor(database, USER_B);
    await configurarBusca(appA);

    const deB = await appB.request('/api/search-settings', { headers: authHeader(USER_B) });
    expect((await deB.json() as { settings: unknown }).settings).toBeNull();

    const deA = await appA.request('/api/search-settings', { headers: authHeader(USER_A) });
    const corpoA = await deA.json() as { settings: { backend: string; hasKey: boolean; baseURL: string } };
    expect(corpoA.settings.backend).toBe('searxng');
    expect(corpoA.settings.baseURL).toBe(BUSCA_URL);
    // A chave nunca volta ao navegador — só se existe.
    expect(Object.keys(corpoA.settings)).not.toContain('apiKey');
  });

  it('recusa URL de instância que a proteção de SSRF barra', async () => {
    const app = appFor(database, USER_A);
    const response = await configurarBusca(app, { baseURL: 'http://169.254.169.254' });
    expect(response.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Anexos
  // ---------------------------------------------------------------------------

  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  async function subirAnexo(app: ReturnType<typeof appFor>, corpo: Record<string, unknown>, userId = USER_A) {
    return app.request('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(userId) },
      body: JSON.stringify(corpo),
    });
  }

  it('manda o texto do documento ao modelo, sem sujar a mensagem do usuário', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseResponse();
    });

    const enviado = await subirAnexo(app, {
      filename: 'notas.txt',
      mime: 'text/plain',
      data: Buffer.from('A taxa de juros subiu 2 pontos.', 'utf8').toString('base64'),
    });
    expect(enviado.status).toBe(200);
    const { attachment } = await enviado.json() as { attachment: { id: string; kind: string; textChars: number } };
    expect(attachment.kind).toBe('document');
    expect(attachment.textChars).toBeGreaterThan(0);

    const resposta = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'resuma', attachmentIds: [attachment.id] }),
    });
    expect(resposta.status).toBe(200);
    await resposta.text();

    // O modelo recebeu o conteúdo do documento…
    expect(corpos[0]).toContain('A taxa de juros subiu 2 pontos.');
    expect(corpos[0]).toContain('notas.txt');
    // …e a mensagem guardada continua sendo só o que o usuário escreveu.
    const conversa = database.listConversations(USER_A)[0];
    const mensagens = database.getMessages(USER_A, conversa.id);
    expect(mensagens[0].content).toBe('resuma');
    expect(mensagens[0].content).not.toContain('taxa de juros');
  });

  it('manda a imagem como parte de conteúdo, e só quando existe imagem', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseResponse();
    });
    const enviado = await subirAnexo(app, { filename: 'tela.png', mime: 'image/png', data: PNG_B64 });
    const { attachment } = await enviado.json() as { attachment: { id: string; kind: string } };
    expect(attachment.kind).toBe('image');

    await (await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'o que é isto?', attachmentIds: [attachment.id] }),
    })).text();

    const corpo = JSON.parse(corpos[0]) as { messages: Array<{ role: string; content: unknown }> };
    const doUsuario = corpo.messages.filter((m) => m.role === 'user').at(-1);
    expect(Array.isArray(doUsuario?.content)).toBe(true);
    expect(JSON.stringify(doUsuario?.content)).toContain('image_url');
    expect(JSON.stringify(doUsuario?.content)).toContain('data:image/png;base64,');
    // As demais mensagens continuam com `content` string: há endpoint que
    // recusa array de partes mesmo para texto puro.
    const sistema = corpo.messages.find((m) => m.role === 'system');
    expect(typeof sistema?.content).toBe('string');
  });

  it('refaz sem as imagens quando o modelo não enxerga, em vez de falhar', async () => {
    // O catálogo não diz quem tem visão — o /models padrão não informa. Então
    // tenta-se, e o 400 do provedor é o sinal.
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      if (corpos.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Invalid content type: image_url is not supported' } }), { status: 400 });
      }
      return sseResponse();
    });
    const enviado = await subirAnexo(app, { filename: 'tela.png', mime: 'image/png', data: PNG_B64 });
    const { attachment } = await enviado.json() as { attachment: { id: string } };

    const resposta = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'descreva', attachmentIds: [attachment.id] }),
    });
    expect(resposta.status).toBe(200);
    const corpo = await resposta.text();
    expect(corpo).toContain('"type":"text"');

    expect(corpos).toHaveLength(2);
    expect(corpos[0]).toContain('image_url');
    // A segunda tentativa não leva imagem, e diz por quê.
    expect(corpos[1]).not.toContain('image_url');
    expect(corpos[1]).toContain('não aceita imagens');
  });

  it('recusa arquivo que não sabe ler', async () => {
    const app = appFor(database, USER_A);
    const resposta = await subirAnexo(app, {
      filename: 'x.bin',
      mime: 'application/octet-stream',
      data: Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64'),
    });
    expect(resposta.status).toBe(400);
  });

  it('isola anexos entre usuários: B não lê, não apaga nem anexa os de A', async () => {
    const appA = appFor(database, USER_A);
    const appB = appFor(database, USER_B, async () => sseResponse());
    const enviado = await subirAnexo(appA, { filename: 'tela.png', mime: 'image/png', data: PNG_B64 });
    const { attachment } = await enviado.json() as { attachment: { id: string } };

    // Recurso de outro usuário devolve 404, não 403 — não confirma que existe.
    expect((await appB.request(`/api/attachments/${attachment.id}`, { headers: authHeader(USER_B) })).status).toBe(404);
    expect((await appB.request(`/api/attachments/${attachment.id}`, { method: 'DELETE', headers: authHeader(USER_B) })).status).toBe(404);

    // E citar o id no chat não anexa nada: a consulta é por dono.
    await (await appB.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_B) },
      body: chatBody({ content: 'oi', attachmentIds: [attachment.id] }),
    })).text();
    const conversaB = database.listConversations(USER_B)[0];
    expect(database.listAttachmentsForConversation(USER_B, conversaB.id)).toHaveLength(0);
    // O anexo de A continua dele, e intocado.
    expect(database.getAttachment(USER_A, attachment.id)?.messageId).toBeNull();
  });

  it('serve os bytes da imagem com cabeçalhos que impedem adivinhação de tipo', async () => {
    const app = appFor(database, USER_A);
    const enviado = await subirAnexo(app, { filename: 'tela.png', mime: 'image/png', data: PNG_B64 });
    const { attachment } = await enviado.json() as { attachment: { id: string } };
    const resposta = await app.request(`/api/attachments/${attachment.id}`, { headers: authHeader(USER_A) });
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toBe('image/png');
    expect(resposta.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('não permite apagar anexo já enviado', async () => {
    const app = appFor(database, USER_A, async () => sseResponse());
    const enviado = await subirAnexo(app, { filename: 'tela.png', mime: 'image/png', data: PNG_B64 });
    const { attachment } = await enviado.json() as { attachment: { id: string } };
    await (await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ attachmentIds: [attachment.id] }),
    })).text();
    // Apagar depois deixaria a mensagem falando de um arquivo inexistente.
    expect((await app.request(`/api/attachments/${attachment.id}`, { method: 'DELETE', headers: authHeader(USER_A) })).status).toBe(404);
  });

  it('importa, edita, versiona e exporta CSV como planilha', async () => {
    const app = appFor(database, USER_A);
    const enviado = await subirAnexo(app, {
      filename: 'vendas.csv',
      mime: 'text/csv',
      data: Buffer.from('produto,valor\nCafé,10\nPão,20', 'utf8').toString('base64'),
    });
    expect(enviado.status).toBe(200);
    const { attachment } = await enviado.json() as { attachment: { id: string; kind: string; spreadsheet: { sheetNames: string[] } } };
    expect(attachment.kind).toBe('spreadsheet');
    expect(attachment.spreadsheet.sheetNames).toEqual(['Planilha 1']);

    const aberta = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, { headers: authHeader(USER_A) });
    const payload = await aberta.json() as { workbook: { sheets: Array<{ cells: Array<{ row: number; column: number; value: unknown }> }> }; version: number };
    expect(payload.version).toBe(1);
    payload.workbook.sheets[0].cells.push({ row: 4, column: 1, value: 'Bolo' });
    (payload.workbook.sheets[0] as { rowCount?: number }).rowCount = 4;

    const salva = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ workbook: payload.workbook, baseVersion: 1 }),
    });
    expect(salva.status).toBe(200);
    expect((await salva.json() as { version: number }).version).toBe(2);

    const antiga = await app.request(`/api/attachments/${attachment.id}/spreadsheet?version=1`, { headers: authHeader(USER_A) });
    const antigaPayload = await antiga.json() as { workbook: { sheets: Array<{ cells: Array<{ value: unknown }> }> }; version: number; currentVersion: number };
    expect(antigaPayload.version).toBe(1);
    expect(antigaPayload.currentVersion).toBe(2);
    expect(antigaPayload.workbook.sheets[0].cells.some((cell) => cell.value === 'Bolo')).toBe(false);

    const conflito = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ workbook: payload.workbook, baseVersion: 1 }),
    });
    expect(conflito.status).toBe(409);

    const exportada = await app.request(`/api/attachments/${attachment.id}/spreadsheet/export?format=csv`, { headers: authHeader(USER_A) });
    expect(exportada.status).toBe(200);
    expect(await exportada.text()).toContain('Bolo');
    const exportadaAntiga = await app.request(`/api/attachments/${attachment.id}/spreadsheet/export?format=csv&version=1`, { headers: authHeader(USER_A) });
    expect(await exportadaAntiga.text()).not.toContain('Bolo');
  });

  it('importa XLSX real e o disponibiliza na bancada', async () => {
    const app = appFor(database, USER_A);
    const xlsx = await workbookToXlsx({ sheets: [{
      name: 'Resumo', rowCount: 2, columnCount: 2,
      cells: [{ row: 1, column: 1, value: 'Métrica' }, { row: 2, column: 1, value: 'Receita' }, { row: 2, column: 2, value: 1250 }],
    }] });
    const enviado = await subirAnexo(app, {
      filename: 'resumo.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: xlsx.toString('base64'),
    });
    expect(enviado.status).toBe(200);
    const { attachment } = await enviado.json() as { attachment: { id: string; kind: string } };
    expect(attachment.kind).toBe('spreadsheet');
    const aberta = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, { headers: authHeader(USER_A) });
    const payload = await aberta.json() as { workbook: { sheets: Array<{ name: string }> } };
    expect(payload.workbook.sheets[0].name).toBe('Resumo');
    const exportada = await app.request(`/api/attachments/${attachment.id}/spreadsheet/export?format=xlsx`, { headers: authHeader(USER_A) });
    expect(exportada.status).toBe(200);
    expect(exportada.headers.get('content-type')).toContain('spreadsheetml');
    expect((await exportada.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('recalcula fórmulas ao salvar uma edição da bancada', async () => {
    const app = appFor(database, USER_A);
    const enviado = await subirAnexo(app, {
      filename: 'calculo.csv', mime: 'text/csv', data: Buffer.from('valor\n2\n3').toString('base64'),
    });
    const { attachment } = await enviado.json() as { attachment: { id: string } };
    const aberta = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, { headers: authHeader(USER_A) });
    const payload = await aberta.json() as { workbook: { sheets: Array<{ rowCount: number; cells: Array<Record<string, unknown>> }> } };
    payload.workbook.sheets[0].rowCount = 4;
    payload.workbook.sheets[0].cells.push({ row: 4, column: 1, value: null, formula: 'SOMA(A2:A3)' });
    const salva = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ workbook: payload.workbook, baseVersion: 1 }),
    });
    expect(salva.status).toBe(200);
    const saved = await salva.json() as { workbook: { sheets: Array<{ cells: Array<{ row: number; value: unknown }> }> } };
    expect(saved.workbook.sheets[0].cells.find((cell) => cell.row === 4)?.value).toBe(5);
  });

  it('isola a leitura e edição de planilhas entre usuários', async () => {
    const appA = appFor(database, USER_A);
    const appB = appFor(database, USER_B);
    const enviado = await subirAnexo(appA, {
      filename: 'privada.csv', mime: 'text/csv', data: Buffer.from('segredo\n42').toString('base64'),
    });
    const { attachment } = await enviado.json() as { attachment: { id: string } };
    expect((await appB.request(`/api/attachments/${attachment.id}/spreadsheet`, { headers: authHeader(USER_B) })).status).toBe(404);
    expect((await appB.request(`/api/attachments/${attachment.id}/spreadsheet`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(USER_B) },
      body: JSON.stringify({ workbook: { sheets: [{ name: 'X', rowCount: 1, columnCount: 1, cells: [] }] }, baseVersion: 1 }),
    })).status).toBe(404);
  });

  it('coloca a seleção da planilha junto da pergunta atual enviada ao modelo', async () => {
    const upstreamBodies: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      upstreamBodies.push(String(init?.body));
      return sseResponse();
    });
    const enviado = await subirAnexo(app, {
      filename: 'indicadores.csv', mime: 'text/csv', data: Buffer.from('nome,valor\nA,10\nB,20\nC,30').toString('base64'),
    });
    const { attachment } = await enviado.json() as { attachment: { id: string } };
    await (await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'guarde esta planilha', attachmentIds: [attachment.id] }),
    })).text();
    const conversation = database.listConversations(USER_A)[0];
    const aberta = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, { headers: authHeader(USER_A) });
    const atual = await aberta.json() as { workbook: { sheets: Array<{ rowCount: number; cells: Array<{ row: number; column: number; value: unknown }> }> } };
    atual.workbook.sheets[0].rowCount = 5;
    atual.workbook.sheets[0].cells.push({ row: 5, column: 1, value: 'Bolo' });
    await app.request(`/api/attachments/${attachment.id}/spreadsheet`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: JSON.stringify({ workbook: atual.workbook, baseVersion: 1 }),
    });
    await (await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({
        conversationId: conversation.id,
        content: 'compare estas duas linhas',
        spreadsheetSelection: { attachmentId: attachment.id, version: 1, sheet: 'Planilha 1', startRow: 2, startColumn: 1, endRow: 3, endColumn: 2 },
      }),
    })).text();
    const last = upstreamBodies.at(-1) ?? '';
    expect(last).toContain('FIM DA SELEÇÃO');
    expect(last).toContain('A\\t10');
    expect(last.indexOf('FIM DA SELEÇÃO')).toBeLessThan(last.indexOf('compare estas duas linhas'));
    expect(last).not.toContain('Bolo');

    await (await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({
        conversationId: conversation.id,
        content: 'leia a versão nova',
        spreadsheetSelection: { attachmentId: attachment.id, version: 2, sheet: 'Planilha 1', startRow: 5, startColumn: 1, endRow: 5, endColumn: 1 },
      }),
    })).text();
    expect(upstreamBodies.at(-1)).toContain('Bolo');
  });

  // ---------------------------------------------------------------------------
  // Edição manual do artefato
  // ---------------------------------------------------------------------------

  const SSE_ARTEFATO =
    'data: {"choices":[{"delta":{"content":"<artifact id=\\"nota\\" type=\\"markdown\\" title=\\"Nota\\">texto do modelo</artifact>"}}]}\n\n'
    + 'data: [DONE]\n\n';

  async function criarArtefato(app: ReturnType<typeof appFor>, userId = USER_A) {
    await (await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(userId) },
      body: chatBody({ content: 'faça uma nota' }),
    })).text();
    return database.listConversations(userId)[0].id;
  }

  function editar(app: ReturnType<typeof appFor>, conversa: string, slug: string, content: string, userId = USER_A) {
    return app.request(`/api/conversations/${conversa}/artifacts/${slug}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(userId) },
      body: JSON.stringify({ content }),
    });
  }

  it('a edição cria uma versão nova e preserva a anterior', async () => {
    // O histórico é o que torna seguro editar: dá para voltar ao que o modelo
    // escreveu depois de mexer à mão.
    const app = appFor(database, USER_A, async () => new Response(SSE_ARTEFATO, { headers: { 'content-type': 'text/event-stream' } }));
    const conversa = await criarArtefato(app);

    const resposta = await editar(app, conversa, 'nota', 'texto editado à mão');
    expect(resposta.status).toBe(200);
    const { version } = await resposta.json() as { version: { version: number; content: string } };
    expect(version.version).toBe(2);

    const artefato = database.getArtifacts(USER_A, conversa)[0];
    expect(artefato.currentVersion).toBe(2);
    expect(artefato.versions.find((v) => v.version === 1)?.content).toBe('texto do modelo');
    expect(artefato.versions.find((v) => v.version === 2)?.content).toBe('texto editado à mão');
  });

  it('a versão editada não inventa custo nem se atribui a uma mensagem', async () => {
    // Ninguém gastou token para escrever isto. Zero seria uma medição errada;
    // ausente é exibido como indisponível.
    const app = appFor(database, USER_A, async () => new Response(SSE_ARTEFATO, { headers: { 'content-type': 'text/event-stream' } }));
    const conversa = await criarArtefato(app);
    await editar(app, conversa, 'nota', 'editado');

    const v2 = database.getArtifacts(USER_A, conversa)[0].versions.find((v) => v.version === 2);
    expect(v2?.costUsd).toBeNull();
    expect(v2?.outputTokens).toBeNull();
    expect(v2?.messageId).toBeNull();
  });

  it('recusa editar artefato que não existe', async () => {
    const app = appFor(database, USER_A, async () => new Response(SSE_ARTEFATO, { headers: { 'content-type': 'text/event-stream' } }));
    const conversa = await criarArtefato(app);
    expect((await editar(app, conversa, 'nao-existe', 'x')).status).toBe(404);
  });

  it('isola a edição entre usuários: B não edita artefato de A', async () => {
    const appA = appFor(database, USER_A, async () => new Response(SSE_ARTEFATO, { headers: { 'content-type': 'text/event-stream' } }));
    const appB = appFor(database, USER_B);
    const conversa = await criarArtefato(appA);

    // Conversa de outro usuário devolve 404, não 403.
    expect((await editar(appB, conversa, 'nota', 'invadido', USER_B)).status).toBe(404);
    // E o conteúdo de A fica intacto.
    expect(database.getArtifacts(USER_A, conversa)[0].versions).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Modo Science
  // ---------------------------------------------------------------------------

  function sseTexto(texto: string): Response {
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: texto } }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
        + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  function chatScience(app: ReturnType<typeof appFor>, nivel: string, formato = 'markdown') {
    return app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'escreva sobre entropia', scienceLevel: nivel, scienceFormat: formato }),
    });
  }

  it('encadeia dois agentes no nível básico e só o último escreve na tela', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseTexto(corpos.length === 1 ? 'rascunho do primeiro agente' : 'documento revisado');
    });

    const resposta = await chatScience(app, 'basic');
    expect(resposta.status).toBe(200);
    const corpo = await resposta.text();

    // Duas chamadas: levantamento e revisão.
    expect(corpos).toHaveLength(2);
    // O usuário acompanha o progresso…
    expect(corpo).toContain('"type":"science_stage"');
    // …e só o texto do revisor vira a resposta.
    const conversa = database.listConversations(USER_A)[0];
    const mensagem = database.getMessages(USER_A, conversa.id).at(-1);
    expect(mensagem?.content).toContain('documento revisado');
    expect(mensagem?.content).not.toContain('rascunho do primeiro agente');
  });

  it('entrega ao revisor o texto que o agente anterior escreveu', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseTexto(corpos.length === 1 ? 'CONTEUDO-DO-PRIMEIRO' : 'final');
    });
    await (await chatScience(app, 'basic')).text();
    // Sem isto a cadeia seria dois agentes independentes, não uma cadeia.
    expect(corpos[1]).toContain('CONTEUDO-DO-PRIMEIRO');
    expect(corpos[1]).toContain('revisar');
  });

  it('todo nível ligado roda a cadeia de dois agentes', async () => {
    // Os níveis de 3 e 5 saíram; os valores continuam aceitos por causa das
    // conversas já gravadas, e caem na cadeia que sobrou.
    for (const [nivel, esperado] of [['basic', 2], ['intermediate', 2], ['advanced', 2]] as const) {
      const database2 = new ChatDatabase(':memory:');
      const corpos: string[] = [];
      const app = appFor(database2, USER_A, async (_input, init) => {
        corpos.push(String(init?.body));
        return sseTexto('texto');
      });
      await (await chatScience(app, nivel)).text();
      expect(corpos.length, nivel).toBe(esperado);
      database2.close();
    }
  });

  it('transmite o texto dos agentes intermediários enquanto eles escrevem', async () => {
    // Não é só conforto visual: sem isto o SSE ficava minutos sem enviar um
    // byte durante um estágio de redação longa, e conexão ociosa é o que
    // proxy, navegador e plataforma derrubam. A tela ficava "1/2" para sempre
    // sem que nada estivesse travado.
    const app = appFor(database, USER_A, async (_input, init) => {
      const primeiro = !String(init?.body).includes('revisar');
      return sseTexto(primeiro ? 'rascunho em andamento' : 'final');
    });
    const corpo = await (await chatScience(app, 'basic')).text();

    expect(corpo).toContain('"type":"science_delta"');
    expect(corpo).toContain('rascunho em andamento');
    // E o rascunho não vira a resposta guardada.
    const conversa = database.listConversations(USER_A)[0];
    expect(database.getMessages(USER_A, conversa.id).at(-1)?.content).not.toContain('rascunho em andamento');
  });

  it('guarda o documento longo num artefato mesmo se o modelo não abrir a tag', async () => {
    // Prompt é pedido, não imposição. Um documento de milhares de palavras
    // solto no corpo da mensagem some no histórico, não versiona e não dá
    // para baixar — é exatamente o caso do artefato.
    const longo = 'Física newtoniana. '.repeat(120);
    const app = appFor(database, USER_A, async (_input, init) => {
      const revisor = String(init?.body).includes('revisar');
      return sseTexto(revisor ? `# Mecânica Clássica\n\n${longo}` : 'rascunho');
    });
    await (await chatScience(app, 'basic')).text();

    const conversa = database.listConversations(USER_A)[0];
    const artefatos = database.getArtifacts(USER_A, conversa.id);
    expect(artefatos).toHaveLength(1);
    expect(artefatos[0].kind).toBe('markdown');
    expect(artefatos[0].title).toBe('Mecânica Clássica');
    expect(artefatos[0].versions[0].content).toContain('Física newtoniana.');
    // E o texto não fica duplicado na mensagem.
    const mensagem = database.getMessages(USER_A, conversa.id).at(-1);
    expect(mensagem?.content).not.toContain(longo);
  });

  it('não deixa o documento duplicado no chat quando o modelo abre o artefato E repete fora', async () => {
    // É o caso que a rede de segurança não pegava: já existe artefato, então
    // ela pulava, e o corpo da mensagem — que é o que se lê primeiro —
    // continuava com o documento inteiro.
    const longo = 'Conteúdo do documento. '.repeat(120);
    const app = appFor(database, USER_A, async (_input, init) => {
      const revisor = String(init?.body).includes('revisar');
      if (!revisor) return sseTexto('rascunho');
      return sseTexto(
        `Segue o documento.\n\n<artifact id="documento" type="markdown" title="Mecânica">${longo}</artifact>\n\n${longo}`,
      );
    });
    await (await chatScience(app, 'basic')).text();

    const conversa = database.listConversations(USER_A)[0];
    const artefatos = database.getArtifacts(USER_A, conversa.id);
    expect(artefatos).toHaveLength(1);
    // O documento está no artefato…
    expect(artefatos[0].versions[0].content).toContain('Conteúdo do documento.');
    // …e a mensagem virou uma apresentação curta com a chamada dele.
    const mensagem = database.getMessages(USER_A, conversa.id).at(-1);
    expect(mensagem?.content).toContain('Segue o documento.');
    expect(mensagem!.content.length).toBeLessThan(400);
  });

  it('apresentação curta fora do artefato é preservada', async () => {
    // Duas frases é o que o prompt pede; cortar isso deixaria a mensagem sem
    // dizer o que o artefato contém.
    const app = appFor(database, USER_A, async (_input, init) => {
      const revisor = String(init?.body).includes('revisar');
      if (!revisor) return sseTexto('rascunho');
      return sseTexto(
        'Este documento cobre as leis de Newton.\n\n'
        + `<artifact id="documento" type="markdown" title="Newton">${'Texto. '.repeat(300)}</artifact>`,
      );
    });
    await (await chatScience(app, 'basic')).text();
    const conversa = database.listConversations(USER_A)[0];
    const mensagem = database.getMessages(USER_A, conversa.id).at(-1);
    expect(mensagem?.content).toContain('Este documento cobre as leis de Newton.');
  });

  it('em LaTeX o artefato nasce como código latex, para abrir na prévia certa', () => {
    // Errar o tipo entrega o documento certo no renderizador errado.
    const longo = 'Texto do documento. '.repeat(120);
    return (async () => {
      const app = appFor(database, USER_A, async (_input, init) => {
        const revisor = String(init?.body).includes('revisar');
        return sseTexto(revisor ? `\\section{Mecânica}\n${longo}` : 'rascunho');
      });
      await (await chatScience(app, 'basic', 'latex')).text();
      const conversa = database.listConversations(USER_A)[0];
      const artefato = database.getArtifacts(USER_A, conversa.id)[0];
      expect(artefato.kind).toBe('code');
      expect(artefato.language).toBe('latex');
    })();
  });

  it('resposta curta em modo Science continua no chat, sem artefato', async () => {
    // Um parágrafo dentro de um painel com versionamento é cerimônia sem função.
    const app = appFor(database, USER_A, async () => sseTexto('Resposta curta.'));
    await (await chatScience(app, 'basic')).text();
    const conversa = database.listConversations(USER_A)[0];
    expect(database.getArtifacts(USER_A, conversa.id)).toHaveLength(0);
  });

  it('repassa o raciocínio dos agentes intermediários, sem misturá-lo ao texto', async () => {
    // Com esforço alto o modelo passa minutos só raciocinando antes da
    // primeira palavra escrita. Sem repassar isso, a tela ficava parada no
    // primeiro estágio e parecia que a cadeia nunca começava.
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      if (corpos.length === 1) {
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"pensando alto"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"texto do rascunho"}}]}\n\n'
            + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return sseTexto('final');
    });
    const corpo = await (await chatScience(app, 'basic')).text();

    expect(corpo).toContain('pensando alto');
    expect(corpo).toContain('"reasoning":true');
    // O raciocínio NÃO pode ser passado ao próximo agente: contaminaria o
    // documento com o monólogo interno do anterior.
    expect(corpos[1]).toContain('texto do rascunho');
    expect(corpos[1]).not.toContain('pensando alto');
  });

  it('leva o nível de esforço a TODOS os agentes da cadeia, em qualquer nível', async () => {
    // O esforço é configuração separada do modo Science e as duas se combinam.
    // Um estágio que perdesse o esforço pensaria menos que os outros, sem que
    // nada na tela dissesse isso.
    for (const [esforco, esperado] of [
      ['off', 'minimal'], ['low', 'low'], ['medium', 'medium'],
      ['high', 'high'], ['xhigh', 'high'], ['max', 'high'],
    ] as const) {
      const banco = new ChatDatabase(':memory:');
      const corpos: string[] = [];
      const app = appFor(banco, USER_A, async (_input, init) => {
        corpos.push(String(init?.body));
        return sseTexto('texto');
      });
      await (await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
        body: chatBody({ content: 'tema', scienceLevel: 'advanced', effort: esforco }),
      })).text();

      expect(corpos.length, esforco).toBe(2);
      for (const [posicao, corpo] of corpos.entries()) {
        // `xhigh` e `max` fecham em `high`: são extensões da OpenRouter, e
        // mandá-las a um endpoint compatível daria 400 (ver effort.ts).
        expect(JSON.parse(corpo).reasoning_effort, `${esforco} agente ${posicao + 1}`).toBe(esperado);
      }
      banco.close();
    }
  });

  it('esforço automático não manda campo nenhum, em nenhum agente', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseTexto('texto');
    });
    await (await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'tema', scienceLevel: 'intermediate', effort: 'auto' }),
    })).text();
    expect(corpos).toHaveLength(2);
    for (const corpo of corpos) expect(JSON.parse(corpo).reasoning_effort).toBeUndefined();
  });

  it('a falha do redator é reportada, e o log diz qual agente caiu', async () => {
    // Era o pior desfecho possível: esperar minutos e receber "geração
    // interrompida" sem nada. O revisor entrega um documento mais raso em vez
    // de nenhum.
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      const corpo = String(init?.body);
      corpos.push(corpo);
      // A falha é do ESTÁGIO, não da chamada: o llm-client repete 5xx, e
      // contar chamadas faria a segunda tentativa "consertar" o estágio.
      // Com dois agentes o único intermediário é o redator; a falha dele não
      // deixa texto para revisar, então o turno falha — que é o desenho.
      if (corpo.includes('Papel: levantamento')) return new Response('falha do provedor', { status: 500 });
      return sseTexto('documento final');
    });

    const corpoSse = await (await chatScience(app, 'basic')).text();
    // Sem texto do redator não há o que revisar: inventar um documento a
    // partir do vazio seria pior do que dizer que não deu.
    expect(corpoSse).toContain('"type":"error"');
    expect(corpoSse).toContain('agente 1/2 FALHOU');
  });

  it('sem nada produzido, a falha ainda é falha', async () => {
    // Sem texto nenhum não há o que revisar: inventar um documento a partir do
    // vazio seria pior do que dizer que não deu.
    const app = appFor(database, USER_A, async () => new Response('erro', { status: 500 }));
    const corpo = await (await chatScience(app, 'basic')).text();
    expect(corpo).toContain('"type":"error"');
  });

  it('o log registra a cadeia sem despejar o texto do modelo nele', async () => {
    // O log existe para explicar comportamento. Despejar o documento dentro
    // dele o tornaria ilegível justamente quando fosse preciso ler.
    const app = appFor(database, USER_A, async () => sseTexto('CONTEUDO-DO-DOCUMENTO'));
    const corpo = await (await chatScience(app, 'intermediate')).text();

    expect(corpo).toContain('"type":"trace"');
    expect(corpo).toContain('turno iniciado');
    expect(corpo).toContain('agente 1/2 iniciado');
    expect(corpo).toContain('agente 1/2 concluído');
    expect(corpo).toContain('resposta concluída');

    // Nenhum evento de trace carrega o texto do modelo.
    const eventos = corpo.split('\n')
      .filter((linha) => linha.startsWith('data:') && linha.includes('"type":"trace"'));
    expect(eventos.length).toBeGreaterThan(4);
    for (const evento of eventos) expect(evento).not.toContain('CONTEUDO-DO-DOCUMENTO');
  });

  it('o log diz por que o turno terminou quando dá erro', async () => {
    const app = appFor(database, USER_A, async () => new Response('estourou', { status: 500 }));
    const corpo = await (await chatScience(app, 'basic')).text();
    expect(corpo).toContain('"scope":"provedor"');
    expect(corpo).toContain('HTTP 500');
  });

  it('soma o custo de todos os agentes, não só o do último', async () => {
    // Cada estágio é uma chamada cobrada; ficar com a última faria a cadeia de
    // cinco parecer o preço de uma.
    const app = appFor(database, USER_A, async () => sseTexto('texto'));
    await (await chatScience(app, 'advanced')).text();
    const conversa = database.listConversations(USER_A)[0];
    const mensagem = database.getMessages(USER_A, conversa.id).at(-1);
    expect(mensagem?.usage?.promptTokens).toBe(20);
    expect(mensagem?.usage?.completionTokens).toBe(10);
  });

  it('guarda nível e formato na conversa, para recarregar do mesmo jeito', async () => {
    const app = appFor(database, USER_A, async () => sseTexto('texto'));
    await (await chatScience(app, 'intermediate', 'latex')).text();
    const conversa = database.listConversations(USER_A)[0];
    expect(conversa.scienceLevel).toBe('intermediate');
    expect(conversa.scienceFormat).toBe('latex');
  });

  it('o formato escolhido chega aos agentes', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseTexto('texto');
    });
    await (await chatScience(app, 'basic', 'latex')).text();
    expect(corpos[0]).toContain('LaTeX');
    expect(corpos[0]).not.toContain('Escreva em Markdown');
  });

  it('desligado mantém a resposta de um agente só', async () => {
    const corpos: string[] = [];
    const app = appFor(database, USER_A, async (_input, init) => {
      corpos.push(String(init?.body));
      return sseResponse();
    });
    await (await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ scienceLevel: 'off' }),
    })).text();
    expect(corpos).toHaveLength(1);
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

  it('transforma o artefato de planilha do modelo em XLSX anexado à resposta', async () => {
    const spec = JSON.stringify({
      filename: 'progressao-geometrica.xlsx',
      sheets: [{ name: 'Progressão Geométrica', rows: [
        ['n', 'Termo (a_n)', 'Soma parcial (S_n)'],
        [1, 2, 2], [2, 6, 8], [3, 18, 26],
      ] }],
    });
    const app = appFor(database, USER_A, async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `<artifact id="pg" type="spreadsheet" title="Progressão geométrica">${spec}</artifact>` } }] })}\n\n` +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(USER_A) },
      body: chatBody({ content: 'faça uma planilha xlsx de progressão geométrica' }),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('spreadsheet_ready');
    expect(stream).not.toContain('artifact_start');

    const conversation = database.listConversations(USER_A)[0];
    const [attachment] = database.listAttachmentsForConversation(USER_A, conversation.id);
    expect(attachment).toMatchObject({ kind: 'spreadsheet', filename: 'progressao-geometrica.xlsx' });
    expect(attachment.messageId).toBe(database.getMessages(USER_A, conversation.id).at(-1)?.id);

    const opened = await app.request(`/api/attachments/${attachment.id}/spreadsheet`, { headers: authHeader(USER_A) });
    const openedBody = await opened.json() as { workbook: { sheets: Array<{ cells: Array<{ value: unknown }> }> } };
    expect(openedBody.workbook.sheets[0].cells.some((cell) => cell.value === 26)).toBe(true);
    const exported = await app.request(`/api/attachments/${attachment.id}/spreadsheet/export?format=xlsx`, { headers: authHeader(USER_A) });
    expect(exported.status).toBe(200);
    expect((await exported.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
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
