import { useMemo } from 'react';
import { Markdown } from './Markdown';
import { normalizeCodeLanguage } from './highlighter';
import { svgToDataUrl } from './sanitize-svg';
import { MermaidRenderer } from './MermaidRenderer';
import { isLatexLanguage, latexToMarkdown } from './latex-to-markdown';
import { MindmapView } from '../components/MindmapView';
import { ChartView } from '../components/ChartView';
import type { ArtifactKind } from '../types';

const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_VISUAL_BYTES = 128 * 1024;

type ArtifactRendererProps = {
  kind: ArtifactKind;
  content: string;
  language?: string | null;
  mode?: 'view' | 'source';
  /**
   * O mapa não deixa recolher enquanto o texto ainda chega: a árvore é
   * remontada a cada pedaço, e um ramo recolhido pelo usuário reapareceria
   * aberto no quadro seguinte.
   */
  streaming?: boolean;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Prévia de um documento LaTeX.
 *
 * É prévia, e o rótulo diz isso: a conversão cobre estrutura e fórmulas, não
 * compila TeX. O que não foi convertido aparece listado em vez de sumir em
 * silêncio — um documento que usa TikZ precisa dizer que o desenho não está
 * ali, senão o usuário confia numa página incompleta.
 */
function LatexPreview({ content }: { content: string }) {
  const doc = useMemo(() => latexToMarkdown(content), [content]);
  const cabecalho = [
    doc.title ? `# ${doc.title}` : '',
    doc.author ? `*${doc.author}*` : '',
  ].filter(Boolean).join('\n\n');

  return (
    <div className="latex-preview">
      <Markdown source={cabecalho ? `${cabecalho}\n\n${doc.markdown}` : doc.markdown} />
      {doc.unsupported.length > 0 ? (
        <p className="artifact-render-warning">
          Prévia aproximada: {doc.unsupported.slice(0, 6).join(', ')}
          {doc.unsupported.length > 6 ? ` e mais ${doc.unsupported.length - 6}` : ''}
          {' '}não {doc.unsupported.length === 1 ? 'foi convertido' : 'foram convertidos'}. A fonte está completa na aba Fonte.
        </p>
      ) : null}
    </div>
  );
}

function sourceView(kind: ArtifactKind, content: string, language?: string | null) {
  if (kind === 'code') {
    const normalized = normalizeCodeLanguage(language ?? undefined) ?? language?.trim() ?? '';
    return <Markdown source={`\`\`\`${normalized}\n${content}\n\`\`\``} />;
  }
  return <pre className="artifact-source"><code>{content}</code></pre>;
}

export function ArtifactRenderer({ kind, content, language, mode = 'view', streaming = false }: ArtifactRendererProps) {
  const tooLarge = byteLength(content) > MAX_ARTIFACT_BYTES;
  const visualTooLarge = (kind === 'svg' || kind === 'mermaid') && byteLength(content) > MAX_VISUAL_BYTES;
  if (mode === 'source' || tooLarge || visualTooLarge) {
    return (
      <div className="artifact-render-source-wrap">
        {tooLarge || visualTooLarge ? <p className="artifact-render-warning">O conteúdo excede o limite de visualização. A fonte continua disponível para inspeção.</p> : null}
        {sourceView(kind, content, language)}
      </div>
    );
  }

  if (kind === 'mindmap') return <MindmapView content={content} streaming={streaming} />;
  if (kind === 'chart') return <ChartView content={content} />;
  if (kind === 'markdown') return <Markdown source={content} />;
  if (kind === 'code') {
    return isLatexLanguage(language) ? <LatexPreview content={content} /> : sourceView(kind, content, language);
  }
  if (kind === 'svg') {
    const dataUrl = svgToDataUrl(content);
    return dataUrl
      ? <img className="artifact-svg-image" src={dataUrl} alt="Artefato SVG renderizado" />
      : <p className="artifact-render-warning">Este SVG não passou pela sanitização. Use a aba Fonte.</p>;
  }
  return <MermaidRenderer content={content} />;
}
