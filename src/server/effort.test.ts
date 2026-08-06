import { describe, expect, it } from 'vitest';
import { effortRequestParams, isEffortRejection } from './effort';

describe('tradução do nível de esforço', () => {
  it('não envia nada em auto — o padrão precisa ser idêntico ao comportamento anterior', () => {
    expect(effortRequestParams('auto', 'deepseek', true)).toBeNull();
    expect(effortRequestParams(undefined, 'deepseek', true)).toBeNull();
  });

  it('não envia nada quando o modelo não faz raciocínio', () => {
    // GLM 4.7 Flash tem reasoning: false no catálogo. Mandar o campo seria
    // pedir 400 para configurar algo que o modelo não tem.
    expect(effortRequestParams('high', 'glm', false)).toBeNull();
    expect(effortRequestParams('off', 'openrouter', false)).toBeNull();
  });

  it('usa reasoning_effort na convenção OpenAI', () => {
    expect(effortRequestParams('high', 'deepseek', true)).toEqual({
      body: { reasoning_effort: 'high' },
      keys: ['reasoning_effort'],
    });
    expect(effortRequestParams('low', 'kimi', true)?.body).toEqual({ reasoning_effort: 'low' });
  });

  it('usa o objeto reasoning da OpenRouter, o único que sabe desligar', () => {
    expect(effortRequestParams('medium', 'openrouter', true)?.body).toEqual({ reasoning: { effort: 'medium' } });
    expect(effortRequestParams('off', 'openrouter', true)?.body).toEqual({ reasoning: { enabled: false } });
  });

  it('reduz o GLM a ligado/desligado, porque o dialeto não gradua', () => {
    expect(effortRequestParams('low', 'glm', true)?.body).toEqual({ thinking: { type: 'enabled' } });
    expect(effortRequestParams('high', 'glm', true)?.body).toEqual({ thinking: { type: 'enabled' } });
    expect(effortRequestParams('off', 'glm', true)?.body).toEqual({ thinking: { type: 'disabled' } });
  });

  it('traduz off como esforço mínimo onde não há desligamento de verdade', () => {
    expect(effortRequestParams('off', 'deepseek', true)?.body).toEqual({ reasoning_effort: 'minimal' });
  });

  it('trata provedor personalizado pela convenção mais difundida', () => {
    expect(effortRequestParams('high', 'meu-endpoint', true)?.body).toEqual({ reasoning_effort: 'high' });
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
