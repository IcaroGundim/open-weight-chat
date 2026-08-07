import { useEffect, useRef, useState } from 'react';
import { gaugeArc, liveRate, needleAngle, scaleFor, trimSamples, type RateSample } from '../render/token-rate';

/**
 * Velocímetro de tokens por segundo.
 *
 * Duas medidas, distinguidas na tela porque têm confiabilidade diferente:
 * durante a geração o número é **estimado** pelo texto que chega (o provedor
 * só informa a contagem no fim), e ao terminar ele é substituído pelo valor
 * **exato**, com os tokens reportados. Marcar essa diferença importa — este
 * projeto trata custo estimado e custo medido como coisas distintas, e
 * velocidade não é diferente.
 *
 * O ponteiro anda por transição CSS, e o número é reamostrado a cada meio
 * segundo. Redesenhar a cada chunk faria o ponteiro tremer e o número piscar
 * sem que nada de útil mudasse.
 */

// A caixa é apertada de propósito: o velocímetro divide o rodapé com o custo e
// o botão de copiar. O arco vai até 120°, e nessa inclinação a ponta desce
// meio raio abaixo do centro — a altura tem de contar esse trecho, senão as
// pontas do arco ficam cortadas na borda do SVG.
const RAIO = 18;
const CENTRO = 22;
const LARGURA = 44;
const ALTURA = 32;

type TokenSpeedometerProps = {
  /** Total de caracteres já recebidos. Cresce durante o stream. */
  readonly chars: number;
  readonly streaming: boolean;
  /** Tokens reportados pelo provedor; presente só no fim. */
  readonly completionTokens?: number;
  /** Duração do turno em ms, para a medida exata. */
  readonly elapsedMs?: number;
};

export function TokenSpeedometer({ chars, streaming, completionTokens, elapsedMs }: TokenSpeedometerProps) {
  const amostras = useRef<RateSample[]>([]);
  const [taxaViva, setTaxaViva] = useState<number | null>(null);
  const [escala, setEscala] = useState(0);

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
      const taxa = liveRate(amostras.current, performance.now());
      setTaxaViva(taxa);
      if (taxa !== null) setEscala((atual) => scaleFor(taxa, atual));
    }, 500);
    return () => window.clearInterval(relogio);
  }, [streaming]);

  const exata = !streaming && completionTokens && elapsedMs
    ? (completionTokens / elapsedMs) * 1000
    : null;
  const taxa = streaming ? taxaViva : exata;
  if (taxa === null || taxa === undefined) return null;

  const escalaUsada = Math.max(escala, scaleFor(taxa));
  const angulo = needleAngle(taxa, escalaUsada);

  return (
    <span className="velocimetro" data-vivo={streaming || undefined}>
      <svg width={LARGURA} height={ALTURA} viewBox={`0 0 ${LARGURA} ${ALTURA}`} aria-hidden="true">
        <path className="velocimetro-trilho" d={gaugeArc(CENTRO, CENTRO, RAIO, -120, 120)} />
        <path className="velocimetro-arco" d={gaugeArc(CENTRO, CENTRO, RAIO, -120, angulo)} />
        <line
          className="velocimetro-ponteiro"
          x1={CENTRO}
          y1={CENTRO}
          x2={CENTRO}
          y2={CENTRO - RAIO + 4}
          transform={`rotate(${angulo} ${CENTRO} ${CENTRO})`}
        />
        <circle className="velocimetro-eixo" cx={CENTRO} cy={CENTRO} r={2.5} />
      </svg>
      <span className="velocimetro-leitura">
        <b className="num">{taxa < 10 ? taxa.toFixed(1) : Math.round(taxa)}</b>
        {/* "~" é a diferença entre medida e estimativa, e ela não pode sumir. */}
        <small>{streaming ? '~tok/s' : 'tok/s'}</small>
      </span>
    </span>
  );
}
