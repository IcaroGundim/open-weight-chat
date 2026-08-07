import { create } from 'zustand';
import {
  ApiError,
  createConversation as createConversationRequest,
  deleteConversation as deleteConversationRequest,
  getArtifactVersion,
  saveArtifactContent,
  getArtifacts,
  getConversation,
  getConversations,
  getModels,
  getSearchSettings,
  renameConversation as renameConversationRequest,
  setConversationEffort,
  streamChat,
} from '../api';
import { getUserId } from '../token-provider';
import { useSettingsStore } from './settings';
import type {
  Attachment,
  ScienceFormat,
  ScienceLevel,
  Artifact,
  ArtifactEndEnvelope,
  ArtifactStartEnvelope,
  ChatMessage,
  Conversation,
  EffortLevel,
  ModelOption,
  SpreadsheetSelection,
  StreamErrorEnvelope,
  Usage,
} from '../types';

const SELECTED_MODEL_STORAGE_KEY = 'open-weight-chat.selected-model';
let sessionEpoch = 0;

function isCurrentSession(epoch: number): boolean {
  return epoch === sessionEpoch;
}

/**
 * Chave de preferência do modelo no localStorage, particionada por usuário
 * (multiusuário com Clerk). Sem usuário logado, usa a chave sem sufixo como
 * fallback para não quebrar ambientes sem autenticação.
 */
function selectedModelStorageKey(): string {
  const userId = getUserId();
  return userId ? `${SELECTED_MODEL_STORAGE_KEY}.${userId}` : SELECTED_MODEL_STORAGE_KEY;
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function initialSelectedModelId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(selectedModelStorageKey());
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
  openSpreadsheetId: string | null;
  pendingSpreadsheetSelection: SpreadsheetSelection | null;
  isLoadingModels: boolean;
  /**
   * Existe busca configurada e ligada nas configurações?
   *
   * O botão de busca do compositor depende disto: um interruptor que não liga
   * nada é pior do que interruptor nenhum — ele promete um recurso e não
   * explica por que não acontece.
   */
  searchAvailable: boolean;
  isLoadingConversations: boolean;
  loadingConversationId: string | null;
  isStreaming: boolean;
  streamingConversationId: string | null;
  streamingMessageId: string | null;
  streamController: AbortController | null;
  streamAbortRequested: boolean;
  /**
   * Nível escolhido antes de a conversa existir. Uma conversa nova só ganha
   * linha no banco no primeiro envio, então a escolha feita até lá não tem
   * onde ser gravada — fica aqui e entra no `createConversation`.
   */
  pendingEffort: EffortLevel | null;
  error: string | null;

  loadModels: () => Promise<void>;
  loadSearchAvailability: () => Promise<void>;
  loadConversations: () => Promise<void>;
  selectConversation: (id: string | null) => Promise<void>;
  newConversation: () => void;
  createConversation: (title?: string) => Promise<Conversation | null>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setSelectedModel: (id: string) => void;
  setEffort: (effort: EffortLevel) => Promise<void>;
  setScience: (level: ScienceLevel, format?: ScienceFormat) => void;
  pendingScience: { level: ScienceLevel; format: ScienceFormat } | null;
  loadArtifacts: (conversationId: string) => Promise<void>;
  openArtifact: (selection: { slug: string; version: number }) => void;
  closeArtifact: () => void;
  openSpreadsheet: (id: string) => void;
  closeSpreadsheet: () => void;
  useSpreadsheetSelection: (selection: SpreadsheetSelection | null) => void;
  selectArtifactVersion: (slug: string, version: number) => Promise<void>;
  saveArtifact: (slug: string, content: string) => Promise<void>;
  promoteCodeArtifact: (messageId: string, code: string, language?: string) => void;
  sendMessage: (content: string, attachments?: Attachment[]) => Promise<void>;
  stopStreaming: () => void;
  clearError: () => void;
  resetState: () => void;
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
  openSpreadsheetId: null,
  pendingSpreadsheetSelection: null,
  isLoadingModels: false,
  searchAvailable: false,
  isLoadingConversations: false,
  loadingConversationId: null,
  isStreaming: false,
  streamingConversationId: null,
  streamingMessageId: null,
  streamController: null,
  streamAbortRequested: false,
  pendingEffort: null,
  pendingScience: null,
  error: null,

  loadSearchAvailability: async () => {
    const epoch = sessionEpoch;
    try {
      const { settings } = await getSearchSettings();
      if (!isCurrentSession(epoch)) return;
      set({ searchAvailable: Boolean(settings?.enabled) });
    } catch {
      // Falha aqui não é erro do usuário nem impede conversar: o botão some e
      // a busca fica indisponível, que é o mesmo estado de não ter configurado.
      if (isCurrentSession(epoch)) set({ searchAvailable: false });
    }
  },

  loadModels: async () => {
    const epoch = sessionEpoch;
    set({ isLoadingModels: true, error: null });
    try {
      const { models, configErrors } = await getModels();
      if (!isCurrentSession(epoch)) return;
      const current = get().selectedModelId;
      const configuredModels = models.filter((model) => model.configured !== false);
      const selectedModelId = models.some((model) => model.id === current && model.configured !== false)
        ? current
        : (configuredModels[0] ?? models[0])?.id ?? null;
      if (typeof window !== 'undefined') {
        const storageKey = selectedModelStorageKey();
        if (selectedModelId) {
          window.localStorage.setItem(storageKey, selectedModelId);
        } else {
          window.localStorage.removeItem(storageKey);
        }
      }
      // Provedor personalizado mal configurado nunca falha em silêncio: o
      // usuário precisa saber que declarou algo e que não entrou.
      const configError = configErrors.length > 0
        ? `Provedor personalizado ignorado — ${configErrors.join(' · ')}`
        : null;
      set({ models, selectedModelId, isLoadingModels: false, error: configError });
    } catch (error) {
      if (!isCurrentSession(epoch)) return;
      set({ models: [], isLoadingModels: false, error: errorMessage(error) });
    }
  },

  loadConversations: async () => {
    const epoch = sessionEpoch;
    set({ isLoadingConversations: true, error: null });
    try {
      const conversations = await getConversations();
      if (!isCurrentSession(epoch)) return;
      set((state) => {
        const active = state.activeConversationId;
        const activeConversationId = active && conversations.some((conversation) => conversation.id === active)
          ? active
          : null;
        return {
          conversations,
          activeConversationId,
          isLoadingConversations: false,
          ...(active && !activeConversationId ? {
            openArtifactSelection: null,
            openSpreadsheetId: null,
            pendingSpreadsheetSelection: null,
          } : {}),
        };
      });
    } catch (error) {
      if (!isCurrentSession(epoch)) return;
      set({ isLoadingConversations: false, error: errorMessage(error) });
    }
  },

  loadArtifacts: async (conversationId) => {
    const epoch = sessionEpoch;
    try {
      const artifacts = await getArtifacts(conversationId);
      if (!isCurrentSession(epoch)) return;
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
      if (!isCurrentSession(epoch)) return;
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
    const epoch = sessionEpoch;
    if (!id) {
      set({ activeConversationId: null, openArtifactSelection: null, openSpreadsheetId: null, pendingSpreadsheetSelection: null, error: null });
      return;
    }
    set({ activeConversationId: id, openArtifactSelection: null, openSpreadsheetId: null, pendingSpreadsheetSelection: null, error: null });
    if (get().messagesLoaded[id]) return;

    set({ loadingConversationId: id });
    try {
      const result = await getConversation(id);
      if (!isCurrentSession(epoch)) return;
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
      if (!isCurrentSession(epoch)) return;
      set((state) => ({ loadingConversationId: state.loadingConversationId === id ? null : state.loadingConversationId, error: errorMessage(error) }));
    }
  },

  newConversation: () => set({ activeConversationId: null, openArtifactSelection: null, openSpreadsheetId: null, pendingSpreadsheetSelection: null, pendingEffort: null, error: null }),

  createConversation: async (title = 'Nova conversa') => {
    const epoch = sessionEpoch;
    const selected = get().models.find((model) => model.id === get().selectedModelId);
    try {
      const conversation = await createConversationRequest({
        title,
        providerId: selected?.providerId,
        modelId: selected?.id,
        effort: get().pendingEffort ?? useSettingsStore.getState().defaultEffort,
      });
      if (!isCurrentSession(epoch)) return null;
      set((state) => ({
        conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
        activeConversationId: conversation.id,
        openArtifactSelection: null,
        openSpreadsheetId: null,
        pendingSpreadsheetSelection: null,
        messagesByConversation: { ...state.messagesByConversation, [conversation.id]: [] },
        messagesLoaded: { ...state.messagesLoaded, [conversation.id]: true },
        pendingEffort: null,
        error: null,
      }));
      return conversation;
    } catch (error) {
      if (!isCurrentSession(epoch)) return null;
      set({ error: errorMessage(error) });
      return null;
    }
  },

  renameConversation: async (id, title) => {
    const epoch = sessionEpoch;
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    try {
      const updated = await renameConversationRequest(id, normalizedTitle);
      if (!isCurrentSession(epoch)) return;
      set((state) => ({
        conversations: state.conversations.map((conversation) => conversation.id === id
          ? { ...conversation, title: updated?.title ?? normalizedTitle }
          : conversation),
        error: null,
      }));
    } catch (error) {
      if (!isCurrentSession(epoch)) return;
      set({ error: errorMessage(error) });
    }
  },

  deleteConversation: async (id) => {
    const epoch = sessionEpoch;
    try {
      await deleteConversationRequest(id);
      if (!isCurrentSession(epoch)) return;
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
          openSpreadsheetId: state.activeConversationId === id ? null : state.openSpreadsheetId,
          pendingSpreadsheetSelection: state.activeConversationId === id ? null : state.pendingSpreadsheetSelection,
          error: null,
        };
      });
    } catch (error) {
      if (!isCurrentSession(epoch)) return;
      set({ error: errorMessage(error) });
    }
  },

  setSelectedModel: (id) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(selectedModelStorageKey(), id);
    }
    set({ selectedModelId: id });
  },

  /**
   * Escolha do modo Science antes do envio.
   *
   * Fica pendente no cliente e só é gravada na conversa quando a mensagem sai
   * — do mesmo jeito que o esforço. Gravar antes criaria conversa vazia só
   * porque alguém mexeu no seletor.
   */
  setScience: (level, format) => {
    set((state) => ({
      pendingScience: {
        level,
        format: format ?? state.pendingScience?.format
          ?? state.conversations.find((c) => c.id === state.activeConversationId)?.scienceFormat
          ?? 'markdown',
      },
    }));
  },

  setEffort: async (effort) => {
    const epoch = sessionEpoch;
    const id = get().activeConversationId;
    // Sem conversa ainda: guarda a escolha para o createConversation do
    // primeiro envio, em vez de descartá-la silenciosamente.
    if (!id) {
      set({ pendingEffort: effort });
      return;
    }
    const previous = get().conversations.find((conversation) => conversation.id === id)?.effort ?? 'auto';
    if (previous === effort) return;
    const apply = (value: EffortLevel) => set((state) => ({
      conversations: state.conversations.map((conversation) => (
        conversation.id === id ? { ...conversation, effort: value } : conversation
      )),
    }));
    apply(effort);
    try {
      await setConversationEffort(id, effort);
    } catch (error) {
      // Reverte: um seletor mostrando um nível que o servidor não gravou
      // faria o usuário pagar por um esforço que não pediu.
      if (!isCurrentSession(epoch)) return;
      apply(previous);
      set({ error: errorMessage(error) });
    }
  },

  openArtifact: (selection) => set({ openArtifactSelection: selection, openSpreadsheetId: null }),

  closeArtifact: () => set({ openArtifactSelection: null }),

  openSpreadsheet: (id) => set({ openSpreadsheetId: id, openArtifactSelection: null }),

  closeSpreadsheet: () => set({ openSpreadsheetId: null }),

  useSpreadsheetSelection: (selection) => set({ pendingSpreadsheetSelection: selection }),

  saveArtifact: async (slug, content) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    const versao = await saveArtifactContent(conversationId, slug, content);
    // Recarrega e já aponta para a versão nova: deixar o painel na anterior
    // faria a edição parecer não ter sido gravada.
    await get().loadArtifacts(conversationId);
    if (versao) get().openArtifact({ slug, version: versao.version });
  },

  selectArtifactVersion: async (slug, version) => {
    const epoch = sessionEpoch;
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    set({ openArtifactSelection: { slug, version } });
    const artifact = (get().artifactsByConversation[conversationId] ?? []).find((item) => item.slug === slug);
    if (artifactVersion(artifact, version)) return;
    try {
      const remoteVersion = await getArtifactVersion(conversationId, slug, version);
      if (!isCurrentSession(epoch)) return;
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

  sendMessage: async (content, attachments = []) => {
    const epoch = sessionEpoch;
    const trimmed = content.trim();
    const spreadsheetSelection = get().pendingSpreadsheetSelection;
    // Anexo sozinho já é uma mensagem: mandar um PDF e pedir "resume" na
    // mensagem seguinte é uso normal, e exigir texto aqui obrigaria o usuário
    // a escrever algo só para destravar o botão.
    if ((!trimmed && attachments.length === 0) || get().isStreaming) return;

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
      const created = await get().createConversation((trimmed || attachments[0]?.filename || 'Nova conversa').slice(0, 56));
      if (!created || !isCurrentSession(epoch)) return;
      conversationId = created.id;
    }

    const userMessage: ChatMessage = {
      id: makeId('user'),
      conversationId,
      role: 'user',
      content: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
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
      // O relógio começa no envio, não no primeiro token: o tempo de espera
      // faz parte do turno, e escondê-lo daria uma velocidade otimista.
      startedAt: Date.now(),
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
      pendingSpreadsheetSelection: null,
    }));

    const updateAssistant = (update: (message: ChatMessage) => ChatMessage) => {
      if (!isCurrentSession(epoch)) return;
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
          effort: get().conversations.find((conversation) => conversation.id === conversationId)?.effort ?? 'auto',
          // Sempre explícito: o servidor trata ausente como ligado, e é a
          // interface que conhece a escolha do usuário.
          webSearch: useSettingsStore.getState().webSearch,
          ...(attachments.length > 0 ? { attachmentIds: attachments.map((anexo) => anexo.id) } : {}),
          ...(spreadsheetSelection ? {
            spreadsheetSelection: {
              attachmentId: spreadsheetSelection.attachmentId,
              version: spreadsheetSelection.version,
              sheet: spreadsheetSelection.sheet,
              startRow: spreadsheetSelection.startRow,
              startColumn: spreadsheetSelection.startColumn,
              endRow: spreadsheetSelection.endRow,
              endColumn: spreadsheetSelection.endColumn,
            },
          } : {}),
          ...(get().pendingScience ? {
            scienceLevel: get().pendingScience!.level,
            scienceFormat: get().pendingScience!.format,
          } : {}),
        },
        {
          onTrace: (evento) => updateAssistant((message) => ({
            ...message,
            trace: [...(message.trace ?? []), evento],
          })),
          onScienceDelta: (delta) => updateAssistant((message) => ({
            ...message,
            // Troca de agente zera o rascunho: o bastidor mostra o que está
            // sendo escrito AGORA, não a colagem de tudo que já passou.
            scienceDraft: message.scienceDraft?.index === delta.index
              ? {
                ...message.scienceDraft,
                text: message.scienceDraft.text + delta.text,
                reasoning: message.scienceDraft.reasoning + delta.reasoning,
              }
              : { role: delta.role, index: delta.index, text: delta.text, reasoning: delta.reasoning },
          })),
          onScienceStage: (stage) => updateAssistant((message) => {
            // Substitui o estágio de mesmo índice em vez de acumular: cada um
            // manda "start" e depois "done", e o que interessa é o estado
            // corrente de cada passo, não o histórico dos avisos.
            const anteriores = (message.scienceStages ?? []).filter((s) => s.index !== stage.index);
            return { ...message, scienceStages: [...anteriores, stage].sort((a, b) => a.index - b.index) };
          }),
          onText: (text) => updateAssistant((message) => ({
            ...message,
            // A resposta final começou: o bastidor sai de cena.
            scienceDraft: undefined,
            content: message.content + text,
          })),
          onReasoning: (reasoning) => updateAssistant((message) => ({ ...message, reasoning: `${message.reasoning ?? ''}${reasoning}` })),
          // A busca fica GUARDADA NA MENSAGEM, não num estado à parte: sem as
          // fontes, quem lê a resposta depois não tem como conferir de onde
          // veio o que está lendo. Elas são parte do que aquela resposta é.
          onSearchStart: ({ query, round }) => {
            if (!isCurrentSession(epoch)) return;
            updateAssistant((message) => ({
              ...message,
              searches: [...(message.searches ?? []), { query, round, results: [], done: false }],
            }));
          },
          onSearchEnd: ({ query, round, results, failure }) => {
            if (!isCurrentSession(epoch)) return;
            updateAssistant((message) => {
              const buscas = message.searches ?? [];
              const indice = buscas.findIndex((busca) => busca.round === round && !busca.done);
              const concluida = { query, round, results, failure: failure ?? null, done: true };
              // Se o `search_start` se perdeu (reconexão, por exemplo), o
              // `search_end` ainda registra a busca em vez de sumir com ela.
              if (indice < 0) return { ...message, searches: [...buscas, concluida] };
              return { ...message, searches: buscas.map((busca, i) => (i === indice ? concluida : busca)) };
            });
          },
          onArtifactStart: (artifact: ArtifactStartEnvelope) => {
            if (!isCurrentSession(epoch)) return;
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
            if (!isCurrentSession(epoch)) return;
            const key = streamingArtifactKey(conversationId, slug);
            set((state) => ({
              streamingArtifacts: { ...state.streamingArtifacts, [key]: (state.streamingArtifacts[key] ?? '') + text },
            }));
          },
          onArtifactEnd: (artifact) => {
            if (!isCurrentSession(epoch)) return;
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
              if (!isCurrentSession(epoch)) return;
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
              // A versão otimista já foi exibida; falhas de reconciliação não interrompem o chat.
            });
          },
          onSpreadsheetReady: ({ attachment }) => {
            if (!isCurrentSession(epoch)) return;
            updateAssistant((message) => ({
              ...message,
              attachments: [...(message.attachments ?? []).filter((item) => item.id !== attachment.id), attachment],
            }));
            set({ openSpreadsheetId: attachment.id, openArtifactSelection: null });
          },
          onUsage: (usage) => updateAssistant((message) => ({
            ...message,
            usage: { ...message.usage, ...usage },
            costUsd: usage.costUsd ?? message.costUsd,
            costEstimated: usage.costEstimated ?? message.costEstimated,
          })),
          onError: (streamError) => {
            if (!isCurrentSession(epoch)) return;
            const message = streamError.message || 'O provedor encerrou a resposta com erro.';
            updateAssistant((current) => ({
              ...current,
              status: 'error',
              finishedAt: Date.now(),
              errorCode: streamError.code,
              errorMessage: message,
            }));
            set({ error: message });
          },
          onDone: (envelope) => {
            if (!isCurrentSession(epoch)) return;
            const finishReason = envelope.finish_reason
              ?? (typeof envelope.finishReason === 'string' ? envelope.finishReason : undefined)
              ?? 'stop';
            updateAssistant((message) => message.status === 'error'
              ? message
              : { ...message, status: 'complete', finishReason, finishedAt: Date.now(), truncated: envelope.truncated === true });
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
      if (!isCurrentSession(epoch)) return;
      const aborted = controller.signal.aborted || get().streamAbortRequested;
      if (aborted) {
        updateAssistant((message) => message.status === 'streaming' ? { ...message, status: 'aborted', finishReason: 'aborted', finishedAt: Date.now() } : message);
      } else {
        const message = errorMessage(error);
        updateAssistant((current) => ({ ...current, status: 'error', errorMessage: message, finishedAt: Date.now() }));
        set({ error: message });
      }
    } finally {
      if (!isCurrentSession(epoch)) return;
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
        if (!isCurrentSession(epoch)) return;
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
                ? { ...message, status: 'aborted', finishReason: 'aborted', finishedAt: Date.now() }
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

  /**
   * Volta ao estado de fábrica. Chamado quando o usuário troca (signOut ou
   * troca de conta no Clerk) para que conversas, artefatos e o modelo do
   * usuário anterior nunca vazem para o próximo.
   */
  resetState: () => {
    sessionEpoch += 1;
    get().streamController?.abort();
    set({
      conversations: [],
      messagesByConversation: {},
      messagesLoaded: {},
      activeConversationId: null,
      models: [],
      selectedModelId: initialSelectedModelId(),
      artifactsByConversation: {},
      streamingArtifacts: {},
      openArtifactSelection: null,
      openSpreadsheetId: null,
      pendingSpreadsheetSelection: null,
      isLoadingModels: false,
      isLoadingConversations: false,
      loadingConversationId: null,
      isStreaming: false,
      streamingConversationId: null,
      streamingMessageId: null,
      streamController: null,
      streamAbortRequested: false,
      // Troca de conta: a escolha pendente é do usuário anterior e não pode
      // atravessar para a primeira conversa da conta seguinte.
      pendingEffort: null,
      error: null,
    });
  },
}));

export function getConversationCost(messages: ChatMessage[], conversation?: Conversation): number {
  return conversation?.totalCostUsd ?? conversationCost(messages);
}

export function getMessageUsage(message: ChatMessage): Usage | undefined {
  return message.usage;
}
