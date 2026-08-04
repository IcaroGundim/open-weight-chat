import { FileCode2, FileText, GitBranch, Image, PanelRightOpen } from 'lucide-react';
import { useChatStore } from '../store/chat';
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
};

function iconFor(kind?: ArtifactKind) {
  if (kind === 'code') return FileCode2;
  if (kind === 'svg') return Image;
  if (kind === 'mermaid') return GitBranch;
  return FileText;
}

function lineCount(content: string): number {
  return content ? content.split('\n').length : 0;
}

export function ArtifactCard({ slug, versionNumber, artifact }: ArtifactCardProps) {
  const openArtifact = useChatStore((state) => state.openArtifact);
  const conversationId = useChatStore((state) => state.activeConversationId);
  const streamingContent = useChatStore((state) => conversationId ? state.streamingArtifacts[`${conversationId}:${slug}`] : undefined);
  const version: ArtifactVersion | undefined = artifact?.versions.find((item) => item.version === versionNumber);
  const content = streamingContent ?? version?.content ?? '';
  const Icon = iconFor(artifact?.kind);
  const isStreaming = streamingContent !== undefined;

  return (
    <div className="artifact-card" data-artifact-slug={slug}>
      <div className="artifact-card-icon"><Icon size={16} aria-hidden="true" /></div>
      <div className="artifact-card-copy">
        <strong>{artifact?.title ?? slug}</strong>
        <span>{artifact ? kindLabels[artifact.kind] : 'Artefato'}{artifact?.language ? ` · ${artifact.language}` : ''}</span>
      </div>
      <div className="artifact-card-metrics">
        {isStreaming ? <span className="artifact-card-dots" aria-label="Artefato sendo gerado"><i /><i /><i /></span> : <span className="num">v{versionNumber}</span>}
        <span className="num">{lineCount(content)} linhas</span>
      </div>
      <button
        type="button"
        className="btn btn-icon artifact-card-open"
        onClick={() => openArtifact({ slug, version: versionNumber })}
        aria-label={`Abrir artefato ${artifact?.title ?? slug}`}
        title="Abrir artefato"
      >
        <PanelRightOpen size={16} />
      </button>
    </div>
  );
}

