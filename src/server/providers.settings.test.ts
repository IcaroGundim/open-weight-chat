import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDatabase } from './db/queries';
import { createApp } from './index';
import { createAuthMiddleware } from './auth';
import { resolveProvider } from './provider-resolution';
import { decryptSecret, encryptSecret, getSecretStorageStatus } from './secrets';

/**
 * Cadastro de provedores pela interface, com autenticação fake (userId fixo).
 * A chave é cifrada com AAD `userId:providerId` (formato v2), nunca aparece em
 * resposta e é isolada por usuário.
 */

const MASTER = 'chave-mestra-de-teste-bem-longa';
const USER = 'user_test_1';
const OTHER = 'user_test_2';
const API_KEY = 'sk-teste-chave-opencode-98765';

const PROVIDER = {
  label: 'OpenCode Zen',
  baseURL: 'https://opencode.ai/zen/v1',
  models: [{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', ctx: 272_000, reasoning: true }],
};

function appFor(db: ChatDatabase, userId = USER) {
  return createApp({
    db,
    auth: createAuthMiddleware({ verifyToken: async () => userId }),
  });
}

function authHeader(userId = USER): Record<string, string> {
  return { Authorization: `Bearer token-${userId}` };
}

function json(body: unknown, userId = USER): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(userId) }, body: JSON.stringify(body) };
}

let database: ChatDatabase;
let secretFile: string;

beforeEach(() => {
  secretFile = join(tmpdir(), `open-weight-chat-provider-${randomUUID()}.secret`);
  process.env.PROVIDER_SECRET_KEY = MASTER;
  process.env.PROVIDER_SECRET_FILE = secretFile;
  delete process.env.ALLOW_ENV_API_KEYS;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEFAULT_PROVIDER_ID;
  delete process.env.DEFAULT_MODEL_ID;
  database = new ChatDatabase(':memory:');
});

afterEach(() => {
  database.close();
  delete process.env.PROVIDER_SECRET_KEY;
  delete process.env.PROVIDER_SECRET_FILE;
  rmSync(secretFile, { force: true });
});

describe('cadastro de provedor pela interface (autenticado)', () => {
  it('grava a chave cifrada e nunca a devolve ao navegador', async () => {
    const app = appFor(database);
    const saved = await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: API_KEY }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).provider.hasKey).toBe(true);

    const listed = await app.request('/api/providers', { headers: authHeader() });
    const payload = await listed.json();
    // A chave não pode aparecer em nenhum ponto da resposta.
    expect(JSON.stringify(payload)).not.toContain(API_KEY);
    expect(payload.providers[0].hasKey).toBe(true);

    // Nem em texto puro no banco; e decifra apenas com o contexto do dono.
    const [record] = database.listProviderSettings(USER);
    expect(record.apiKeyCipher).not.toContain(API_KEY);
    expect(decryptSecret(record.apiKeyCipher, { userId: USER, providerId: 'opencode' })).toBe(API_KEY);
    // Contexto errado (outro usuário/provedor) não decifra.
    expect(decryptSecret(record.apiKeyCipher, { userId: OTHER, providerId: 'opencode' })).toBeNull();
  });

  it('coloca o provedor no catálogo do usuário e o marca como configurado', async () => {
    const app = appFor(database);
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: API_KEY }));

    // Resolução por usuário: URL e chave vêm do registro dele.
    const resolved = await resolveProvider(USER, 'opencode', database);
    expect(resolved?.baseURL).toBe('https://opencode.ai/zen/v1');
    expect(resolved?.apiKey).toBe(API_KEY);

    const catalog = await (await app.request('/api/models', { headers: authHeader() })).json();
    const entry = catalog.providers.find((item: { id: string }) => item.id === 'opencode');
    expect(entry.source).toBe('custom');
    expect(entry.configured).toBe(true);
  });

  it('salva sem modelos e descobre o catálogo OpenAI-compatible no servidor', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const app = createApp({
      db: database,
      auth: createAuthMiddleware({ verifyToken: async () => USER }),
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({
          data: [
            { id: 'zen-fast', name: 'Zen Fast', context_length: 200_000 },
            { id: 'zen-reasoner', name: 'Zen Reasoner', reasoning: true },
          ],
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const saved = await app.request('/api/providers/opencode', json({
      ...PROVIDER,
      models: [],
      apiKey: API_KEY,
    }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).provider.models).toHaveLength(0);

    const discovered = await app.request('/api/providers/opencode/discover-models', { method: 'POST', headers: authHeader() });
    expect(discovered.status).toBe(200);
    const payload = await discovered.json();
    expect(payload.discovered).toBe(2);
    expect(payload.provider.models[0]).toMatchObject({ id: 'zen-fast', ctx: 200_000 });
    expect(payload.provider.models[1]).toMatchObject({ id: 'zen-reasoner', ctx: 131_072, reasoning: true });
    // A chave DO USUÁRIO foi enviada ao upstream — e só ela.
    expect(requests).toEqual([{ url: 'https://opencode.ai/zen/v1/models', authorization: `Bearer ${API_KEY}` }]);

    const catalog = await (await app.request('/api/models', { headers: authHeader() })).json();
    expect(catalog.providers.find((item: { id: string }) => item.id === 'opencode').models).toHaveLength(2);
  });

  it('configura um provedor embutido pela web e substitui o catálogo ao descobrir modelos', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const app = createApp({
      db: database,
      auth: createAuthMiddleware({ verifyToken: async () => USER }),
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({
          data: [{ id: 'openrouter/modelo-real', name: 'Modelo real', context_length: 256_000 }],
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const saved = await app.request('/api/providers/openrouter', json({
      label: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      models: [],
      apiKey: API_KEY,
    }));
    expect(saved.status).toBe(200);

    const discovered = await app.request('/api/providers/openrouter/discover-models', { method: 'POST', headers: authHeader() });
    expect(discovered.status).toBe(200);
    expect((await discovered.json()).provider.models).toEqual([
      expect.objectContaining({ id: 'openrouter/modelo-real', ctx: 256_000 }),
    ]);
    expect(requests).toEqual([{
      url: 'https://openrouter.ai/api/v1/models',
      authorization: `Bearer ${API_KEY}`,
    }]);

    const catalog = await (await app.request('/api/models', { headers: authHeader() })).json();
    const provider = catalog.providers.find((item: { id: string }) => item.id === 'openrouter');
    expect(provider.source).toBe('builtin');
    expect(provider.models).toEqual([
      expect.objectContaining({ id: 'openrouter/modelo-real', contextWindow: 256_000 }),
    ]);
  });

  it('gera a chave-mestra automaticamente quando o cadastro vem pela web', async () => {
    delete process.env.PROVIDER_SECRET_KEY;
    const app = appFor(database);
    const response = await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: API_KEY }));
    expect(response.status).toBe(200);
    expect((await response.json()).provider.hasKey).toBe(true);
    expect(getSecretStorageStatus().available).toBe(true);
    expect(database.listProviderSettings(USER)).toHaveLength(1);
  });

  it('salva sem chave quando o campo não é enviado e mantém a chave em edições seguintes', async () => {
    const app = appFor(database);
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: API_KEY }));
    // Edição sem o campo apiKey: o segredo precisa sobreviver.
    await app.request('/api/providers/opencode', json({ ...PROVIDER, label: 'Renomeado' }));
    const [record] = database.listProviderSettings(USER);
    expect(record.label).toBe('Renomeado');
    expect(decryptSecret(record.apiKeyCipher, { userId: USER, providerId: 'opencode' })).toBe(API_KEY);

    // apiKey: null apaga.
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: null }));
    expect(database.listProviderSettings(USER)[0].apiKeyCipher).toBeNull();
  });

  it('permite configurar um provedor embutido pela interface', async () => {
    const app = appFor(database);
    const response = await app.request('/api/providers/deepseek', json({
      label: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-v4-flash', ctx: 1_048_576 }],
      apiKey: API_KEY,
    }));
    expect(response.status).toBe(200);
    const resolved = await resolveProvider(USER, 'deepseek', database);
    expect(resolved?.baseURL).toBe('https://api.deepseek.com/v1');
    expect(resolved?.apiKey).toBe(API_KEY);
  });

  it('recusa modelo sem janela de contexto', async () => {
    const app = appFor(database);
    const response = await app.request('/api/providers/opencode', json({ ...PROVIDER, models: [{ id: 'x' }] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('contexto');
  });

  it('rejeita URL base insegura (SSRF) antes de salvar', async () => {
    const app = appFor(database);
    const response = await app.request('/api/providers/opencode', json({
      ...PROVIDER,
      baseURL: 'http://169.254.169.254/latest/meta-data',
      apiKey: API_KEY,
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('URL de provedor');
    expect(database.listProviderSettings(USER)).toHaveLength(0);
  });

  it('remove o provedor do usuário ao apagar', async () => {
    const app = appFor(database);
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: API_KEY }));
    expect(database.listProviderSettings(USER)).toHaveLength(1);

    const removed = await app.request('/api/providers/opencode', { method: 'DELETE', headers: authHeader() });
    expect(removed.status).toBe(200);
    expect(database.listProviderSettings(USER)).toHaveLength(0);
  });

  it('isola provedores entre usuários: B não vê, não apaga nem descobre os de A', async () => {
    const appA = appFor(database, USER);
    const appB = appFor(database, OTHER);

    await appA.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: API_KEY }));

    // B não vê nenhum provedor.
    const listByB = await appB.request('/api/providers', { headers: authHeader(OTHER) });
    expect((await listByB.json()).providers).toHaveLength(0);

    // B não apaga o de A (404) e o registro de A continua intacto.
    const deleteByB = await appB.request('/api/providers/opencode', { method: 'DELETE', headers: authHeader(OTHER) });
    expect(deleteByB.status).toBe(404);
    const [recordA] = database.listProviderSettings(USER);
    expect(recordA).toBeDefined();
    expect(decryptSecret(recordA.apiKeyCipher, { userId: USER, providerId: 'opencode' })).toBe(API_KEY);

    // B não descobre modelos do provedor de A (sem registro próprio → 404).
    const discoverByB = await appB.request('/api/providers/opencode/discover-models', { method: 'POST', headers: authHeader(OTHER) });
    expect(discoverByB.status).toBe(404);

    // B pode criar o MESMO id com a SUA chave: registro separado, sem tocar A.
    const putByB = await appB.request('/api/providers/opencode', json({
      ...PROVIDER,
      label: 'OpenCode Zen do B',
      apiKey: 'sk-teste-chave-do-b-11111',
    }, OTHER));
    expect(putByB.status).toBe(200);
    const [recordB] = database.listProviderSettings(OTHER);
    expect(recordB.label).toBe('OpenCode Zen do B');
    expect(decryptSecret(recordB.apiKeyCipher, { userId: OTHER, providerId: 'opencode' })).toBe('sk-teste-chave-do-b-11111');
    // A continua com a chave dele.
    expect(decryptSecret(recordA.apiKeyCipher, { userId: USER, providerId: 'opencode' })).toBe(API_KEY);
  });

  it('não decifra com outra chave-mestra', () => {
    const blob = encryptSecret(API_KEY, { userId: USER, providerId: 'opencode' });
    process.env.PROVIDER_SECRET_KEY = 'outra-chave-mestra-diferente';
    expect(getSecretStorageStatus().available).toBe(true);
    expect(decryptSecret(blob, { userId: USER, providerId: 'opencode' })).toBeNull();
  });
});
