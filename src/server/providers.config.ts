import type { ModelPricing, ModelsResponse, ProviderCatalog, ProviderId } from '../shared/types';
import { getCustomProviders, resetCustomProvidersCache } from './providers.custom';

export interface ProviderModelConfig {
  readonly id: string;
  readonly label: string;
  /** Context window in tokens. Required because it drives context trimming. */
  readonly ctx: number;
  readonly reasoning: boolean;
  readonly pricing: ModelPricing;
}

export interface ProviderConfig {
  readonly id: ProviderId;
  readonly label: string;
  readonly baseURL: string;
  readonly baseURLEnv?: string;
  readonly apiKeyEnv?: string;
  readonly requiresApiKey: boolean;
  readonly verifiedAt: string;
  readonly models: readonly ProviderModelConfig[];
}

const freePricing: ModelPricing = {
  inputPerMillion: 0,
  cachedInputPerMillion: 0,
  outputPerMillion: 0,
};

const unknownPricing: ModelPricing = {
  inputPerMillion: null,
  cachedInputPerMillion: null,
  outputPerMillion: null,
};

/**
 * Catálogo estático de provedores embutidos: endpoints, modelos e preços.
 *
 * Este módulo NÃO contém chaves nem dados de usuário: `apiKeyEnv` guarda
 * apenas o NOME da variável de ambiente (e mesmo essa fonte só é consultada
 * em dev/teste com opt-in — ver `allowEnvApiKeys` em provider-resolution.ts).
 * A resolução por usuário, dentro da requisição, vive em
 * `src/server/provider-resolution.ts`; o catálogo global mutável
 * (`setRuntimeProviders`) foi removido justamente para eliminar o vazamento
 * de chave entre requisições simultâneas de usuários diferentes.
 */
export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    requiresApiKey: true,
    verifiedAt: '2026-08-04',
    models: [
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 0.0028,
          outputPerMillion: 0.28,
        },
      },
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.435,
          cachedInputPerMillion: null,
          outputPerMillion: 0.87,
        },
      },
    ],
  },
  glm: {
    id: 'glm',
    label: 'GLM (Z.ai)',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    requiresApiKey: true,
    verifiedAt: '2026-08-04',
    models: [
      {
        id: 'glm-4.7-flashx',
        label: 'GLM 4.7 FlashX',
        ctx: 1_048_576,
        reasoning: false,
        pricing: { inputPerMillion: 0.07, cachedInputPerMillion: null, outputPerMillion: 0.4 },
      },
      {
        id: 'glm-4.5-air',
        label: 'GLM 4.5 Air',
        ctx: 131_072,
        reasoning: true,
        pricing: { inputPerMillion: 0.2, cachedInputPerMillion: null, outputPerMillion: 1.1 },
      },
      {
        id: 'glm-4.7',
        label: 'GLM 4.7',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 0.6, cachedInputPerMillion: null, outputPerMillion: 2.2 },
      },
      {
        id: 'glm-5',
        label: 'GLM 5',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 1, cachedInputPerMillion: null, outputPerMillion: 3.2 },
      },
      {
        id: 'glm-5.2',
        label: 'GLM 5.2',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 1.4, cachedInputPerMillion: null, outputPerMillion: 4.4 },
      },
      {
        id: 'glm-4.7-flash',
        label: 'GLM 4.7 Flash',
        ctx: 1_048_576,
        reasoning: false,
        pricing: freePricing,
      },
    ],
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    baseURL: 'https://api.kimi.ai/v1',
    apiKeyEnv: 'KIMI_API_KEY',
    requiresApiKey: true,
    verifiedAt: '2026-08-04',
    models: [
      {
        id: 'kimi-k3',
        label: 'Kimi K3',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
      },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    requiresApiKey: true,
    verifiedAt: '2026-08-04',
    models: [
      {
        id: 'openrouter/auto',
        label: 'Auto Router',
        ctx: 1_048_576,
        reasoning: true,
        pricing: unknownPricing,
      },
      {
        id: 'deepseek/deepseek-v4-flash',
        label: 'DeepSeek V4 Flash (OpenRouter)',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 0.09, cachedInputPerMillion: null, outputPerMillion: 0.18 },
      },
      {
        id: 'z-ai/glm-5.2',
        label: 'GLM 5.2 (OpenRouter)',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 1.4, cachedInputPerMillion: null, outputPerMillion: 4.4 },
      },
      {
        id: 'moonshotai/kimi-k3',
        label: 'Kimi K3 (OpenRouter)',
        ctx: 1_048_576,
        reasoning: true,
        pricing: { inputPerMillion: 3, cachedInputPerMillion: null, outputPerMillion: 15 },
      },
    ],
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    baseURLEnv: 'OLLAMA_BASE_URL',
    requiresApiKey: false,
    verifiedAt: '2026-08-04',
    models: [
      {
        id: 'llama3.2',
        label: 'Llama 3.2',
        ctx: 131_072,
        reasoning: false,
        pricing: freePricing,
      },
      {
        id: 'qwen3',
        label: 'Qwen 3',
        ctx: 131_072,
        reasoning: true,
        pricing: freePricing,
      },
    ],
  },
} as const satisfies Record<ProviderId, ProviderConfig>;

const STALE_AFTER_DAYS = 90;

/** True quando o catálogo do provedor passou da idade de re-verificação. */
export function isStale(verifiedAt: string, now = new Date()): boolean {
  const verified = Date.parse(`${verifiedAt}T00:00:00.000Z`);
  if (!Number.isFinite(verified)) return true;
  const age = now.getTime() - verified;
  return age > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Configurado no catálogo ESTÁTICO (legado): sem acesso ao usuário, a única
 * fonte possível de chave é a variável de ambiente nomeada por `apiKeyEnv`.
 * É apenas um booleano — a chave em si nunca entra neste módulo.
 */
function isConfigured(provider: ProviderConfig): boolean {
  if (!provider.requiresApiKey) return true;
  return Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]);
}

interface StaticCatalog {
  readonly byId: ReadonlyMap<string, ProviderConfig>;
  readonly customIds: ReadonlySet<string>;
  readonly errors: readonly string[];
}

/**
 * Visão estática única sobre embutidos + provedores do arquivo/env custom.
 * É memoizada, mas NUNCA contém chaves nem dados de usuário: qualquer coisa
 * por usuário passa por `resolveProvider`/`resolveModelsCatalog` em
 * provider-resolution.ts.
 */
let staticCache: StaticCatalog | null = null;

function getStaticCatalog(): StaticCatalog {
  if (staticCache) return staticCache;
  const custom = getCustomProviders();
  const byId = new Map<string, ProviderConfig>();
  for (const provider of Object.values(PROVIDERS)) byId.set(provider.id, provider);
  const customIds = new Set<string>();
  for (const provider of custom.providers) {
    byId.set(provider.id, provider);
    customIds.add(provider.id);
  }
  staticCache = { byId, customIds, errors: custom.errors };
  return staticCache;
}

/** Apenas para testes: relê arquivo/env de provedores custom na próxima chamada. */
export function resetProvidersCache(): void {
  staticCache = null;
  resetCustomProvidersCache();
}

/**
 * Lista estática de provedores (embutidos + arquivo custom), na ordem do
 * catálogo. Usada pela resolução por usuário como base; não contém chaves.
 */
export function listStaticProviders(): readonly ProviderConfig[] {
  return [...getStaticCatalog().byId.values()];
}

export function getProvider(providerId: string): ProviderConfig | undefined {
  return getStaticCatalog().byId.get(providerId);
}

/** Erros de configuração de provedores personalizados, para exibição. */
export function getProviderConfigErrors(): readonly string[] {
  return getStaticCatalog().errors;
}

export function getModel(providerId: string, modelId: string): ProviderModelConfig | undefined {
  return getProvider(providerId)?.models.find((model) => model.id === modelId);
}

/**
 * LEGADO (catálogo estático, SEM usuário): usado apenas pelo index.ts antigo
 * (reescrito na Onda 4) e por testes antigos. `configured` considera apenas a
 * presença da variável de ambiente de `apiKeyEnv` — no fluxo novo, use
 * `resolveModelsCatalog(userId, db)` (provider-resolution.ts), que decide a
 * configuração pela chave do usuário autenticado.
 */
export function getDefaultModelSelection(): { providerId: ProviderId; modelId: string } {
  const envProvider = process.env.DEFAULT_PROVIDER_ID;
  const envModel = process.env.DEFAULT_MODEL_ID;
  const configuredProvider = envProvider ? getProvider(envProvider) : undefined;
  const configuredModel = configuredProvider && envModel ? getModel(configuredProvider.id, envModel) : undefined;
  if (configuredProvider && configuredModel) {
    return { providerId: configuredProvider.id, modelId: configuredModel.id };
  }

  const firstProvider = PROVIDERS.deepseek;
  return { providerId: firstProvider.id, modelId: firstProvider.models[0].id };
}

/**
 * LEGADO (catálogo estático, SEM usuário): usado apenas pelo index.ts antigo
 * e por testes antigos. A resposta nunca contém chaves — apenas o booleano
 * `configured` derivado de variável de ambiente. Para o catálogo por usuário,
 * use `resolveModelsCatalog(userId, db)`.
 */
export function getModelsCatalog(now = new Date()): ModelsResponse {
  const merged = getStaticCatalog();
  const providers = [...merged.byId.values()].map<ProviderCatalog>((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: isConfigured(provider),
    verifiedAt: provider.verifiedAt,
    stale: isStale(provider.verifiedAt, now),
    source: merged.customIds.has(provider.id) ? 'custom' : 'builtin',
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      contextWindow: model.ctx,
      reasoning: model.reasoning,
      pricing: model.pricing,
    })),
  }));
  const defaults = getDefaultModelSelection();
  return {
    providers,
    defaultProviderId: defaults.providerId,
    defaultModelId: defaults.modelId,
    configErrors: [...merged.errors],
  };
}
