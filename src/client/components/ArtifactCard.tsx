import { BarChart3, ChevronRight, FileCode2, FileText, GitBranch, Image, Network } from 'lucide-react';
import { useChatStore } from '../store/chat';
import { AgentOrb } from './AgentOrb';
import { ArtifactWaves } from './ArtifactWaves';
import type { Artifact, ArtifactKind, ArtifactVersion } from '../types';

type ArtifactCardProps = {
  slug: string;
  versionNumber: number;
  artifact?: Artifact;
};

const kindLabels: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  code: 'Código',
  svg: 'SVG',
  mermaid: 'Mermaid',
  mindmap: 'Mapa mental',
  chart: 'Gráfico',
};

function iconFor(kind?: ArtifactKind) {
  if (kind === 'code') return FileCode2;
  if (kind === 'svg') return Image;
  if (kind === 'mermaid') return GitBranch;
  if (kind === 'mindmap') return Network;
  if (kind === 'chart') return BarChart3;
  return FileText;
}

function lineCount(content: string): number {
  return content ? content.split('\n').length : 0;
}

export function ArtifactCard({ slug, versionNumber, artifact }: ArtifactCardProps) {
  const openArtifact = useChatStore((state) => state.openArtifact);
  const closeArtifact = useChatStore((state) => state.closeArtifact);
  const selecaoAberta = useChatStore((state) => state.openArtifactSelection);
  const conversationId = useChatStore((state) => state.activeConversationId);
  const streamingContent = useChatStore((state) => conversationId ? state.streamingArtifacts[`${conversationId}:${slug}`] : undefined);
  const version: ArtifactVersion | undefined = artifact?.versions.find((item) => item.version === versionNumber);
  const content = streamingContent ?? version?.content ?? '';
  const Icon = iconFor(artifact?.kind);
  const isStreaming = streamingContent !== undefined;
  // Reescrever do zero e aplicar um find/replace produzem uma versão nova do
  // mesmo jeito, mas custam e arriscam coisas diferentes. A operação já está
  // registrada na versão; mostrá-la enquanto o stream corre deixa claro, antes
  // de abrir o painel, se o conteúdo anterior está sendo preservado.
  const isRevision = version?.operation === 'update';

  // O cartão é um interruptor, não um gatilho: clicar de novo fecha o painel.
  // Antes ele só reabria o que já estava aberto, e o clique não devolvia
  // resposta nenhuma — parecia que o app tinha ignorado.
  const estaAberto = selecaoAberta?.slug === slug && selecaoAberta.version === versionNumber;
  const alternar = () => (estaAberto ? closeArtifact() : openArtifact({ slug, version: versionNumber }));

  // O cartão inteiro é o botão. Antes havia um botão de abrir à direita, e ele
  // era alvo redundante: não há nada mais para fazer com um cartão de artefato
  // além de abri-lo, então a caixa em volta do ícone só disputava o clique com
  // a área que o usuário já tenta clicar.
  //
  // `data-streaming` acende o feixe no contorno: o cartão vivo se distingue
  // dos demais de relance.
  return (
    <button
      type="button"
      className="artifact-card"
      data-artifact-slug={slug}
      data-streaming={isStreaming || undefined}
      onClick={alternar}
      // `aria-expanded` é o que faz o leitor de tela anunciar o estado, e é
      // por isso que o rótulo também muda: quem ouve "Abrir artefato" num
      // painel já aberto recebe a informação errada.
      aria-expanded={estaAberto}
      aria-label={`${estaAberto ? 'Fechar' : 'Abrir'} artefato ${artifact?.title ?? slug}`}
    >
      <ArtifactWaves />
      {/* Enquanto escreve, o orb ocupa o lugar do ícone do tipo. Um artefato
          em construção não precisa anunciar que é Markdown; precisa anunciar
          que ainda não acabou. */}
      <span className="artifact-card-mark">
        {isStreaming ? (
          isRevision
            ? <AgentOrb activity="revisando" label="Artefato sendo revisado" />
            : <AgentOrb activity="construindo" label="Artefato sendo gerado" />
        ) : <Icon size={17} aria-hidden="true" />}
      </span>
      <span className="artifact-card-copy">
        <strong>{artifact?.title ?? slug}</strong>
        {/* Tipo e medidas na mesma linha: separá-los em duas colunas abria um
            vão morto no meio do cartão, e o que é sobre o mesmo arquivo se lê
            junto. Mono só nos valores medidos. */}
        <span className="artifact-card-meta">
          {artifact ? kindLabels[artifact.kind] : 'Artefato'}
          {artifact?.language ? ` · ${artifact.language}` : ''}
          {' · '}<span className="num">v{versionNumber}</span>
          {' · '}<span className="num">{lineCount(content)}</span> linhas
        </span>
      </span>
      {/* Chevron, e não o ícone de painel: aquele desenha um retângulo, e um
          retângulo colado na borda de um cartão lê como um segundo botão em
          caixa — justamente a caixa que este cartão perdeu. */}
      <ChevronRight className="artifact-card-chevron" size={16} aria-hidden="true" />
    </button>
  );
}

