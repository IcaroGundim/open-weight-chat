import { Children, isValidElement, memo, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { highlightCode, normalizeCodeLanguage } from './highlighter';
import { hasMathSyntax, prepareMarkdownForRender } from './math-normalize';
import { codeSpansToMath } from './formula-code';
import { MermaidRenderer } from './MermaidRenderer';
import { TikzView } from './TikzView';
import type { StreamErrorEnvelope } from '../types';

type MarkdownProps = {
  source: string;
  streaming?: boolean;
  className?: string;
  onPromoteCode?: (code: string, language?: string) => void;
};

type CodeBlockProps = {
  code: string;
  language?: string;
  streaming: boolean;
  onPromoteCode?: (code: string, language?: string) => void;
};

function SafeLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const value = href ?? '';
  let safe = true;
  let external = false;
  try {
    const url = new URL(value, window.location.origin);
    safe = ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
    external = url.origin !== window.location.origin && ['http:', 'https:'].includes(url.protocol);
  } catch {
    safe = value.startsWith('/') || value.startsWith('#');
  }

  if (!safe) return <span className="markdown-unsafe-link">{children}</span>;
  return (
    <a
      {...props}
      href={value}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer nofollow' : undefined}
    >
      {children}
    </a>
  );
}

/**
 * Cerca ```mermaid vira figura, não bloco de código.
 *
 * É o mecanismo de ilustração de um documento em Markdown: o agente
 * ilustrador do modo Science desenha em Mermaid, e sem isto o que ele produz
 * apareceria como um monte de texto entre crases — a figura existiria no
 * arquivo e não para quem lê.
 *
 * Enquanto o texto ainda está chegando, o diagrama fica como código: um
 * Mermaid pela metade não compila, e tentar renderizar a cada pedaço faria a
 * área piscar entre erro e desenho.
 */
function isMermaidFence(language?: string): boolean {
  return (language ?? '').trim().toLowerCase() === 'mermaid';
}

function isTikzFence(language?: string): boolean {
  return (language ?? '').trim().toLowerCase() === 'tikz';
}

/**
 * A cerca ```tikz carrega a legenda na primeira linha, quando existe.
 *
 * O `\caption` do LaTeX fica fora do `tikzpicture`, e a cerca só transporta
 * um bloco de texto — a primeira linha é o lugar mais simples de pôr a
 * legenda sem inventar um formato.
 */
function separarLegenda(codigo: string): { caption: string | null; source: string } {
  const linhas = codigo.split('\n');
  const primeira = linhas[0]?.trim() ?? '';
  if (primeira && !primeira.startsWith('\\')) {
    return { caption: primeira, source: linhas.slice(1).join('\n') };
  }
  return { caption: null, source: codigo };
}

function CodeBlock({ code, language, streaming, onPromoteCode }: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = normalizeCodeLanguage(language);

  useEffect(() => {
    let cancelled = false;
    const delay = streaming ? 260 : 0;
    const timer = setTimeout(() => {
      void highlightCode(code, normalizedLanguage ?? undefined).then((html) => {
        if (!cancelled) setHighlighted(html);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, normalizedLanguage, streaming]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="markdown-code-shell">
      <div className="markdown-code-toolbar">
        <span>{normalizedLanguage ?? 'texto'}</span>
        <div className="markdown-code-actions">
          {onPromoteCode ? (
            <button type="button" className="code-promote-button" onClick={() => onPromoteCode(code, language)}>
              Abrir como artefato
            </button>
          ) : null}
          <button type="button" className="code-copy-button" onClick={() => void copy()} aria-label="Copiar código">
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      </div>
      {highlighted ? (
        <div className="markdown-code-highlight" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <pre><code>{code}</code></pre>
      )}
    </div>
  );
}

function MarkdownCode({ className, children }: Record<string, unknown>) {
  return <code className={typeof className === 'string' ? className : undefined}>{children as ReactNode}</code>;
}

function MarkdownPre({ children, streaming, onPromoteCode }: { children?: ReactNode; streaming: boolean; onPromoteCode?: (code: string, language?: string) => void }) {
  const child = Children.toArray(children)[0];
  if (isValidElement(child) && child.type === 'code') {
    const codeProps = child.props as { children?: unknown; className?: unknown };
    const code = String(codeProps.children ?? '').replace(/\n$/, '');
    const language = typeof codeProps.className === 'string'
      ? codeProps.className.replace(/^language-/, '')
      : undefined;
    if (isTikzFence(language) && !streaming) {
      const { caption, source } = separarLegenda(code);
      return <TikzView source={source} caption={caption} />;
    }
    if (isMermaidFence(language) && !streaming) {
      return (
        <figure className="markdown-figura">
          <MermaidRenderer content={code} />
        </figure>
      );
    }
    return <CodeBlock code={code} language={language} streaming={streaming} onPromoteCode={onPromoteCode} />;
  }
  return <pre>{children}</pre>;
}

type KatexPlugin = (tree: unknown, options?: unknown) => unknown;

function MarkdownRenderer({ source, streaming = false, className = '', onPromoteCode }: MarkdownProps) {
  /**
   * Fórmula escrita entre crases vira matemática ANTES de tudo.
   *
   * Precisa vir antes de `hasMathSyntax`, que é quem decide se o KaTeX é
   * carregado: convertendo depois, a conversão aconteceria e o renderizador
   * chegaria sem o plugin, deixando `$...$` cru na tela.
   */
  const fonte = useMemo(() => codeSpansToMath(source), [source]);
  const math = useMemo(() => hasMathSyntax(fonte), [fonte]);
  const [katexPlugin, setKatexPlugin] = useState<KatexPlugin | null>(null);

  useEffect(() => {
    if (!math || katexPlugin) return;
    let active = true;
    void import('rehype-katex')
      .then(async (module) => {
        await import('katex/dist/katex.min.css');
        if (active) setKatexPlugin(() => module.default as unknown as KatexPlugin);
      })
      .catch(() => {
        if (active) setKatexPlugin(null);
      });
    return () => {
      active = false;
    };
  }, [math, katexPlugin]);

  const renderedSource = useMemo(() => prepareMarkdownForRender(fonte, streaming), [fonte, streaming]);
  const components = useMemo<Components>(() => ({
    a: SafeLink,
    code: (props) => <MarkdownCode {...(props as Record<string, unknown>)} />,
    pre: (props) => <MarkdownPre {...(props as { children?: ReactNode })} streaming={streaming} onPromoteCode={onPromoteCode} />,
    input: (props) => <input {...props} disabled aria-hidden="true" />,
  }), [onPromoteCode, streaming]);

  return (
    <div className={`markdown-body ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={katexPlugin ? [[katexPlugin, { trust: false, strict: 'ignore' }] as never] : []}
        components={components}
      >
        {renderedSource}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownRenderer);

export function MarkdownError({ error }: { error: StreamErrorEnvelope }) {
  return <p className="markdown-error">{error.message ?? 'Erro ao renderizar a resposta.'}</p>;
}
