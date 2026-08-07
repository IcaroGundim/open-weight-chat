import { useCallback, useEffect, useRef } from 'react';
import {
  ARTIFACT_WIDTH_DEFAULT,
  ARTIFACT_WIDTH_MAX,
  ARTIFACT_WIDTH_MIN,
  clampArtifactWidth,
  useSettingsStore,
} from '../store/settings';

/**
 * Divisor entre o chat e o painel de artefato.
 *
 * Mora dentro do painel, ancorado na borda esquerda dele, e não como uma
 * quarta trilha do grid. Uma trilha própria mudaria o `grid-template-columns`
 * em três regras (aberto, barra recolhida, celular) e roubaria largura do
 * conteúdo; ancorado, ele flutua sobre a divisa e não ocupa espaço nenhum.
 *
 * A área que responde ao ponteiro é bem maior que a linha visível: a linha tem
 * 1px porque é uma divisa, mas acertar 1px com o mouse é tarefa de perícia.
 *
 * **Teclado é obrigatório aqui**, não enfeite: um alvo de arrastar é
 * intransponível para quem não usa mouse, e sem as setas o painel ficaria
 * travado na largura de fábrica para essas pessoas. Daí `role="separator"`
 * com `aria-valuenow` — o leitor de tela anuncia a largura em porcentagem.
 */

const PASSO_TECLADO = 2;
const PASSO_TECLADO_GRANDE = 8;

export function ArtifactResizer({ label = 'Largura do painel de artefato' }: { label?: string }) {
  const largura = useSettingsStore((state) => state.artifactWidth);
  const setLargura = useSettingsStore((state) => state.setArtifactWidth);
  const arrastando = useRef(false);

  /**
   * Durante o arrasto o valor vai direto para a variável CSS, sem passar pelo
   * estado: o grid tem transição de 0,22s e o React re-renderiza a árvore
   * inteira do painel a cada pixel. O estado é gravado uma vez, ao soltar.
   */
  const aplicarAoVivo = useCallback((percent: number) => {
    document.documentElement.style.setProperty('--largura-artefato', `${percent}%`);
  }, []);

  // O valor persistido comanda enquanto ninguém arrasta.
  useEffect(() => {
    if (!arrastando.current) aplicarAoVivo(largura);
  }, [largura, aplicarAoVivo]);

  const larguraDoPonteiro = (clientX: number): number =>
    clampArtifactWidth(((window.innerWidth - clientX) / window.innerWidth) * 100);

  const aoPressionar = (evento: React.PointerEvent<HTMLDivElement>) => {
    evento.preventDefault();
    arrastando.current = true;
    document.body.dataset.redimensionando = 'true';
    (evento.currentTarget as Element).setPointerCapture(evento.pointerId);
  };

  const aoMover = (evento: React.PointerEvent<HTMLDivElement>) => {
    if (!arrastando.current) return;
    aplicarAoVivo(larguraDoPonteiro(evento.clientX));
  };

  const aoSoltar = (evento: React.PointerEvent<HTMLDivElement>) => {
    if (!arrastando.current) return;
    arrastando.current = false;
    delete document.body.dataset.redimensionando;
    setLargura(larguraDoPonteiro(evento.clientX));
  };

  const aoTeclar = (evento: React.KeyboardEvent<HTMLDivElement>) => {
    const passo = evento.shiftKey ? PASSO_TECLADO_GRANDE : PASSO_TECLADO;
    // Seta para a esquerda alarga o painel: ela move a DIVISA para a
    // esquerda, e é a divisa que está sob o foco.
    if (evento.key === 'ArrowLeft') setLargura(largura + passo);
    else if (evento.key === 'ArrowRight') setLargura(largura - passo);
    else if (evento.key === 'Home') setLargura(ARTIFACT_WIDTH_MAX);
    else if (evento.key === 'End') setLargura(ARTIFACT_WIDTH_MIN);
    else return;
    evento.preventDefault();
  };

  return (
    <div
      className="artifact-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(largura)}
      aria-valuemin={ARTIFACT_WIDTH_MIN}
      aria-valuemax={ARTIFACT_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={aoPressionar}
      onPointerMove={aoMover}
      onPointerUp={aoSoltar}
      onPointerCancel={aoSoltar}
      onKeyDown={aoTeclar}
      // Duplo clique volta ao padrão: é a saída para quem arrastou longe
      // demais e não quer caçar a largura de fábrica no olho.
      onDoubleClick={() => setLargura(ARTIFACT_WIDTH_DEFAULT)}
      title="Arraste para redimensionar · duplo clique volta ao padrão"
    >
      <span className="artifact-resizer-alca" aria-hidden="true" />
    </div>
  );
}
