import { useMemo, useRef, useState } from 'react';
import { Table2 } from 'lucide-react';
import {
  MAX_SERIES,
  arcPath,
  barPath,
  formatValue,
  niceTicks,
  parseChartSpec,
  pieSlices,
  valueExtent,
  type ChartSpec,
} from '../render/chart';

/**
 * Gráfico interativo em SVG puro.
 *
 * Sem biblioteca de gráficos: as formas aqui são retângulo, polilinha e setor,
 * e o que uma biblioteca traria de valor (escalas, eixos) são vinte linhas de
 * aritmética. O que ela traria de custo é meio megabyte e uma estética que não
 * é a deste projeto.
 *
 * O contrato de dataviz do projeto aparece em decisões concretas:
 *
 * - **Cor por posição da série, nunca por grandeza.** Reordenar não repinta.
 * - **Um eixo de valor.** A especificação não tem como declarar um segundo.
 * - **Legenda sempre que houver duas séries ou mais** — identidade nunca fica
 *   só na cor. Com uma série o título já a nomeia, e a legenda seria ruído.
 * - **Tabela alternativa obrigatória.** Três das seis cores da paleta ficam
 *   abaixo de 3:1 contra o papel claro; o validador marca isso como aviso
 *   vinculante, e a tabela é o alívio exigido. Ela também é onde ficam as
 *   séries que passaram do teto e os componentes agrupados em "Outros".
 * - **Nenhum número em cima de cada ponto.** O eixo e o tooltip carregam.
 */

const ALTURA = 300;
const MARGEM = { topo: 16, direita: 16, baixo: 40, esquerda: 56 };
const LARGURA_BASE = 560;
/** Barra fina: ver as marcas do contrato. Nunca preenche a faixa inteira. */
const BARRA_MAXIMA = 24;
/** Vão em cor de superfície entre marcas que se tocam. */
const VAO = 2;

type ChartViewProps = { readonly content: string };

interface Foco {
  readonly indice: number;
  readonly x: number;
  readonly y: number;
}

export function ChartView({ content }: ChartViewProps) {
  const { spec, error, notes } = useMemo(() => parseChartSpec(content), [content]);
  const [ocultas, setOcultas] = useState<ReadonlySet<string>>(new Set());
  const [foco, setFoco] = useState<Foco | null>(null);
  const [tabela, setTabela] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  if (error) return <p className="artifact-render-warning">{error}</p>;
  if (!spec) return <p className="artifact-render-loading">Montando o gráfico…</p>;

  const visiveis = spec.series.filter((serie) => !ocultas.has(serie.name));
  const desenhavel: ChartSpec = { ...spec, series: visiveis.length > 0 ? visiveis : spec.series };
  const corDe = (nome: string) => `var(--serie-${(spec.series.findIndex((s) => s.name === nome) % MAX_SERIES) + 1})`;

  return (
    <div className="chart">
      <div className="chart-cabecalho">
        <div>
          {spec.title ? <h4 className="chart-titulo">{spec.title}</h4> : null}
          {spec.series.length === 1 ? <p className="chart-subtitulo">{spec.series[0].name}</p> : null}
        </div>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setTabela((atual) => !atual)}
          aria-pressed={tabela}
        >
          <Table2 size={15} aria-hidden="true" />
          {tabela ? 'Ver gráfico' : 'Ver tabela'}
        </button>
      </div>

      {tabela ? (
        <ChartTable spec={spec} />
      ) : spec.type === 'pie' ? (
        <PieChart spec={desenhavel} corDe={corDe} />
      ) : (
        <CartesianChart
          spec={desenhavel}
          tipo={spec.type}
          corDe={corDe}
          foco={foco}
          setFoco={setFoco}
          svgRef={svgRef}
        />
      )}

      {/* Legenda a partir de duas séries; com uma, o subtítulo já nomeia. */}
      {!tabela && spec.type !== 'pie' && spec.series.length >= 2 ? (
        <ul className="chart-legenda">
          {spec.series.map((serie) => {
            const oculta = ocultas.has(serie.name);
            return (
              <li key={serie.name}>
                <button
                  type="button"
                  className="chart-legenda-item"
                  data-oculta={oculta || undefined}
                  aria-pressed={!oculta}
                  onClick={() => setOcultas((atuais) => {
                    const proximas = new Set(atuais);
                    if (proximas.has(serie.name)) proximas.delete(serie.name);
                    // Esconder a última série deixaria um gráfico vazio.
                    else if (atuais.size < spec.series.length - 1) proximas.add(serie.name);
                    return proximas;
                  })}
                >
                  <span className="chart-legenda-marca" style={{ background: corDe(serie.name) }} />
                  {serie.name}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {notes.map((nota) => <p className="chart-nota" key={nota}>{nota}</p>)}
    </div>
  );
}

function CartesianChart({
  spec, tipo, corDe, foco, setFoco, svgRef,
}: {
  spec: ChartSpec;
  tipo: 'bar' | 'line' | 'area';
  corDe: (nome: string) => string;
  foco: Foco | null;
  setFoco: (foco: Foco | null) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const largura = LARGURA_BASE;
  const plotL = largura - MARGEM.esquerda - MARGEM.direita;
  const plotA = ALTURA - MARGEM.topo - MARGEM.baixo;
  const { min, max } = valueExtent(spec);
  const marcas = niceTicks(min, max);
  const escalaMin = Math.min(...marcas);
  const escalaMax = Math.max(...marcas);
  const y = (valor: number) =>
    MARGEM.topo + plotA - ((valor - escalaMin) / (escalaMax - escalaMin || 1)) * plotA;
  const faixa = plotL / Math.max(1, spec.x.length);
  const centroX = (indice: number) => MARGEM.esquerda + faixa * (indice + 0.5);

  const aoMover = (evento: React.PointerEvent<SVGSVGElement>) => {
    const caixa = svgRef.current?.getBoundingClientRect();
    if (!caixa) return;
    const px = ((evento.clientX - caixa.left) / caixa.width) * largura;
    const indice = Math.max(0, Math.min(spec.x.length - 1, Math.floor((px - MARGEM.esquerda) / faixa)));
    setFoco({ indice, x: centroX(indice), y: MARGEM.topo });
  };

  return (
    <div className="chart-palco">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${largura} ${ALTURA}`}
        className="chart-svg"
        role="img"
        aria-label={spec.title ?? 'Gráfico'}
        onPointerMove={aoMover}
        onPointerLeave={() => setFoco(null)}
      >
        {/* Grade sólida e recessiva: tracejado leria como projeção. */}
        {marcas.map((marca) => (
          <g key={marca}>
            <line className="chart-grade" x1={MARGEM.esquerda} x2={largura - MARGEM.direita} y1={y(marca)} y2={y(marca)} />
            <text className="chart-tick" x={MARGEM.esquerda - 8} y={y(marca)} textAnchor="end" dominantBaseline="central">
              {formatValue(marca)}
            </text>
          </g>
        ))}

        {foco ? <line className="chart-crosshair" x1={foco.x} x2={foco.x} y1={MARGEM.topo} y2={MARGEM.topo + plotA} /> : null}

        {tipo === 'bar' ? (
          spec.x.map((_, indice) => {
            const series = spec.series;
            const larguraGrupo = Math.min(faixa - 10, BARRA_MAXIMA * series.length + VAO * (series.length - 1));
            const larguraBarra = spec.stacked
              ? Math.min(BARRA_MAXIMA, faixa - 10)
              : (larguraGrupo - VAO * (series.length - 1)) / series.length;
            let acumulado = 0;
            return series.map((serie, s) => {
              const valor = serie.values[indice];
              const base = spec.stacked ? acumulado : 0;
              acumulado += Math.max(0, valor);
              const topo = spec.stacked ? y(base + Math.max(0, valor)) : y(Math.max(valor, escalaMin));
              const fundo = spec.stacked ? y(base) : y(Math.max(0, escalaMin));
              const x = spec.stacked
                ? centroX(indice) - larguraBarra / 2
                : centroX(indice) - larguraGrupo / 2 + s * (larguraBarra + VAO);
              const altura = Math.max(0, fundo - topo - (spec.stacked && s > 0 ? VAO : 0));
              return (
                <path
                  key={`${serie.name}-${indice}`}
                  className="chart-barra"
                  d={barPath(x, topo, larguraBarra, altura)}
                  fill={corDe(serie.name)}
                />
              );
            });
          })
        ) : (
          spec.series.map((serie) => {
            const pontos = serie.values.map((valor, indice) => `${centroX(indice)},${y(valor)}`).join(' ');
            const area = `M ${centroX(0)},${y(Math.max(0, escalaMin))} L ${pontos.split(' ').join(' L ')} `
              + `L ${centroX(serie.values.length - 1)},${y(Math.max(0, escalaMin))} Z`;
            return (
              <g key={serie.name}>
                {tipo === 'area' ? <path className="chart-area" d={area} fill={corDe(serie.name)} /> : null}
                <polyline className="chart-linha" points={pontos} stroke={corDe(serie.name)} />
                {/* Marcador só no ponto em foco: um ponto em cada valor vira
                    ruído numa série longa. Anel na cor da superfície. */}
                {foco ? (
                  <circle
                    className="chart-marcador"
                    cx={centroX(foco.indice)}
                    cy={y(serie.values[foco.indice])}
                    r={5}
                    fill={corDe(serie.name)}
                  />
                ) : null}
              </g>
            );
          })
        )}

        {spec.x.map((rotulo, indice) => (
          // Um rótulo a cada N quando são muitos: sobrepostos, não se lê nenhum.
          indice % Math.ceil(spec.x.length / 8) === 0 ? (
            <text key={rotulo + indice} className="chart-tick" x={centroX(indice)} y={ALTURA - MARGEM.baixo + 18} textAnchor="middle">
              {rotulo.length > 10 ? `${rotulo.slice(0, 9)}…` : rotulo}
            </text>
          ) : null
        ))}
        {spec.yLabel ? (
          <text className="chart-eixo-rotulo" transform={`translate(12 ${MARGEM.topo + plotA / 2}) rotate(-90)`} textAnchor="middle">
            {spec.yLabel}
          </text>
        ) : null}
        {spec.xLabel ? (
          <text className="chart-eixo-rotulo" x={MARGEM.esquerda + plotL / 2} y={ALTURA - 4} textAnchor="middle">
            {spec.xLabel}
          </text>
        ) : null}
      </svg>

      {foco ? (
        <div
          className="chart-tooltip"
          style={{ left: `${(foco.x / largura) * 100}%`, top: 8 }}
          role="status"
        >
          <strong>{spec.x[foco.indice]}</strong>
          {spec.series.map((serie) => (
            <span key={serie.name}>
              <i style={{ background: corDe(serie.name) }} aria-hidden="true" />
              {serie.name}
              <b className="num">{formatValue(serie.values[foco.indice])}</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PieChart({ spec, corDe }: { spec: ChartSpec; corDe: (nome: string) => string }) {
  const fatias = pieSlices(spec);
  const [foco, setFoco] = useState<number | null>(null);
  const cx = 150;
  const cy = 150;
  if (fatias.length === 0) return <p className="artifact-render-warning">O gráfico não tem valores positivos para dividir.</p>;

  return (
    <div className="chart-pizza">
      <svg viewBox="0 0 300 300" className="chart-svg-pizza" role="img" aria-label={spec.title ?? 'Gráfico de pizza'}>
        {fatias.map((fatia, indice) => (
          <path
            key={fatia.label}
            /* Rosca, não pizza cheia: o furo dá onde encostar o olho e evita
               a ponta fina no centro, que é onde o ângulo engana mais. */
            d={arcPath(cx, cy, foco === indice ? 122 : 118, fatia.startAngle, fatia.endAngle, 62)}
            fill={`var(--serie-${(fatia.colorIndex % MAX_SERIES) + 1})`}
            className="chart-fatia"
            onPointerEnter={() => setFoco(indice)}
            onPointerLeave={() => setFoco(null)}
          >
            <title>{`${fatia.label}: ${formatValue(fatia.value)} (${fatia.percent.toFixed(1)}%)`}</title>
          </path>
        ))}
        {foco !== null ? (
          <>
            <text className="chart-pizza-valor" x={cx} y={cy - 6} textAnchor="middle">{formatValue(fatias[foco].value)}</text>
            <text className="chart-pizza-rotulo" x={cx} y={cy + 16} textAnchor="middle">{fatias[foco].label}</text>
          </>
        ) : null}
      </svg>
      <ul className="chart-legenda chart-legenda-pizza">
        {fatias.map((fatia) => (
          <li key={fatia.label}>
            <span className="chart-legenda-item" data-estatico>
              <span className="chart-legenda-marca" style={{ background: `var(--serie-${(fatia.colorIndex % MAX_SERIES) + 1})` }} />
              {fatia.label}
              <b className="num">{fatia.percent.toFixed(1)}%</b>
            </span>
          </li>
        ))}
      </ul>
      <span className="chart-legenda-marca" hidden style={{ background: corDe(spec.series[0].name) }} />
    </div>
  );
}

/** Os mesmos dados em tabela — é o alívio exigido pelo aviso de contraste. */
function ChartTable({ spec }: { spec: ChartSpec }) {
  return (
    <div className="chart-tabela">
      <table>
        <thead>
          <tr>
            <th scope="col">{spec.xLabel ?? 'Categoria'}</th>
            {spec.series.map((serie) => <th scope="col" key={serie.name}>{serie.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {spec.x.map((rotulo, indice) => (
            <tr key={rotulo + indice}>
              <th scope="row">{rotulo}</th>
              {spec.series.map((serie) => (
                <td className="num" key={serie.name}>{formatValue(serie.values[indice])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
