import { afterEach, describe, expect, it } from 'vitest';
import { getModel, getModelsCatalog, getProvider, resetProvidersCache } from './providers.config';

function withConfig(value: unknown): void {
  process.env.CUSTOM_PROVIDERS = typeof value === 'string' ? value : JSON.stringify(value);
  resetProvidersCache();
}

/**
 * Gateway fictício, de propósito.
 *
 * Este arquivo já usou o OpenCode como exemplo, o que deixou de servir quando
 * ele virou provedor embutido: metade dos testes aqui verifica que uma
 * configuração inválida faz o provedor **sumir** do catálogo, e um id embutido
 * nunca some — o embutido reaparece por baixo e o teste passaria a medir outra
 * coisa. O exemplo precisa ser um id que só exista se o arquivo custom o criar.
 */
const validProvider = {
  id: 'meu-gateway',
  label: 'Meu Gateway',
  baseURL: 'https://gateway.exemplo.com/v1',
  apiKeyEnv: 'MEU_GATEWAY_API_KEY',
  models: [{ id: 'modelo-rapido', label: 'Modelo Rápido', ctx: 272_000, reasoning: true }],
};

afterEach(() => {
  delete process.env.CUSTOM_PROVIDERS;
  delete process.env.MEU_GATEWAY_API_KEY;
  resetProvidersCache();
});

describe('provedores personalizados', () => {
  it('lê o ambiente sob demanda, não na importação do módulo', () => {
    // O módulo já foi importado no topo deste arquivo. Se o parse acontecesse
    // no corpo do módulo, esta variável chegaria tarde demais — que é
    // exatamente o que aconteceria em dev, onde .env carrega depois dos imports.
    withConfig([validProvider]);
    expect(getProvider('meu-gateway')?.baseURL).toBe('https://gateway.exemplo.com/v1');
    expect(getModel('meu-gateway', 'modelo-rapido')?.ctx).toBe(272_000);
  });

  it('expõe o provedor no catálogo marcado como custom e sem verificação', () => {
    withConfig([validProvider]);
    const catalog = getModelsCatalog();
    const provider = catalog.providers.find((item) => item.id === 'meu-gateway');
    expect(provider?.source).toBe('custom');
    expect(provider?.configured).toBe(false);
    // Sem verifiedAt declarado, entra como não verificado — os preços são do usuário.
    expect(provider?.stale).toBe(true);
    expect(catalog.configErrors).toEqual([]);
    expect(catalog.providers.filter((item) => item.source === 'builtin').length).toBeGreaterThan(0);
  });

  it('marca como configurado quando a variável de ambiente da chave existe', () => {
    process.env.MEU_GATEWAY_API_KEY = 'chave-de-teste';
    withConfig([validProvider]);
    expect(getModelsCatalog().providers.find((item) => item.id === 'meu-gateway')?.configured).toBe(true);
  });

  it('recusa chave colada dentro do JSON, nomeando o campo', () => {
    withConfig([{ ...validProvider, apiKey: 'sk-vazou-aqui' }]);
    const [error] = getModelsCatalog().configErrors;
    expect(error).toContain('apiKey');
    expect(error).toContain('apiKeyEnv');
    expect(getProvider('meu-gateway')).toBeUndefined();
  });

  it('recusa modelo sem janela de contexto', () => {
    withConfig([{ ...validProvider, models: [{ id: 'sem-ctx', label: 'Sem ctx' }] }]);
    expect(getModelsCatalog().configErrors[0]).toContain('ctx');
    expect(getProvider('meu-gateway')).toBeUndefined();
  });

  it('recusa colisão com id embutido, nomeando o id', () => {
    withConfig([{ ...validProvider, id: 'deepseek' }]);
    const [error] = getModelsCatalog().configErrors;
    expect(error).toContain('deepseek');
    // O provedor embutido continua intacto.
    expect(getProvider('deepseek')?.baseURL).toBe('https://api.deepseek.com/v1');
  });

  it('reporta JSON inválido em vez de derrubar o catálogo', () => {
    withConfig('{ isto nao e json');
    const catalog = getModelsCatalog();
    expect(catalog.configErrors[0]).toContain('CUSTOM_PROVIDERS');
    expect(catalog.providers.length).toBeGreaterThan(0);
  });

  it('deixa o preço nulo quando não é declarado, sem inventar zero', () => {
    withConfig([validProvider]);
    const pricing = getModel('meu-gateway', 'modelo-rapido')?.pricing;
    expect(pricing).toEqual({ inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null });
  });
});
