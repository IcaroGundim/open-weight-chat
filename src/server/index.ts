import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  ChatRequestSchema,
  CreateConversationSchema,
  ProviderIdSchema,
  ProviderSettingsInputSchema,
  UpdateConversationSchema,
  type Artifact,
  type Message,
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
// Somente tipo: um import de valor traria `node:sqlite` para o grafo de
// módulos da função serverless, que não usa SQLite. Ver src/server/main.ts.
import type { ProviderSettingsRecord } from './db/queries';
import type { ChatDatabaseAdapter } from './db/database';
import { NeonChatDatabase } from './db/neon';
import { createAuthMiddleware, type AppVariables } from './auth';
import {
  resolveDefaultModelSelection,
  resolveModelsCatalog,
  resolveProvider,
  type ResolvedProvider,
} from './provider-resolution';
import type { ProviderModelConfig } from './providers.config';
import { encryptSecret, getSecretStorageStatus } from './secrets';
import { discoverProviderModels } from './providers.discovery';
import { assertSafeProviderUrl } from './ssrf';
import { pickDefaultRateLimitStore, type RateLimitStore } from './rate-limit';

// Node 24 can load the local .env without adding a dotenv dependency. Existing
// process variables still remain the source of truth in deployed environments.
try {
  process.loadEnvFile(process.env.ENV_FILE ?? '.env');
} catch {
  // A .env file is optional; production can inject variables through the process manager.
}

export interface AppOptions {
  db?: ChatDatabaseAdapter;
  fetchImpl?: typeof fetch;
  staticRoot?: string;
  /**
   * Middleware de autenticação injetável. Os testes passam um verifier fake;
   * sem ele, o createApp usa o Clerk real (createAuthMiddleware()).
   */
  auth?: ReturnType<typeof createAuthMiddleware>;
  /** Store de limites de uso injetável (testes). Sem ele, é escolhido do banco. */
  rateLimit?: RateLimitStore;
}

function validationMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

async function parseJson<T>(c: Context<{ Variables: AppVariables }>, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }): Promise<T> {
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

function jsonError(c: Context<{ Variables: AppVariables }>, error: unknown): Response {
  const normalized = normalizeError(error);
  return c.json({ error: errorPayload(normalized) }, normalized.status as 400);
}

function modelNotFound(): AppError {
  return new AppError('MODEL_NOT_FOUND', {
    status: 404,
    message: 'O provedor ou modelo selecionado não está configurado no servidor.',
  });
}

/**
 * Valida a seleção provedor/modelo DENTRO DA REQUISIÇÃO, com os dados do
 * usuário autenticado (provider-resolution.ts). Não existe mais catálogo
 * global mutável — cada chamada resolve o provedor efetivo do dono.
 */
async function assertUserModelSelection(
  userId: string,
  providerId: string,
  modelId: string,
  db: ChatDatabaseAdapter,
): Promise<{ provider: ResolvedProvider; model: ProviderModelConfig }> {
  const provider = await resolveProvider(userId, providerId, db);
  const model = provider?.models.find((item) => item.id === modelId);
  if (!provider || !model) throw modelNotFound();
  // Rejeita tambÃ©m registros legados que tenham sido criados antes da
  // validaÃ§Ã£o de URL. A checagem completa (DNS e redirecionamentos) acontece
  // novamente no fetch do stream, antes de qualquer conexÃ£o com o upstream.
  assertSafeProviderUrl(provider.baseURL);
  return { provider, model };
}

function conversationContext(
  systemPrompt: string | null,
  messages: readonly Message[],
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
  messages: readonly Message[],
  artifacts: readonly Artifact[],
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

function routeErrorHandler(error: unknown, c: Context<{ Variables: AppVariables }>): Response {
  return jsonError(c, error);
}

function toProviderSettings(record: ProviderSettingsRecord): ProviderSettings {
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

/**
 * Origem do Clerk para a CSP. O Clerk 2025+ serve o frontend de login em
 * https://<instância>.clerk.accounts.dev; CLERK_FRONTEND_API_ORIGIN permite
 * customizar (self-hosting ou domínio próprio). Wildcard de host é aceito em
 * script-src/connect-src/frame-src pela especificação CSP.
 */
function clerkOrigin(): string {
  return process.env.CLERK_FRONTEND_API_ORIGIN ?? 'https://*.clerk.accounts.dev';
}

function contentSecurityPolicy(): string {
  const clerk = clerkOrigin();
  return [
    "default-src 'self'",
    `script-src 'self' ${clerk}`,
    `connect-src 'self' ${clerk}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-src ${clerk}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

function isProductionDeployment(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

/**
 * Normaliza a única origem de navegador autorizada a chamar a API de outro
 * origin. Em produção ela é obrigatória: o frontend e a API normalmente ficam
 * na mesma origem na Vercel, mas a configuração explícita evita abrir CORS por
 * acidente quando forem separados no futuro.
 */
export function resolveAppOrigin(
  rawOrigin = process.env.APP_ORIGIN,
  production = isProductionDeployment(),
): string | undefined {
  const value = rawOrigin?.trim();
  if (!value) {
    if (!production) return undefined;
    throw new AppError('UNKNOWN', {
      status: 500,
      message: 'Configure APP_ORIGIN com a origem HTTPS pública do aplicativo em produção.',
    });
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new AppError('UNKNOWN', {
      status: 500,
      message: 'APP_ORIGIN precisa ser uma URL absoluta válida.',
    });
  }

  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new AppError('UNKNOWN', {
      status: 500,
      message: 'APP_ORIGIN precisa usar http ou https.',
    });
  }
  if (production && origin.protocol !== 'https:') {
    throw new AppError('UNKNOWN', {
      status: 500,
      message: 'APP_ORIGIN precisa usar HTTPS em produção.',
    });
  }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new AppError('UNKNOWN', {
      status: 500,
      message: 'APP_ORIGIN deve conter somente a origem (esquema, host e porta opcional), sem caminho, credenciais, query ou fragmento.',
    });
  }

  return origin.origin;
}

export function createApp(options: AppOptions = {}): Hono<{ Variables: AppVariables }> {
  // Sem banco injetado, o único fallback daqui é o Neon. O SQLite é escolhido
  // por src/server/main.ts, que é a entrada local — assim `node:sqlite` nunca
  // entra no grafo de módulos da função serverless.
  if (!options.db && !process.env.DATABASE_URL) {
    throw new AppError('UNKNOWN', {
      status: 500,
      message: 'Configure DATABASE_URL (Neon) nas variáveis de ambiente. O disco da função é somente leitura e não persiste entre invocações, então o SQLite não funciona no deploy.',
    });
  }
  const db = options.db ?? new NeonChatDatabase(process.env.DATABASE_URL as string);
  const rateLimit = options.rateLimit ?? pickDefaultRateLimitStore(db);
  const appOrigin = resolveAppOrigin();
  // Testes injetam um verifier fake; produção usa o Clerk real.
  const authMiddleware = options.auth ?? createAuthMiddleware();
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', contentSecurityPolicy());
    await next();
  });

  // A API usa bearer token, não cookies: somente APP_ORIGIN pode obter uma
  // resposta para chamadas cross-origin. Sem APP_ORIGIN no desenvolvimento,
  // não emitimos CORS; o proxy do Vite mantém frontend e API na mesma origem.
  if (appOrigin) {
    app.use('/api/*', cors({
      origin: appOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86_400,
    }));
  }

  // /api/health é a ÚNICA rota pública: registrada ANTES do middleware de
  // autenticação, que protege todo o restante de /api/*.
  app.get('/api/health', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true as const });
  });

  // Toda rota /api/* a partir daqui exige autenticação. O middleware devolve
  // 401 ANTES de qualquer acesso ao banco (ver src/server/auth.ts).
  app.use('/api/*', authMiddleware);

  // Primeiro acesso autenticado: garante o registro do usuário (uma vez por
  // requisição, upsert idempotente). Nunca roda para /api/health.
  app.use('/api/*', async (c, next) => {
    await db.ensureUser(c.get('userId'));
    await next();
  });

  app.get('/api/models', async (c) => {
    const userId = c.get('userId');
    return c.json(await resolveModelsCatalog(userId, db));
  });

  app.get('/api/providers', async (c) => {
    const userId = c.get('userId');
    return c.json({
      providers: (await db.listProviderSettings(userId)).map(toProviderSettings),
      secretStorage: getSecretStorageStatus(),
    });
  });

  app.put('/api/providers/:id', async (c) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');
      const idCheck = ProviderIdSchema.safeParse(id);
      if (!idCheck.success) {
        throw new AppError('UNKNOWN', { status: 400, message: validationMessage(idCheck.error) });
      }
      const body = await parseJson(c, ProviderSettingsInputSchema);
      // SSRF: URL base precisa ser segura (HTTPS em produção; http://localhost
      // permitido em dev/teste — opções padrão do ssrf.ts por ambiente).
      assertSafeProviderUrl(body.baseURL);

      let apiKeyCipher: string | null | undefined;
      if (body.apiKey === null) {
        // null apaga a chave.
        apiKeyCipher = null;
      } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        const status = getSecretStorageStatus();
        if (!status.available) {
          throw new AppError('UNKNOWN', { status: 400, message: status.reason ?? 'Não é possível guardar chaves.' });
        }
        // v2: a chave é amarrada ao dono via AAD userId:providerId.
        apiKeyCipher = encryptSecret(body.apiKey.trim(), { userId, providerId: id });
      }
      // apiKeyCipher undefined → mantém a chave atual do usuário.

      const record = await db.upsertProviderSettings(userId, {
        id,
        label: body.label,
        baseURL: body.baseURL,
        models: body.models,
        verifiedAt: body.verifiedAt ?? null,
        apiKeyCipher,
      });
      return c.json({ provider: toProviderSettings(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.post('/api/providers/:id/discover-models', async (c) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');
      const idCheck = ProviderIdSchema.safeParse(id);
      if (!idCheck.success) {
        throw new AppError('UNKNOWN', { status: 400, message: validationMessage(idCheck.error) });
      }
      await rateLimit.checkModelDiscovery(userId);
      // Resolve com os dados DO USUÁRIO (nunca de outro) e exige registro
      // próprio: sem registro, 404 — sem revelar que o id existe.
      const resolved = await resolveProvider(userId, id, db);
      const record = resolved ? (await db.listProviderSettings(userId)).find((item) => item.id === id) : undefined;
      if (!resolved || !record) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Provedor não encontrado.' });
      }
      const models = await discoverProviderModels(
        resolved.baseURL,
        resolved.apiKey ?? undefined,
        options.fetchImpl ?? fetch,
      );
      const updated = await db.upsertProviderSettings(userId, {
        id,
        label: record.label,
        baseURL: record.baseURL,
        models,
        verifiedAt: new Date().toISOString().slice(0, 10),
        // apiKeyCipher indefinido preserva a chave atual do usuário.
      });
      return c.json({ provider: toProviderSettings(updated), discovered: models.length });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.delete('/api/providers/:id', async (c) => {
    const userId = c.get('userId');
    const deleted = await db.deleteProviderSettings(userId, c.req.param('id'));
    if (!deleted) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Provedor não encontrado.' }));
    return c.json({ ok: true as const });
  });

  app.get('/api/analytics/costs', async (c) => {
    const userId = c.get('userId');
    const rawDays = Number(c.req.query('days') ?? 30);
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.trunc(rawDays))) : 30;
    return c.json(await db.getCostAnalytics(userId, days));
  });

  app.get('/api/conversations/search', async (c) => {
    const userId = c.get('userId');
    const query = c.req.query('q')?.trim() ?? '';
    if (!query) return c.json({ results: [] });
    if (query.length > 200) return jsonError(c, new AppError('UNKNOWN', { status: 400, message: 'A busca pode ter no máximo 200 caracteres.' }));
    try {
      return c.json({ results: await db.searchConversations(userId, query) });
    } catch {
      return jsonError(c, new AppError('UNKNOWN', { status: 400, message: 'A expressão de busca não é válida.' }));
    }
  });

  app.get('/api/conversations', async (c) => {
    const userId = c.get('userId');
    const includeArchived = c.req.query('includeArchived') === 'true';
    return c.json({ conversations: await db.listConversations(userId, { includeArchived }) });
  });

  app.post('/api/conversations', async (c) => {
    try {
      const userId = c.get('userId');
      const body = await parseJson(c, CreateConversationSchema);
      let providerId: ProviderId;
      let modelId: string;
      if (body.providerId) {
        providerId = body.providerId;
        const resolved = await resolveProvider(userId, providerId, db);
        modelId = body.modelId ?? resolved?.models[0]?.id ?? '';
        if (!resolved || !resolved.models.some((model) => model.id === modelId)) throw modelNotFound();
      } else {
        const defaults = await resolveDefaultModelSelection(userId, db);
        providerId = defaults.providerId;
        modelId = body.modelId ?? defaults.modelId;
        if (body.modelId) {
          const resolved = await resolveProvider(userId, providerId, db);
          if (!resolved?.models.some((model) => model.id === modelId)) throw modelNotFound();
        }
      }
      const conversation = await db.createConversation(userId, {
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

  app.get('/api/conversations/:id', async (c) => {
    const userId = c.get('userId');
    const conversation = await db.getConversation(userId, c.req.param('id'));
    if (!conversation) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ conversation });
  });

  app.patch('/api/conversations/:id', async (c) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');
      const body = await parseJson(c, UpdateConversationSchema);
      const current = await db.getConversation(userId, id);
      if (!current) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      const providerId = body.providerId ?? current.providerId;
      const modelId = body.modelId ?? current.modelId;
      await assertUserModelSelection(userId, providerId, modelId, db);
      const conversation = await db.updateConversation(userId, id, { ...body, providerId, modelId });
      if (!conversation) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      return c.json({ conversation });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.delete('/api/conversations/:id', async (c) => {
    const userId = c.get('userId');
    const deleted = await db.deleteConversation(userId, c.req.param('id'));
    if (!deleted) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ ok: true as const });
  });

  app.get('/api/conversations/:id/messages', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ messages: await db.getMessages(userId, id) });
  });

  app.get('/api/conversations/:id/artifacts', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ artifacts: await db.getArtifacts(userId, id) });
  });

  app.get('/api/conversations/:id/artifacts/:slug/versions/:version', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    const version = Number(c.req.param('version'));
    if (!Number.isSafeInteger(version) || version < 1) {
      return jsonError(c, new AppError('UNKNOWN', { status: 400, message: 'A versão do artefato é inválida.' }));
    }
    const artifactVersion = await db.getArtifactVersion(userId, id, c.req.param('slug'), version);
    if (!artifactVersion) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Versão do artefato não encontrada.' }));
    return c.json({ version: artifactVersion });
  });

  app.post('/api/chat', async (c) => {
    try {
      const userId = c.get('userId');
      const request = await parseJson(c, ChatRequestSchema);
      // Limite de uso: 20 inícios de chat/minuto, ANTES de criar qualquer
      // registro ou tocar no upstream.
      await rateLimit.checkChatStart(userId);
      const selection = await assertUserModelSelection(userId, request.providerId, request.modelId, db);
      let conversation = request.conversationId ? await db.getConversation(userId, request.conversationId) : null;
      if (request.conversationId && !conversation) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      }
      if (!conversation) {
        conversation = await db.createConversation(userId, { providerId: selection.provider.id, modelId: selection.model.id });
      } else if (conversation.providerId !== selection.provider.id || conversation.modelId !== selection.model.id) {
        conversation = await db.updateConversation(userId, conversation.id, {
          providerId: selection.provider.id,
          modelId: selection.model.id,
        });
        if (!conversation) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      }

      await db.insertMessage(userId, {
        conversationId: conversation.id,
        role: 'user',
        content: request.content,
        providerId: selection.provider.id,
        modelId: selection.model.id,
      });
      const context = requestContext(
        conversation.systemPrompt,
        await db.getMessages(userId, conversation.id),
        await db.getArtifacts(userId, conversation.id),
        selection.model.ctx,
      );
      const promptText = context.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
      const assistant = await db.insertMessage(userId, {
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        reasoning: '',
        providerId: selection.provider.id,
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
      let streamSlotId: string | null = null;

      const persistPartial = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastPersistedAt < 2_000 && content.length - lastPersistedLength < 4_000) return;
        // Renova a expiração do slot de stream junto com a persistência
        // parcial (escritas já existentes; sem custo adicional relevante).
        await Promise.all([
          db.updateMessage(userId, assistant.id, { content, reasoning }),
          streamSlotId ? rateLimit.touchStream(userId, streamSlotId) : Promise.resolve(),
        ]);
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
            const existing = (await db.getArtifacts(userId, conversation.id)).find((artifact) => artifact.slug === parserEvent.slug);
            const artifact = await db.upsertArtifact(userId, {
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
              await db.insertArtifactVersion(userId, {
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
          const current = (await db.getArtifacts(userId, conversation.id)).find((artifact) => artifact.slug === parserEvent.slug);
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
          await db.insertArtifactVersion(userId, {
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

      const attributeArtifactCost = async (completionTokens: number, totalCost: number | null) => {
        if (producedVersions.length === 0) return;
        const sizes = producedVersions.map((item) => item.costBasisTokens);
        const totalSize = sizes.reduce((sum, size) => sum + size, 0);
        await Promise.all(producedVersions.map(async (item, index) => {
          const share = sizes[index] / totalSize;
          await db.updateArtifactVersionCost(
            userId,
            conversation.id,
            item.slug,
            item.version,
            Math.max(0, Math.round(completionTokens * share)),
            totalCost === null ? null : Number((totalCost * share).toFixed(8)),
          );
        }));
      };

      const emitArtifactEnds = async (stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never) => {
        for (const completed of completedArtifactEnds) {
          const version = await db.getArtifactVersion(userId, conversation.id, completed.slug, completed.version);
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

      // Slot de stream ativo: no máximo 2 por usuário. A liberação acontece
      // no finally do stream (sucesso, erro ou aborto do cliente), com flag
      // para nunca liberar duas vezes.
      streamSlotId = await rateLimit.acquireStreamSlot(userId);
      let streamSlotReleased = false;
      const releaseStreamSlot = async () => {
        if (streamSlotReleased) return;
        streamSlotReleased = true;
        try {
          if (streamSlotId) await rateLimit.releaseStreamSlot(userId, streamSlotId);
        } catch {
          // Best-effort: se a liberação falhar, a expiração de 10 minutos
          // do slot cobre o vazamento.
        }
      };

      let response: Response;
      try {
        response = streamSSE(
          c,
          async (stream) => {
            stream.onAbort(() => {
              clientAborted = true;
              if (!upstreamController.signal.aborted) upstreamController.abort(new DOMException('Cliente desconectou.', 'AbortError'));
            });
            try {
              for await (const event of streamOpenAICompatible({
                providerId: selection.provider.id,
                modelId: selection.model.id,
                // Dados EFETIVOS do usuário, resolvidos dentro da requisição.
                baseURL: selection.provider.baseURL,
                apiKey: selection.provider.apiKey,
                requiresApiKey: selection.provider.requiresApiKey,
                messages: context.messages,
                temperature: request.temperature,
                signal: upstreamController.signal,
                fetchImpl: options.fetchImpl,
              })) {
                if (event.kind === 'text') {
                  await consumeParserEvents(parser.push(event.text), stream);
                  await persistPartial();
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
                  await persistPartial();
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
              await attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
              await emitArtifactEnds(stream);
              finishReason = finishReason ?? 'stop';
              await db.updateMessage(userId, assistant.id, {
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
              await attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
              await emitArtifactEnds(stream);
              const terminalReason = aborted ? 'aborted' : 'error';
              await db.updateMessage(userId, assistant.id, {
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
              await persistPartial(true);
              await releaseStreamSlot();
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
      } catch (error) {
        // streamSSE falhou antes de iniciar o callback: libera o slot aqui.
        await releaseStreamSlot();
        throw error;
      }
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

let cachedApp: Hono<{ Variables: AppVariables }> | null = null;

/**
 * Criação preguiçosa e memoizada.
 *
 * `createApp` abre o banco. Fazer isso no corpo do módulo derrubava a função da
 * Vercel já na importação, e a plataforma respondia FUNCTION_INVOCATION_FAILED
 * — um 500 opaco, sem chance de explicar a causa. Adiada, a falha vira uma
 * resposta JSON legível (ver api/[...route].ts).
 */
export function getApp(): Hono<{ Variables: AppVariables }> {
  cachedApp ??= createApp();
  return cachedApp;
}
