import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Pencil, Plus, Search, Settings, Trash2, X } from 'lucide-react';
import { searchConversations as searchConversationsRequest } from '../api';
import { useChatStore } from '../store/chat';
import type { Conversation } from '../types';

type ConversationSidebarProps = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
};

function dateLabel(value?: string | number): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(date);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function ConversationSidebar({ open, onOpen, onClose, onOpenSettings }: ConversationSidebarProps) {
  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const isLoading = useChatStore((state) => state.isLoadingConversations);
  const newConversation = useChatStore((state) => state.newConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const renameConversation = useChatStore((state) => state.renameConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const [search, setSearch] = useState('');
  const [remoteResults, setRemoteResults] = useState<Conversation[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setRemoteResults(null);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchConversationsRequest(query)
        .then((results) => {
          if (active) setRemoteResults(results);
        })
        .catch(() => {
          if (active) setRemoteResults(null);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  // Os rótulos de atalho na interface precisam corresponder a atalhos reais.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        newConversation();
        setRenamingId(null);
        setConfirmingId(null);
        onClose();
        return;
      }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        onOpen();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newConversation, onClose, onOpen]);

  useEffect(() => {
    if (renamingId) renameRef.current?.select();
  }, [renamingId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query && remoteResults) return remoteResults;
    return conversations.filter((conversation) => !query || conversation.title.toLowerCase().includes(query));
  }, [conversations, remoteResults, search]);

  const startRename = (conversation: Conversation) => {
    setConfirmingId(null);
    setRenamingId(conversation.id);
    setRenameValue(conversation.title);
  };

  const commitRename = (conversation: Conversation) => {
    const title = renameValue.trim();
    if (title && title !== conversation.title) void renameConversation(conversation.id, title);
    setRenamingId(null);
  };

  return (
    <>
      {open ? <button type="button" className="sidebar-scrim" onClick={onClose} aria-label="Fechar menu" /> : null}
      <aside className={'conversation-sidebar' + (open ? ' sidebar-open' : '')} aria-label="Conversas">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">O</span>
          <span className="brand-name">Open Weight Chat</span>
          <button type="button" className="btn btn-icon sidebar-close" onClick={onClose} aria-label="Fechar barra lateral">
            <X size={17} />
          </button>
        </div>

        <button
          type="button"
          className="new-conversation-button"
          onClick={() => {
            newConversation();
            onClose();
          }}
        >
          <Plus size={16} aria-hidden="true" />
          <span>Nova conversa</span>
          <kbd aria-hidden="true">Ctrl K</kbd>
        </button>

        <label className="conversation-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Buscar conversas</span>
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar conversas"
          />
          <kbd aria-hidden="true">/</kbd>
        </label>

        <div className="sidebar-section-heading">
          <span>{searching ? 'Buscando…' : 'Conversas'}</span>
          <span className="sidebar-count">{filtered.length}</span>
        </div>

        <nav className="conversation-list" aria-label="Lista de conversas">
          {isLoading ? (
            <p className="sidebar-state">Carregando…</p>
          ) : filtered.length === 0 ? (
            <p className="sidebar-state">
              <FileText size={16} aria-hidden="true" />
              {search ? 'Nenhuma conversa encontrada.' : 'Suas conversas aparecerão aqui.'}
            </p>
          ) : filtered.map((conversation) => {
            const isActive = conversation.id === activeConversationId;

            if (renamingId === conversation.id) {
              return (
                <div key={conversation.id} className="conversation-item conversation-item-active">
                  <form
                    className="conversation-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename(conversation);
                    }}
                  >
                    <input
                      ref={renameRef}
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => commitRename(conversation)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      aria-label={'Novo nome para ' + conversation.title}
                    />
                  </form>
                </div>
              );
            }

            if (confirmingId === conversation.id) {
              return (
                <div key={conversation.id} className="conversation-item conversation-item-active">
                  <div className="conversation-confirm">
                    <span>Excluir esta conversa?</span>
                    <button
                      type="button"
                      className="confirm-yes"
                      onClick={() => {
                        void deleteConversation(conversation.id);
                        setConfirmingId(null);
                      }}
                    >
                      Excluir
                    </button>
                    <button type="button" onClick={() => setConfirmingId(null)}>Cancelar</button>
                  </div>
                </div>
              );
            }

            return (
              <div key={conversation.id} className={'conversation-item' + (isActive ? ' conversation-item-active' : '')}>
                <button
                  type="button"
                  className="conversation-select"
                  onClick={() => {
                    void selectConversation(conversation.id);
                    onClose();
                  }}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="conversation-title">{conversation.title || 'Nova conversa'}</span>
                  <span className="conversation-meta">
                    {conversation.modelId ?? 'sem modelo'}
                    <time>{dateLabel(conversation.updatedAt ?? conversation.createdAt)}</time>
                  </span>
                </button>
                <div className="conversation-actions">
                  <button type="button" onClick={() => startRename(conversation)} aria-label={'Renomear ' + conversation.title} title="Renomear">
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="action-danger" onClick={() => setConfirmingId(conversation.id)} aria-label={'Excluir ' + conversation.title} title="Excluir">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="sidebar-settings-button" onClick={onOpenSettings}>
            <Settings size={15} aria-hidden="true" />
            <span>Configurações</span>
            <kbd aria-hidden="true">Ctrl ,</kbd>
          </button>
          <div className="sidebar-status">
            <span className="status-dot" aria-hidden="true" />
            <span>SQLite local · chaves no servidor</span>
          </div>
        </div>
      </aside>
    </>
  );
}
