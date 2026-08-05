import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDatabase } from './db/queries';
import {
  allowEnvApiKeys,
  resolveDefaultModelSelection,
  resolveModelsCatalog,
  resolveProvider,
} from './provider-resolution';
import { resetProvidersCache } from './providers.config';
import { encryptSecret } from './secrets';

/**
 * Isolamento de chaves POR USUÁRIO: o mesmo providerId (ex.: openrouter)
 * aponta para chaves diferentes por usuário, resolvidas dentro da requisição,
 * sem catálogo global mutável. A chave decifrada só existe no retorno de
 * resolveProvider — nunca no catálogo (resolveModelsCatalog) nem no banco
 * (cifrada).
 */

const MASTER = 'chave-mestra-de-teste-bem-longa';
const USER_A = 'user_a';
const USER_B = 'user_b';

let secretFile: string;
let database: ChatDatabase;

beforeEach(() => {
  secretFile = join(tmpdir(), `provider-resolution-${randomUUID()}.secret`);
  process.env.PROVIDER_SECRET_KEY = MASTER;
  process.env.PROVIDER_SECRET_FILE = secretFile;
  database = new ChatDatabase(':memory:');
});

afterEach(() => {
  database.close();
  delete process.env.PROVIDER_SECRET_KEY;
  delete process.env.PROVIDER_SECRET_FILE;
  delete process.env.ALLOW_ENV_API_KEYS;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEFAULT_PROVIDER_ID;
  delete process.env.DEFAULT_MODEL_ID;
  delete process.env.VERCEL;
  process.env.NODE_ENV = 'test';
  resetProvidersCache();
  rmSync(secretFile, { force: true });
});

function saveKey(userId: string, providerId: string, apiKey: string): void {
  database.upsertProviderSettings(userId, {
    id: providerId,
    label: providerId,
    baseURL: 'https://exemplo.invalido/v1',
    models: [],
    apiKeyCipher: encryptSecret(apiKey, { userId, providerId }),
  });
}

describe('resolveProvider — isolamento de chaves entre usuários', () => {
  it('devolve a chave de cada usuário, nunca a do outro', async () => {
    saveKey(USER_A, 'openrouter', 'sk-X-do-usuario-A');
    saveKey(USER_B, 'openrouter', 'sk-Y-do-usuario-B');

    const forA = await resolveProvider(USER_A, 'openrouter', database);
    const forB = await resolveProvider(USER_B, 'openrouter', database);

    expect(forA?.apiKey).toBe('sk-X-do-usuario-A');
    expect(forB?.apiKey).toBe('sk-Y-do-usuario-B');
  });

  it('usuário sem registro não herda a chave de ninguém', async () => {
    saveKey(USER_A, 'openrouter', 'sk-X-do-usuario-A');

    const forB = await resolveProvider(USER_B, 'openrouter', database);
    expect(forB?.apiKey).toBeNull();
    // Provedor que exige chave continua exigindo — o erro claro vem no uso.
    expect(forB?.requiresApiKey).toBe(true);
  });

  it('mantém as chaves corretas sob concorrência (Promise.all)', async () => {
    saveKey(USER_A, 'openrouter', 'sk-X-do-usuario-A');
    saveKey(USER_B, 'openrouter', 'sk-Y-do-usuario-B');

    // Alterna resoluções dos dois usuários em paralelo, como duas requisições
    // simultâneas do servidor — cada uma só pode ver a chave do seu dono.
    const jobs = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? resolveProvider(USER_A, 'openrouter', database)
        : resolveProvider(USER_B, 'openrouter', database),
    );
    const results = await Promise.all(jobs);
    results.forEach((resolved, index) => {
      expect(resolved?.apiKey).toBe(index % 2 === 0 ? 'sk-X-do-usuario-A' : 'sk-Y-do-usuario-B');
    });
  });

  it('usuário sem chave → apiKey null; provedor inexistente → null', async () => {
    const withoutKey = await resolveProvider(USER_A, 'openrouter', database);
    expect(withoutKey?.apiKey).toBeNull();
    expect(withoutKey?.requiresApiKey).toBe(true);
    expect(withoutKey?.baseURL).toBe('https://openrouter.ai/api/v1');

    expect(await resolveProvider(USER_A, 'nao-existe', database)).toBeNull();
  });

  it('registro do usuário tem precedência sobre o catálogo embutido', async () => {
    database.upsertProviderSettings(USER_A, {
      id: 'openrouter',
      label: 'Meu OpenRouter',
      baseURL: 'https://meu-gateway.invalido/v1',
      verifiedAt: '2026-01-01',
      models: [{ id: 'meu-modelo', label: 'Meu Modelo', ctx: 100_000, reasoning: false }],
      apiKeyCipher: encryptSecret('sk-X-do-usuario-A', { userId: USER_A, providerId: 'openrouter' }),
    });

    const resolved = await resolveProvider(USER_A, 'openrouter', database);
    expect(resolved?.label).toBe('Meu OpenRouter');
    expect(resolved?.baseURL).toBe('https://meu-gateway.invalido/v1');
    expect(resolved?.verifiedAt).toBe('2026-01-01');
    expect(resolved?.models.map((model) => model.id)).toEqual(['meu-modelo']);
    expect(resolved?.source).toBe('builtin'); // sobrescreve embutido → mantém source
    expect(resolved?.apiKey).toBe('sk-X-do-usuario-A');
  });

  it('provedor criado só pelo usuário tem source "user" e é keyless sem chave gravada', async () => {
    database.upsertProviderSettings(USER_A, {
      id: 'meu-local',
      label: 'Meu servidor local',
      baseURL: 'http://localhost:1234/v1',
      models: [{ id: 'm1', label: 'M1', ctx: 8_192, reasoning: false }],
    });

    const resolved = await resolveProvider(USER_A, 'meu-local', database);
    expect(resolved?.source).toBe('user');
    expect(resolved?.requiresApiKey).toBe(false);
    expect(resolved?.apiKey).toBeNull();
  });
});

describe('resolveModelsCatalog', () => {
  it('lista embutidos e marca configured conforme a chave do usuário', async () => {
    const catalog = await resolveModelsCatalog(USER_A, database);
    const ids = catalog.providers.map((provider) => provider.id);
    expect(ids).toContain('deepseek');
    expect(ids).toContain('glm');
    expect(ids).toContain('kimi');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('ollama');

    // Sem chave: provedores que exigem chave aparecem como não configurados.
    expect(catalog.providers.find((p) => p.id === 'openrouter')?.configured).toBe(false);
    // Keyless (Ollama) está sempre configurado.
    expect(catalog.providers.find((p) => p.id === 'ollama')?.configured).toBe(true);

    saveKey(USER_A, 'openrouter', 'sk-X-do-usuario-A');
    const withKey = await resolveModelsCatalog(USER_A, database);
    expect(withKey.providers.find((p) => p.id === 'openrouter')?.configured).toBe(true);
    // A chave do usuário B não configura o catálogo de A.
    expect((await resolveModelsCatalog(USER_B, database)).providers.find((p) => p.id === 'openrouter')?.configured).toBe(false);
  });

  it('desativa Ollama localhost no catálogo de produção', async () => {
    process.env.NODE_ENV = 'production';

    const catalog = await resolveModelsCatalog(USER_A, database);
    expect(catalog.providers.find((provider) => provider.id === 'ollama')?.configured).toBe(false);
    expect(catalog.defaultProviderId).toBe('deepseek');
  });

  it('nunca expõe a chave em lugar nenhum da resposta', async () => {
    saveKey(USER_A, 'openrouter', 'sk-X-super-secreta');
    database.upsertProviderSettings(USER_A, {
      id: 'meu-local',
      label: 'Local',
      baseURL: 'http://localhost:1234/v1',
      models: [{ id: 'm1', label: 'M1', ctx: 8_192, reasoning: false }],
      apiKeyCipher: encryptSecret('sk-local-tambem-secreta', { userId: USER_A, providerId: 'meu-local' }),
    });

    const serialized = JSON.stringify(await resolveModelsCatalog(USER_A, database));
    expect(serialized).not.toContain('sk-X-super-secreta');
    expect(serialized).not.toContain('sk-local-tambem-secreta');
    // configured é booleano: o campo existe, o valor da chave não.
    expect(serialized).toContain('"configured":true');
  });

  it('provedor custom do usuário aparece com source "custom" e models validados', async () => {
    database.upsertProviderSettings(USER_A, {
      id: 'meu-local',
      label: 'Local',
      baseURL: 'http://localhost:1234/v1',
      verifiedAt: '2026-01-02',
      models: [{ id: 'm1', label: 'M1', ctx: 8_192, reasoning: true }],
    });

    const catalog = await resolveModelsCatalog(USER_A, database);
    const entry = catalog.providers.find((p) => p.id === 'meu-local');
    expect(entry?.source).toBe('custom');
    expect(entry?.verifiedAt).toBe('2026-01-02');
    expect(entry?.models).toEqual([
      { id: 'm1', label: 'M1', contextWindow: 8_192, reasoning: true, pricing: { inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null } },
    ]);
  });

  it('usuário que sobrescreve um embutido mantém o source do embutido', async () => {
    database.upsertProviderSettings(USER_A, {
      id: 'deepseek',
      label: 'DeepSeek da conta A',
      baseURL: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', ctx: 1_048_576, reasoning: true }],
      apiKeyCipher: encryptSecret('sk-deepseek-A', { userId: USER_A, providerId: 'deepseek' }),
    });

    const catalog = await resolveModelsCatalog(USER_A, database);
    const entry = catalog.providers.find((p) => p.id === 'deepseek');
    expect(entry?.source).toBe('builtin');
    expect(entry?.label).toBe('DeepSeek da conta A');
    expect(entry?.configured).toBe(true);
  });
});

describe('resolveDefaultModelSelection', () => {
  it('usa o primeiro provedor configurado do catálogo do usuário', async () => {
    saveKey(USER_A, 'openrouter', 'sk-X-do-usuario-A');
    const selection = await resolveDefaultModelSelection(USER_A, database);
    expect(selection.providerId).toBe('openrouter');
    expect(selection.modelId).toBe('openrouter/auto');
  });

  it('sem chaves, cai no primeiro provedor keyless (ollama)', async () => {
    const selection = await resolveDefaultModelSelection(USER_A, database);
    expect(selection.providerId).toBe('ollama');
    expect(selection.modelId).toBe('llama3.2');
  });

  it('respeita DEFAULT_PROVIDER_ID/DEFAULT_MODEL_ID quando o provedor está no catálogo', async () => {
    saveKey(USER_A, 'openrouter', 'sk-X-do-usuario-A');
    process.env.DEFAULT_PROVIDER_ID = 'glm';
    process.env.DEFAULT_MODEL_ID = 'glm-5';

    const selection = await resolveDefaultModelSelection(USER_A, database);
    expect(selection).toEqual({ providerId: 'glm', modelId: 'glm-5' });
  });
});

describe('allowEnvApiKeys', () => {
  it('é false por padrão (dev sem opt-in)', () => {
    expect(allowEnvApiKeys()).toBe(false);
  });

  it('é true apenas com ALLOW_ENV_API_KEYS=true fora de produção', () => {
    process.env.ALLOW_ENV_API_KEYS = 'true';
    expect(allowEnvApiKeys()).toBe(true);
  });

  it('é false em produção mesmo com a flag ligada (NODE_ENV)', () => {
    process.env.ALLOW_ENV_API_KEYS = 'true';
    process.env.NODE_ENV = 'production';
    expect(allowEnvApiKeys()).toBe(false);
  });

  it('é false em produção mesmo com a flag ligada (VERCEL)', () => {
    process.env.ALLOW_ENV_API_KEYS = 'true';
    process.env.VERCEL = '1';
    expect(allowEnvApiKeys()).toBe(false);
  });

  it('chave de ambiente só entra como fallback em dev com opt-in', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-do-ambiente';

    // Sem opt-in: a chave de ambiente NÃO é usada.
    const semOptIn = await resolveProvider(USER_A, 'deepseek', database);
    expect(semOptIn?.apiKey).toBeNull();

    // Com opt-in (dev/teste): serve de fallback quando o usuário não cadastrou.
    process.env.ALLOW_ENV_API_KEYS = 'true';
    const comOptIn = await resolveProvider(USER_A, 'deepseek', database);
    expect(comOptIn?.apiKey).toBe('sk-do-ambiente');

    // Mas a chave do usuário cadastrado tem precedência sobre a do ambiente.
    saveKey(USER_A, 'deepseek', 'sk-do-usuario');
    const comRegistro = await resolveProvider(USER_A, 'deepseek', database);
    expect(comRegistro?.apiKey).toBe('sk-do-usuario');
  });

  it('em produção, a chave de ambiente nunca é usada', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-do-ambiente';
    process.env.ALLOW_ENV_API_KEYS = 'true';
    process.env.NODE_ENV = 'production';

    const resolved = await resolveProvider(USER_A, 'deepseek', database);
    expect(resolved?.apiKey).toBeNull();
  });
});
