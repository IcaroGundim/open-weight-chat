import { EffortLevelSchema, type EffortLevel, type ProviderId } from '../shared/types';

/**
 * Lê a coluna `conversations.effort`. NULL — toda conversa criada antes da
 * migração 004 — e qualquer valor que não seja um nível conhecido caem em
 * `auto`, o único que não envia parâmetro ao provedor. Um banco com lixo
 * nessa coluna degrada para o comportamento antigo em vez de quebrar o envio.
 */
export function parseEffortColumn(value: unknown): EffortLevel {
  const parsed = EffortLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : 'auto';
}

/**
 * Tradução do nível de esforço para o corpo da requisição de cada provedor.
 *
 * O app fala um protocolo só — OpenAI-compatible — mas raciocínio é
 * justamente onde esse "compatible" se desfaz: cada provedor batizou o
 * parâmetro de um jeito, e um campo desconhecido não é ignorado em silêncio
 * por todo mundo — parte devolve 400 e a mensagem inteira falha. Por isso a
 * divergência mora aqui, num módulo só, e não espalhada no cliente HTTP.
 *
 * Três dialetos cobrem o catálogo:
 *
 * - `reasoning_effort`  convenção da OpenAI, a mais difundida entre endpoints
 *   compatíveis. É o padrão para provedores personalizados (BYOK), porque é
 *   a única aposta razoável sobre um endpoint que não conhecemos.
 * - `reasoning`         objeto unificado da OpenRouter, o único dialeto que
 *   sabe desligar o raciocínio explicitamente (`enabled: false`).
 * - `thinking`          GLM / Z.ai. É binário: liga ou desliga, sem graduação.
 *
 * **Os nomes destes parâmetros não são autoritativos**, pela mesma razão que
 * `providers.config.ts` declara sobre os preços: foram levantados por busca,
 * não pela documentação de cada provedor, e alguns modelos do catálogo são
 * recentes demais para haver documentação estável. É por isso que
 * `auto` — que não envia nada — é o padrão, e que o cliente HTTP repete a
 * requisição sem estes campos quando o provedor devolve 400 reclamando deles.
 */
type EffortDialect = 'reasoning_effort' | 'reasoning' | 'thinking';

const DIALECT_BY_PROVIDER: Readonly<Partial<Record<ProviderId, EffortDialect>>> = {
  deepseek: 'reasoning_effort',
  kimi: 'reasoning_effort',
  ollama: 'reasoning_effort',
  openrouter: 'reasoning',
  glm: 'thinking',
};

/** Provedor personalizado cai na convenção mais difundida. */
const DEFAULT_DIALECT: EffortDialect = 'reasoning_effort';

/**
 * `off` num dialeto que só gradua esforço não tem tradução honesta: o mais
 * perto é o menor esforço disponível. A interface diz isso ao usuário em vez
 * de prometer um desligamento que o provedor não oferece.
 */
const MINIMAL_EFFORT = 'minimal';

export interface EffortRequestParams {
  /** Campos a mesclar no corpo da requisição. */
  readonly body: Record<string, unknown>;
  /** Chaves injetadas, para reconhecer o 400 que reclama delas. */
  readonly keys: readonly string[];
}

/**
 * Monta os campos de raciocínio para um envio.
 *
 * Devolve `null` — nenhum campo, corpo intocado — só quando o nível é `auto`
 * ou está ausente.
 *
 * **Não** consulta o `reasoning` do catálogo, e isso é uma correção de rumo:
 * a primeira versão suprimia os campos quando o modelo estava marcado como
 * "não raciocina". Só que esse flag vem `false` para TODO modelo descoberto
 * pelo `/models` do provedor — o endpoint padrão da OpenAI não informa essa
 * capacidade —, o que travava a funcionalidade justamente no caso BYOK, que é
 * a premissa do produto. O flag também não é autoritativo nem no catálogo
 * embutido, pela mesma razão que os preços não são.
 *
 * Quem protege do 400 é a retentativa sem estes campos, no `llm-client`. O
 * gate era redundante com ela — e, ao contrário dela, errava fechado.
 */
export function effortRequestParams(
  level: EffortLevel | undefined,
  providerId: ProviderId,
): EffortRequestParams | null {
  if (!level || level === 'auto') return null;

  const dialect = DIALECT_BY_PROVIDER[providerId] ?? DEFAULT_DIALECT;

  if (dialect === 'reasoning') {
    const body = level === 'off' ? { reasoning: { enabled: false } } : { reasoning: { effort: level } };
    return { body, keys: ['reasoning'] };
  }

  if (dialect === 'thinking') {
    // Binário: qualquer graduação vira "ligado". Não há como pedir "pense
    // pouco" aqui, e inventar um campo extra seria arriscar o 400 que este
    // módulo existe para evitar.
    const body = { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } };
    return { body, keys: ['thinking'] };
  }

  const body = { reasoning_effort: level === 'off' ? MINIMAL_EFFORT : level };
  return { body, keys: ['reasoning_effort'] };
}

/**
 * O provedor rejeitou a requisição por causa dos campos de raciocínio?
 *
 * Só olha 400: 429 e 5xx já têm o próprio caminho de retentativa, e um 400 de
 * contexto estourado não menciona estes campos — repetir a requisição nesse
 * caso só faria o usuário esperar duas vezes pelo mesmo erro.
 */
export function isEffortRejection(status: number, body: string, keys: readonly string[]): boolean {
  if (status !== 400 || keys.length === 0) return false;
  const lowered = body.toLowerCase();
  return keys.some((key) => lowered.includes(key.toLowerCase()));
}
