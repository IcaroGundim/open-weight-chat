import { useEffect, useRef, useState } from 'react';
import { finalRate, liveRate, trimSamples, type RateSample } from '../render/token-rate';

/**
 * Contador de tokens por segundo.
 *
 * Duas medidas, distinguidas na tela porque têm confiabilidade diferente:
 * durante a geração o número é **estimado** pelo texto que chega (o provedor
 * só informa a contagem no fim), e ao terminar ele é substituído pelo valor
 * **exato**, com os tokens reportados. Marcar essa diferença importa — este
 * projeto trata custo estimado e custo medido como coisas distintas, e
 * velocidade não é diferente.
 *
 * É só o número, sem mostrador. Um ponteiro precisa de escala para significar
 * alguma coisa, e não existe escala honesta aqui: 15 tok/s é bom num modelo
 * local e ruim num endpoint rápido, então o ponteiro ou ficava colado no fim
 * ou parado no começo. O número sozinho não promete a comparação que o
 * mostrador prometia.
 *
 * Reamostrado a cada meio segundo. A cada chunk, o número piscaria sem que
 * nada de útil mudasse.
 */

type TokenRateProps = {
  /** Total de caracteres já recebidos. Cresce durante o stream. */
  readonly chars: number;
  readonly streaming: boolean;
  /** Tokens reportados pelo provedor; presente só no fim. */
  readonly completionTokens?: number;
  /** Duração do turno em ms, para a medida exata. */
  readonly elapsedMs?: number;
};

export function TokenRate({ chars, streaming, completionTokens, elapsedMs }: TokenRateProps) {
  const amostras = useRef<RateSample[]>([]);
  const [taxaViva, setTaxaViva] = useState<number | null>(null);

  // Uma amostra por chunk recebido; o cálculo é separado, por relógio.
  useEffect(() => {
    if (!streaming) return;
    const agora = performance.now();
    amostras.current = trimSamples([...amostras.current, { at: agora, chars }], agora);
  }, [chars, streaming]);

  useEffect(() => {
    if (!streaming) {
      amostras.current = [];
      setTaxaViva(null);
      return;
    }
    const relogio = window.setInterval(() => {
      setTaxaViva(liveRate(amostras.current, performance.now()));
    }, 500);
    return () => window.clearInterval(relogio);
  }, [streaming]);

  const exata = !streaming && completionTokens && elapsedMs ? finalRate(completionTokens, elapsedMs) : null;
  const taxa = streaming ? taxaViva : exata;
  if (taxa === null || taxa === undefined) return null;

  return (
    <span className="taxa-tokens" data-vivo={streaming || undefined}>
      <b className="num">{taxa < 10 ? taxa.toFixed(1) : Math.round(taxa)}</b>
      {/* "~" é a diferença entre medida e estimativa, e ela não pode sumir. */}
      <small>{streaming ? '~tok/s' : 'tok/s'}</small>
    </span>
  );
}
