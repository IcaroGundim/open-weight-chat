import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText } from 'lucide-react';
import { Markdown } from '../render/Markdown';
import { useChatStore } from '../store/chat';
import { attachmentUrl } from '../api';
import { AgentOrb } from './AgentOrb';
import { SearchBlock } from './SearchBlock';
import { ArtifactCard } from './ArtifactCard';
import { CostBadge } from './CostBadge';
import { TokenRate } from './TokenRate';
import { ReasoningBlock } from './ReasoningBlock';
import { SpreadsheetCard } from './SpreadsheetCard';
import { EMPTY_ARTIFACTS, type Attachment, type ChatMessage } from '../types';

type MessageBubbleProps = {
  message: ChatMessage;
};

const artifactMarker = /(?:^|\r?\n)\[\[artefato:([a-z0-9][a-z0-9-]{0,63})@(\d+)\]\](?=\r?\n|$)/gm;

function formatTime(value?: string | number): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDateTime(value?: string | number): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Anexos da mensagem do usuário.
 *
 * Imagem aparece como imagem — é o que ela é, e uma linha "foto.png · 240 KB"
 * obrigaria a abrir para saber o que foi mandado. Documento aparece como
 * linha, porque o conteúdo dele já foi para o modelo como texto e reproduzi-lo
 * aqui repetiria a mensagem inteira.
 */
function MessageAttachments({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  const imagens = attachments.filter((anexo) => anexo.kind === 'image');
  const documentos = attachments.filter((anexo) => anexo.kind === 'document');
  const planilhas = attachments.filter((anexo) => anexo.kind === 'spreadsheet');
  return (
    <div className="message-anexos">
      {imagens.length > 0 ? (
        <div className="message-anexos-imagens">
          {imagens.map((anexo) => (
            <a key={anexo.id} href={attachmentUrl(anexo.id)} target="_blank" rel="noopener noreferrer">
              <img src={attachmentUrl(anexo.id)} alt={anexo.filename} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {documentos.map((anexo) => (
        <span className="message-anexo-doc" key={anexo.id}>
          <FileText size={14} aria-hidden="true" />
          <span>{anexo.filename}</span>
          {anexo.textChars === 0 ? <em>sem texto legível</em> : null}
          {anexo.truncated ? <em>cortado</em> : null}
        </span>
      ))}
      {planilhas.map((anexo) => (
        <SpreadsheetCard key={anexo.id} attachment={anexo} />
      ))}
    </div>
  );
}

/**
 * Progresso da cadeia Science.
 *
 * Fica guardado NA mensagem, não num estado efêmero: quem reabre a conversa
 * depois precisa saber por quantas mãos aquele texto passou — é o que explica
 * o custo e a extensão dele.
 */
function ScienceStages({ message }: { message: ChatMessage }) {
  const estagios = message.scienceStages;
  if (!estagios || estagios.length === 0) return null;
  return (
    <ol className="science-progresso">
      {estagios.map((estagio) => (
        <li key={estagio.index} data-status={estagio.status}>
          <span className="num">{estagio.index}/{estagio.total}</span>
          {estagio.label}
          {/* Concluído fica dito: sem isso, um passo que terminou e um que
              nem começou se parecem. */}
          {estagio.status === 'done' ? <span className="science-progresso-ok" aria-hidden="true">✓</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Bastidor: o texto que o agente em curso está escrevendo.
 *
 * Fica visualmente rebaixado — menor, recuado, em tom secundário — porque não
 * é a resposta. É rascunho de um agente intermediário, e confundi-lo com o
 * documento final seria pior do que não mostrar nada.
 *
 * A rolagem acompanha o fim: um painel de altura fixa que não rola para baixo
 * mostra sempre o começo do texto, que é justamente a parte que já foi lida.
 */
function ScienceDraft({ message }: { message: ChatMessage }) {
  const draft = message.scienceDraft;
  const corpoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const corpo = corpoRef.current;
    if (corpo) corpo.scrollTop = corpo.scrollHeight;
  }, [draft?.text, draft?.reasoning]);

  if (!draft) return null;
  // Enquanto não há texto, o painel mostra o raciocínio: com esforço alto essa
  // fase leva minutos, e é justamente quando o usuário precisa ver que algo
  // está acontecendo.
  const escrevendo = draft.text.trim().length > 0;
  const conteudo = escrevendo ? draft.text : draft.reasoning;
  if (!conteudo.trim()) return null;
  // O nome do agente vem da lista de estágios, pelo índice.
  //
  // Sem ele o painel dizia só "Escrevendo", e como CADA agente devolve o
  // documento inteiro — o aprofundador reescreve tudo com os acréscimos —, a
  // tela mostrava um texto longo sendo escrito três vezes seguidas, sem nada
  // indicando que eram autores diferentes. Parecia um laço.
  const rotulo = message.scienceStages?.find((estagio) => estagio.index === draft.index)?.label;
  return (
    <details className="science-bastidor" open>
      <summary>
        <span className="status-dot" aria-hidden="true" />
        {rotulo ? <><strong>{rotulo}</strong> · </> : null}
        {escrevendo ? 'escrevendo' : 'raciocinando'} — <span className="num">{conteudo.length.toLocaleString('pt-BR')}</span> caracteres
      </summary>
      <div className="science-bastidor-corpo" ref={corpoRef} aria-live="off" data-raciocinio={!escrevendo || undefined}>
        {/* Texto cru de propósito: renderizar Markdown a cada pedaço faria o
            painel refluir inteiro a cada token. */}
        {conteudo}
      </div>
    </details>
  );
}

/**
 * Log de diagnóstico do turno.
 *
 * Existe para transformar "bugou" em algo verificável: quantos agentes
 * rodaram, quanto tempo cada um levou, que retentativa aconteceu por baixo,
 * por que terminou. O botão de copiar é o ponto — o log só vale se sair
 * daqui e chegar em quem vai ler.
 *
 * Fechado por padrão: é ferramenta de investigação, não parte da leitura.
 */
function TraceLog({ message }: { message: ChatMessage }) {
  const linhas = message.trace;
  const [copiado, setCopiado] = useState(false);
  if (!linhas || linhas.length === 0) return null;

  const comoTexto = linhas
    .map((linha) => `${String(linha.at).padStart(6)}ms  ${linha.scope.padEnd(9)} ${linha.event}${linha.detail ? ` — ${linha.detail}` : ''}`)
    .join('\n');

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(comoTexto);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 1400);
    } catch {
      setCopiado(false);
    }
  };

  return (
    <details className="trace-log">
      <summary>
        Log do turno — <span className="num">{linhas.length}</span> eventos
      </summary>
      <div className="trace-log-acoes">
        <button type="button" className="btn btn-quiet" onClick={() => void copiar()}>
          {copiado ? <Check size={14} /> : <Copy size={14} />}
          {copiado ? 'Copiado' : 'Copiar log'}
        </button>
      </div>
      <ol className="trace-log-lista">
        {linhas.map((linha, indice) => (
          <li key={`${linha.at}-${indice}`} data-escopo={linha.scope}>
            <span className="num trace-log-tempo">{(linha.at / 1000).toFixed(1)}s</span>
            <span className="trace-log-escopo">{linha.scope}</span>
            <span>
              {linha.event}
              {linha.detail ? <em>{linha.detail}</em> : null}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AssistantContent({ message }: { message: ChatMessage }) {
  const artifacts = useChatStore((state) => state.artifactsByConversation[message.conversationId ?? ''] ?? EMPTY_ARTIFACTS);
  const promoteCodeArtifact = useChatStore((state) => state.promoteCodeArtifact);
  const segments: Array<{ type: 'text'; value: string } | { type: 'artifact'; slug: string; version: number }> = [];
  let cursor = 0;
  for (const match of message.content.matchAll(artifactMarker)) {
    const index = match.index ?? 0;
    const prefixLength = match[0].startsWith('\r\n') ? 2 : match[0].startsWith('\n') ? 1 : 0;
    const markerStart = index + prefixLength;
    if (markerStart > cursor) segments.push({ type: 'text', value: message.content.slice(cursor, markerStart) });
    segments.push({ type: 'artifact', slug: match[1], version: Number(match[2]) });
    cursor = index + match[0].length;
  }
  if (cursor < message.content.length) segments.push({ type: 'text', value: message.content.slice(cursor) });
  if (!segments.length) segments.push({ type: 'text', value: message.content });

  return (
    <>
      {segments.map((segment, index) => segment.type === 'artifact'
        ? <ArtifactCard key={`${segment.slug}-${segment.version}-${index}`} slug={segment.slug} versionNumber={segment.version} artifact={artifacts.find((item) => item.slug === segment.slug)} />
        : segment.value ? (
          <Markdown
            key={`text-${index}`}
            source={segment.value}
            streaming={message.status === 'streaming'}
            onPromoteCode={message.status === 'streaming' ? undefined : (code, language) => promoteCodeArtifact(message.id, code, language)}
          />
        ) : null)}
    </>
  );
}

export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isStreaming = message.status === 'streaming';

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={'message-row ' + (isUser ? 'message-row-user' : 'message-row-assistant')}>
      <div className="message-head">
        <span className="message-role">{isUser ? 'Você' : 'Assistente'}</span>
        {message.createdAt ? <time dateTime={formatDateTime(message.createdAt)}>{formatTime(message.createdAt)}</time> : null}
        {/* Sem selo de "gerando" no cabeçalho: o estado já é dito duas vezes
            embaixo — pelo orb enquanto não há texto (e é ele que carrega o
            rótulo lido por leitor de tela) e pelo próprio texto aparecendo
            depois. Um terceiro anúncio da mesma coisa é ruído. */}
      </div>

      <div className={'message-body ' + (isUser ? 'message-body-user' : 'message-body-assistant') + (message.status === 'error' ? ' message-body-error' : '')}>
        {isUser ? (
          <>
            <MessageAttachments attachments={message.attachments} />
            {message.content ? <p className="user-message-text">{message.content}</p> : null}
          </>
        ) : message.content ? (
          <>
            <ScienceStages message={message} />
            <MessageAttachments attachments={message.attachments} />
            <AssistantContent message={message} />
          </>
        ) : message.attachments?.length ? (
          <MessageAttachments attachments={message.attachments} />
        ) : isStreaming ? (
          <>
            <ScienceStages message={message} />
            <ScienceDraft message={message} />
            <AgentOrb activity="pensando" label="Assistente está respondendo" />
          </>
        ) : null}

        {/* Antes do raciocínio e do texto: a busca é o que ACONTECEU primeiro,
            e a ordem na tela deve ser a ordem dos fatos. */}
        {message.searches?.length ? <SearchBlock searches={message.searches} /> : null}

        {message.reasoning ? (
          <ReasoningBlock reasoning={message.reasoning} tokens={message.usage?.reasoningTokens} streaming={isStreaming} />
        ) : null}
        <TraceLog message={message} />
        {message.status === 'error' ? (
          <p className="message-error-text">{message.errorMessage ?? 'Não foi possível concluir esta resposta.'}</p>
        ) : null}
        {message.truncated ? (
          <p className="context-truncated-note">O histórico antigo foi reduzido para caber na janela deste modelo.</p>
        ) : null}
      </div>

      {isUser ? null : (
        <div className="message-footer">
          {/* Junto do custo: as duas são medidas do mesmo turno, e quem olha
              uma costuma querer a outra. */}
          <TokenRate
            chars={message.content.length + (message.reasoning?.length ?? 0)}
            streaming={message.status === 'streaming'}
            completionTokens={message.usage?.completionTokens}
            elapsedMs={message.startedAt && message.finishedAt ? message.finishedAt - message.startedAt : undefined}
          />
          <CostBadge costUsd={message.costUsd} usage={message.usage} />
          {message.costEstimated && !message.usage?.costEstimated ? (
            <span className="message-note message-note-warn">custo estimado</span>
          ) : null}
          {message.status === 'aborted' ? <span className="message-note">geração interrompida</span> : null}
          {message.content ? (
            <button type="button" className="message-copy" onClick={() => void copyMessage()} aria-label="Copiar resposta">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
});
