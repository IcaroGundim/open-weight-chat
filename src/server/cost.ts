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

/**
 * Soma o uso informado por vários rounds do mesmo turno.
 *
 * Uma resposta com busca chama o provedor mais de uma vez, e cada chamada é
 * cobrada. Ficar com o uso do último round faria o custo aparecer menor do que
 * foi — e custo que mente é pior do que custo ausente (ver PLANO.md).
 *
 * Um campo só entra na soma quando **todos** os rounds o informaram. Se algum
 * round não reportou `prompt_tokens`, por exemplo, somar os demais daria um
 * número autoritativo e errado; omitir o campo devolve o cálculo à estimativa
 * sobre o texto acumulado, que é aproximada mas honesta — e a estimativa já se
 * anuncia como tal via `costEstimated`.
 */
const CAMPOS_SOMAVEIS = [
  'prompt_tokens',
  'completion_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'total_tokens',
  // O custo informado pela OpenRouter entra na soma pela mesma razão dos
  // tokens: cada round é uma cobrança. E pela mesma regra do "tudo ou nada" —
  // um round sem custo informado derruba o campo inteiro para a tabela, que é
  // aproximada mas não omite metade da conta.
  'cost',
] as const;

export function sumProviderUsage(rounds: readonly (ProviderUsageLike | null)[]): ProviderUsageLike | null {
  const informados = rounds.filter((round): round is ProviderUsageLike => Boolean(round));
  if (informados.length === 0) return null;
  // Um round que não reportou nada conta como lacuna: nenhum campo pode ser
  // dado como completo.
  if (informados.length !== rounds.length) return null;

  const soma: Record<string, number> = {};
  for (const campo of CAMPOS_SOMAVEIS) {
    let total = 0;
    let completo = true;
    for (const round of informados) {
      const valor = nestedNumber(round, [[campo]]);
      if (valor === undefined) {
        completo = false;
        break;
      }
      total += valor;
    }
    if (completo) soma[campo] = total;
  }
  return Object.keys(soma).length > 0 ? soma : null;
}

/**
 * Custo em dólares informado pelo próprio provedor, se houver.
 *
 * Hoje só a OpenRouter informa: ela devolve `usage.cost` (créditos, e um
 * crédito é um dólar) na última mensagem do stream, sempre — o
 * `usage: { include: true }` que a documentação antiga pedia foi descontinuado
 * e não tem efeito. O número é o preço do endpoint que de fato atendeu, que na
 * OpenRouter varia por requisição: no `llama-3.3-70b-instruct` os treze
 * endpoints iam de US$ 0,32 a US$ 2,25 por milhão de tokens de saída. Nenhuma
 * tabela estática acerta isso, e com o modo rápido ligado o erro é sistemático
 * para baixo — a rota mais veloz raramente é a mais barata.
 *
 * Zero é aceito de propósito, e é a única entrada de custo zero legítima do
 * sistema: um modelo gratuito da OpenRouter custa zero de verdade, dito pelo
 * provedor. O que a invariante proíbe é *inventar* zero na ausência de dado —
 * e a ausência aqui continua devolvendo `undefined`.
 */
export function reportedCostUsd(raw: ProviderUsageLike | null | undefined): number | undefined {
  if (!raw) return undefined;
  return nestedNumber(raw, [['cost'], ['costUsd'], ['cost_details', 'upstream_inference_cost']]);
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

export function calculateCost(model: ProviderModelConfig, usage: Usage, reported?: number): Cost {
  // O que o provedor cobrou vence o que a tabela projeta: é medida contra
  // estimativa, e este projeto já trata as duas como coisas diferentes.
  if (reported !== undefined) {
    return { usd: Number(reported.toFixed(8)), estimated: false, pricingAvailable: true, reported: true };
  }
  const { pricing } = model;
  const pricingAvailable = pricing.inputPerMillion !== null && pricing.outputPerMillion !== null;
  if (!pricingAvailable) {
    return { usd: null, estimated: true, pricingAvailable: false, reported: false };
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
    reported: false,
  };
}

export function calculateUsageAndCost(model: ProviderModelConfig, input: UsageInput): CostCalculation {
  const usage = normalizeUsage(input);
  return { usage, cost: calculateCost(model, usage, reportedCostUsd(input.raw)) };
}

