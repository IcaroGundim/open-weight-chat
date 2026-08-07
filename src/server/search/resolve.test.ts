import { describe, expect, it } from 'vitest';
import { resolveSearch } from './index';
import type { ChatDatabaseAdapter } from '../db/database';

function dbCom(settings: Record<string, unknown> | null): ChatDatabaseAdapter {
  return { getSearchSettings: async () => settings } as unknown as ChatDatabaseAdapter;
}

const nativa = {
  backend: 'openrouter',
  baseURL: null,
  apiKeyCipher: null,
  maxResults: 5,
  enabled: true,
  updatedAt: 0,
};

describe('busca nativa do provedor', () => {
  it('resolve para o modo provider, sem chave própria', async () => {
    const resolvida = await resolveSearch('u1', dbCom(nativa), 'https://openrouter.ai/api/v1');
    expect(resolvida).toEqual({ backend: 'openrouter', kind: 'provider', baseURL: null, apiKey: null, maxResults: 5 });
  });

  /**
   * A invariante do projeto, aplicada a este caso: sem busca utilizável o
   * prompt de busca não é injetado. Com a nativa escolhida e um modelo de
   * outro provedor, ela **não** é utilizável — devolver qualquer coisa aqui
   * faria o modelo pedir uma busca que nunca chega e gastar o turno nisso.
   */
  it('devolve null quando o modelo não é da OpenRouter', async () => {
    for (const url of ['https://api.deepseek.com/v1', 'https://opencode.ai/zen/v1', 'http://localhost:11434/v1']) {
      expect(await resolveSearch('u1', dbCom(nativa), url)).toBeNull();
    }
  });

  /** Sem provedor em mãos — a tela de configuração — também é null. */
  it('devolve null sem baseURL', async () => {
    expect(await resolveSearch('u1', dbCom(nativa))).toBeNull();
  });

  it('desligada é null mesmo com o provedor certo', async () => {
    expect(await resolveSearch('u1', dbCom({ ...nativa, enabled: false }), 'https://openrouter.ai/api/v1')).toBeNull();
  });

  /**
   * O buscador externo não passa a depender do provedor: ele é chamado por
   * este servidor e funciona com qualquer modelo. Só a nativa é condicionada.
   */
  it('não condiciona o buscador externo ao provedor', async () => {
    const externa = { backend: 'searxng', baseURL: 'https://busca.exemplo.com', apiKeyCipher: null, maxResults: 3, enabled: true, updatedAt: 0 };
    const resolvida = await resolveSearch('u1', dbCom(externa), 'https://api.deepseek.com/v1');
    expect(resolvida?.kind).toBe('external');
    expect(resolvida?.backend).toBe('searxng');
  });
});
