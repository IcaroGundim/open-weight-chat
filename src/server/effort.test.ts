import { describe, expect, it } from 'vitest';
import { effortRequestParams, isEffortRejection } from './effort';

describe('tradução do nível de esforço', () => {
  it('não envia nada em auto — o padrão precisa ser idêntico ao comportamento anterior', () => {
    expect(effortRequestParams('auto', 'deepseek')).toBeNull();
    expect(effortRequestParams(undefined, 'deepseek')).toBeNull();
  });

  it('não consulta o flag `reasoning` do catálogo — ele trava o BYOK', () => {
    // Regressão: a primeira versão suprimia os campos quando o modelo estava
    // marcado como "não raciocina". Mas a descoberta grava `reasoning: false`
    // em TODO modelo vindo do /models do provedor (o endpoint padrão não
    // informa a capacidade), o que desabilitava o recurso para os 340 modelos
    // de um OpenRouter real. Quem protege do 400 é a retentativa sem os
    // campos, no llm-client — não um flag que erra fechado.
    expect(effortRequestParams('high', 'glm')?.body).toEqual({ thinking: { type: 'enabled' } });
    expect(effortRequestParams('off', 'openrouter')?.body).toEqual({ reasoning: { enabled: false } });
  });

  it('usa reasoning_effort na convenção OpenAI', () => {
    expect(effortRequestParams('high', 'deepseek')).toEqual({
      body: { reasoning_effort: 'high' },
      keys: ['reasoning_effort'],
    });
    expect(effortRequestParams('low', 'kimi')?.body).toEqual({ reasoning_effort: 'low' });
  });

  it('usa o objeto reasoning da OpenRouter, o único que sabe desligar', () => {
    expect(effortRequestParams('medium', 'openrouter')?.body).toEqual({ reasoning: { effort: 'medium' } });
    expect(effortRequestParams('off', 'openrouter')?.body).toEqual({ reasoning: { enabled: false } });
  });

  it('reduz o GLM a ligado/desligado, porque o dialeto não gradua', () => {
    expect(effortRequestParams('low', 'glm')?.body).toEqual({ thinking: { type: 'enabled' } });
    expect(effortRequestParams('high', 'glm')?.body).toEqual({ thinking: { type: 'enabled' } });
    expect(effortRequestParams('off', 'glm')?.body).toEqual({ thinking: { type: 'disabled' } });
  });

  it('traduz off como esforço mínimo onde não há desligamento de verdade', () => {
    expect(effortRequestParams('off', 'deepseek')?.body).toEqual({ reasoning_effort: 'minimal' });
  });

  it('repassa xhigh e max na OpenRouter, que é quem os declara', () => {
    // 60 modelos do catálogo aceitam xhigh e 41 aceitam max (supported_efforts).
    expect(effortRequestParams('xhigh', 'openrouter')?.body).toEqual({ reasoning: { effort: 'xhigh' } });
    expect(effortRequestParams('max', 'openrouter')?.body).toEqual({ reasoning: { effort: 'max' } });
  });

  it('fecha xhigh e max em high na convenção OpenAI, em vez de deixar cair no padrão', () => {
    // A convenção define minimal|low|medium|high. Enviar xhigh daria 400, e a
    // retentativa cairia para "sem campo" — isto é, para o padrão do provedor,
    // que pode ser MENOR que high. Pedir mais e receber menos é o pior caso.
    expect(effortRequestParams('xhigh', 'deepseek')?.body).toEqual({ reasoning_effort: 'high' });
    expect(effortRequestParams('max', 'kimi')?.body).toEqual({ reasoning_effort: 'high' });
    expect(effortRequestParams('max', 'meu-endpoint')?.body).toEqual({ reasoning_effort: 'high' });
  });

  it('mantém o GLM binário também nos níveis novos', () => {
    expect(effortRequestParams('xhigh', 'glm')?.body).toEqual({ thinking: { type: 'enabled' } });
    expect(effortRequestParams('max', 'glm')?.body).toEqual({ thinking: { type: 'enabled' } });
  });

  it('trata provedor personalizado pela convenção mais difundida', () => {
    expect(effortRequestParams('high', 'meu-endpoint')?.body).toEqual({ reasoning_effort: 'high' });
  });
});

describe('reconhecimento do 400 causado pelos campos de raciocínio', () => {
  const keys = ['reasoning_effort'];

  it('reconhece a reclamação do provedor sobre o campo que enviamos', () => {
    const body = '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}';
    expect(isEffortRejection(400, body, keys)).toBe(true);
  });

  it('ignora 400 que não fala dos nossos campos — contexto estourado não deve virar retentativa', () => {
    const body = '{"error":{"message":"This model\'s maximum context length is 65536 tokens"}}';
    expect(isEffortRejection(400, body, keys)).toBe(false);
  });

  it('ignora status que já têm caminho próprio de retentativa', () => {
    const body = 'reasoning_effort';
    expect(isEffortRejection(429, body, keys)).toBe(false);
    expect(isEffortRejection(500, body, keys)).toBe(false);
  });

  it('não reconhece nada quando nenhum campo foi injetado', () => {
    expect(isEffortRejection(400, 'reasoning_effort', [])).toBe(false);
  });
});
