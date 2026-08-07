import { PROVIDERS, type ProviderModelConfig } from './providers.config';
import type { ProviderId, ProviderModelInput } from '../shared/types';

/**
 * O que é específico do OpenCode mora aqui.
 *
 * O gateway do OpenCode não é um endpoint OpenAI-compatible como os outros do
 * catálogo: ele **roteia por família de modelo**. Um mesmo host serve três
 * protocolos diferentes —
 *
 *   - `/chat/completions`  OpenAI-compatible (DeepSeek, GLM, Kimi, MiniMax…)
 *   - `/messages`          protocolo da Anthropic (Claude, Qwen)
 *   - `/responses`         protocolo Responses da OpenAI (GPT, e parte do resto)
 *   - `/models/{id}`       protocolo do Google (Gemini)
 *
 * — e este app fala apenas o primeiro. Um modelo servido pelos outros não
 * "funciona pior": ele falha em toda mensagem.
 *
 * O `/models` do OpenCode devolve os quatro grupos misturados, sem dizer qual
 * protocolo cada um usa, e sem preço nem janela de contexto. Descobrir modelos
 * sem filtro, portanto, encheria a lista do usuário de opções que não podem
 * ser selecionadas sem erro — que é justamente o oposto do que o botão
 * "buscar modelos" promete.
 *
 * A separação também **não** segue o nome: `minimax-m3` é `/chat/completions`
 * no Zen e `/messages` no Go; `grok-4.5` é o inverso. Por isso o conjunto
 * utilizável vem da lista explícita de `providers.config.ts`, por provedor, e
 * não de uma regra por prefixo — que erraria nos dois casos.
 */

export const OPENCODE_PROVIDER_IDS = ['opencode', 'opencode-go'] as const;
export type OpenCodeProviderId = (typeof OPENCODE_PROVIDER_IDS)[number];

/** Onde o usuário obtém a chave — a mesma para Zen e Go. */
export const OPENCODE_CONSOLE_URL = 'https://opencode.ai/auth';

/**
 * Qual catálogo do OpenCode uma baseURL representa — ou `null` se não for uma.
 *
 * O discriminador é a URL, e **não o id do provedor**, porque id é livre: o
 * usuário pode registrar um provedor chamado `opencode` apontando para o
 * gateway dele. Chavear pelo id faria o filtro daqui descartar os modelos
 * desse usuário, que não têm nada a ver com o OpenCode. O que justifica o
 * filtro é o comportamento daquele host específico, então é ele quem decide.
 */
export function openCodeCatalogFor(baseURL: string): OpenCodeProviderId | null {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return null;
  const caminho = url.pathname.replace(/\/+$/u, '');
  // O Go é prefixo mais longo e precisa ser testado primeiro, senão
  // `/zen/go/v1` casaria como Zen.
  if (caminho.startsWith('/zen/go/v1')) return 'opencode-go';
  if (caminho.startsWith('/zen/v1')) return 'opencode';
  return null;
}

/**
 * Intersecção entre o que o provedor anuncia agora e o que sabemos dirigir.
 *
 * A disponibilidade vem do `/models` (viva, muda sem avisar); a janela de
 * contexto e o preço vêm do nosso catálogo, porque o `/models` do OpenCode não
 * informa nenhum dos dois. Sem esse enriquecimento, todo modelo descoberto
 * entraria sem preço — e custo ausente é exibido como indisponível, o que
 * apagaria a medição inteira de quem usa o OpenCode.
 *
 * Modelo novo do lado deles só aparece depois de entrar no catálogo daqui.
 * É a troca consciente: preferimos uma lista menor e correta a uma lista
 * completa em que parte das opções quebra ao ser escolhida.
 */
export function filterOpenCodeModels(
  providerId: OpenCodeProviderId,
  discovered: readonly ProviderModelInput[],
): ProviderModelInput[] {
  // Map<string, …> explícito: `PROVIDERS` é `as const`, então sem a anotação o
  // TypeScript infere a união literal dos ids como tipo da chave e recusa
  // qualquer busca por um id vindo da rede.
  const conhecidos = new Map<string, ProviderModelConfig>(
    PROVIDERS[providerId].models.map((model) => [model.id, model]),
  );
  const vistos = new Set<string>();
  const compativeis: ProviderModelInput[] = [];

  for (const model of discovered) {
    const conhecido = conhecidos.get(model.id);
    if (!conhecido || vistos.has(model.id)) continue;
    vistos.add(model.id);
    compativeis.push({
      id: conhecido.id,
      label: conhecido.label,
      ctx: conhecido.ctx,
      reasoning: conhecido.reasoning,
      pricing: {
        inputPerMillion: conhecido.pricing.inputPerMillion,
        cachedInputPerMillion: conhecido.pricing.cachedInputPerMillion,
        outputPerMillion: conhecido.pricing.outputPerMillion,
      },
    });
  }
  return compativeis;
}

/**
 * Mensagem para quando a intersecção sai vazia.
 *
 * Só acontece se o OpenCode tiver reorganizado o catálogo — e aí o usuário
 * precisa saber que o problema não é a chave dele, senão vai ficar
 * recadastrando uma chave que está certa.
 */
export const OPENCODE_SEM_MODELOS =
  'O OpenCode respondeu, mas nenhum dos modelos disponíveis usa o protocolo /chat/completions, '
  + 'que é o que este aplicativo fala. A chave está válida — o catálogo do provedor é que mudou.';
