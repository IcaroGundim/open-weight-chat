import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserButton } from '@clerk/react';
import { ArrowRight, BarChart3, Download, Menu, Moon, PanelLeft, RefreshCw, Sun, X } from 'lucide-react';
import { useChatStore } from '../store/chat';
import { useSettingsStore } from '../store/settings';
import { EMPTY_MESSAGES } from '../types';
import { CostBadge } from './CostBadge';
import { CostOverview } from './CostOverview';
import { ArtifactPanel } from './ArtifactPanel';
import { Composer } from './Composer';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageBubble } from './MessageBubble';
import { ModelCard } from './ModelCard';
import { ModelPicker } from './ModelPicker';
import { SettingsPanel } from './SettingsPanel';

const suggestions = [
  'Compare dois modelos pelo custo real de uma tarefa longa.',
  'Monte um exemplo de streaming SSE em TypeScript.',
  'Explique quando o cache de prompt compensa, com a conta.',
];

function exportConversation(
  title: string,
  messages: ReturnType<typeof useChatStore.getState>['messagesByConversation'][string],
): void {
  const markdown = messages.map((message) => {
    const heading = message.role === 'user' ? 'Você' : message.role === 'assistant' ? 'Assistente' : 'Sistema';
    const reasoning = message.reasoning?.trim()
      ? '\n\n> Raciocínio:\n> ' + message.reasoning.trim().replaceAll('\n', '\n> ')
      : '';
    return '## ' + heading + '\n\n' + message.content.trim() + reasoning;
  }).join('\n\n---\n\n');
  const blob = new Blob(['# ' + title + '\n\n' + markdown + '\n'], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = (title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'conversa') + '.md';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function initialSidebarOpen(): boolean {
  if (typeof window === 'undefined') return true;
  return !window.matchMedia('(max-width: 900px)').matches;
}

export function ChatView() {
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [costOverviewOpen, setCostOverviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const theme = useSettingsStore((state) => state.theme);
  const density = useSettingsStore((state) => state.density);
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);
  const toggleTheme = useSettingsStore((state) => state.toggleTheme);
  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const messagesByConversation = useChatStore((state) => state.messagesByConversation);
  const models = useChatStore((state) => state.models);
  const selectedModelId = useChatStore((state) => state.selectedModelId);
  const isLoadingModels = useChatStore((state) => state.isLoadingModels);
  const isLoadingConversations = useChatStore((state) => state.isLoadingConversations);
  const loadingConversationId = useChatStore((state) => state.loadingConversationId);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const error = useChatStore((state) => state.error);
  const loadModels = useChatStore((state) => state.loadModels);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopStreaming = useChatStore((state) => state.stopStreaming);
  const setSelectedModel = useChatStore((state) => state.setSelectedModel);
  const clearError = useChatStore((state) => state.clearError);
  const openArtifactSelection = useChatStore((state) => state.openArtifactSelection);
  const closeArtifact = useChatStore((state) => state.closeArtifact);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const messages = activeConversationId ? messagesByConversation[activeConversationId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const totalCost = useMemo(
    () => activeConversation?.totalCostUsd ?? messages.reduce((sum, message) => sum + (message.costUsd ?? message.usage?.costUsd ?? 0), 0),
    [activeConversation?.totalCostUsd, messages],
  );

  const openSidebar = useCallback(() => {
    setSettingsOpen(false);
    setSidebarOpen(true);
  }, []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openSettings = useCallback(() => {
    setCostOverviewOpen(false);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.reduceMotion = reduceMotion ? 'true' : 'false';
  }, [density, reduceMotion, theme]);

  useEffect(() => {
    void loadModels();
    void loadConversations();
  }, [loadConversations, loadModels]);

  useEffect(() => {
    if (!openArtifactSelection || typeof window === 'undefined') return;
    if (window.innerWidth >= 900 && window.innerWidth < 1280) setSidebarOpen(false);
  }, [openArtifactSelection]);

  useEffect(() => {
    if (!bottomRef.current) return;
    bottomRef.current.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth', block: 'end' });
  }, [messages, isStreaming]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (costOverviewOpen) setCostOverviewOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (openArtifactSelection) closeArtifact();
      else if (sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeArtifact, costOverviewOpen, openArtifactSelection, settingsOpen, sidebarOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSettings]);

  const headerTitle = activeConversation?.title ?? 'Nova conversa';
  const canSend = !isLoadingModels && models.length > 0;

  return (
    <div className={'chat-app' + (sidebarOpen ? '' : ' sidebar-collapsed') + (openArtifactSelection && activeConversationId ? ' artifact-panel-open' : '')}>
      <ConversationSidebar open={sidebarOpen} onOpen={openSidebar} onClose={closeSidebar} onOpenSettings={openSettings} />
      <main className="chat-main">
        <header className="chat-header">
          <div className="chat-header-leading">
            <button
              type="button"
              className="btn btn-icon sidebar-toggle-button"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label={sidebarOpen ? 'Recolher barra lateral' : 'Abrir barra lateral'}
              title={sidebarOpen ? 'Recolher barra lateral' : 'Abrir barra lateral'}
            >
              {sidebarOpen ? <PanelLeft size={18} /> : <Menu size={18} />}
            </button>
            <h1 title={headerTitle}>{headerTitle}</h1>
          </div>
          <div className="chat-header-actions">
            <ModelPicker
              models={models}
              selectedModelId={selectedModelId}
              onChange={setSelectedModel}
              loading={isLoadingModels}
              disabled={isStreaming}
            />
            <CostBadge costUsd={totalCost} compact label="Sessão" />
            <button type="button" className="btn btn-icon" onClick={() => setCostOverviewOpen(true)} aria-label="Ver custos dos últimos 30 dias" title="Custos">
              <BarChart3 size={17} />
            </button>
            {activeConversationId && messages.length > 0 ? (
              <button type="button" className="btn btn-icon" onClick={() => exportConversation(headerTitle, messages)} aria-label="Exportar conversa em Markdown" title="Exportar Markdown">
                <Download size={17} />
              </button>
            ) : null}
            <button type="button" className="btn btn-icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'} title="Alternar tema">
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <span className="account-button" title="Conta e sair">
              <UserButton />
            </span>
          </div>
        </header>

        {error ? (
          <div className="error-banner" role="alert">
            <p>{error}</p>
            <div className="error-actions">
              <button type="button" className="btn" onClick={() => { clearError(); void loadModels(); void loadConversations(); }}>
                <RefreshCw size={15} /> Tentar de novo
              </button>
              <button type="button" className="btn btn-icon" onClick={clearError} aria-label="Fechar aviso de erro"><X size={16} /></button>
            </div>
          </div>
        ) : null}

        <section className="message-scroll" aria-live="polite" aria-label="Mensagens da conversa">
          {!activeConversationId ? (
            <div className="welcome-state">
              <div className="welcome-copy">
                <h2>Converse com modelos open-weight e veja o preço de cada resposta.</h2>
                <p>As chaves ficam no seu servidor, as conversas no seu disco. O medidor abaixo é do modelo selecionado agora.</p>
              </div>
              <ModelCard model={selectedModel} loading={isLoadingModels} />
              <div className="suggestion-list">
                <p className="suggestion-heading">Para começar</p>
                {suggestions.map((suggestion) => (
                  <button
                    type="button"
                    className="suggestion-row"
                    key={suggestion}
                    onClick={() => void sendMessage(suggestion)}
                    disabled={isStreaming || !canSend}
                  >
                    <span>{suggestion}</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : isLoadingConversations || loadingConversationId === activeConversationId ? (
            <div className="conversation-loading"><span className="loading-spinner" aria-hidden="true" /> Carregando mensagens…</div>
          ) : messages.length === 0 ? (
            <div className="empty-conversation">
              <h2>Comece por uma pergunta específica.</h2>
              <p>Envie uma pergunta, um trecho de código ou uma decisão que você quer explorar. O custo aparece embaixo de cada resposta.</p>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              <div ref={bottomRef} />
            </div>
          )}
        </section>

        <div className="composer-wrap">
          <Composer onSend={sendMessage} onStop={stopStreaming} isStreaming={isStreaming} disabled={!canSend} />
          <p className="privacy-note">As chaves ficam no servidor e o Markdown é renderizado sem HTML cru.</p>
        </div>
      </main>
      {costOverviewOpen ? <CostOverview onClose={() => setCostOverviewOpen(false)} /> : null}
      {settingsOpen ? (
        <SettingsPanel
          models={models}
          selectedModelId={selectedModelId}
          onModelChange={setSelectedModel}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {openArtifactSelection && activeConversationId ? <ArtifactPanel conversationId={activeConversationId} onClose={closeArtifact} /> : null}
    </div>
  );
}
