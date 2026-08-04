import type { Cost, Usage } from '../shared/types';
import type { ProviderModelConfig } from './providers.config';
import { estimateTokens } from './context';

export type ProviderUsageLike = Record<string, unknown>;

export interface UsageInput {
  raw?: ProviderUsageLike | null;
  promptText: string;
  completionText: string;
  reasoningText?: string;
}

export interface CostCalculation {
  usage: Usage;
  cost: Cost;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function nestedNumber(object: ProviderUsageLike, paths: string[][]): number | undefined {
  for (const path of paths) {
    let value: unknown = object;
    for (const key of path) {
      if (!value || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    const result = finiteNumber(value);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function normalizeUsage(input: UsageInput): Usage {
  const raw = input.raw ?? {};
  const rawPrompt = nestedNumber(raw, [['prompt_tokens'], ['input_tokens'], ['promptTokens']]);
  const rawCached = nestedNumber(raw, [
    ['cached_tokens'],
    ['prompt_cache_hit_tokens'],
    ['prompt_cache_hit_tokens_count'],
    ['prompt_tokens_details', 'cached_tokens'],
    ['promptTokensDetails', 'cachedTokens'],
  ]);
  const rawCompletion = nestedNumber(raw, [['completion_tokens'], ['output_tokens'], ['completionTokens']]);
  const rawReasoning = nestedNumber(raw, [
    ['reasoning_tokens'],
    ['completion_tokens_details', 'reasoning_tokens'],
    ['completionTokensDetails', 'reasoningTokens'],
  ]);
  const rawTotal = nestedNumber(raw, [['total_tokens'], ['totalTokens']]);

  const promptTokens = rawPrompt ?? estimateTokens(input.promptText);
  const reasoningTokens = rawReasoning ?? 0;
  const completionTokens =
    rawCompletion ?? Math.max(estimateTokens(input.completionText) + estimateTokens(input.reasoningText ?? ''), reasoningTokens);
  const cachedTokens = Math.min(rawCached ?? 0, promptTokens);
  const totalTokens = rawTotal ?? promptTokens + completionTokens;

  return {
    promptTokens: Math.round(promptTokens),
    cachedTokens: Math.round(cachedTokens),
    completionTokens: Math.round(completionTokens),
    reasoningTokens: Math.min(Math.round(reasoningTokens), Math.round(completionTokens)),
    totalTokens: Math.round(totalTokens),
    estimated: rawPrompt === undefined || rawCompletion === undefined,
  };
}

export function calculateCost(model: ProviderModelConfig, usage: Usage): Cost {
  const { pricing } = model;
  const pricingAvailable = pricing.inputPerMillion !== null && pricing.outputPerMillion !== null;
  if (!pricingAvailable) {
    return { usd: null, estimated: true, pricingAvailable: false };
  }

  const promptTokens = Math.max(0, usage.promptTokens);
  const cachedTokens = Math.min(Math.max(0, usage.cachedTokens), promptTokens);
  const regularInputTokens = promptTokens - cachedTokens;
  const cachedPrice = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const usd =
    (regularInputTokens * (pricing.inputPerMillion as number) +
      cachedTokens * (cachedPrice as number) +
      Math.max(0, usage.completionTokens) * (pricing.outputPerMillion as number)) /
    1_000_000;
  return {
    usd: Number(usd.toFixed(8)),
    estimated: usage.estimated,
    pricingAvailable: true,
  };
}

export function calculateUsageAndCost(model: ProviderModelConfig, input: UsageInput): CostCalculation {
  const usage = normalizeUsage(input);
  return { usage, cost: calculateCost(model, usage) };
}

