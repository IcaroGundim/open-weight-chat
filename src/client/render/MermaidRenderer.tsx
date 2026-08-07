import { useEffect, useMemo, useState } from 'react';
import { svgToDataUrl } from './sanitize-svg';
import { useSettingsStore } from '../store/settings';

/**
 * Diagrama Mermaid renderizado para imagem.
 *
 * Extraído do renderizador de artefatos porque passou a ter dois consumidores:
 * o artefato de tipo `mermaid` e as cercas ```mermaid dentro do texto — que é
 * como uma ilustração chega num documento em Markdown. Enquanto vivia lá
 * dentro, uma cerca dessas aparecia como bloco de código, e a figura que o
 * agente ilustrador desenhou não existia para o leitor.
 *
 * A saída é uma imagem (data URI) e não SVG injetado no DOM: o conteúdo vem de
 * um modelo, e `svgToDataUrl` é quem passa isso pela sanitização.
 */

const MAX_VISUAL_BYTES = 128 * 1024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function MermaidRenderer({ content }: { content: string }) {
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
