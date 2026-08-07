import { RoutingModeSchema, type RoutingMode } from '../shared/types';

/**
 * Modo de roteamento da OpenRouter.
 *
 * A OpenRouter não é um provedor: é um **balanceador** na frente de vários.
 * Um mesmo id de modelo é servido por endpoints diferentes, com preço e
 * velocidade diferentes, e o padrão dela equilibra os dois. O campo `provider`
 * do corpo permite forçar o critério, e `sort: 'throughput'` manda escolher o
 * endpoint mais rápido disponível — o mesmo que o sufixo `:nitro` no id do
 * modelo, segundo a documentação de provider routing.
 *
 * **Rápido custa mais, e quanto mais varia por modelo.** Medido no catálogo
 * público em 07/08/2026, o `llama-3.3-70b-instruct` tinha 13 endpoints com a
 * saída entre US$ 0,32 e US$ 2,25 por milhão de tokens — 7× de diferença entre
 * o mais barato e o mais caro. Não existe um "acréscimo do modo rápido" fixo
 * que a interface pudesse prometer; o que existe é um preço que só se conhece
 * depois da chamada. Daí a segunda metade desta funcionalidade, em `cost.ts`:
 * a OpenRouter informa o custo real da requisição no uso, e com o modo rápido
 * ligado esse número passa a ser a única fonte honesta — a tabela estática de
 * `providers.config.ts` descreve o preço padrão do modelo, não o do endpoint
 * que atendeu.
 *
 * O reconhecimento é pela **baseURL efetiva**, nunca pelo id do provedor, pela
 * mesma razão do OpenCode: id é livre, e alguém pode registrar um provedor
 * chamado `openrouter` apontando para outro lugar. Mandar `provider` a um
 * endpoint que não o conhece é arriscar 400 na mensagem inteira — e é
 * exatamente o risco que o `auto` do esforço existe para evitar.
 */

export function parseRoutingMode(value: unknown): RoutingMode {
  const parsed = RoutingModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'auto';
}

/** A baseURL é da OpenRouter? Só aí o campo `provider` pode ser enviado. */
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

export interface RoutingRequestParams {
  /** Campos a acrescentar ao corpo da requisição. */
  readonly body: Record<string, unknown>;
  /** Nomes dos campos, para o cliente HTTP saber o que remover num 400. */
  readonly keys: readonly string[];
}

/**
 * Traduz o modo para o corpo da requisição.
 *
 * `auto` não envia campo nenhum, pelo mesmo motivo do esforço: o padrão do
 * provedor é o único comportamento que não depende de uma suposição nossa.
 */
export function routingRequestParams(mode: RoutingMode, baseURL: string): RoutingRequestParams | null {
  if (mode !== 'fast') return null;
  if (!isOpenRouterBaseUrl(baseURL)) return null;
  return { body: { provider: { sort: 'throughput' } }, keys: ['provider'] };
}
