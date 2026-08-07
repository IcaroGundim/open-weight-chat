import { AppError, normalizeError } from '../errors';
import { decryptSecret } from '../secrets';
import { assertSafeProviderUrl } from '../ssrf';
import type { ChatDatabaseAdapter } from '../db/database';
import {
  SearchBackendSchema,
  type SearchBackend,
  type SearchResult,
  type SearchSettings,
} from '../../shared/types';
import { BACKEND_REQUIRES_KEY, BACKEND_REQUIRES_URL, runBackend } from './backends';
import { isOpenRouterBaseUrl } from '../openrouter';

/**
 * Resolução da busca POR USUÁRIO e DENTRO DA REQUISIÇÃO.
 *
 * Mesma disciplina de `provider-resolution.ts`, e pela mesma razão: não existe
 * catálogo global mutável. A configuração é lida do banco a cada uso e a
 * chave é decifrada ali, com o contexto do usuário autenticado. Guardar a
 * busca resolvida em módulo faria duas requisições simultâneas de usuários
 * diferentes compartilharem chave de buscador — exatamente o que
 * `setRuntimeProviders` fazia antes de ser removido.
 */

/**
 * AAD da chave de busca no formato v2 do `secrets.ts`.
 *
 * O prefixo `search:` mantém o espaço de nomes separado do de provedores de
 * chat. Sem ele, um usuário com um provedor personalizado chamado `brave`
 * teria o mesmo AAD para duas chaves diferentes — e o AAD é justamente o que
 * amarra cada segredo ao seu dono e ao seu uso.
 */
function aadProviderId(backend: SearchBackend): string {
  return `search:${backend}`;
}

export interface ResolvedSearch {
  backend: SearchBackend;
  /**
   * Quem executa a busca.
   *
   * `external` é o protocolo de marcador: o modelo escreve `<search>`, este
   * servidor consulta o buscador e refaz a chamada com os resultados.
   * `provider` é a busca nativa do provedor, que acontece dentro do próprio
   * pedido de chat — não há marcador, não há rounds e não há nada para este
   * servidor executar. Os dois caminhos são incompatíveis por construção: ligar
   * os dois faria duas buscas e cobraria as duas.
   */
  kind: 'external' | 'provider';
  baseURL: string | null;
  apiKey: string | null;
  maxResults: number;
}

export function encryptionProviderId(backend: SearchBackend): string {
  return aadProviderId(backend);
}

/** Projeção segura para o navegador: nunca a chave, só se ela existe. */
export function toSearchSettingsResponse(record: {
  backend: string;
  baseURL: string | null;
  apiKeyCipher: string | null;
  maxResults: number;
  enabled: boolean;
  updatedAt: number;
}): SearchSettings | null {
  const backend = SearchBackendSchema.safeParse(record.backend);
  // Backend desconhecido no banco (registro de uma versão futura, ou
  // corrompido) some da interface em vez de derrubar a tela de configuração.
  if (!backend.success) return null;
  return {
    backend: backend.data,
    baseURL: record.baseURL,
    hasKey: Boolean(record.apiKeyCipher),
    maxResults: record.maxResults,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  };
}

/**
 * Devolve a busca utilizável do usuário, ou `null` quando não há.
 *
 * `null` cobre todos os casos em que buscar não é possível — sem
 * configuração, desligada, sem a chave que o backend exige, sem a URL que o
 * SearXNG exige. Quem chama não precisa distinguir: sem busca utilizável, o
 * prompt de busca simplesmente não é injetado e o modelo nunca fica sabendo
 * que o recurso existe. Prometer ao modelo uma ferramenta que vai falhar é
 * pior do que não oferecer.
 */
export async function resolveSearch(
  userId: string,
  db: ChatDatabaseAdapter,
  /**
   * BaseURL efetiva do provedor desta requisição.
   *
   * Necessária porque a busca nativa não existe fora da OpenRouter: escolhida
   * ela e selecionado um modelo da DeepSeek, o resultado tem de ser `null` —
   * e não uma busca que o modelo vai pedir e nunca receber. Ausente, só as
   * buscas externas são consideradas; é o que serve à tela de configuração,
   * que não tem provedor nenhum em mãos.
   */
  providerBaseURL?: string,
): Promise<ResolvedSearch | null> {
  const record = await db.getSearchSettings(userId);
  if (!record || !record.enabled) return null;

  const backend = SearchBackendSchema.safeParse(record.backend);
  if (!backend.success) return null;

  if (backend.data === 'openrouter') {
    // Mesma regra do resto: o host decide, nunca o id do provedor.
    if (!providerBaseURL || !isOpenRouterBaseUrl(providerBaseURL)) return null;
    return { backend: 'openrouter', kind: 'provider', baseURL: null, apiKey: null, maxResults: record.maxResults };
  }

  const apiKey = record.apiKeyCipher
    ? decryptSecret(record.apiKeyCipher, { userId, providerId: aadProviderId(backend.data) })
    : null;
  if (BACKEND_REQUIRES_KEY[backend.data] && !apiKey) return null;
  if (BACKEND_REQUIRES_URL[backend.data] && !record.baseURL) return null;

  return {
    backend: backend.data,
    kind: 'external',
    baseURL: record.baseURL,
    apiKey,
    maxResults: record.maxResults,
  };
}

export interface SearchOutcome {
  readonly results: SearchResult[];
  /** Mensagem legível quando a busca falhou. `null` em sucesso. */
  readonly failure: string | null;
}

/**
 * Executa uma busca e **nunca lança**.
 *
 * Uma busca que falha não pode derrubar a resposta: o modelo já escreveu o
 * marcador e está esperando. Devolver o erro como resultado deixa o laço do
 * chat seguir — ele informa o modelo de que a busca falhou e o modelo responde
 * com o que sabe, dizendo que não conseguiu consultar. O usuário vê a falha
 * no cartão da busca em vez de ver a mensagem inteira morrer.
 */
export async function runSearch(
  resolved: ResolvedSearch,
  query: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<SearchOutcome> {
  try {
    // O endpoint do SearXNG vem do usuário. Mesmo tendo sido validado ao
    // salvar, ele pode ter mudado por DNS desde então — a revalidação a cada
    // chamada é a mesma regra que o chat aplica ao endpoint do provedor.
    if (resolved.baseURL) assertSafeProviderUrl(resolved.baseURL);
    const results = await runBackend(resolved.backend, {
      query,
      maxResults: resolved.maxResults,
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      signal,
      fetchImpl,
    });
    return { results, failure: null };
  } catch (error) {
    // Aborto é do usuário, não falha da busca: propaga para o laço do chat
    // encerrar como cancelamento em vez de reportar um erro de buscador.
    if (signal.aborted) throw error;
    const normalized = error instanceof AppError ? error : normalizeError(error);
    return { results: [], failure: normalized.message.slice(0, 300) };
  }
}

/**
 * Resultados no formato que volta ao modelo.
 *
 * Numerado para o modelo poder referenciar, e com a URL visível porque é ela
 * que ele precisa citar. O aviso final existe porque modelos completam trecho
 * truncado de memória com naturalidade — e um trecho de buscador é sempre
 * truncado.
 */
export function formatResultsForModel(query: string, outcome: SearchOutcome): string {
  if (outcome.failure) {
    return [
      `Resultados da busca por "${query}":`,
      '',
      `A busca falhou: ${outcome.failure}`,
      '',
      'Responda com o que você já sabe e diga claramente ao usuário que não foi possível consultar a web agora.',
    ].join('\n');
  }
  if (outcome.results.length === 0) {
    return [
      `Resultados da busca por "${query}":`,
      '',
      'Nenhum resultado.',
      '',
      'Tente uma consulta diferente, ou diga ao usuário que não encontrou nada sobre isso.',
    ].join('\n');
  }
  const itens = outcome.results.map((resultado, indice) => {
    const data = resultado.publishedAt ? ` (${resultado.publishedAt})` : '';
    return `[${indice + 1}] ${resultado.title}${data}\n${resultado.url}\n${resultado.snippet}`;
  });
  return [
    `Resultados da busca por "${query}":`,
    '',
    ...itens,
    '',
    'Estes são trechos, não as páginas inteiras. Use-os para responder e cite as URLs que usar. Se um trecho não sustenta o que você ia afirmar, diga que não encontrou — não complete de memória.',
  ].join('\n');
}
