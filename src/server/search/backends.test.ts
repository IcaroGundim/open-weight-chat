import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { runBackend } from './backends';

/**
 * Os backends só são exercitados com fetch injetado: nenhum teste toca a rede.
 * As formas de resposta abaixo são as documentadas por cada serviço.
 */

function fetchFake(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

function pedido(overrides: Record<string, unknown> = {}) {
  return {
    query: 'preço do café',
    maxResults: 3,
    apiKey: 'chave-de-teste',
    baseURL: null,
    signal: new AbortController().signal,
    // DNS fake: o teste é sobre normalização de resposta, não sobre resolver
    // nomes reais na internet.
    lookup: async () => ['93.184.216.34'],
    ...overrides,
  } as Parameters<typeof runBackend>[1];
}

describe('backends de busca', () => {
  it('normaliza a resposta da Brave e limpa a marcação do trecho', async () => {
    // A Brave devolve o trecho com <strong> em volta dos termos casados. Essas
    // tags iriam parar dentro do prompt do modelo.
    const resultados = await runBackend('brave', pedido({
      fetchImpl: fetchFake({
        web: {
          results: [
            { title: 'Café hoje', url: 'https://exemplo.com/cafe', description: 'O <strong>preço</strong>  subiu.', age: '2026-08-01' },
          ],
        },
      }),
    }));
    expect(resultados).toEqual([
      { title: 'Café hoje', url: 'https://exemplo.com/cafe', snippet: 'O preço subiu.', publishedAt: '2026-08-01' },
    ]);
  });

  it('normaliza a resposta da Tavily', async () => {
    const resultados = await runBackend('tavily', pedido({
      fetchImpl: fetchFake({
        results: [{ title: 'Relatório', url: 'https://exemplo.com/r', content: 'Trecho.', published_date: '2026-07-30' }],
      }),
    }));
    expect(resultados[0].url).toBe('https://exemplo.com/r');
    expect(resultados[0].publishedAt).toBe('2026-07-30');
  });

  it('descarta resultado sem URL válida em vez de derrubar a busca inteira', async () => {
    // Um item quebrado é lixo do backend, não motivo para o usuário ficar sem
    // resposta nenhuma.
    const resultados = await runBackend('tavily', pedido({
      fetchImpl: fetchFake({
        results: [
          { title: 'Quebrado', url: 'nao-e-url', content: 'x' },
          { title: 'Bom', url: 'https://exemplo.com/ok', content: 'y' },
        ],
      }),
    }));
    expect(resultados).toHaveLength(1);
    expect(resultados[0].title).toBe('Bom');
  });

  it('respeita o limite de resultados pedido', async () => {
    const resultados = await runBackend('tavily', pedido({
      maxResults: 2,
      fetchImpl: fetchFake({
        results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://exemplo.com/${i}`, content: 'x' })),
      }),
    }));
    expect(resultados).toHaveLength(2);
  });

  it('traduz 401 em erro de chave, e não em erro genérico', async () => {
    await expect(runBackend('brave', pedido({ fetchImpl: fetchFake({}, 401) })))
      .rejects.toMatchObject({ code: 'INVALID_API_KEY' });
  });

  it('traduz 429 em limite de uso', async () => {
    await expect(runBackend('tavily', pedido({ fetchImpl: fetchFake({}, 429) })))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('no SearXNG, 403 aponta para o formato json desabilitado', async () => {
    // É a causa real mais comum, e a mensagem genérica mandaria o usuário
    // procurar problema na chave — que esse backend nem exige.
    await expect(runBackend('searxng', pedido({ baseURL: 'https://busca.exemplo.com', fetchImpl: fetchFake({}, 403) })))
      .rejects.toThrow(/settings\.yml/u);
  });

  it('exige a URL no SearXNG', async () => {
    await expect(runBackend('searxng', pedido({ baseURL: null, fetchImpl: fetchFake({}) })))
      .rejects.toBeInstanceOf(AppError);
  });

  it('não confunde resposta ilegível com ausência de resultados', async () => {
    const fetchImpl = (async () => new Response('<html>erro</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(runBackend('brave', pedido({ fetchImpl }))).rejects.toThrow(/ilegível/u);
  });

  it('manda a chave da Brave no cabeçalho que ela espera', async () => {
    let cabecalhos: Record<string, string> = {};
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      cabecalhos = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ web: { results: [] } }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await runBackend('brave', pedido({ apiKey: 'segredo', fetchImpl }));
    expect(cabecalhos['x-subscription-token']).toBe('segredo');
    // E nunca no Authorization, que é o cabeçalho do provedor de chat.
    expect(cabecalhos.authorization).toBeUndefined();
  });
});
