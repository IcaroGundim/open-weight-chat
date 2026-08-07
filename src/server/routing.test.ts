import { describe, expect, it } from 'vitest';
import { isOpenRouterBaseUrl, parseRoutingMode, routingRequestParams } from './routing';
import { reportedCostUsd, calculateCost, calculateUsageAndCost, sumProviderUsage } from './cost';
import type { ProviderModelConfig } from './providers.config';

const modelo: ProviderModelConfig = {
  id: 'meta-llama/llama-3.3-70b-instruct',
  label: 'Llama 3.3 70B',
  ctx: 131_072,
  reasoning: false,
  pricing: { inputPerMillion: 0.1, outputPerMillion: 0.32, cachedInputPerMillion: null },
};

describe('modo de roteamento', () => {
  it('auto não envia campo nenhum', () => {
    expect(routingRequestParams('auto', 'https://openrouter.ai/api/v1')).toBeNull();
  });

  it('fast pede o endpoint de maior vazão', () => {
    expect(routingRequestParams('fast', 'https://openrouter.ai/api/v1')).toEqual({
      body: { provider: { sort: 'throughput' } },
      keys: ['provider'],
    });
  });

  /**
   * O ponto da funcionalidade inteira: `provider` é campo da OpenRouter, e um
   * endpoint que não o conhece pode devolver 400 — derrubando a mensagem por
   * causa de uma preferência de velocidade.
   */
  it('não envia o campo para um endpoint que não é da OpenRouter', () => {
    expect(routingRequestParams('fast', 'https://api.deepseek.com/v1')).toBeNull();
    expect(routingRequestParams('fast', 'https://opencode.ai/zen/v1')).toBeNull();
    expect(routingRequestParams('fast', 'http://localhost:11434/v1')).toBeNull();
  });

  /**
   * Mesma regra do OpenCode: id de provedor é livre, e alguém pode registrar
   * um provedor chamado `openrouter` apontando para o próprio servidor. Quem
   * decide é o host.
   */
  it('reconhece pela baseURL, e um sósia não passa', () => {
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouterBaseUrl('https://gateway.openrouter.ai/v1')).toBe(true);
    expect(isOpenRouterBaseUrl('https://openrouter.ai.exemplo.com/v1')).toBe(false);
    expect(isOpenRouterBaseUrl('https://meu-openrouter.com/v1')).toBe(false);
    expect(isOpenRouterBaseUrl('não é uma url')).toBe(false);
  });

  it('valor desconhecido cai em auto, que é o que não envia nada', () => {
    expect(parseRoutingMode('turbo')).toBe('auto');
    expect(parseRoutingMode(undefined)).toBe('auto');
    expect(parseRoutingMode('fast')).toBe('fast');
  });
});

describe('custo informado pelo provedor', () => {
  it('lê o campo cost da OpenRouter', () => {
    expect(reportedCostUsd({ completion_tokens: 100, cost: 0.00234 })).toBe(0.00234);
    expect(reportedCostUsd({ completion_tokens: 100 })).toBeUndefined();
    expect(reportedCostUsd(null)).toBeUndefined();
  });

  /**
   * Um modelo gratuito da OpenRouter custa zero de verdade. A invariante do
   * projeto proíbe *inventar* zero na ausência de dado — não proíbe registrar
   * um zero que o provedor afirmou.
   */
  it('zero informado é um custo, não uma ausência', () => {
    expect(reportedCostUsd({ cost: 0 })).toBe(0);
    expect(calculateCost(modelo, { promptTokens: 10, cachedTokens: 0, completionTokens: 10, reasoningTokens: 0, totalTokens: 20, estimated: false }, 0))
      .toEqual({ usd: 0, estimated: false, pricingAvailable: true, reported: true });
  });

  /**
   * A razão de existir de tudo isto. Com o roteamento rápido a OpenRouter pode
   * servir por um endpoint mais caro que o preço padrão da tabela; medido no
   * catálogo público em 07/08/2026, os treze endpoints deste modelo iam de
   * US$ 0,32 a US$ 2,25 por milhão de tokens de saída.
   */
  it('o valor do provedor vence a tabela, e deixa de ser estimativa', () => {
    const semInformado = calculateUsageAndCost(modelo, {
      raw: { prompt_tokens: 1_000, completion_tokens: 1_000_000 },
      promptText: 'oi',
      completionText: 'tchau',
    });
    expect(semInformado.cost.usd).toBeCloseTo(0.3201, 4);
    expect(semInformado.cost.reported).toBe(false);

    const comInformado = calculateUsageAndCost(modelo, {
      raw: { prompt_tokens: 1_000, completion_tokens: 1_000_000, cost: 2.2531 },
      promptText: 'oi',
      completionText: 'tchau',
    });
    expect(comInformado.cost.usd).toBe(2.2531);
    expect(comInformado.cost.reported).toBe(true);
    expect(comInformado.cost.estimated).toBe(false);
  });

  it('soma o custo informado por todos os rounds de busca', () => {
    const somado = sumProviderUsage([
      { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 150, cost: 0.001 },
      { prompt_tokens: 300, completion_tokens: 80, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 380, cost: 0.004 },
    ]);
    expect(somado?.cost).toBeCloseTo(0.005, 10);
  });

  /**
   * Um round sem custo informado não pode virar uma soma parcial apresentada
   * como exata: o custo apareceria menor do que foi.
   */
  it('um round sem custo derruba o campo inteiro para a estimativa', () => {
    const somado = sumProviderUsage([
      { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
      { prompt_tokens: 300, completion_tokens: 80 },
    ]);
    expect(somado?.cost).toBeUndefined();
  });
});
