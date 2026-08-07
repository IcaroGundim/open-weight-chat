/**
 * Velocidade de geração, em tokens por segundo.
 *
 * **O provedor só informa a contagem de tokens no fim do stream**, no envelope
 * de uso. Durante a geração não há número real para mostrar — só o texto
 * chegando. Daí as duas medidas, que o velocímetro distingue na tela:
 *
 * - **Ao vivo**, estimada pelo texto recebido numa janela deslizante. É
 *   aproximada e se anuncia como tal.
 * - **Final**, exata, calculada com os tokens que o provedor reportou.
 *
 * A janela deslizante é o ponto da medida ao vivo. A média desde o início
 * responde devagar: um modelo que passou vinte segundos raciocinando e depois
 * escreveu rápido marcaria uma velocidade baixa por muito tempo, escondendo o
 * que está acontecendo agora — que é justamente o que um velocímetro serve
 * para mostrar.
 */

export interface RateSample {
  /** Milissegundos (relógio monotônico ou Date.now). */
  readonly at: number;
  /** Total ACUMULADO de caracteres recebidos até este instante. */
  readonly chars: number;
}

/** Janela da medida ao vivo. Curta o bastante para reagir, longa o bastante
 *  para não pular a cada chunk. */
export const JANELA_MS = 3_000;

/**
 * Divisor de caracteres por token.
 *
 * Mesma aproximação de `estimateTokens` no servidor, e pelo mesmo motivo: sem
 * o tokenizador do provedor, quatro caracteres por token é o palpite que erra
 * menos em texto latino. Como os dois lados usam a mesma conta, a estimativa
 * ao vivo e o custo estimado contam a mesma história.
 */
const CHARS_POR_TOKEN = 4;

/**
 * Velocidade instantânea a partir das amostras.
 *
 * Devolve `null` quando ainda não há janela suficiente para uma medida
 * honesta — mostrar "300 tok/s" porque dois chunks chegaram juntos no
 * primeiro décimo de segundo seria ruído, não informação.
 */
export function liveRate(samples: readonly RateSample[], agora: number): number | null {
  if (samples.length < 2) return null;
  const inicioDaJanela = agora - JANELA_MS;
  // Só o que caiu DENTRO da janela conta. Pegar a amostra anterior a ela como
  // base estenderia o intervalo para trás e diluiria a medida: um turno que
  // passou 20s pensando e 2s escrevendo marcaria a média dos 22s, que é
  // justamente o número que o velocímetro não deve mostrar.
  const naJanela = samples.filter((amostra) => amostra.at >= inicioDaJanela);
  const janela = naJanela.length >= 2 ? naJanela : samples.slice(-2);
  const base = janela[0];
  const ultima = janela[janela.length - 1];
  const decorridoMs = ultima.at - base.at;
  // Menos de meio segundo não sustenta uma taxa: o denominador é pequeno
  // demais e qualquer rajada vira um número absurdo.
  if (decorridoMs < 500) return null;
  const tokens = (ultima.chars - base.chars) / CHARS_POR_TOKEN;
  if (tokens <= 0) return null;
  return (tokens / decorridoMs) * 1000;
}

/** Descarta amostras que já saíram da janela, para o vetor não crescer sem fim. */
export function trimSamples(samples: readonly RateSample[], agora: number): RateSample[] {
  const corte = agora - JANELA_MS * 2;
  const primeiraViva = samples.findIndex((amostra) => amostra.at >= corte);
  // Guarda uma amostra antes do corte: ela é a base do intervalo.
  const inicio = primeiraViva <= 0 ? 0 : primeiraViva - 1;
  return samples.slice(inicio);
}

/** Velocidade exata do turno, com os tokens que o provedor reportou. */
export function finalRate(completionTokens: number, elapsedMs: number): number | null {
  if (!Number.isFinite(completionTokens) || completionTokens <= 0) return null;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 500) return null;
  return (completionTokens / elapsedMs) * 1000;
}
