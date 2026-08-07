import { useMemo } from 'react';
import { encurtar, meiaLarguraDe, paraSvg, parseTikz, pontoDoRotulo, tikzBounds, UNIDADE } from './tikz';

/**
 * Figura TikZ desenhada na prévia.
 *
 * Quando o desenho não pode ser reconstruído, cai no cartão com a legenda —
 * dizer "há uma figura aqui, e ela mostra isto" é honesto; desenhar meia
 * figura seria pior que não desenhar, porque o leitor não teria como saber
 * que está vendo um pedaço.
 *
 * As cores saem dos tokens do app, e não do que o TikZ eventualmente declare:
 * a figura precisa funcionar nos dois temas, e o LaTeX foi escrito sem saber
 * em qual deles seria lido.
 */

type TikzViewProps = {
  readonly source: string;
  readonly caption?: string | null;
};

// A meia largura vem do módulo de geometria: se o desenho usasse uma conta e
// o posicionamento outra, os nós encostariam de novo.
const meiaLargura = meiaLarguraDe;

const MEIA_ALTURA = 0.34;

export function TikzView({ source, caption }: TikzViewProps) {
  const figura = useMemo(() => parseTikz(source), [source]);
  const limites = useMemo(() => (figura ? tikzBounds(figura) : null), [figura]);

  if (!figura || !limites) {
    return (
      <figure className="tikz-figura tikz-figura-vazia">
        <p className="artifact-render-warning">
          Figura em TikZ que a prévia não conseguiu desenhar{caption ? ` — ${caption}` : ''}.
          Ela aparece ao compilar o LaTeX; a fonte está na aba Fonte.
        </p>
      </figure>
    );
  }

  const marcador = `seta-${Math.abs(source.length * 31 + figura.nodes.length)}`;

  return (
    <figure className="tikz-figura">
      <svg
        className="tikz-svg"
        viewBox={`${limites.minX} ${limites.minY} ${limites.width} ${limites.height}`}
        style={{ maxWidth: `${Math.min(680, limites.width)}px` }}
        role="img"
        aria-label={caption ?? 'Figura'}
      >
        <defs>
          <marker id={marcador} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="tikz-ponta" />
          </marker>
        </defs>

        {figura.shapes.map((forma, indice) => {
          if (forma.kind === 'circle') {
            const centro = paraSvg(forma.x, forma.y);
            return <circle key={indice} className="tikz-traco" data-tracejado={forma.dashed || undefined}
              cx={centro.x} cy={centro.y} r={forma.x2 * UNIDADE} />;
          }
          const a = paraSvg(forma.x, forma.y);
          const b = paraSvg(forma.x2, forma.y2);
          return <rect key={indice} className="tikz-traco" data-tracejado={forma.dashed || undefined}
            x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)}
            width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} rx={4} />;
        })}

        {figura.edges.map((aresta, indice) => {
          const de = paraSvg(aresta.from.x, aresta.from.y);
          const para = paraSvg(aresta.to.x, aresta.to.y);
          // Recuo pela borda do nó de destino, quando há um ali: a ponta da
          // seta escondida sob o retângulo faz a linha parecer sumir.
          const alvo = figura.nodes.find((node) =>
            Math.abs(node.x - aresta.to.x) < 0.01 && Math.abs(node.y - aresta.to.y) < 0.01);
          const recuo = alvo ? meiaLargura(alvo.label) * UNIDADE * 0.9 : 4;
          const fim = encurtar(de, para, recuo);
          const meio = pontoDoRotulo(de, fim);
          return (
            <g key={indice}>
              <line
                className="tikz-traco"
                data-tracejado={aresta.dashed || undefined}
                x1={de.x} y1={de.y} x2={fim.x} y2={fim.y}
                markerEnd={aresta.arrow !== 'none' ? `url(#${marcador})` : undefined}
                markerStart={aresta.arrow === 'both' ? `url(#${marcador})` : undefined}
              />
              {aresta.label ? (
                <text className="tikz-rotulo-aresta" x={meio.x} y={meio.y} textAnchor="middle" dominantBaseline="central">{aresta.label}</text>
              ) : null}
            </g>
          );
        })}

        {figura.nodes.map((node, indice) => {
          const centro = paraSvg(node.x, node.y);
          const largura = meiaLargura(node.label) * UNIDADE * 2;
          const altura = MEIA_ALTURA * UNIDADE * 2;
          return (
            <g key={node.id ?? `n${indice}`}>
              {node.shape === 'circle' ? (
                <circle className="tikz-no" data-tracejado={node.dashed || undefined}
                  cx={centro.x} cy={centro.y} r={Math.max(largura, altura) / 2} />
              ) : node.shape === 'rectangle' ? (
                <rect className="tikz-no" data-tracejado={node.dashed || undefined}
                  x={centro.x - largura / 2} y={centro.y - altura / 2}
                  width={largura} height={altura} rx={6} />
              ) : null}
              {node.label ? (
                <text className="tikz-rotulo" x={centro.x} y={centro.y} textAnchor="middle" dominantBaseline="central">
                  {node.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {caption ? <figcaption>{caption}</figcaption> : null}
      {/* Franqueza sobre o que ficou de fora: uma figura desenhada pela metade
          sem aviso é pior do que uma figura não desenhada. */}
      {figura.skipped.length > 0 ? (
        <p className="tikz-aviso">
          <span className="num">{figura.skipped.length}</span>{' '}
          {figura.skipped.length === 1 ? 'comando não foi desenhado' : 'comandos não foram desenhados'}; a figura
          completa aparece ao compilar o LaTeX.
        </p>
      ) : null}
    </figure>
  );
}
