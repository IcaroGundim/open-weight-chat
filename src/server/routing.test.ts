import { describe, expect, it } from 'vitest';
import { isOpenRouterBaseUrl, isRoutingRejection, parseRoutingMode, routingRequestParams } from './routing';
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

describe('quando o 400 é do campo de roteamento', () => {
  it('reconhece a reclamação de campo desconhecido', () => {
    expect(isRoutingRejection(400, '{"error":{"message":"provider: unknown field"}}', ['provider'])).toBe(true);
    expect(isRoutingRejection(400, 'Unrecognized request argument supplied: provider', ['provider'])).toBe(true);
  });

  /**
   * "provider" aparece em quase todo erro de gateway. Desligar o modo rápido
   * por causa deles faria o usuário perder a preferência sem saber por quê — e
   * ainda gastaria uma ida à rede para receber o mesmo erro.
   */
  it('não confunde erro de gateway com reclamação do campo', () => {
    for (const corpo of [
      '{"error":{"message":"No provider available for this model"}}',
      '{"error":{"message":"Provider returned an error"}}',
      '{"error":{"message":"All providers failed"}}',
      '{"error":{"message":"maximum context length is 65536 tokens"}}',
    ]) {
      expect(isRoutingRejection(400, corpo, ['provider'])).toBe(false);
    }
  });

  it('ignora status que não é 400: 429 e 5xx já têm o próprio caminho', () => {
    expect(isRoutingRejection(429, 'provider: unknown field', ['provider'])).toBe(false);
    expect(isRoutingRejection(503, 'provider: unknown field', ['provider'])).toBe(false);
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
      reportsCostUsd: true,
    });
    expect(semInformado.cost.usd).toBeCloseTo(0.3201, 4);
    expect(semInformado.cost.reported).toBe(false);

    const comInformado = calculateUsageAndCost(modelo, {
      raw: { prompt_tokens: 1_000, completion_tokens: 1_000_000, cost: 2.2531 },
      promptText: 'oi',
      completionText: 'tchau',
      reportsCostUsd: true,
    });
    expect(comInformado.cost.usd).toBe(2.2531);
    expect(comInformado.cost.reported).toBe(true);
    expect(comInformado.cost.estimated).toBe(false);
  });

  /**
   * A trava por baseURL. Um endpoint qualquer que devolva um campo `cost` na
   * sua própria unidade não pode virar dólar marcado como exato — seria um
   * erro silencioso com etiqueta de medida, o pior estado deste número.
   */
  it('só aceita o custo de quem sabidamente informa em dólar', () => {
    const entrada = {
      raw: { prompt_tokens: 1_000, completion_tokens: 1_000_000, cost: 999 },
      promptText: 'oi',
      completionText: 'tchau',
    };
    const semTrava = calculateUsageAndCost(modelo, entrada);
    expect(semTrava.cost.reported).toBe(false);
    expect(semTrava.cost.usd).toBeCloseTo(0.3201, 4);

    expect(calculateUsageAndCost(modelo, { ...entrada, reportsCostUsd: true }).cost.usd).toBe(999);
  });

  /**
   * `upstream_inference_cost` é a PARCELA que o provedor de origem cobrou da
   * OpenRouter, não o total da requisição. Tratá-la como total informaria
   * menos do que foi cobrado — com etiqueta de valor exato por cima.
   */
  it('não confunde a parcela do upstream com o total', () => {
    expect(reportedCostUsd({ cost_details: { upstream_inference_cost: 0.002 } })).toBeUndefined();
    expect(reportedCostUsd({ cost: 0.005, cost_details: { upstream_inference_cost: 0.002 } })).toBe(0.005);
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
