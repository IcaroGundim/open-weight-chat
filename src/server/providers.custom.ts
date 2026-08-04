import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { BUILTIN_PROVIDER_IDS, ProviderIdSchema } from '../shared/types';
import type { ProviderConfig, ProviderModelConfig } from './providers.config';

/**
 * Provedores personalizados: qualquer endpoint OpenAI-compatível pode ser
 * ligado sem tocar em código. O cliente de streaming é um só — o que muda é
 * baseURL, chave e id de modelo (PLANO.md §3.1).
 *
 * A chave nunca entra na configuração: entra o NOME da variável de ambiente.
 */

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;

/** Nomes de campo que denunciam uma chave colada direto no JSON. */
const SECRET_FIELDS = new Set(['apikey', 'api_key', 'key', 'token', 'secret', 'authorization', 'bearer']);

const PricingSchema = z
  .object({
    inputPerMillion: z.number().nonnegative().nullable().optional(),
    cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
    outputPerMillion: z.number().nonnegative().nullable().optional(),
  })
  .optional();

const CustomModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(160).optional(),
  // Obrigatório de propósito: um ctx errado ou ausente quebra o corte de
  // contexto em silêncio, e o erro só aparece como falha do provedor.
  ctx: z
    .number({ error: 'ctx é obrigatório: informe a janela de contexto do modelo, em tokens.' })
    .int('ctx precisa ser um número inteiro de tokens.')
    .positive('ctx precisa ser maior que zero.'),
  reasoning: z.boolean().optional(),
  pricing: PricingSchema,
});

const CustomProviderSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().trim().min(1).max(80),
  baseURL: z.string().url('baseURL precisa ser uma URL absoluta, incluindo o esquema.'),
  baseURLEnv: z.string().regex(ENV_NAME).optional(),
  apiKeyEnv: z.string().regex(ENV_NAME, 'apiKeyEnv deve ser o NOME de uma variável de ambiente, em MAIÚSCULAS.').optional(),
  requiresApiKey: z.boolean().optional(),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'verifiedAt deve estar no formato AAAA-MM-DD.').optional(),
  models: z.array(CustomModelSchema).min(1, 'Declare ao menos um modelo.'),
});

export interface CustomProvidersResult {
  readonly providers: readonly ProviderConfig[];
  readonly errors: readonly string[];
}

function findInlineSecret(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) return key;
  }
  return null;
}

function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join('.') || 'raiz'}: ${issue.message}`)
    .join('; ');
}

function toModelConfig(model: z.infer<typeof CustomModelSchema>): ProviderModelConfig {
  return {
    id: model.id,
    label: model.label ?? model.id,
    ctx: model.ctx,
    reasoning: model.reasoning ?? false,
    pricing: {
      inputPerMillion: model.pricing?.inputPerMillion ?? null,
      cachedInputPerMillion: model.pricing?.cachedInputPerMillion ?? null,
      outputPerMillion: model.pricing?.outputPerMillion ?? null,
    },
  };
}

function parseSource(raw: unknown, origin: string, seen: Set<string>, into: ProviderConfig[], errors: string[]): void {
  const entries = Array.isArray(raw) ? raw : [raw];
  entries.forEach((entry, index) => {
    const where = `${origin}[${index}]`;

    const secret = findInlineSecret(entry);
    if (secret) {
      errors.push(
        `${where}: remova o campo "${secret}". Use "apiKeyEnv" com o NOME da variável de ambiente — esta configuração não é secreta e pode acabar num commit.`,
      );
      return;
    }
    for (const model of Array.isArray((entry as { models?: unknown })?.models) ? (entry as { models: unknown[] }).models : []) {
      const modelSecret = findInlineSecret(model);
      if (modelSecret) {
        errors.push(`${where}: remova o campo "${modelSecret}" do modelo. Chaves só por variável de ambiente.`);
        return;
      }
    }

    const parsed = CustomProviderSchema.safeParse(entry);
    if (!parsed.success) {
      errors.push(`${where}: ${describeIssues(parsed.error.issues)}`);
      return;
    }

    const provider = parsed.data;
    if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(provider.id)) {
      errors.push(
        `${where}: o id "${provider.id}" já pertence a um provedor embutido. Escolha outro id — para corrigir preços de um provedor embutido, edite src/server/providers.config.ts.`,
      );
      return;
    }
    if (seen.has(provider.id)) {
      errors.push(`${where}: o id "${provider.id}" foi declarado mais de uma vez.`);
      return;
    }

    const duplicateModel = provider.models
      .map((model) => model.id)
      .find((id, position, all) => all.indexOf(id) !== position);
    if (duplicateModel) {
      errors.push(`${where}: o modelo "${duplicateModel}" aparece mais de uma vez em "${provider.id}".`);
      return;
    }

    seen.add(provider.id);
    into.push({
      id: provider.id,
      label: provider.label,
      baseURL: provider.baseURL,
      baseURLEnv: provider.baseURLEnv,
      apiKeyEnv: provider.apiKeyEnv,
      requiresApiKey: provider.requiresApiKey ?? Boolean(provider.apiKeyEnv),
      // Sem data declarada, o provedor entra como não verificado: os preços são
      // do usuário e a interface já avisa quando falta verificação.
      verifiedAt: provider.verifiedAt ?? '',
      models: provider.models.map(toModelConfig),
    });
  });
}

function readFileSource(errors: string[]): unknown {
  const configured = process.env.CUSTOM_PROVIDERS_FILE;
  const path = configured
    ? (isAbsolute(configured) ? configured : join(process.cwd(), configured))
    : join(process.cwd(), 'providers.local.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Ausência do arquivo é o caso normal; só o arquivo ilegível vira erro.
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    errors.push(`${path}: JSON inválido (${error instanceof Error ? error.message : 'erro de parse'}).`);
    return undefined;
  }
}

function parseAll(): CustomProvidersResult {
  const providers: ProviderConfig[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const fileSource = readFileSource(errors);
  if (fileSource !== undefined) parseSource(fileSource, 'providers.local.json', seen, providers, errors);

  const envValue = process.env.CUSTOM_PROVIDERS?.trim();
  if (envValue) {
    try {
      parseSource(JSON.parse(envValue) as unknown, 'CUSTOM_PROVIDERS', seen, providers, errors);
    } catch (error) {
      errors.push(`CUSTOM_PROVIDERS: JSON inválido (${error instanceof Error ? error.message : 'erro de parse'}).`);
    }
  }

  return { providers, errors };
}

let cache: CustomProvidersResult | null = null;

/**
 * Leitura preguiçosa e memoizada. Não pode ser um `const` de topo de módulo:
 * `src/server/index.ts` chama `process.loadEnvFile()` no corpo do módulo, mas
 * os `import` são içados acima disso — um parse no topo rodaria antes do .env
 * existir, e os provedores personalizados sumiriam só no ambiente local.
 */
export function getCustomProviders(): CustomProvidersResult {
  cache ??= parseAll();
  return cache;
}

/** Apenas para testes: força uma releitura do ambiente. */
export function resetCustomProvidersCache(): void {
  cache = null;
}
