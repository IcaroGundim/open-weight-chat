import { describe, expect, it } from 'vitest';
import { calculateCost, normalizeUsage } from './cost';
import { getModel } from './providers.config';

describe('cost calculator', () => {
  it('normalizes real usage and clamps cached tokens', () => {
    const usage = normalizeUsage({
      raw: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
        prompt_tokens_details: { cached_tokens: 150 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
      promptText: 'ignored',
      completionText: 'ignored',
    });
    expect(usage).toEqual({
      promptTokens: 100,
      cachedTokens: 100,
      completionTokens: 40,
      reasoningTokens: 10,
      totalTokens: 140,
      estimated: false,
    });
  });

  it('marks fallback usage as estimated and calculates configured pricing', () => {
    const model = getModel('deepseek', 'deepseek-v4-flash');
    if (!model) throw new Error('test model missing');
    const usage = normalizeUsage({ raw: null, promptText: 'a'.repeat(40), completionText: 'b'.repeat(40) });
    const cost = calculateCost(model, usage);
    expect(usage.estimated).toBe(true);
    expect(cost.estimated).toBe(true);
    expect(cost.pricingAvailable).toBe(true);
    expect(cost.usd).toBeGreaterThan(0);
  });
});

