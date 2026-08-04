import { memo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Markdown } from '../render/Markdown';
import { useChatStore } from '../store/chat';
import { ArtifactCard } from './ArtifactCard';
import { CostBadge } from './CostBadge';
import { ReasoningBlock } from './ReasoningBlock';
import { EMPTY_ARTIFACTS, type ChatMessage } from '../types';

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
        {isStreaming ? (
          <span className="message-live"><span className="status-dot" aria-hidden="true" />gerando</span>
        ) : null}
      </div>

      <div className={'message-body ' + (isUser ? 'message-body-user' : 'message-body-assistant') + (message.status === 'error' ? ' message-body-error' : '')}>
        {isUser ? (
          <p className="user-message-text">{message.content}</p>
        ) : message.content ? (
          <AssistantContent message={message} />
        ) : isStreaming ? (
          <span className="typing-indicator" aria-label="Assistente está respondendo"><i /><i /><i /></span>
        ) : null}

        {message.reasoning ? (
          <ReasoningBlock reasoning={message.reasoning} tokens={message.usage?.reasoningTokens} streaming={isStreaming} />
        ) : null}
        {message.status === 'error' ? (
          <p className="message-error-text">{message.errorMessage ?? 'Não foi possível concluir esta resposta.'}</p>
        ) : null}
        {message.truncated ? (
          <p className="context-truncated-note">O histórico antigo foi reduzido para caber na janela deste modelo.</p>
        ) : null}
      </div>

      {isUser ? null : (
        <div className="message-footer">
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
