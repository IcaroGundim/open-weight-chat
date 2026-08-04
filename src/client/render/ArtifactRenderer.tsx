import { useEffect, useMemo, useState } from 'react';
import { Markdown } from './Markdown';
import { normalizeCodeLanguage } from './highlighter';
import { svgToDataUrl } from './sanitize-svg';
import { useSettingsStore } from '../store/settings';
import type { ArtifactKind } from '../types';

const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_VISUAL_BYTES = 128 * 1024;

type ArtifactRendererProps = {
  kind: ArtifactKind;
  content: string;
  language?: string | null;
  mode?: 'view' | 'source';
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function MermaidRenderer({ content }: { content: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const theme = useSettingsStore((state) => state.theme);
  const id = useMemo(() => `artifact-mermaid-${Math.random().toString(36).slice(2)}`, []);

  useEffect(() => {
    setDataUrl(null);
    setFailed(false);
    if (byteLength(content) > MAX_VISUAL_BYTES) {
      setFailed(true);
      return;
    }
    let active = true;
    void import('mermaid').then(async ({ default: mermaid }) => {
      const styles = getComputedStyle(document.documentElement);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'base',
        themeVariables: {
          background: styles.getPropertyValue('--paper').trim(),
          primaryColor: styles.getPropertyValue('--surface').trim(),
          primaryTextColor: styles.getPropertyValue('--ink').trim(),
          primaryBorderColor: styles.getPropertyValue('--rule-strong').trim(),
          lineColor: styles.getPropertyValue('--wine').trim(),
          secondaryColor: styles.getPropertyValue('--surface-2').trim(),
          tertiaryColor: styles.getPropertyValue('--wine-tint').trim(),
        },
      });
      const result = await mermaid.render(id, content);
      const nextUrl = svgToDataUrl(result.svg);
      if (active) {
        setDataUrl(nextUrl);
        setFailed(!nextUrl);
      }
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [content, id, theme]);

  if (failed) return <p className="artifact-render-warning">Este diagrama excede o limite seguro ou não pôde ser renderizado. Use a aba Fonte.</p>;
  if (!dataUrl) return <span className="artifact-render-loading">Renderizando diagrama…</span>;
  return <img className="artifact-svg-image" src={dataUrl} alt="Diagrama Mermaid renderizado" />;
}

function sourceView(kind: ArtifactKind, content: string, language?: string | null) {
  if (kind === 'code') {
    const normalized = normalizeCodeLanguage(language ?? undefined) ?? language?.trim() ?? '';
    return <Markdown source={`\`\`\`${normalized}\n${content}\n\`\`\``} />;
  }
  return <pre className="artifact-source"><code>{content}</code></pre>;
}

export function ArtifactRenderer({ kind, content, language, mode = 'view' }: ArtifactRendererProps) {
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

  if (kind === 'markdown') return <Markdown source={content} />;
  if (kind === 'code') return sourceView(kind, content, language);
  if (kind === 'svg') {
    const dataUrl = svgToDataUrl(content);
    return dataUrl
      ? <img className="artifact-svg-image" src={dataUrl} alt="Artefato SVG renderizado" />
      : <p className="artifact-render-warning">Este SVG não passou pela sanitização. Use a aba Fonte.</p>;
  }
  return <MermaidRenderer content={content} />;
}
