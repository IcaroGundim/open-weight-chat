import { create } from 'zustand';
import {
  ApiError,
  createConversation as createConversationRequest,
  deleteConversation as deleteConversationRequest,
  getArtifactVersion,
  getArtifacts,
  getConversation,
  getConversations,
  getModels,
  renameConversation as renameConversationRequest,
  streamChat,
} from '../api';
import type {
  Artifact,
  ArtifactEndEnvelope,
  ArtifactStartEnvelope,
  ChatMessage,
  Conversation,
  ModelOption,
  StreamErrorEnvelope,
  Usage,
} from '../types';

const SELECTED_MODEL_STORAGE_KEY = 'open-weight-chat.selected-model';

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function initialSelectedModelId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMIT') return 'O provedor está limitando requisições. Aguarde e tente novamente.';
    if (error.code === 'INVALID_API_KEY') return 'A chave de API configurada foi recusada pelo provedor.';
    if (error.code === 'MODEL_NOT_FOUND') return 'O modelo selecionado não está disponível neste provedor.';
    if (error.code === 'CONTEXT_LENGTH_EXCEEDED') return 'A conversa excedeu a janela de contexto do modelo.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Algo deu errado. Tente novamente.';
}

function conversationCost(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + (message.costUsd ?? message.usage?.costUsd ?? 0), 0);
}

function streamingArtifactKey(conversationId: string, slug: string): string {
  return `${conversationId}:${slug}`;
}

function artifactMarkerText(slug: string, version: number): string {
  return `[[artefato:${slug}@${version}]]`;
}

function artifactVersion(artifact: Artifact | undefined, version: number): Artifact['versions'][number] | undefined {
  return artifact?.versions.find((item) => item.version === version)
    ?? (artifact?.currentVersion === version ? artifact.versions.at(-1) : undefined);
}

function manualArtifactSlug(language: string | undefined, existing: Artifact[]): string {
  const base = `codigo-${(language ?? 'selecionado').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'selecionado'}`.slice(0, 56);
  if (!existing.some((artifact) => artifact.slug === base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base.slice(0, 63 - String(suffix).length - 1)}-${suffix}`;
    if (!existing.some((artifact) => artifact.slug === candidate)) return candidate;
  }
  return `codigo-${Date.now().toString(36)}`.slice(0, 64);
}

function replaceManualCodeBlock(source: string, code: string, language: string | undefined, marker: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  const target = code.replace(/\r\n/gu, '\n').replace(/\n$/u, '');
  const expectedLanguage = language?.trim().replace(/^language-/u, '').toLowerCase();
  for (let start = 0; start < lines.length; start += 1) {
    const opening = lines[start].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u);
    if (!opening) continue;
    const info = opening[2].trim().split(/\s+/u)[0]?.replace(/^language-/u, '').toLowerCase() ?? '';
    if (expectedLanguage && info && info !== expectedLanguage) continue;
    let end = start + 1;
    while (end < lines.length && !new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`, 'u').test(lines[end])) end += 1;
    if (end >= lines.length) continue;
    const body = lines.slice(start + 1, end).join('\n').replace(/\n$/u, '');
    if (body !== target) continue;
    return [...lines.slice(0, start), marker, ...lines.slice(end + 1)].join(newline);
  }
  return source ? `${source}${newline}${newline}${marker}` : marker;
}

function replaceArtifact(artifacts: Artifact[], next: Artifact): Artifact[] {
  const index = artifacts.findIndex((artifact) => artifact.slug === next.slug);
  if (index < 0) return [...artifacts, next];
  return artifacts.map((artifact) => artifact.slug === next.slug ? next : artifact);
}

interface ChatState {
  conversations: Conversation[];
  messagesByConversation: Record<string, ChatMessage[]>;
  messagesLoaded: Record<string, boolean>;
  activeConversationId: string | null;
  models: ModelOption[];
  selectedModelId: string | null;
  artifactsByConversation: Record<string, Artifact[]>;
  streamingArtifacts: Record<string, string>;
  openArtifactSelection: { slug: string; version: number } | null;
  isLoadingModels: boolean;
  isLoadingConversations: boolean;
  loadingConversationId: string | null;
  isStreaming: boolean;
  streamingConversationId: string | null;
  streamingMessageId: string | null;
  streamController: AbortController | null;
  streamAbortRequested: boolean;
  error: string | null;

  loadModels: () => Promise<void>;
  loadConversations: () => Promise<void>;
  selectConversation: (id: string | null) => Promise<void>;
  newConversation: () => void;
  createConversation: (title?: string) => Promise<Conversation | null>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setSelectedModel: (id: string) => void;
  loadArtifacts: (conversationId: string) => Promise<void>;
  openArtifact: (selection: { slug: string; version: number }) => void;
  closeArtifact: () => void;
  selectArtifactVersion: (slug: string, version: number) => Promise<void>;
  promoteCodeArtifact: (messageId: string, code: string, language?: string) => void;
  sendMessage: (content: string) => Promise<void>;
  stopStreaming: () => void;
  clearError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  messagesByConversation: {},
  messagesLoaded: {},
  activeConversationId: null,
  models: [],
  selectedModelId: initialSelectedModelId(),
  artifactsByConversation: {},
  streamingArtifacts: {},
  openArtifactSelection: null,
  isLoadingModels: false,
  isLoadingConversations: false,
  loadingConversationId: null,
  isStreaming: false,
  streamingConversationId: null,
  streamingMessageId: null,
  streamController: null,
  streamAbortRequested: false,
  error: null,

  loadModels: async () => {
    set({ isLoadingModels: true, error: null });
    try {
      const models = await getModels();
      const current = get().selectedModelId;
      const configuredModels = models.filter((model) => model.configured !== false);
      const selectedModelId = models.some((model) => model.id === current && model.configured !== false)
        ? current
        : (configuredModels[0] ?? models[0])?.id ?? null;
      if (typeof window !== 'undefined') {
        if (selectedModelId) {
          window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, selectedModelId);
        } else {
          window.localStorage.removeItem(SELECTED_MODEL_STORAGE_KEY);
        }
      }
      set({ models, selectedModelId, isLoadingModels: false });
    } catch (error) {
      set({ models: [], isLoadingModels: false, error: errorMessage(error) });
    }
  },

  loadConversations: async () => {
    set({ isLoadingConversations: true, error: null });
    try {
      const conversations = await getConversations();
      set((state) => {
        const active = state.activeConversationId;
        const activeConversationId = active && conversations.some((conversation) => conversation.id === active)
          ? active
          : null;
        return { conversations, activeConversationId, isLoadingConversations: false };
      });
    } catch (error) {
      set({ isLoadingConversations: false, error: errorMessage(error) });
    }
  },

  loadArtifacts: async (conversationId) => {
    try {
      const artifacts = await getArtifacts(conversationId);
      set((state) => ({
        artifactsByConversation: {
          ...state.artifactsByConversation,
          [conversationId]: [
            ...artifacts,
            ...(state.artifactsByConversation[conversationId] ?? []).filter((item) => item.id.startsWith('local:') && !artifacts.some((artifact) => artifact.slug === item.slug)),
          ],
        },
      }));
    } catch {
      // Artefatos são uma extensão opcional da API. Conversas antigas continuam utilizáveis.
      set((state) => ({
        artifactsByConversation: {
          ...state.artifactsByConversation,
          [conversationId]: (state.artifactsByConversation[conversationId] ?? []).filter((item) => item.id.startsWith('local:')),
        },
      }));
    }
  },

  selectConversation: async (id) => {
    if (!id) {
      set({ activeConversationId: null, error: null });
      return;
    }
    set({ activeConversationId: id, error: null });
    if (get().messagesLoaded[id]) return;

    set({ loadingConversationId: id });
    try {
      const result = await getConversation(id);
      set((state) => ({
        messagesByConversation: { ...state.messagesByConversation, [id]: result.messages },
        messagesLoaded: { ...state.messagesLoaded, [id]: true },
        conversations: result.conversation
          ? state.conversations.map((conversation) => conversation.id === id ? { ...conversation, ...result.conversation } : conversation)
          : state.conversations,
        loadingConversationId: state.loadingConversationId === id ? null : state.loadingConversationId,
      }));
      void get().loadArtifacts(id);
    } catch (error) {
      set((state) => ({ loadingConversationId: state.loadingConversationId === id ? null : state.loadingConversationId, error: errorMessage(error) }));
    }
  },

  newConversation: () => set({ activeConversationId: null, openArtifactSelection: null, error: null }),

  createConversation: async (title = 'Nova conversa') => {
    const selected = get().models.find((model) => model.id === get().selectedModelId);
    try {
      const conversation = await createConversationRequest({
        title,
        providerId: selected?.providerId,
        modelId: selected?.id,
      });
      set((state) => ({
        conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
        activeConversationId: conversation.id,
        messagesByConversation: { ...state.messagesByConversation, [conversation.id]: [] },
        messagesLoaded: { ...state.messagesLoaded, [conversation.id]: true },
        error: null,
      }));
      return conversation;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  renameConversation: async (id, title) => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    try {
      const updated = await renameConversationRequest(id, normalizedTitle);
      set((state) => ({
        conversations: state.conversations.map((conversation) => conversation.id === id
          ? { ...conversation, title: updated?.title ?? normalizedTitle }
          : conversation),
        error: null,
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  deleteConversation: async (id) => {
    try {
      await deleteConversationRequest(id);
      set((state) => {
        const conversations = state.conversations.filter((conversation) => conversation.id !== id);
        const { [id]: _messages, ...messagesByConversation } = state.messagesByConversation;
        const { [id]: _loaded, ...messagesLoaded } = state.messagesLoaded;
        const { [id]: _artifacts, ...artifactsByConversation } = state.artifactsByConversation;
        return {
          conversations,
          messagesByConversation,
          messagesLoaded,
          artifactsByConversation,
          activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
          openArtifactSelection: state.activeConversationId === id ? null : state.openArtifactSelection,
          error: null,
        };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  setSelectedModel: (id) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, id);
    }
    set({ selectedModelId: id });
  },

  openArtifact: (selection) => set({ openArtifactSelection: selection }),

  closeArtifact: () => set({ openArtifactSelection: null }),

  selectArtifactVersion: async (slug, version) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    set({ openArtifactSelection: { slug, version } });
    const artifact = (get().artifactsByConversation[conversationId] ?? []).find((item) => item.slug === slug);
    if (artifactVersion(artifact, version)) return;
    try {
      const remoteVersion = await getArtifactVersion(conversationId, slug, version);
      if (!remoteVersion) return;
      set((state) => ({
        artifactsByConversation: {
          ...state.artifactsByConversation,
          [conversationId]: (state.artifactsByConversation[conversationId] ?? []).map((item) => item.slug === slug
            ? { ...item, versions: [...item.versions, remoteVersion].sort((a, b) => a.version - b.version) }
            : item),
        },
      }));
    } catch {
      // O painel continua mostrando as versões já reconstruídas no primeiro GET.
    }
  },

  promoteCodeArtifact: (messageId, code, language) => {
    set((state) => {
      let conversationId: string | null = null;
      let currentMessage: ChatMessage | null = null;
      for (const [id, messages] of Object.entries(state.messagesByConversation)) {
        const found = messages.find((message) => message.id === messageId);
        if (found) {
          conversationId = id;
          currentMessage = found;
          break;
        }
      }
      if (!conversationId || !currentMessage || currentMessage.role !== 'assistant') return state;
      const existing = state.artifactsByConversation[conversationId] ?? [];
      const slug = manualArtifactSlug(language, existing);
      const now = Date.now();
      const marker = artifactMarkerText(slug, 1);
      const version = {
        version: 1,
        content: code,
        operation: 'create' as const,
        messageId,
        outputTokens: null,
        costUsd: null,
        truncated: false,
        createdAt: now,
      };
      const artifact: Artifact = {
        id: `local:${conversationId}:${slug}`,
        conversationId,
        slug,
        kind: 'code',
        language: language?.trim() || null,
        title: language ? `Código ${language}` : 'Código selecionado',
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        versions: [version],
      };
      const content = replaceManualCodeBlock(currentMessage.content, code, language, marker);
      return {
        artifactsByConversation: {
          ...state.artifactsByConversation,
          [conversationId]: [...existing, artifact],
        },
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((message) => message.id === messageId ? { ...message, content } : message),
        },
      };
    });
  },

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed || get().isStreaming) return;

    const selected = get().models.find((model) => model.id === get().selectedModelId);
    if (!selected) {
      set({ error: 'Carregue os modelos e selecione um modelo antes de enviar.' });
      return;
    }
    if (selected.configured === false) {
      set({ error: 'Configure a chave deste provedor no servidor antes de enviar.' });
      return;
    }

    let conversationId = get().activeConversationId;
    if (!conversationId || !get().conversations.some((conversation) => conversation.id === conversationId)) {
      const created = await get().createConversation(trimmed.slice(0, 56));
      if (!created) return;
      conversationId = created.id;
    }

    const userMessage: ChatMessage = {
      id: makeId('user'),
      conversationId,
      role: 'user',
      content: trimmed,
      status: 'complete',
      createdAt: Date.now(),
    };
    const assistantMessage: ChatMessage = {
      id: makeId('assistant'),
      conversationId,
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      createdAt: Date.now(),
    };
    const controller = new AbortController();

    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId as string]: [
          ...(state.messagesByConversation[conversationId as string] ?? []),
          userMessage,
          assistantMessage,
        ],
      },
      messagesLoaded: { ...state.messagesLoaded, [conversationId as string]: true },
      conversations: state.conversations.map((conversation) => conversation.id === conversationId
        ? { ...conversation, title: conversation.title === 'Nova conversa' ? trimmed.slice(0, 56) : conversation.title, updatedAt: Date.now() }
        : conversation),
      isStreaming: true,
      streamingConversationId: conversationId,
      streamingMessageId: assistantMessage.id,
      streamController: controller,
      streamAbortRequested: false,
      error: null,
    }));

    const updateAssistant = (update: (message: ChatMessage) => ChatMessage) => {
      set((state) => {
        if (state.streamingMessageId !== assistantMessage.id) return state;
        const messages = state.messagesByConversation[conversationId as string] ?? [];
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId as string]: messages.map((message) => message.id === assistantMessage.id ? update(message) : message),
          },
        };
      });
    };

    try {
      await streamChat(
        {
          conversationId,
          content: trimmed,
          providerId: selected.providerId,
          modelId: selected.id,
        },
        {
          onText: (text) => updateAssistant((message) => ({ ...message, content: message.content + text })),
          onReasoning: (reasoning) => updateAssistant((message) => ({ ...message, reasoning: `${message.reasoning ?? ''}${reasoning}` })),
          onArtifactStart: (artifact: ArtifactStartEnvelope) => {
            const now = Date.now();
            const previous = (get().artifactsByConversation[conversationId] ?? []).find((item) => item.slug === artifact.slug);
            const pendingVersion = {
              version: artifact.version,
              content: '',
              operation: artifact.operation,
              messageId: assistantMessage.id,
              outputTokens: null,
              costUsd: null,
              truncated: false,
              createdAt: now,
            } as const;
            const optimistic: Artifact = {
              id: previous?.id ?? `${conversationId}:${artifact.slug}`,
              conversationId,
              slug: artifact.slug,
              kind: artifact.kind,
              language: artifact.language,
              title: artifact.title,
              currentVersion: artifact.version,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
              versions: previous?.versions.some((item) => item.version === artifact.version)
                ? previous.versions
                : [...(previous?.versions ?? []), pendingVersion].sort((a, b) => a.version - b.version),
            };
            set((state) => ({
              artifactsByConversation: {
                ...state.artifactsByConversation,
                [conversationId]: replaceArtifact(state.artifactsByConversation[conversationId] ?? [], optimistic),
              },
              streamingArtifacts: {
                ...state.streamingArtifacts,
                [streamingArtifactKey(conversationId, artifact.slug)]: '',
              },
            }));
            updateAssistant((message) => ({
              ...message,
              content: `${message.content}${message.content && !message.content.endsWith('\n') ? '\n\n' : ''}${artifactMarkerText(artifact.slug, artifact.version)}\n\n`,
            }));
          },
          onArtifactDelta: ({ slug, text }) => {
            const key = streamingArtifactKey(conversationId, slug);
            set((state) => ({
              streamingArtifacts: { ...state.streamingArtifacts, [key]: (state.streamingArtifacts[key] ?? '') + text },
            }));
          },
          onArtifactEnd: (artifact) => {
            const key = streamingArtifactKey(conversationId, artifact.slug);
            set((state) => {
              const body = state.streamingArtifacts[key] ?? '';
              const nextArtifacts = (state.artifactsByConversation[conversationId] ?? []).map((item) => item.slug === artifact.slug
                ? {
                    ...item,
                    currentVersion: artifact.version,
                    updatedAt: Date.now(),
                    versions: item.versions.map((version) => version.version === artifact.version
                      ? { ...version, content: body, truncated: artifact.truncated, outputTokens: artifact.outputTokens, costUsd: artifact.costUsd }
                      : version),
                  }
                : item);
              const { [key]: _streaming, ...streamingArtifacts } = state.streamingArtifacts;
              return {
                artifactsByConversation: { ...state.artifactsByConversation, [conversationId]: nextArtifacts },
                streamingArtifacts,
              };
            });
            void getArtifactVersion(conversationId, artifact.slug, artifact.version).then((remoteVersion) => {
              if (!remoteVersion) return;
              set((state) => ({
                artifactsByConversation: {
                  ...state.artifactsByConversation,
                  [conversationId]: (state.artifactsByConversation[conversationId] ?? []).map((item) => item.slug === artifact.slug
                    ? {
                        ...item,
                        currentVersion: Math.max(item.currentVersion, remoteVersion.version),
                        versions: item.versions.some((version) => version.version === remoteVersion.version)
                          ? item.versions.map((version) => version.version === remoteVersion.version ? remoteVersion : version)
                          : [...item.versions, remoteVersion].sort((a, b) => a.version - b.version),
                      }
                    : item),
                },
              }));
            }).catch(() => {
              // A versÃ£o otimista jÃ¡ foi exibida; falhas de reconciliaÃ§Ã£o nÃ£o interrompem o chat.
            });
          },
          onUsage: (usage) => updateAssistant((message) => ({
            ...message,
            usage: { ...message.usage, ...usage },
            costUsd: usage.costUsd ?? message.costUsd,
            costEstimated: usage.costEstimated ?? message.costEstimated,
          })),
          onError: (streamError) => {
            const message = streamError.message || 'O provedor encerrou a resposta com erro.';
            updateAssistant((current) => ({
              ...current,
              status: 'error',
              errorCode: streamError.code,
              errorMessage: message,
            }));
            set({ error: message });
          },
          onDone: (envelope) => {
            const finishReason = envelope.finish_reason
              ?? (typeof envelope.finishReason === 'string' ? envelope.finishReason : undefined)
              ?? 'stop';
            updateAssistant((message) => message.status === 'error'
              ? message
              : { ...message, status: 'complete', finishReason, truncated: envelope.truncated === true });
            set((state) => {
              const messages = state.messagesByConversation[conversationId as string] ?? [];
              const totalCostUsd = conversationCost(messages);
              return {
                conversations: state.conversations.map((conversation) => conversation.id === conversationId
                  ? { ...conversation, totalCostUsd, updatedAt: Date.now(), messageCount: messages.length }
                  : conversation),
              };
            });
          },
        },
        controller.signal,
      );
    } catch (error) {
      const aborted = controller.signal.aborted || get().streamAbortRequested;
      if (aborted) {
        updateAssistant((message) => message.status === 'streaming' ? { ...message, status: 'aborted', finishReason: 'aborted' } : message);
      } else {
        const message = errorMessage(error);
        updateAssistant((current) => ({ ...current, status: 'error', errorMessage: message }));
        set({ error: message });
      }
    } finally {
      const ownsStream = get().streamController === controller || get().streamingMessageId === assistantMessage.id;
      set((state) => {
        const prefix = `${conversationId}:`;
        const streamingArtifacts = Object.fromEntries(
          Object.entries(state.streamingArtifacts).filter(([key]) => !key.startsWith(prefix)),
        );
        return ownsStream
          ? {
              isStreaming: false,
              streamingMessageId: null,
              streamingConversationId: null,
              streamController: null,
              streamAbortRequested: false,
              streamingArtifacts,
            }
          : { streamingArtifacts };
      });
      setTimeout(() => {
        const current = get();
        if (!current.isStreaming || current.streamingConversationId !== conversationId) void current.loadArtifacts(conversationId);
      }, 200);
    }
  },

  stopStreaming: () => {
    const { streamController, streamingMessageId } = get();
    if (!streamController) return;
    streamController.abort();
    set((state) => ({
      messagesByConversation: streamingMessageId && state.streamingConversationId
        ? {
            ...state.messagesByConversation,
            [state.streamingConversationId]: (state.messagesByConversation[state.streamingConversationId] ?? []).map((message) =>
              message.id === streamingMessageId && message.status === 'streaming'
                ? { ...message, status: 'aborted', finishReason: 'aborted' }
                : message,
            ),
          }
        : state.messagesByConversation,
      isStreaming: false,
      streamController: null,
      streamingMessageId: null,
      streamingConversationId: null,
      streamAbortRequested: true,
    }));
  },

  clearError: () => set({ error: null }),
}));

export function getConversationCost(messages: ChatMessage[], conversation?: Conversation): number {
  return conversation?.totalCostUsd ?? conversationCost(messages);
}

export function getMessageUsage(message: ChatMessage): Usage | undefined {
  return message.usage;
}
