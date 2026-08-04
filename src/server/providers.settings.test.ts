import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDatabase } from './db/queries';
import { createApp } from './index';
import { getProvider, getProviderApiKey, resetProvidersCache } from './providers.config';
import { decryptSecret, encryptSecret, getSecretStorageStatus } from './secrets';

const SECRET = 'chave-mestra-de-teste-bem-longa';
const PROVIDER = {
  label: 'OpenCode Zen',
  baseURL: 'https://opencode.ai/zen/v1',
  models: [{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', ctx: 272_000, reasoning: true }],
};

function json(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

let database: ChatDatabase;
let secretFile: string;

beforeEach(() => {
  secretFile = join(tmpdir(), `open-weight-chat-provider-${randomUUID()}.secret`);
  process.env.PROVIDER_SECRET_KEY = SECRET;
  process.env.PROVIDER_SECRET_FILE = secretFile;
  database = new ChatDatabase(':memory:');
});

afterEach(() => {
  database.close();
  delete process.env.PROVIDER_SECRET_KEY;
  delete process.env.PROVIDER_SECRET_FILE;
  rmSync(secretFile, { force: true });
  resetProvidersCache();
});

describe('cadastro de provedor pela interface', () => {
  it('grava a chave cifrada e nunca a devolve ao navegador', async () => {
    const app = createApp({ db: database });
    const saved = await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: 'sk-segredo-real' }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).provider.hasKey).toBe(true);

    const listed = await app.request('/api/providers');
    const payload = await listed.json();
    // A chave não pode aparecer em nenhum ponto da resposta.
    expect(JSON.stringify(payload)).not.toContain('sk-segredo-real');
    expect(payload.providers[0].hasKey).toBe(true);

    // Nem em texto puro no banco.
    const [record] = database.listProviderSettings();
    expect(record.apiKeyCipher).not.toContain('sk-segredo-real');
    expect(decryptSecret(record.apiKeyCipher)).toBe('sk-segredo-real');
  });

  it('coloca o provedor no catálogo e o marca como configurado', async () => {
    const app = createApp({ db: database });
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: 'sk-segredo-real' }));

    const provider = getProvider('opencode');
    expect(provider?.baseURL).toBe('https://opencode.ai/zen/v1');
    expect(getProviderApiKey(provider!)).toBe('sk-segredo-real');

    const catalog = await (await app.request('/api/models')).json();
    const entry = catalog.providers.find((item: { id: string }) => item.id === 'opencode');
    expect(entry.source).toBe('custom');
    expect(entry.configured).toBe(true);
  });

  it('salva sem modelos e descobre o catálogo OpenAI-compatible no servidor', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const app = createApp({
      db: database,
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
      apiKey: 'sk-segredo-real',
    }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).provider.models).toHaveLength(0);

    const discovered = await app.request('/api/providers/opencode/discover-models', { method: 'POST' });
    expect(discovered.status).toBe(200);
    const payload = await discovered.json();
    expect(payload.discovered).toBe(2);
    expect(payload.provider.models[0]).toMatchObject({ id: 'zen-fast', ctx: 200_000 });
    expect(payload.provider.models[1]).toMatchObject({ id: 'zen-reasoner', ctx: 131_072, reasoning: true });
    expect(requests).toEqual([{ url: 'https://opencode.ai/zen/v1/models', authorization: 'Bearer sk-segredo-real' }]);
    expect((await (await app.request('/api/models')).json()).providers.find((item: { id: string }) => item.id === 'opencode').models).toHaveLength(2);
  });

  it('configura um provedor embutido pela web e substitui o catálogo ao descobrir modelos', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const app = createApp({
      db: database,
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
      apiKey: 'sk-openrouter-real',
    }));
    expect(saved.status).toBe(200);

    const discovered = await app.request('/api/providers/openrouter/discover-models', { method: 'POST' });
    expect(discovered.status).toBe(200);
    expect((await discovered.json()).provider.models).toEqual([
      expect.objectContaining({ id: 'openrouter/modelo-real', ctx: 256_000 }),
    ]);
    expect(requests).toEqual([{
      url: 'https://openrouter.ai/api/v1/models',
      authorization: 'Bearer sk-openrouter-real',
    }]);

    const catalog = await (await app.request('/api/models')).json();
    const provider = catalog.providers.find((item: { id: string }) => item.id === 'openrouter');
    expect(provider.source).toBe('builtin');
    expect(provider.models).toEqual([
      expect.objectContaining({ id: 'openrouter/modelo-real', contextWindow: 256_000 }),
    ]);
  });

  it('gera a chave-mestra automaticamente quando o cadastro vem pela web', async () => {
    delete process.env.PROVIDER_SECRET_KEY;
    const app = createApp({ db: database });
    const response = await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: 'sk-segredo-real' }));
    expect(response.status).toBe(200);
    expect((await response.json()).provider.hasKey).toBe(true);
    expect(getSecretStorageStatus().available).toBe(true);
    expect(database.listProviderSettings()).toHaveLength(1);
  });

  it('salva sem chave quando o campo não é enviado e mantém a chave em edições seguintes', async () => {
    const app = createApp({ db: database });
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: 'sk-segredo-real' }));
    // Edição sem o campo apiKey: o segredo precisa sobreviver.
    await app.request('/api/providers/opencode', json({ ...PROVIDER, label: 'Renomeado' }));
    const [record] = database.listProviderSettings();
    expect(record.label).toBe('Renomeado');
    expect(decryptSecret(record.apiKeyCipher)).toBe('sk-segredo-real');

    // apiKey: null apaga.
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: null }));
    expect(database.listProviderSettings()[0].apiKeyCipher).toBeNull();
  });

  it('permite configurar um provedor embutido pela interface', async () => {
    const app = createApp({ db: database });
    const response = await app.request('/api/providers/deepseek', json({
      label: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-v4-flash', ctx: 1_048_576 }],
      apiKey: 'sk-deepseek-real',
    }));
    expect(response.status).toBe(200);
    expect(getProvider('deepseek')?.baseURL).toBe('https://api.deepseek.com/v1');
    expect(getProviderApiKey(getProvider('deepseek')!)).toBe('sk-deepseek-real');
  });

  it('recusa modelo sem janela de contexto', async () => {
    const app = createApp({ db: database });
    const response = await app.request('/api/providers/opencode', json({ ...PROVIDER, models: [{ id: 'x' }] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('contexto');
  });

  it('remove o provedor do catálogo ao apagar', async () => {
    const app = createApp({ db: database });
    await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: 'sk-segredo-real' }));
    expect(getProvider('opencode')).toBeDefined();

    const removed = await app.request('/api/providers/opencode', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(getProvider('opencode')).toBeUndefined();
  });

  it('não decifra com outra chave-mestra', () => {
    const blob = encryptSecret('sk-segredo-real');
    process.env.PROVIDER_SECRET_KEY = 'outra-chave-mestra-diferente';
    expect(getSecretStorageStatus().available).toBe(true);
    expect(decryptSecret(blob)).toBeNull();
  });
});
