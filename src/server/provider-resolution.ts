import type { ModelsResponse, ProviderCatalog, ProviderId, ProviderModelInput } from '../shared/types';
import { ProviderModelInputSchema } from '../shared/types';
import type { ChatDatabaseAdapter } from './db/database';
import type { ProviderSettingsRecord } from './db/queries';
import { getCustomProviders } from './providers.custom';
import { PROVIDERS, isStale, listStaticProviders, type ProviderConfig, type ProviderModelConfig } from './providers.config';
import { decryptSecret } from './secrets';
import { assertSafeProviderUrl } from './ssrf';

/**
 * Resolução de provedores POR USUÁRIO e DENTRO DA REQUISIÇÃO.
 *
 * O catálogo estático (providers.config.ts) e o arquivo de provedores
 * personalizados (providers.custom.ts) nunca contêm chaves. As chaves vivem
 * cifradas no `provider_settings` de cada usuário (secrets.ts, formato v2 com
 * AAD amarrado a `userId:providerId`) e só são decifradas aqui, no momento do
 * uso, com o contexto do usuário autenticado da requisição.
 *
 * Não existe mais catálogo global mutável (setRuntimeProviders foi removido):
 * cada chamada a `resolveProvider` monta o provedor efetivo a partir do
 * usuário pedido, então duas requisições simultâneas de usuários diferentes
 * nunca compartilham chave — cada chamada ao upstream recebe somente a chave
 * do seu dono.
 */

export interface ResolvedProvider {
  id: ProviderId;
  label: string;
  baseURL: string;
  requiresApiKey: boolean;
  apiKey: string | null;
  models: readonly ProviderModelConfig[];
  verifiedAt: string;
  source: 'builtin' | 'custom' | 'user';
}

/**
 * Chaves de ambiente (DEEPSEEK_API_KEY etc.) só como fallback de DEV/teste,
 * com opt-in explícito (ALLOW_ENV_API_KEYS=true). Em produção — NODE_ENV=production
 * ou VERCEL — NENHUMA chave de ambiente é usada, mesmo com a flag ligada: a
 * única fonte de chave é o provider_settings do usuário autenticado.
 */
export function allowEnvApiKeys(): boolean {
  if (process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL)) return false;
  return process.env.ALLOW_ENV_API_KEYS === 'true';
}

function isBuiltin(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** Base estática do provedor: embutido primeiro (custom file não pode sobrescrever embutido). */
function staticBase(providerId: string): ProviderConfig | undefined {
  if (isBuiltin(providerId)) return PROVIDERS[providerId as keyof typeof PROVIDERS];
  return getCustomProviders().providers.find((provider) => provider.id === providerId);
}

/** Converte o modelo salvo pelo usuário (ProviderModelInput) no formato interno. */
function toModelConfig(input: ProviderModelInput): ProviderModelConfig {
  return {
    id: input.id,
    label: input.label ?? input.id,
    ctx: input.ctx,
    reasoning: input.reasoning ?? false,
    pricing: {
      inputPerMillion: input.pricing?.inputPerMillion ?? null,
      cachedInputPerMillion: input.pricing?.cachedInputPerMillion ?? null,
      outputPerMillion: input.pricing?.outputPerMillion ?? null,
    },
  };
}

/** Modelos do registro do usuário, validados defensivamente (linha corrompida não derruba nada). */
function recordModels(record: ProviderSettingsRecord): ProviderModelConfig[] {
  const models: ProviderModelConfig[] = [];
  for (const raw of Array.isArray(record.models) ? record.models : []) {
    const parsed = ProviderModelInputSchema.safeParse(raw);
    if (parsed.success) models.push(toModelConfig(parsed.data));
  }
  return models;
}

/** Fallback de dev/teste: chave da variável de ambiente nomeada pelo catálogo (só com opt-in). */
function envApiKeyFallback(base: ProviderConfig | undefined): string | null {
  if (!allowEnvApiKeys()) return null;
  const name = base?.apiKeyEnv;
  if (!name) return null;
  const value = process.env[name];
  return value && value.trim() ? value : null;
}

/**
 * O catálogo nunca deve sugerir como utilizável uma URL que o servidor
 * bloquearia no chat. Isso desativa o Ollama em localhost na produção, sem
 * impedir que o usuário configure um endpoint Ollama público com HTTPS.
 * A resolução de DNS e a validação de redirecionamentos continuam ocorrendo
 * no momento do fetch (safeFetchWithRedirects).
 */
function hasSafeProviderUrl(baseURL: string): boolean {
  if (!baseURL.trim()) return false;
  try {
    assertSafeProviderUrl(baseURL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Monta o provedor efetivo a partir da base estática e do registro do usuário
 * (que tem precedência sobre a base). A chave é SEMPRE decifrada com o
 * contexto `{ userId, providerId }` do dono da requisição.
 */
function resolveProviderParts(
  userId: string,
  providerId: string,
  base: ProviderConfig | undefined,
  record: ProviderSettingsRecord | undefined,
): ResolvedProvider {
  const recordModelsList = record ? recordModels(record) : [];
  // Modelos do usuário substituem os do catálogo apenas quando não vazios.
  const models = record && recordModelsList.length > 0 ? recordModelsList : (base?.models ?? []);

  let baseURL = '';
  if (record?.baseURL.trim()) baseURL = record.baseURL;
  else if (base) baseURL = base.baseURLEnv && process.env[base.baseURLEnv]?.trim() ? (process.env[base.baseURLEnv] as string) : base.baseURL;

  // Semântica de requiresApiKey: a do catálogo embutido/custom é autoritativa
  // (ex.: DeepSeek exige chave mesmo que o registro do usuário esteja sem uma —
  // aí apiKey fica null e o uso falha com erro claro). Provedor criado só pelo
  // usuário (sem base estática) exige chave exatamente quando tem uma gravada;
  // sem chave, é tratado como endpoint keyless (ex.: servidor local).
  const requiresApiKey = base ? base.requiresApiKey : Boolean(record?.apiKeyCipher);

  // A chave só pode vir do registro do usuário; ambiente é fallback de dev/teste.
  const storedKey = record?.apiKeyCipher
    ? decryptSecret(record.apiKeyCipher, { userId, providerId })
    : null;
  const apiKey = storedKey ?? envApiKeyFallback(base);

  const source: ResolvedProvider['source'] = base ? (isBuiltin(base.id) ? 'builtin' : 'custom') : 'user';

  return {
    id: providerId as ProviderId,
    label: record?.label || base?.label || providerId,
    baseURL,
    requiresApiKey,
    apiKey,
    models,
    verifiedAt: (record?.verifiedAt?.trim() || base?.verifiedAt) ?? '',
    source,
  };
}

/**
 * Resolve o provedor EFETIVO do usuário dentro da requisição: base do catálogo
 * embutido/custom, com os dados do provider_settings do usuário tendo
 * precedência, e a chave decifrada com o contexto do dono. Retorna null para
 * provedor inexistente (nem no catálogo nem no registro do usuário).
 */
export async function resolveProvider(
  userId: string,
  providerId: string,
  db: ChatDatabaseAdapter,
): Promise<ResolvedProvider | null> {
  const base = staticBase(providerId);
  const records = await db.listProviderSettings(userId);
  const record = records.find((item) => item.id === providerId);
  if (!base && !record) return null;
  return resolveProviderParts(userId, providerId, base, record);
}

function toCatalogModel(model: ProviderModelConfig): ProviderCatalog['models'][number] {
  return {
    id: model.id,
    label: model.label,
    contextWindow: model.ctx,
    reasoning: model.reasoning,
    pricing: model.pricing,
  };
}

/**
 * Catálogo do usuário: embutidos + custom (arquivo/env) + provider_settings do
 * usuário, com precedência do usuário. `configured` é o booleano
 * `requiresApiKey ? temChave : true` — a chave NUNCA aparece na resposta.
 */
function buildUserCatalog(userId: string, records: ProviderSettingsRecord[], now: Date): ProviderCatalog[] {
  const entries: ProviderCatalog[] = [];

  for (const base of listStaticProviders()) {
    const record = records.find((item) => item.id === base.id);
    const resolved = resolveProviderParts(userId, base.id, base, record);
    entries.push({
      id: resolved.id,
      label: resolved.label,
      configured: hasSafeProviderUrl(resolved.baseURL) && (resolved.requiresApiKey ? Boolean(resolved.apiKey) : true),
      verifiedAt: resolved.verifiedAt,
      stale: isStale(resolved.verifiedAt, now),
      // Usuário que sobrescreve um embutido mantém o source do embutido.
      source: isBuiltin(resolved.id) ? 'builtin' : 'custom',
      models: resolved.models.map(toCatalogModel),
    });
  }

  const staticIds = new Set(entries.map((entry) => entry.id));
  for (const record of records) {
    if (staticIds.has(record.id)) continue;
    const resolved = resolveProviderParts(userId, record.id, undefined, record);
    entries.push({
      id: resolved.id,
      label: resolved.label,
      configured: hasSafeProviderUrl(resolved.baseURL) && (resolved.requiresApiKey ? Boolean(resolved.apiKey) : true),
      verifiedAt: resolved.verifiedAt,
      stale: isStale(resolved.verifiedAt, now),
      // Provedor criado só pelo usuário não é embutido.
      source: 'custom',
      models: resolved.models.map(toCatalogModel),
    });
  }

  return entries;
}

/**
 * Escolha do padrão: DEFAULT_PROVIDER_ID/DEFAULT_MODEL_ID valem se o usuário
 * tem o provedor no catálogo (e o modelo existe); senão, o primeiro provedor
 * configurado do catálogo do usuário; se nenhum estiver configurado, cai no
 * DeepSeek embutido (a primeira chamada mostra o erro claro de chave ausente).
 */
function pickDefault(providers: ProviderCatalog[]): { providerId: ProviderId; modelId: string } {
  const envProvider = process.env.DEFAULT_PROVIDER_ID;
  const envModel = process.env.DEFAULT_MODEL_ID;
  if (envProvider && envModel) {
    const provider = providers.find((item) => item.id === envProvider);
    const model = provider?.models.find((item) => item.id === envModel);
    if (provider && model) return { providerId: provider.id, modelId: model.id };
  }

  const firstConfigured = providers.find((provider) => provider.configured && provider.models.length > 0);
  if (firstConfigured) return { providerId: firstConfigured.id, modelId: firstConfigured.models[0].id };

  return { providerId: 'deepseek', modelId: PROVIDERS.deepseek.models[0].id };
}

/** Catálogo de modelos do usuário (substitui o getModelsCatalog() global). */
export async function resolveModelsCatalog(userId: string, db: ChatDatabaseAdapter): Promise<ModelsResponse> {
  const records = await db.listProviderSettings(userId);
  const providers = buildUserCatalog(userId, records, new Date());
  const defaults = pickDefault(providers);
  return {
    providers,
    defaultProviderId: defaults.providerId,
    defaultModelId: defaults.modelId,
    configErrors: [...getCustomProviders().errors],
  };
}

/** Modelo padrão do usuário (substitui o getDefaultModelSelection() global). */
export async function resolveDefaultModelSelection(
  userId: string,
  db: ChatDatabaseAdapter,
): Promise<{ providerId: ProviderId; modelId: string }> {
  const records = await db.listProviderSettings(userId);
  return pickDefault(buildUserCatalog(userId, records, new Date()));
}
