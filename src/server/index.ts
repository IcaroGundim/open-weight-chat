import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  ChatRequestSchema,
  CreateConversationSchema,
  ProviderIdSchema,
  ProviderSettingsInputSchema,
  UpdateConversationSchema,
  type ProviderSettings,
  type SseEnvelope,
  type ProviderId,
} from '../shared/types';
import { applyEdits } from './artifacts/patch';
import { buildArtifactContext } from './artifacts/context';
import { artifactMarker } from './artifacts/marker';
import { createArtifactParser, type ParserEvent } from './artifacts/parser';
import { composeSystemPrompt } from './artifacts/system-prompt';
import { calculateUsageAndCost } from './cost';
import { estimateContextTokens, estimateTokens, trimContext, type ContextMessage } from './context';
import { AppError, errorPayload, normalizeError } from './errors';
import { streamOpenAICompatible } from './llm-client';
import { ChatDatabase } from './db/queries';
import {
  getDefaultModelSelection,
  getModel,
  getModelsCatalog,
  getProvider,
  getProviderApiKey,
  getProviderBaseURL,
  setRuntimeProviders,
  type ProviderModelConfig,
  type RuntimeProvider,
} from './providers.config';
import { decryptSecret, encryptSecret, getSecretStorageStatus } from './secrets';
import { discoverProviderModels } from './providers.discovery';

// Node 24 can load the local .env without adding a dotenv dependency. Existing
// process variables still remain the source of truth in deployed environments.
try {
  process.loadEnvFile(process.env.ENV_FILE ?? '.env');
} catch {
  // A .env file is optional; production can inject variables through the process manager.
}

export interface AppOptions {
  db?: ChatDatabase;
  fetchImpl?: typeof fetch;
  staticRoot?: string;
}

function validationMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

async function parseJson<T>(c: Context, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError('UNKNOWN', { status: 400, message: 'O corpo da requisição precisa ser um JSON válido.' });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('UNKNOWN', { status: 400, message: validationMessage(parsed.error) });
  }
  return parsed.data;
}

function jsonError(c: Context, error: unknown): Response {
  const normalized = normalizeError(error);
  return c.json({ error: errorPayload(normalized) }, normalized.status as 400);
}

function assertModelSelection(providerId: string, modelId: string): { providerId: ProviderId; model: ProviderModelConfig } {
  const provider = getProvider(providerId);
  const model = getModel(providerId, modelId);
  if (!provider || !model) {
    throw new AppError('MODEL_NOT_FOUND', {
      status: 404,
      message: 'O provedor ou modelo selecionado não está configurado no servidor.',
    });
  }
  return { providerId: provider.id, model };
}

function conversationContext(
  systemPrompt: string | null,
  messages: ReturnType<ChatDatabase['getMessages']>,
): ContextMessage[] {
  const context: ContextMessage[] = [{ role: 'system', content: composeSystemPrompt(systemPrompt) }];
  for (const message of messages) {
    if (message.role === 'system') continue;
    // Empty assistant placeholders/errors are persistence records, not context.
    if (message.role === 'assistant' && !message.content.trim()) continue;
    context.push({ role: message.role, content: message.content });
  }
  return context;
}

function requestContext(
  systemPrompt: string | null,
  messages: ReturnType<ChatDatabase['getMessages']>,
  artifacts: ReturnType<ChatDatabase['getArtifacts']>,
  contextWindow: number,
): { messages: ContextMessage[]; truncated: boolean } {
  const full = conversationContext(systemPrompt, messages);
  const newest = full.at(-1)?.role === 'user' ? full.at(-1) : null;
  const history = newest ? full.slice(0, -1) : full;
  const artifactState = buildArtifactContext(artifacts, contextWindow);
  const reserved = [newest, artifactState.message].filter((message): message is ContextMessage => Boolean(message));
  const reservedTokens = estimateContextTokens(reserved);
  const targetBudget = Math.max(1, Math.floor(contextWindow * 0.7) - reservedTokens);
  const effectiveWindow = Math.max(1, Math.ceil(targetBudget / 0.7));
  const trimmed = trimContext(history, effectiveWindow);
  return {
    messages: [
      ...trimmed.messages,
      ...(artifactState.message ? [artifactState.message] : []),
      ...(newest ? [newest] : []),
    ],
    truncated: trimmed.truncated,
  };
}

function writeEnvelope(stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never, envelope: SseEnvelope): Promise<void> {
  return stream.writeSSE({ event: envelope.type, data: JSON.stringify(envelope) });
}

function routeErrorHandler(error: unknown, c: Context): Response {
  return jsonError(c, error);
}

/**
 * Recarrega no catálogo os provedores cadastrados pela interface, decifrando as
 * chaves apenas para a memória do processo. Registro inválido é ignorado em vez
 * de derrubar o catálogo inteiro.
 */
function refreshRuntimeProviders(db: ChatDatabase): void {
  const runtime: RuntimeProvider[] = [];
  for (const record of db.listProviderSettings()) {
    const parsed = ProviderSettingsInputSchema.safeParse({
      label: record.label,
      baseURL: record.baseURL,
      verifiedAt: record.verifiedAt,
      models: record.models,
    });
    if (!parsed.success) continue;
    runtime.push({
      config: {
        id: record.id,
        label: parsed.data.label,
        baseURL: parsed.data.baseURL,
        requiresApiKey: true,
        verifiedAt: record.verifiedAt ?? '',
        models: parsed.data.models.map((model) => ({
          id: model.id,
          label: model.label ?? model.id,
          ctx: model.ctx,
          reasoning: model.reasoning ?? false,
          pricing: {
            inputPerMillion: model.pricing?.inputPerMillion ?? null,
            cachedInputPerMillion: model.pricing?.cachedInputPerMillion ?? null,
            outputPerMillion: model.pricing?.outputPerMillion ?? null,
          },
        })),
      },
      apiKey: decryptSecret(record.apiKeyCipher),
    });
  }
  setRuntimeProviders(runtime);
}

function toProviderSettings(record: ReturnType<ChatDatabase['listProviderSettings']>[number]): ProviderSettings {
  const models = ProviderSettingsInputSchema.shape.models.safeParse(record.models);
  return {
    id: record.id,
    label: record.label,
    baseURL: record.baseURL,
    verifiedAt: record.verifiedAt,
    models: models.success ? models.data : [],
    // A chave nunca sai daqui; o navegador só sabe se existe.
    hasKey: Boolean(record.apiKeyCipher),
    updatedAt: record.updatedAt,
  };
}

export function createApp(options: AppOptions = {}): Hono {
  const db = options.db ?? new ChatDatabase();
  const app = new Hono();
  refreshRuntimeProviders(db);

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    await next();
  });

  app.get('/api/models', (c) => c.json(getModelsCatalog()));

  app.get('/api/providers', (c) => c.json({
    providers: db.listProviderSettings().map(toProviderSettings),
    secretStorage: getSecretStorageStatus(),
  }));

  app.put('/api/providers/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const idCheck = ProviderIdSchema.safeParse(id);
      if (!idCheck.success) {
        throw new AppError('UNKNOWN', { status: 400, message: validationMessage(idCheck.error) });
      }
      const body = await parseJson(c, ProviderSettingsInputSchema);

      let apiKeyCipher: string | null | undefined;
      if (body.apiKey === null) {
        apiKeyCipher = null;
      } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        const status = getSecretStorageStatus();
        if (!status.available) {
          throw new AppError('UNKNOWN', { status: 400, message: status.reason ?? 'Não é possível guardar chaves.' });
        }
        apiKeyCipher = encryptSecret(body.apiKey.trim());
      }

      const record = db.upsertProviderSettings({
        id,
        label: body.label,
        baseURL: body.baseURL,
        models: body.models,
        verifiedAt: body.verifiedAt ?? null,
        apiKeyCipher,
      });
      refreshRuntimeProviders(db);
      return c.json({ provider: toProviderSettings(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.post('/api/providers/:id/discover-models', async (c) => {
    try {
      const id = c.req.param('id');
      const idCheck = ProviderIdSchema.safeParse(id);
      if (!idCheck.success) {
        throw new AppError('UNKNOWN', { status: 400, message: validationMessage(idCheck.error) });
      }
      const record = db.listProviderSettings().find((item) => item.id === id);
      if (!record) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Provedor não encontrado.' });
      }
      const provider = getProvider(id);
      if (!provider) {
        throw new AppError('UNKNOWN', { status: 400, message: 'O provedor ainda não está disponível no catálogo.' });
      }
      const models = await discoverProviderModels(
        getProviderBaseURL(provider),
        getProviderApiKey(provider),
        options.fetchImpl ?? fetch,
      );
      const updated = db.upsertProviderSettings({
        id,
        label: record.label,
        baseURL: record.baseURL,
        models,
        verifiedAt: new Date().toISOString().slice(0, 10),
      });
      refreshRuntimeProviders(db);
      return c.json({ provider: toProviderSettings(updated), discovered: models.length });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.delete('/api/providers/:id', (c) => {
    const deleted = db.deleteProviderSettings(c.req.param('id'));
    if (!deleted) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Provedor não encontrado.' }));
    refreshRuntimeProviders(db);
    return c.json({ ok: true as const });
  });

  app.get('/api/analytics/costs', (c) => {
    const rawDays = Number(c.req.query('days') ?? 30);
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.trunc(rawDays))) : 30;
    return c.json(db.getCostAnalytics(days));
  });

  app.get('/api/conversations/search', (c) => {
    const query = c.req.query('q')?.trim() ?? '';
    if (!query) return c.json({ results: [] });
    if (query.length > 200) return jsonError(c, new AppError('UNKNOWN', { status: 400, message: 'A busca pode ter no máximo 200 caracteres.' }));
    try {
      return c.json({ results: db.searchConversations(query) });
    } catch {
      return jsonError(c, new AppError('UNKNOWN', { status: 400, message: 'A expressão de busca não é válida.' }));
    }
  });

  app.get('/api/conversations', (c) => {
    const includeArchived = c.req.query('includeArchived') === 'true';
    return c.json({ conversations: db.listConversations({ includeArchived }) });
  });

  app.post('/api/conversations', async (c) => {
    try {
      const body = await parseJson(c, CreateConversationSchema);
      const defaults = getDefaultModelSelection();
      const providerId = body.providerId ?? defaults.providerId;
      const modelId = body.modelId ?? (body.providerId ? getProvider(body.providerId)?.models[0]?.id : defaults.modelId);
      if (!modelId) throw new AppError('MODEL_NOT_FOUND', { status: 404 });
      assertModelSelection(providerId, modelId);
      const conversation = db.createConversation({
        title: body.title,
        providerId,
        modelId,
        systemPrompt: body.systemPrompt,
      });
      return c.json({ conversation }, 201);
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.get('/api/conversations/:id', (c) => {
    const conversation = db.getConversation(c.req.param('id'));
    if (!conversation) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ conversation });
  });

  app.patch('/api/conversations/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const body = await parseJson(c, UpdateConversationSchema);
      const current = db.getConversation(id);
      if (!current) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      const providerId = body.providerId ?? current.providerId;
      const modelId = body.modelId ?? current.modelId;
      assertModelSelection(providerId, modelId);
      const conversation = db.updateConversation(id, { ...body, providerId, modelId });
      if (!conversation) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      return c.json({ conversation });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.delete('/api/conversations/:id', (c) => {
    const deleted = db.deleteConversation(c.req.param('id'));
    if (!deleted) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ ok: true as const });
  });

  app.get('/api/conversations/:id/messages', (c) => {
    const id = c.req.param('id');
    if (!db.getConversation(id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ messages: db.getMessages(id) });
  });

  app.get('/api/conversations/:id/artifacts', (c) => {
    const id = c.req.param('id');
    if (!db.getConversation(id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ artifacts: db.getArtifacts(id) });
  });

  app.get('/api/conversations/:id/artifacts/:slug/versions/:version', (c) => {
    const id = c.req.param('id');
    if (!db.getConversation(id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    const version = Number(c.req.param('version'));
    if (!Number.isSafeInteger(version) || version < 1) {
      return jsonError(c, new AppError('UNKNOWN', { status: 400, message: 'A versão do artefato é inválida.' }));
    }
    const artifactVersion = db.getArtifactVersion(id, c.req.param('slug'), version);
    if (!artifactVersion) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Versão do artefato não encontrada.' }));
    return c.json({ version: artifactVersion });
  });

  app.post('/api/chat', async (c) => {
    let request: ReturnType<typeof ChatRequestSchema.parse>;
    try {
      request = await parseJson(c, ChatRequestSchema);
      const selection = assertModelSelection(request.providerId, request.modelId);
      let conversation = request.conversationId ? db.getConversation(request.conversationId) : null;
      if (request.conversationId && !conversation) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      }
      if (!conversation) {
        conversation = db.createConversation({ providerId: selection.providerId, modelId: selection.model.id });
      } else if (conversation.providerId !== selection.providerId || conversation.modelId !== selection.model.id) {
        conversation = db.updateConversation(conversation.id, {
          providerId: selection.providerId,
          modelId: selection.model.id,
        });
        if (!conversation) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      }

      db.insertMessage({
        conversationId: conversation.id,
        role: 'user',
        content: request.content,
        providerId: selection.providerId,
        modelId: selection.model.id,
      });
      const context = requestContext(
        conversation.systemPrompt,
        db.getMessages(conversation.id),
        db.getArtifacts(conversation.id),
        selection.model.ctx,
      );
      const promptText = context.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
      const assistant = db.insertMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        reasoning: '',
        providerId: selection.providerId,
        modelId: selection.model.id,
      });
      const requestSignal = c.req.raw.signal;
      const upstreamController = new AbortController();
      let clientAborted = requestSignal.aborted;
      const abortFromClient = () => {
        clientAborted = true;
        if (!upstreamController.signal.aborted) upstreamController.abort(requestSignal.reason);
      };
      requestSignal.addEventListener('abort', abortFromClient, { once: true });
      if (requestSignal.aborted) abortFromClient();
      const startedAt = Date.now();
      let content = '';
      let reasoning = '';
      let rawUsage: Record<string, unknown> | null = null;
      let finishReason: string | null = null;
      let lastPersistedAt = 0;
      let lastPersistedLength = 0;
      const parser = createArtifactParser();
      const artifactBuffers = new Map<string, string>();
      const openArtifacts = new Map<string, {
        version: number;
        operation: 'create' | 'rewrite';
        kind: 'markdown' | 'code' | 'svg' | 'mermaid';
        language: string | null;
        title: string;
      }>();
      const producedVersions: Array<{ slug: string; version: number; content: string; completionText: string; costBasisTokens: number }> = [];
      const completedArtifactEnds: Array<{ slug: string; version: number; truncated: boolean }> = [];
      let parserEnded = false;

      const persistPartial = (force = false) => {
        const now = Date.now();
        if (!force && now - lastPersistedAt < 250 && content.length - lastPersistedLength < 1_000) return;
        db.updateMessage(assistant.id, { content, reasoning });
        lastPersistedAt = now;
        lastPersistedLength = content.length;
      };

      const emit = async (stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never, envelope: SseEnvelope) => {
        if (!stream.aborted) await writeEnvelope(stream, envelope);
      };

      const consumeParserEvents = async (
        events: ParserEvent[],
        stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never,
      ) => {
        for (const parserEvent of events) {
          if (parserEvent.kind === 'text') {
            content += parserEvent.text;
            await emit(stream, {
              type: 'text',
              text: parserEvent.text,
              conversationId: conversation.id,
              messageId: assistant.id,
            });
            continue;
          }
          if (parserEvent.kind === 'artifact_open') {
            const existing = db.getArtifacts(conversation.id).find((artifact) => artifact.slug === parserEvent.slug);
            const artifact = db.upsertArtifact({
              conversationId: conversation.id,
              slug: parserEvent.slug,
              kind: parserEvent.type,
              language: parserEvent.language,
              title: parserEvent.title,
            });
            const version = artifact.currentVersion + 1;
            openArtifacts.set(parserEvent.slug, {
              version,
              operation: existing ? 'rewrite' : 'create',
              kind: parserEvent.type,
              language: parserEvent.language,
              title: parserEvent.title,
            });
            artifactBuffers.set(parserEvent.slug, '');
            content += `\n\n${artifactMarker(parserEvent.slug, version)}\n\n`;
            await emit(stream, {
              type: 'artifact_start',
              slug: parserEvent.slug,
              kind: parserEvent.type,
              language: parserEvent.language,
              title: parserEvent.title,
              version,
              operation: existing ? 'rewrite' : 'create',
              conversationId: conversation.id,
              messageId: assistant.id,
            });
            continue;
          }
          if (parserEvent.kind === 'artifact_body') {
            const current = artifactBuffers.get(parserEvent.slug);
            if (current === undefined) continue;
            artifactBuffers.set(parserEvent.slug, current + parserEvent.text);
            await emit(stream, {
              type: 'artifact_delta',
              slug: parserEvent.slug,
              text: parserEvent.text,
              conversationId: conversation.id,
              messageId: assistant.id,
            });
            continue;
          }
          if (parserEvent.kind === 'artifact_close') {
            const open = openArtifacts.get(parserEvent.slug);
            const body = artifactBuffers.get(parserEvent.slug) ?? '';
            if (open) {
              db.insertArtifactVersion({
                conversationId: conversation.id,
                slug: parserEvent.slug,
                kind: open.kind,
                language: open.language,
                title: open.title,
                content: body,
                operation: open.operation,
                messageId: assistant.id,
                truncated: parserEvent.truncated,
                version: open.version,
              });
              producedVersions.push({
                slug: parserEvent.slug,
                version: open.version,
                content: body,
                completionText: body,
                costBasisTokens: Math.max(1, estimateTokens(body)),
              });
              completedArtifactEnds.push({ slug: parserEvent.slug, version: open.version, truncated: parserEvent.truncated });
            }
            openArtifacts.delete(parserEvent.slug);
            artifactBuffers.delete(parserEvent.slug);
            continue;
          }
          const current = db.getArtifacts(conversation.id).find((artifact) => artifact.slug === parserEvent.slug);
          const currentVersion = current?.versions.find((version) => version.version === current.currentVersion);
          if (!current || !currentVersion) {
            await emit(stream, {
              type: 'error',
              error: errorPayload(new AppError('UNKNOWN', { status: 400, message: `Não encontrei o artefato “${parserEvent.slug}” para revisar.` })),
              conversationId: conversation.id,
              messageId: assistant.id,
            });
            continue;
          }
          const patched = applyEdits(currentVersion.content, parserEvent.edits);
          if (!patched.ok) {
            const reason = patched.reason === 'not_found' ? 'não foi encontrado' : 'não é único';
            await emit(stream, {
              type: 'error',
              error: errorPayload(new AppError('UNKNOWN', { status: 400, message: `O trecho para revisão ${reason} no artefato “${parserEvent.slug}”.` })),
              conversationId: conversation.id,
              messageId: assistant.id,
            });
            continue;
          }
          const version = current.currentVersion + 1;
          const patchText = parserEvent.edits.map((edit) => `${edit.find}\n${edit.replace}`).join('\n');
          db.insertArtifactVersion({
            conversationId: conversation.id,
            slug: parserEvent.slug,
            kind: current.kind,
            language: current.language,
            title: current.title,
            content: patched.content,
            operation: 'update',
            messageId: assistant.id,
            version,
          });
          producedVersions.push({
            slug: parserEvent.slug,
            version,
            content: patched.content,
            completionText: patchText,
            costBasisTokens: Math.max(1, estimateTokens(patchText)),
          });
          content += `\n\n${artifactMarker(parserEvent.slug, version)}\n\n`;
          await emit(stream, {
            type: 'artifact_start',
            slug: parserEvent.slug,
            kind: current.kind,
            language: current.language,
            title: current.title,
            version,
            operation: 'update',
            conversationId: conversation.id,
            messageId: assistant.id,
          });
          completedArtifactEnds.push({ slug: parserEvent.slug, version, truncated: false });
        }
      };

      const finishParser = async (stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never) => {
        if (parserEnded) return;
        parserEnded = true;
        await consumeParserEvents(parser.end(), stream);
      };

      const completionText = () => `${content}${[...artifactBuffers.values()].join('')}${producedVersions.map((item) => item.completionText).join('')}`;

      const attributeArtifactCost = (completionTokens: number, totalCost: number | null) => {
        if (producedVersions.length === 0) return;
        const sizes = producedVersions.map((item) => item.costBasisTokens);
        const totalSize = sizes.reduce((sum, size) => sum + size, 0);
        producedVersions.forEach((item, index) => {
          const share = sizes[index] / totalSize;
          db.updateArtifactVersionCost(
            conversation.id,
            item.slug,
            item.version,
            Math.max(0, Math.round(completionTokens * share)),
            totalCost === null ? null : Number((totalCost * share).toFixed(8)),
          );
        });
      };

      const emitArtifactEnds = async (stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never) => {
        for (const completed of completedArtifactEnds) {
          const version = db.getArtifactVersion(conversation.id, completed.slug, completed.version);
          await emit(stream, {
            type: 'artifact_end',
            slug: completed.slug,
            version: completed.version,
            truncated: completed.truncated,
            outputTokens: version?.outputTokens ?? null,
            costUsd: version?.costUsd ?? null,
            conversationId: conversation.id,
            messageId: assistant.id,
          });
        }
        completedArtifactEnds.length = 0;
      };

      const response = streamSSE(
        c,
        async (stream) => {
          stream.onAbort(() => {
            clientAborted = true;
            if (!upstreamController.signal.aborted) upstreamController.abort(new DOMException('Cliente desconectou.', 'AbortError'));
          });
          try {
            for await (const event of streamOpenAICompatible({
              providerId: selection.providerId,
              modelId: selection.model.id,
              messages: context.messages,
              temperature: request.temperature,
              signal: upstreamController.signal,
              fetchImpl: options.fetchImpl,
            })) {
              if (event.kind === 'text') {
                await consumeParserEvents(parser.push(event.text), stream);
                persistPartial();
              } else if (event.kind === 'reasoning') {
                reasoning += event.reasoning;
                if (!stream.aborted) {
                  await writeEnvelope(stream, {
                    type: 'reasoning',
                    reasoning: event.reasoning,
                    conversationId: conversation.id,
                    messageId: assistant.id,
                  });
                }
                persistPartial();
              } else if (event.kind === 'usage') {
                rawUsage = event.usage;
              } else if (event.kind === 'finish') {
                finishReason = event.finishReason;
              }
            }

            await finishParser(stream);
            const calculated = calculateUsageAndCost(selection.model, {
              raw: rawUsage,
              promptText,
              completionText: completionText(),
              reasoningText: reasoning,
            });
            attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
            await emitArtifactEnds(stream);
            finishReason = finishReason ?? 'stop';
            db.updateMessage(assistant.id, {
              content,
              reasoning,
              usage: calculated.usage,
              cost: calculated.cost,
              finishReason,
              latencyMs: Date.now() - startedAt,
            });
            if (!stream.aborted) {
              await writeEnvelope(stream, {
                type: 'usage',
                usage: calculated.usage,
                cost: calculated.cost,
                conversationId: conversation.id,
                messageId: assistant.id,
              });
              await writeEnvelope(stream, {
                type: 'done',
                done: true,
                finishReason,
                truncated: context.truncated,
                usage: calculated.usage,
                cost: calculated.cost,
                conversationId: conversation.id,
                messageId: assistant.id,
              });
            }
          } catch (error) {
            const normalized = normalizeError(error);
            const aborted = clientAborted || requestSignal.aborted || stream.aborted;
            await finishParser(stream);
            const calculated = calculateUsageAndCost(selection.model, {
              raw: rawUsage,
              promptText,
              completionText: completionText(),
              reasoningText: reasoning,
            });
            attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
            await emitArtifactEnds(stream);
            const terminalReason = aborted ? 'aborted' : 'error';
            db.updateMessage(assistant.id, {
              content,
              reasoning,
              usage: calculated.usage,
              cost: calculated.cost,
              finishReason: terminalReason,
              errorCode: aborted ? null : normalized.code,
              latencyMs: Date.now() - startedAt,
            });
            if (!aborted && !stream.aborted) {
              await writeEnvelope(stream, {
                type: 'error',
                error: errorPayload(normalized),
                conversationId: conversation.id,
                messageId: assistant.id,
              });
              await writeEnvelope(stream, {
                type: 'done',
                done: true,
                finishReason: terminalReason,
                truncated: context.truncated,
                usage: calculated.usage,
                cost: calculated.cost,
                conversationId: conversation.id,
                messageId: assistant.id,
              });
            }
          } finally {
            persistPartial(true);
            requestSignal.removeEventListener('abort', abortFromClient);
            if (!upstreamController.signal.aborted && (clientAborted || stream.aborted)) upstreamController.abort();
          }
        },
        async (error, stream) => {
          const normalized = normalizeError(error);
          if (!stream.aborted) {
            await writeEnvelope(stream, {
              type: 'error',
              error: errorPayload(normalized),
              conversationId: conversation.id,
              messageId: assistant.id,
            });
          }
        },
      );
      return response;
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  const staticRoot = options.staticRoot ?? 'dist';
  const staticIndex = join(staticRoot, 'index.html');
  if (existsSync(staticIndex)) {
    app.use('/*', serveStatic({ root: staticRoot }));
    app.get('/*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: { code: 'UNKNOWN', message: 'Rota não encontrada.', retryable: false } }, 404);
      }
      return serveStatic({ root: staticRoot, path: 'index.html' })(c, next);
    });
  }

  app.notFound((c) => c.req.path.startsWith('/api/')
    ? c.json({ error: { code: 'UNKNOWN', message: 'Rota não encontrada.', retryable: false } }, 404)
    : c.text('Not found', 404));
  app.onError((error, c) => routeErrorHandler(error, c));
  return app;
}

export const app = createApp();

export function startServer(): ReturnType<typeof serve> {
  const port = Number(process.env.PORT ?? 8787);
  const hostname = process.env.HOST ?? '0.0.0.0';
  return serve({ fetch: app.fetch, port, hostname });
}

const modulePath = fileURLToPath(import.meta.url);
const entrypoint = process.argv
  .slice(1)
  .filter((argument) => !argument.startsWith('-'))
  .some((argument) => {
    try {
      return resolve(argument) === modulePath;
    } catch {
      return false;
    }
  });
if (entrypoint) {
  startServer();
  console.log(`Backend ouvindo em http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 8787}`);
}
