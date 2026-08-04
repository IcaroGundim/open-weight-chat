import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
  process.env.PROVIDER_SECRET_KEY = SECRET;
  database = new ChatDatabase(':memory:');
});

afterEach(() => {
  database.close();
  delete process.env.PROVIDER_SECRET_KEY;
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

  it('recusa guardar chave sem PROVIDER_SECRET_KEY, em vez de gravar em texto puro', async () => {
    delete process.env.PROVIDER_SECRET_KEY;
    const app = createApp({ db: database });
    const response = await app.request('/api/providers/opencode', json({ ...PROVIDER, apiKey: 'sk-segredo-real' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('PROVIDER_SECRET_KEY');
    expect(database.listProviderSettings()).toHaveLength(0);
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

  it('recusa id de provedor embutido nomeando o id', async () => {
    const app = createApp({ db: database });
    const response = await app.request('/api/providers/deepseek', json(PROVIDER));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('deepseek');
    expect(getProvider('deepseek')?.baseURL).toBe('https://api.deepseek.com/v1');
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
