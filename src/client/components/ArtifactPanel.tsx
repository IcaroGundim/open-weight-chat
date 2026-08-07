import { Check, Copy, Download, Pencil, FileCode2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ArtifactRenderer } from '../render/ArtifactRenderer';
import { ArtifactResizer } from './ArtifactResizer';
import { isLatexLanguage } from '../render/latex-to-markdown';
import { AgentOrb } from './AgentOrb';
import { useChatStore } from '../store/chat';
import { EMPTY_ARTIFACTS, type Artifact, type ArtifactKind } from '../types';

type ArtifactPanelProps = {
  conversationId: string;
  onClose: () => void;
};

const extensions: Record<ArtifactKind, string> = {
  markdown: 'md',
  code: 'txt',
  svg: 'svg',
  mermaid: 'mmd',
  // Roteiro indentado é Markdown; a extensão diz o que o arquivo é.
  mindmap: 'md',
  // A especificação é JSON.
  chart: 'json',
};

const codeExtensions: Record<string, string> = {
  javascript: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  tsx: 'tsx',
  python: 'py',
  json: 'json',
  bash: 'sh',
  sql: 'sql',
  html: 'html',
  css: 'css',
  go: 'go',
  rust: 'rs',
  markdown: 'md',
};

function safeFilename(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'artefato';
}

function lines(content: string): number {
  return content ? content.split('\n').length : 0;
}

function extensionFor(artifact: Artifact): string {
  if (artifact.kind !== 'code') return extensions[artifact.kind];
  const language = artifact.language?.trim().toLowerCase().replace(/^language-/, '') ?? '';
  return codeExtensions[language] ?? 'txt';
}

/**
 * Código abre na fonte, porque é o que se quer ver num trecho de código.
 * LaTeX é a exceção: ali a fonte é o meio, e o documento é o fim — abrir na
 * prévia é o motivo de a prévia existir.
 */
function abaInicial(artifact?: { kind: string; language?: string | null } | null): 'view' | 'source' {
  if (artifact?.kind !== 'code') return 'view';
  return isLatexLanguage(artifact.language) ? 'view' : 'source';
}

export function ArtifactPanel({ conversationId, onClose }: ArtifactPanelProps) {
  const selection = useChatStore((state) => state.openArtifactSelection);
  const artifacts = useChatStore((state) => state.artifactsByConversation[conversationId] ?? EMPTY_ARTIFACTS);
  const loadArtifacts = useChatStore((state) => state.loadArtifacts);
  const selectArtifactVersion = useChatStore((state) => state.selectArtifactVersion);
  const artifact = artifacts.find((item) => item.slug === selection?.slug);
  const selectedVersion = selection
    ? artifact?.versions.find((item) => item.version === selection.version)
    : artifact?.versions.find((item) => item.version === artifact.currentVersion);
  const [tab, setTab] = useState<'view' | 'source'>(abaInicial(artifact));
  /** Rascunho da edição. `null` = não está editando. */
  const [rascunho, setRascunho] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroEdicao, setErroEdicao] = useState<string | null>(null);
  const saveArtifact = useChatStore((state) => state.saveArtifact);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadArtifacts(conversationId);
  }, [conversationId, loadArtifacts]);

  useEffect(() => {
    setTab(abaInicial(artifact));
    setCopied(false);
  }, [artifact?.slug, artifact?.kind]);

  const content = selectedVersion?.content ?? '';
  const availableVersions = useMemo(() => artifact?.versions.slice().sort((a, b) => b.version - a.version) ?? [], [artifact?.versions]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    if (!artifact) return;
    const blob = new Blob([content], { type: artifact.kind === 'svg' ? 'image/svg+xml' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilename(artifact.title)}.${extensionFor(artifact)}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="artifact-panel" aria-label="Painel de artefato">
      <ArtifactResizer />
      <div className="artifact-panel-header">
        <div className="artifact-panel-heading">
          <FileCode2 size={18} aria-hidden="true" />
          <div>
            <span className="artifact-panel-kicker">Artefato</span>
            <h2>{artifact?.title ?? selection?.slug ?? 'Carregando…'}</h2>
          </div>
        </div>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Fechar painel de artefato" title="Fechar">
          <X size={17} />
        </button>
      </div>

      {artifact ? (
        <>
          <div className="artifact-panel-toolbar">
            <label className="artifact-version-select">
              <span>Versão</span>
              <select
                value={selectedVersion?.version ?? artifact.currentVersion}
                onChange={(event) => void selectArtifactVersion(artifact.slug, Number(event.target.value))}
                disabled={rascunho !== null}
                aria-label="Selecionar versão do artefato"
              >
                {availableVersions.map((version) => <option key={version.version} value={version.version}>v{version.version}</option>)}
              </select>
            </label>
            <div className="artifact-panel-actions">
              <button type="button" className="btn btn-icon" onClick={() => void copy()} disabled={!content} aria-label="Copiar artefato" title="Copiar">
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <button type="button" className="btn btn-icon" onClick={download} disabled={!content} aria-label="Baixar artefato" title="Baixar">
                <Download size={16} />
              </button>
              {/* Editar leva à FONTE, sempre: é ela que se edita, e abrir o
                  campo por baixo da aba Visualizar deixaria o usuário
                  digitando num painel que mostra outra coisa. */}
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => { setTab('source'); setErroEdicao(null); setRascunho(content); }}
                disabled={!selectedVersion || rascunho !== null}
                aria-label="Editar a fonte do artefato"
                title="Editar a fonte"
              >
                <Pencil size={16} />
              </button>
            </div>
          </div>
          <div className="artifact-panel-tabs" role="tablist" aria-label="Modo de visualização">
            <button type="button" role="tab" aria-selected={tab === 'view'} className={tab === 'view' ? 'artifact-tab-active' : ''} onClick={() => setTab('view')}>Visualizar</button>
            <button type="button" role="tab" aria-selected={tab === 'source'} className={tab === 'source' ? 'artifact-tab-active' : ''} onClick={() => setTab('source')}>Fonte</button>
          </div>
          <div className="artifact-panel-content">
            {rascunho !== null ? (
              <div className="artifact-edicao">
                <textarea
                  className="artifact-edicao-campo"
                  value={rascunho}
                  onChange={(evento) => setRascunho(evento.target.value)}
                  spellCheck={false}
                  aria-label="Fonte do artefato"
                  autoFocus
                />
                {erroEdicao ? <p className="provider-error" role="alert">{erroEdicao}</p> : null}
                <div className="artifact-edicao-acoes">
                  <span className="artifact-edicao-aviso">
                    Salvar cria a versão <span className="num">v{artifact.currentVersion + 1}</span>; a atual continua no histórico.
                  </span>
                  <span className="artifact-edicao-botoes">
                    <button type="button" className="btn btn-quiet" onClick={() => { setRascunho(null); setErroEdicao(null); }} disabled={salvando}>
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={salvando || rascunho === content}
                      onClick={async () => {
                        setSalvando(true);
                        setErroEdicao(null);
                        try {
                          await saveArtifact(artifact.slug, rascunho);
                          setRascunho(null);
                        } catch (motivo) {
                          // O rascunho FICA: perder o que a pessoa acabou de
                          // escrever por causa de uma falha de rede seria o
                          // pior desfecho possível aqui.
                          setErroEdicao(motivo instanceof Error ? motivo.message : 'Não consegui salvar a edição.');
                        } finally {
                          setSalvando(false);
                        }
                      }}
                    >
                      {salvando ? 'Salvando…' : 'Salvar como nova versão'}
                    </button>
                  </span>
                </div>
              </div>
            ) : selectedVersion ? (
              <ArtifactRenderer kind={artifact.kind} language={artifact.language} content={content} mode={tab} />
            ) : <p className="artifact-panel-empty">Esta versão ainda está sendo reconstruída.</p>}
          </div>
          <footer className="artifact-panel-footer">
            <span className="num">v{selectedVersion?.version ?? artifact.currentVersion}</span>
            <span>·</span>
            <span className={selectedVersion?.costUsd !== null && selectedVersion?.costUsd !== undefined ? 'artifact-cost' : ''}>{selectedVersion?.costUsd !== null && selectedVersion?.costUsd !== undefined ? `≈$${selectedVersion.costUsd.toFixed(4)}` : 'custo indisponível'}</span>
            <span>·</span>
            <span className="num">{lines(content)} linhas</span>
            {selectedVersion?.truncated ? <span className="artifact-truncated">· resposta truncada</span> : null}
          </footer>
        </>
      ) : (
        <div className="artifact-panel-empty"><AgentOrb activity="reconstruindo" /> Reconstruindo artefato…</div>
      )}
    </aside>
  );
}
