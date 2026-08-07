import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, MessageCircleQuestion, Minus, Plus } from 'lucide-react';
import { collectIds, layoutMindmap, linkPath, parseMindmap, pathTo } from '../render/mindmap';
import { useChatStore } from '../store/chat';

/**
 * Mapa mental interativo.
 *
 * Interativo aqui quer dizer três coisas concretas: **recolher um ramo**
 * (mapa grande só se lê escondendo o que não interessa agora), **arrastar** e
 * **aproximar**. Sem as três, seria uma figura — e figura o `mermaid` já
 * desenhava.
 *
 * Clicar num nó **não** recolhe direto: abre um cartão perguntando o que
 * fazer com aquele tópico — explicar ou recolher. O motivo é que as duas
 * ações competem pelo mesmo alvo, e a mais cara das duas (mandar uma
 * pergunta, que gasta tokens) não pode acontecer por engano. O cartão também
 * é onde o usuário lê o caminho do tópico antes de perguntar.
 *
 * SVG desenhado à mão, sem biblioteca de grafo. O layout é uma árvore
 * horizontal de altura fixa, uns cem números para calcular; d3 ou similar
 * traria um megabyte para resolver problemas (colisão, força, arestas
 * cruzadas) que uma árvore não tem.
 */

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;
const MARGEM = 28;

type MindmapViewProps = {
  readonly content: string;
  /** Streaming: recolher enquanto o texto ainda chega atrapalharia. */
  readonly streaming?: boolean;
};

export function MindmapView({ content, streaming = false }: MindmapViewProps) {
  const raiz = useMemo(() => parseMindmap(content), [content]);
  const [colapsados, setColapsados] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [deslocamento, setDeslocamento] = useState({ x: MARGEM, y: MARGEM });
  const arrasto = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const palcoRef = useRef<HTMLDivElement>(null);
  /** Nó cujo cartão de ações está aberto. */
  const [escolhido, setEscolhido] = useState<string | null>(null);

  // O envio vem do store direto, e não por callback do renderizador: entre
  // este componente e o chat há o painel e o ArtifactRenderer, e passar a
  // função por eles só para chegar aqui atravessaria duas camadas que não têm
  // nada a ver com o assunto.
  const sendMessage = useChatStore((state) => state.sendMessage);
  const isStreamingChat = useChatStore((state) => state.isStreaming);

  const layout = useMemo(() => layoutMindmap(raiz, colapsados), [raiz, colapsados]);

  const alternar = useCallback((id: string) => {
    setColapsados((atuais) => {
      const proximos = new Set(atuais);
      if (proximos.has(id)) proximos.delete(id);
      else proximos.add(id);
      return proximos;
    });
  }, []);

  /** Enquadra o mapa inteiro na área visível. */
  const ajustar = useCallback(() => {
    const palco = palcoRef.current;
    if (!palco || layout.width === 0) return;
    const escala = Math.min(
      (palco.clientWidth - MARGEM * 2) / layout.width,
      (palco.clientHeight - MARGEM * 2) / layout.height,
      1,
    );
    const usada = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, escala));
    setZoom(usada);
    setDeslocamento({
      x: (palco.clientWidth - layout.width * usada) / 2,
      y: (palco.clientHeight - layout.height * usada) / 2,
    });
  }, [layout.width, layout.height]);

  // Enquadra ao abrir e enquanto o mapa cresce durante o streaming: um mapa
  // que nasce fora da tela parece um mapa quebrado.
  useEffect(() => { ajustar(); }, [ajustar]);

  const aoRolar = (evento: React.WheelEvent) => {
    evento.preventDefault();
    setZoom((atual) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, atual * (evento.deltaY < 0 ? 1.1 : 0.9))));
  };

  const aoPressionar = (evento: React.PointerEvent) => {
    // Só o fundo arrasta; sobre um nó o clique é para recolher.
    if ((evento.target as Element).closest('[data-no]')) return;
    // Clique no fundo fecha o cartão, como em qualquer menu.
    setEscolhido(null);
    arrasto.current = { x: evento.clientX, y: evento.clientY, ox: deslocamento.x, oy: deslocamento.y };
    (evento.currentTarget as Element).setPointerCapture(evento.pointerId);
  };

  const aoMover = (evento: React.PointerEvent) => {
    if (!arrasto.current) return;
    setDeslocamento({
      x: arrasto.current.ox + (evento.clientX - arrasto.current.x),
      y: arrasto.current.oy + (evento.clientY - arrasto.current.y),
    });
  };

  const aoSoltar = () => { arrasto.current = null; };

  const perguntar = (id: string) => {
    const caminho = pathTo(raiz, id);
    const alvo = caminho.at(-1);
    if (!alvo) return;
    // O caminho entra como contexto porque o modelo não viu o mapa: um rótulo
    // solto como "Retropropagação" é ambíguo fora dele.
    const contexto = caminho.length > 1 ? ` (dentro de ${caminho.slice(0, -1).join(' › ')})` : '';
    setEscolhido(null);
    void sendMessage(`Explique em detalhe o tópico "${alvo}"${contexto} do mapa mental.`);
  };

  // Escape fecha o cartão: é o que a tecla faz em todo lugar do sistema.
  useEffect(() => {
    if (!escolhido) return;
    const aoTeclar = (evento: KeyboardEvent) => { if (evento.key === 'Escape') setEscolhido(null); };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [escolhido]);

  if (!raiz) {
    return <p className="artifact-render-warning">Este mapa ainda não tem conteúdo legível. A fonte está na aba Fonte.</p>;
  }

  const total = collectIds(raiz).length;
  const recolhidos = colapsados.size;

  return (
    <div className="mindmap">
      <div className="mindmap-barra">
        <span className="mindmap-contagem">
          <span className="num">{total}</span> {total === 1 ? 'tópico' : 'tópicos'}
          {recolhidos > 0 ? <> · <span className="num">{recolhidos}</span> recolhido{recolhidos === 1 ? '' : 's'}</> : null}
        </span>
        <span className="mindmap-acoes">
          {recolhidos > 0 ? (
            <button type="button" className="btn btn-quiet" onClick={() => setColapsados(new Set())}>
              Expandir tudo
            </button>
          ) : null}
          <button type="button" className="btn btn-icon" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z * 0.85))} aria-label="Afastar">
            <Minus size={15} />
          </button>
          <button type="button" className="btn btn-icon" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.18))} aria-label="Aproximar">
            <Plus size={15} />
          </button>
          <button type="button" className="btn btn-icon" onClick={ajustar} aria-label="Enquadrar o mapa" title="Enquadrar">
            <Maximize2 size={15} />
          </button>
        </span>
      </div>

      <div
        className="mindmap-palco"
        ref={palcoRef}
        onWheel={aoRolar}
        onPointerDown={aoPressionar}
        onPointerMove={aoMover}
        onPointerUp={aoSoltar}
        onPointerCancel={aoSoltar}
      >
        <svg width="100%" height="100%" role="img" aria-label={`Mapa mental: ${raiz.label}`}>
          <g transform={`translate(${deslocamento.x} ${deslocamento.y}) scale(${zoom})`}>
            {layout.links.map((ligacao) => (
              <path
                key={`${ligacao.from.id}-${ligacao.to.id}`}
                className="mindmap-ligacao"
                d={linkPath(ligacao.from, ligacao.to)}
              />
            ))}
            {layout.nodes.map((node) => {
              const temFilhos = node.childCount > 0;
              return (
                <g
                  key={node.id}
                  data-no
                  data-nivel={Math.min(node.depth, 3)}
                  data-colapsado={node.collapsed || undefined}
                  className="mindmap-no"
                  transform={`translate(${node.x} ${node.y})`}
                  onClick={() => { if (!streaming) setEscolhido(node.id); }}
                  onKeyDown={(evento) => {
                    if (!streaming && (evento.key === 'Enter' || evento.key === ' ')) {
                      evento.preventDefault();
                      setEscolhido(node.id);
                    }
                  }}
                  // Todo nó é alcançável por teclado agora, não só os que têm
                  // filhos: folha não recolhe, mas tem o que explicar.
                  tabIndex={streaming ? -1 : 0}
                  role="button"
                  aria-haspopup="menu"
                  aria-expanded={escolhido === node.id}
                >
                  <rect width={node.width} height={node.height} rx={9} />
                  <text x={13} y={node.height / 2} dominantBaseline="central">
                    {node.label.length > 32 ? `${node.label.slice(0, 31)}…` : node.label}
                  </text>
                  {/* O contador só aparece recolhido: aberto, os filhos estão
                      à vista e o número seria uma informação repetida. */}
                  {temFilhos && node.collapsed ? (
                    <g className="mindmap-contador" transform={`translate(${node.width - 8} ${node.height / 2})`}>
                      <circle r={11} />
                      <text dominantBaseline="central" textAnchor="middle">{node.childCount}</text>
                    </g>
                  ) : null}
                  {/* Título completo no hover, já que o rótulo pode ser cortado. */}
                  <title>{node.label}</title>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Cartão de ações do tópico escolhido.
            Fica FORA do <svg>, em HTML: dentro dele precisaria de
            foreignObject, e botão dentro de foreignObject perde foco e
            tabulação em parte dos navegadores. A posição acompanha o nó
            aplicando a mesma transformação do palco. */}
        {(() => {
          if (!escolhido) return null;
          const node = layout.nodes.find((item) => item.id === escolhido);
          if (!node) return null;
          const caminho = pathTo(raiz, node.id);
          return (
            <div
              className="mindmap-acoes-no"
              role="menu"
              aria-label={`Ações para ${node.label}`}
              style={{
                left: deslocamento.x + (node.x + node.width) * zoom + 10,
                top: deslocamento.y + node.y * zoom,
              }}
              // O clique não pode subir até o palco, que interpretaria como
              // início de arrasto.
              onPointerDown={(evento) => evento.stopPropagation()}
            >
              <p className="mindmap-acoes-titulo">{node.label}</p>
              {caminho.length > 1 ? (
                <p className="mindmap-acoes-caminho">{caminho.slice(0, -1).join(' › ')}</p>
              ) : null}
              <button
                type="button"
                className="btn btn-primary"
                role="menuitem"
                onClick={() => perguntar(node.id)}
                disabled={isStreamingChat}
              >
                <MessageCircleQuestion size={15} aria-hidden="true" />
                {isStreamingChat ? 'Aguarde a resposta…' : 'Explicar este tópico'}
              </button>
              {node.childCount > 0 ? (
                <button
                  type="button"
                  className="btn btn-quiet"
                  role="menuitem"
                  onClick={() => { alternar(node.id); setEscolhido(null); }}
                >
                  {node.collapsed ? 'Abrir ramo' : 'Recolher ramo'}
                </button>
              ) : null}
            </div>
          );
        })()}
      </div>
      <p className="mindmap-dica">Clique num tópico para explicar ou recolher · arraste para mover · role para aproximar</p>
    </div>
  );
}
