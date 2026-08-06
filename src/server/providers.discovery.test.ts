import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { MAX_DISCOVERED_MODELS, discoverProviderModels } from './providers.discovery';

function modelsPayload(count: number): string {
  const data = Array.from({ length: count }, (_, index) => ({
    id: `modelo-${String(index).padStart(4, '0')}`,
    object: 'model',
    owned_by: 'teste',
  }));
  return JSON.stringify({ data });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discoverProviderModels — teto do catálogo', () => {
  it('limita a MAX_DISCOVERED_MODELS mantendo os primeiros após deduplicar', async () => {
    const fetchImpl = async () => jsonResponse(JSON.parse(modelsPayload(600)) as unknown);
    const models = await discoverProviderModels('http://localhost:11434/v1', undefined, fetchImpl);

    expect(models.length).toBe(MAX_DISCOVERED_MODELS);
    expect(models[0].id).toBe('modelo-0000');
    expect(models[models.length - 1].id).toBe('modelo-0499');
  });

  it('deduplica por id antes de aplicar o teto', async () => {
    // 300 únicos repetidos duas vezes: 600 linhas, 300 modelos — tudo cabe.
    const unique = Array.from({ length: 300 }, (_, index) => ({ id: `m-${index}` }));
    const fetchImpl = async () => jsonResponse({ data: [...unique, ...unique] });
    const models = await discoverProviderModels('http://localhost:11434/v1', undefined, fetchImpl);

    expect(models.length).toBe(300);
    expect(new Set(models.map((model) => model.id)).size).toBe(300);
  });

  it('lista vazia continua sendo erro', async () => {
    const fetchImpl = async () => jsonResponse({ data: [] });
    await expect(discoverProviderModels('http://localhost:11434/v1', undefined, fetchImpl)).rejects.toMatchObject({
      code: 'UNKNOWN',
      status: 400,
    });
  });
});

describe('discoverProviderModels — SSRF via safeFetchWithRedirects', () => {
  it('bloqueia IP em faixa privada antes de qualquer fetch', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonResponse({ data: [] });
    };

    const error = await discoverProviderModels('http://192.168.0.10/v1', 'sk-teste', fetchImpl).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNKNOWN');
    expect((error as AppError).status).toBe(400);
    expect((error as AppError).message).toContain('faixa bloqueada');
    expect(called).toBe(false);
  });

  it('bloqueia o metadata cloud (169.254.169.254)', async () => {
    const fetchImpl = async () => jsonResponse({ data: [] });
    const error = await discoverProviderModels('http://169.254.169.254/latest/meta-data', undefined, fetchImpl).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('faixa bloqueada');
  });

  it('não segue redirecionamento para host bloqueado', async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/models' } });
    const error = await discoverProviderModels('http://localhost:11434/v1', undefined, fetchImpl).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('faixa bloqueada');
  });

  it('segue redirecionamento seguro (localhost em dev) e envia a chave no header', async () => {
    let calls = 0;
    let authorization: string | null = null;
    const fetchImpl = async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      authorization = new Headers(init?.headers).get('authorization');
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: 'http://localhost:9999/v1/models' } });
      }
      return jsonResponse(JSON.parse(modelsPayload(3)) as unknown);
    };

    const models = await discoverProviderModels('http://localhost:11434/v1', 'sk-secreta', fetchImpl);
    expect(calls).toBe(2);
    expect(authorization).toBe('Bearer sk-secreta');
    expect(models.length).toBe(3);
  });

  it('falha de conexão vira erro amigável', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    const error = await discoverProviderModels('http://localhost:11434/v1', undefined, fetchImpl).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('Não foi possível conectar');
  });
});

describe('capacidade de raciocínio dos modelos descobertos', () => {
  const descobrir = async (row: Record<string, unknown>) => {
    const models = await discoverProviderModels(
      'http://localhost:11434/v1',
      undefined,
      async () => jsonResponse({ data: [row] }),
    );
    return models[0]?.reasoning;
  };

  it('lê supported_parameters — a forma real da OpenRouter', async () => {
    // Regressão: `qwen/qwen3.8-max` raciocina, mas não casa com nenhuma
    // heurística de nome. Antes, os 340 modelos de um OpenRouter real vinham
    // marcados como `false` e travavam o seletor de esforço.
    await expect(descobrir({
      id: 'qwen/qwen3.8-max',
      name: 'Qwen: Qwen3.8 Max',
      supported_parameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'temperature'],
    })).resolves.toBe(true);
  });

  it('lista declarada sem raciocínio é um "não" do provedor, não cai para o nome', async () => {
    await expect(descobrir({
      id: 'algum/modelo-think-pro',
      name: 'Think Pro',
      supported_parameters: ['max_tokens', 'temperature'],
    })).resolves.toBe(false);
  });

  it('ignora o campo `reasoning` quando ele é objeto, como na OpenRouter', async () => {
    // O objeto não é booleano; quem decide é supported_parameters.
    await expect(descobrir({
      id: 'x/y',
      name: 'X Y',
      reasoning: { supported_efforts: ['high', 'low'], default_effort: 'high' },
      supported_parameters: ['reasoning'],
    })).resolves.toBe(true);
  });

  it('respeita o booleano quando o provedor o declara', async () => {
    await expect(descobrir({ id: 'a/b', name: 'A B', reasoning: false, supported_parameters: ['reasoning'] })).resolves.toBe(false);
    await expect(descobrir({ id: 'c/d', name: 'C D', supports_reasoning: true })).resolves.toBe(true);
  });

  it('sem declaração nenhuma, resta o nome', async () => {
    await expect(descobrir({ id: 'foo/deepthink-v2', name: 'DeepThink v2' })).resolves.toBe(true);
    await expect(descobrir({ id: 'foo/basico', name: 'Basico' })).resolves.toBe(false);
  });
});
