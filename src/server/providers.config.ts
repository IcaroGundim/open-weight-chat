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

  /**
   * OpenCode Zen e OpenCode Go.
   *
   * Duas assinaturas do mesmo fornecedor, com a MESMA chave
   * (`OPENCODE_API_KEY`) e catálogos/preços diferentes — por isso são dois
   * provedores, e não um com dois modos: `resolveProvider` devolve baseURL por
   * provedor, e o custo de um modelo depende de qual dos dois atendeu.
   *
   * **Só os modelos servidos em `/chat/completions` entram aqui.** O gateway
   * do OpenCode roteia por família: GPT e parte dos demais respondem em
   * `/responses` (protocolo Responses da OpenAI), Claude e Qwen em `/messages`
   * (protocolo da Anthropic) e Gemini em `/models/{id}`. Este app fala
   * `/chat/completions` e só isso, então listar os outros seria oferecer
   * modelos que falham em toda mensagem.
   *
   * A divisão NÃO segue o nome do modelo: `minimax-m3` é `/chat/completions`
   * no Zen e `/messages` no Go; `grok-4.5` é o inverso. Por isso a lista é
   * explícita por provedor, e não uma regra por prefixo — que estaria errada
   * nos dois casos.
   *
   * Preços e endpoints lidos da documentação em 07/08/2026
   * (opencode.ai/docs/zen e /docs/go) e sujeitos à mesma ressalva dos demais:
   * revalide antes de tratar como projeção. `ctx` cai em 131.072 onde não há
   * número verificado — errar para baixo só faz o contexto ser aparado antes
   * do necessário, enquanto errar para cima faz o provedor recusar a
   * requisição inteira. `reasoning` aqui é dica de exibição, não capacidade
   * apurada (ver effort.ts, que de propósito não consulta esse campo).
   */
  'opencode': {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    requiresApiKey: true,
    verifiedAt: '2026-08-07',
    models: [
      {
        id: 'big-pickle',
        label: 'Big Pickle',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 0.028,
          outputPerMillion: 0.28,
        },
      },
      {
        id: 'deepseek-v4-flash-free',
        label: 'DeepSeek V4 Flash Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.74,
          cachedInputPerMillion: 0.145,
          outputPerMillion: 3.48,
        },
      },
      {
        id: 'glm-5',
        label: 'GLM 5',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.0,
          cachedInputPerMillion: 0.2,
          outputPerMillion: 3.2,
        },
      },
      {
        id: 'glm-5.1',
        label: 'GLM 5.1',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4,
        },
      },
      {
        id: 'glm-5.2',
        label: 'GLM 5.2',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4,
        },
      },
      {
        id: 'kimi-k2.5',
        label: 'Kimi K2.5',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.6,
          cachedInputPerMillion: 0.1,
          outputPerMillion: 3.0,
        },
      },
      {
        id: 'kimi-k2.6',
        label: 'Kimi K2.6',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.16,
          outputPerMillion: 4.0,
        },
      },
      {
        id: 'kimi-k2.7-code',
        label: 'Kimi K2.7 Code',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.19,
          outputPerMillion: 4.0,
        },
      },
      {
        id: 'kimi-k3',
        label: 'Kimi K3',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 3.0,
          cachedInputPerMillion: 0.3,
          outputPerMillion: 15.0,
        },
      },
      {
        id: 'laguna-s-2.1-free',
        label: 'Laguna S 2.1 Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'ling-3.0-flash-free',
        label: 'Ling-3.0-flash Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'longcat-2.0-free',
        label: 'LongCat-2.0 Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'mimo-v2.5-free',
        label: 'MiMo-V2.5 Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'minimax-m2.5',
        label: 'MiniMax M2.5',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.3,
          cachedInputPerMillion: 0.06,
          outputPerMillion: 1.2,
        },
      },
      {
        id: 'minimax-m2.7',
        label: 'MiniMax M2.7',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.3,
          cachedInputPerMillion: 0.06,
          outputPerMillion: 1.2,
        },
      },
      {
        id: 'minimax-m3',
        label: 'MiniMax M3',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.3,
          cachedInputPerMillion: 0.06,
          outputPerMillion: 1.2,
        },
      },
      {
        id: 'nemotron-3-ultra-free',
        label: 'Nemotron 3 Ultra Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
      {
        id: 'north-mini-code-free',
        label: 'North Mini Code Free',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.0,
          cachedInputPerMillion: 0.0,
          outputPerMillion: 0.0,
        },
      },
    ],
  },
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    requiresApiKey: true,
    verifiedAt: '2026-08-07',
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
          cachedInputPerMillion: 0.003625,
          outputPerMillion: 0.87,
        },
      },
      {
        id: 'glm-5.1',
        label: 'GLM-5.1',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4,
        },
      },
      {
        id: 'glm-5.2',
        label: 'GLM-5.2',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4,
        },
      },
      {
        id: 'grok-4.5',
        label: 'Grok 4.5',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 2.0,
          cachedInputPerMillion: 0.3,
          outputPerMillion: 6.0,
        },
      },
      {
        id: 'hy3',
        label: 'Hy3',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 0.035,
          outputPerMillion: 0.58,
        },
      },
      {
        id: 'kimi-k2.6',
        label: 'Kimi K2.6',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.16,
          outputPerMillion: 4.0,
        },
      },
      {
        id: 'kimi-k2.7-code',
        label: 'Kimi K2.7 Code',
        ctx: 131_072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.19,
          outputPerMillion: 4.0,
        },
      },
      {
        id: 'kimi-k3',
        label: 'Kimi K3',
        ctx: 1_048_576,
        reasoning: true,
        pricing: {
          inputPerMillion: 3.0,
          cachedInputPerMillion: 0.3,
          outputPerMillion: 15.0,
        },
      },
      {
        id: 'mimo-v2.5',
        label: 'MiMo-V2.5',
        ctx: 131_072,
        reasoning: true,
        pricing: unknownPricing,
      },
      {
        id: 'mimo-v2.5-pro',
        label: 'MiMo-V2.5-Pro',
        ctx: 131_072,
        reasoning: true,
        pricing: unknownPricing,
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
