/**
 * O que é específico da OpenRouter mora aqui, como `opencode.ts` faz para o
 * OpenCode.
 *
 * A OpenRouter não é um provedor: é um **balanceador** na frente de vários. O
 * mesmo id de modelo é servido por endpoints diferentes, com preços
 * diferentes — no `z-ai/glm-5.2` a saída ia de US$ 1,49 a US$ 7,26 por milhão
 * entre 32 endpoints, medido em 07/08/2026. Nenhuma tabela estática acerta
 * isso, e é por isso que o custo dela vem do próprio uso da resposta e não de
 * `providers.config.ts`.
 *
 * O reconhecimento é sempre pela **baseURL efetiva**, nunca pelo id do
 * provedor: id é livre, e alguém pode registrar um provedor chamado
 * `openrouter` apontando para outro lugar. Mesma regra do OpenCode.
 */

export function isOpenRouterBaseUrl(baseURL: string): boolean {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
}

/**
 * Busca na web nativa da OpenRouter.
 *
 * É de outra natureza que os buscadores de `search/backends.ts`. Ali o app faz
 * a busca: o modelo escreve `<search>`, o servidor consulta o Brave e refaz a
 * chamada com os resultados — três idas ao provedor no pior caso, cada uma
 * cobrada. Aqui a OpenRouter faz tudo dentro da mesma requisição: ela busca,
 * injeta os resultados e devolve a resposta já citada. Uma chamada só.
 *
 * As duas consequências práticas:
 *
 * - **Não precisa de chave de buscador.** É a chave da OpenRouter que já está
 *   configurada. Quem não quer administrar uma conta no Brave ou no Tavily
 *   passa a ter busca.
 * - **Só vale para modelos da OpenRouter.** O plugin é dela; num endpoint
 *   direto da DeepSeek ou no OpenCode ele não existe. Por isso este backend
 *   convive com os outros em vez de substituí-los, e por isso `resolveSearch`
 *   devolve `null` quando ele está escolhido e o provedor não é a OpenRouter —
 *   injetar o prompt de busca ali prometeria ao modelo algo que não chega.
 *
 * O custo entra em `usage.cost`, junto com o da inferência: US$ 0,005 por
 * requisição com até 10 resultados no Exa, o motor padrão. Não é preciso somar
 * nada à parte, e é mais uma razão para o custo da OpenRouter vir do uso e não
 * da tabela — a tabela não sabe da busca.
 */
export function webPluginBody(maxResults: number): Record<string, unknown> {
  return { plugins: [{ id: 'web', max_results: Math.max(1, Math.min(10, maxResults)) }] };
}

/**
 * Citações da resposta, no formato `url_citation` das anotações.
 *
 * O conteúdo é aparado porque a OpenRouter devolve o trecho da página inteiro,
 * e o cartão de busca da interface mostra um resumo — guardar mil caracteres
 * por citação incharia o envelope SSE sem nada aparecer na tela.
 */
export interface OpenRouterCitation {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

const MAX_SNIPPET = 400;

export function parseCitations(value: unknown): OpenRouterCitation[] {
  if (!Array.isArray(value)) return [];
  const citacoes: OpenRouterCitation[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const registro = item as Record<string, unknown>;
    if (registro.type !== 'url_citation') continue;
    const citacao = registro.url_citation;
    if (!citacao || typeof citacao !== 'object') continue;
    const dados = citacao as Record<string, unknown>;
    const url = typeof dados.url === 'string' ? dados.url : '';
    if (!url) continue;
    const title = typeof dados.title === 'string' && dados.title.trim() ? dados.title.trim() : url;
    const content = typeof dados.content === 'string' ? dados.content : '';
    citacoes.push({
      title: title.slice(0, 300),
      url: url.slice(0, 2048),
      snippet: content.replace(/\s+/gu, ' ').trim().slice(0, MAX_SNIPPET),
    });
  }
  return citacoes;
}
