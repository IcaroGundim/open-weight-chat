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
  ArtifactEditSchema,
  AttachmentUploadSchema,
  SpreadsheetSaveSchema,
  SpreadsheetWorkbookSchema,
  ProviderSettingsInputSchema,
  SearchSettingsInputSchema,
  UpdateConversationSchema,
  type Artifact,
  type Attachment,
  type Message,
  type ProviderSettings,
  type SseEnvelope,
  type ProviderId,
  type SpreadsheetSelection,
} from '../shared/types';
import { recalculateWorkbook } from '../shared/spreadsheet-formulas';
import { applyEdits } from './artifacts/patch';
import { buildArtifactContext } from './artifacts/context';
import { artifactMarker } from './artifacts/marker';
import { createArtifactParser, type ParserEvent } from './artifacts/parser';
import { composeSystemPrompt } from './artifacts/system-prompt';
import { calculateUsageAndCost, sumProviderUsage } from './cost';
import { estimateContextTokens, estimateTokens, trimContext, type ContextMessage } from './context';
import { AppError, errorPayload, normalizeError } from './errors';
import { streamOpenAICompatible } from './llm-client';
// Somente tipo: um import de valor traria `node:sqlite` para o grafo de
// módulos da função serverless, que não usa SQLite. Ver src/server/main.ts.
import type { AttachmentRecord, ProviderSettingsRecord } from './db/queries';
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
import { OPENCODE_SEM_MODELOS, filterOpenCodeModels, openCodeCatalogFor } from './opencode';
import { assertSafeProviderUrl } from './ssrf';
import { BACKEND_REQUIRES_URL } from './search/backends';
import {
  encryptionProviderId,
  formatResultsForModel,
  resolveSearch,
  runSearch,
  toSearchSettingsResponse,
} from './search';
import { createSearchScanner, searchSystemPrompt } from './search/protocol';
import { handoffMessage, scienceChain } from './science/levels';
import { analyzeAttachment, decodeAttachment, documentPromptBlock, imageDataUrl } from './attachments';
import { generatedSpreadsheetFromArtifact, spreadsheetPromptBlock, workbookSheetToCsv, workbookToXlsx } from './spreadsheets';

/**
 * Prazo de vida de um anexo que nunca foi enviado.
 *
 * Sobe-se um arquivo, muda-se de ideia e fecha-se a aba: sem isto, os bytes
 * ficariam no banco para sempre. Um dia é folgado o bastante para quem deixou
 * a aba aberta e curto o bastante para não virar depósito.
 */
const ORPHAN_ATTACHMENT_MS = 24 * 60 * 60 * 1000;

/**
 * Buscas por resposta.
 *
 * Três é o suficiente para refinar uma consulta ruim (buscar, ver que veio
 * torto, buscar melhor) sem transformar uma pergunta em uma sequência cara de
 * chamadas ao provedor — cada round é uma cobrança a mais, e o contexto cresce
 * a cada um. O limite é dito ao modelo no prompt e imposto aqui: prompt sem
 * imposição é sugestão.
 */
const MAX_SEARCH_ROUNDS = 3;

/**
 * Quanto texto pós-marcador vale a pena drenar para capturar o `usage` do
 * provedor. Acima disso o modelo está ignorando a instrução de parar, e
 * continuar lendo custa tokens de verdade para comprar uma contagem exata —
 * a estimativa, que se anuncia como estimativa, sai mais barato.
 */
const MAX_DESCARTE_APOS_MARCADOR = 4_000;

/**
 * A partir de quanto texto o modo Science guarda a resposta num artefato.
 *
 * Abaixo disso é resposta de conversa, e o artefato só atrapalharia — um
 * parágrafo dentro de um painel com versionamento é cerimônia sem função.
 */
const MIN_SCIENCE_ARTIFACT_CHARS = 1_200;
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
  // Rejeita também registros legados que tenham sido criados antes da
  // validação de URL. A checagem completa (DNS e redirecionamentos) acontece
  // novamente no fetch do stream, antes de qualquer conexão com o upstream.
  assertSafeProviderUrl(provider.baseURL);
  return { provider, model };
}

/**
 * Anexos vivem numa tabela própria e são reinjetados aqui, a cada requisição.
 *
 * A alternativa era gravar o texto do documento dentro de `messages.content`.
 * Foi descartada porque esse campo é o que a interface mostra: o usuário veria
 * o PDF inteiro despejado dentro da própria pergunta. Separado, a bolha mostra
 * o que ele escreveu e o modelo recebe o que precisa.
 */
function conversationContext(
  systemPrompt: string | null,
  messages: readonly Message[],
  extras: readonly string[] = [],
  attachmentsByMessage: ReadonlyMap<string, readonly AttachmentRecord[]> = new Map(),
  spreadsheetSelection?: SpreadsheetSelection,
): ContextMessage[] {
  const context: ContextMessage[] = [{ role: 'system', content: composeSystemPrompt(systemPrompt, extras) }];
  for (const message of messages) {
    if (message.role === 'system') continue;
    // Empty assistant placeholders/errors are persistence records, not context.
    if (message.role === 'assistant' && !message.content.trim()) continue;
    const anexos = attachmentsByMessage.get(message.id) ?? [];
    const documentos = anexos
      .filter((anexo) => anexo.kind === 'document')
      .map((anexo) => documentPromptBlock(anexo.filename, anexo.extractedText ?? '', anexo.truncated));
    const planilhas = anexos
      .filter((anexo) => anexo.kind === 'spreadsheet' && anexo.extractedText)
      .flatMap((anexo) => {
        let stored: unknown;
        try { stored = JSON.parse(anexo.extractedText as string) as unknown; } catch { return []; }
        const parsed = SpreadsheetWorkbookSchema.safeParse(stored);
        if (!parsed.success) return [];
        return [spreadsheetPromptBlock(anexo.filename, parsed.data)];
      });
    const imagens = anexos
      .filter((anexo) => anexo.kind === 'image' && anexo.dataBase64)
      .map((anexo) => imageDataUrl(anexo.mime, anexo.dataBase64 as string));
    context.push({
      role: message.role,
      // Documento antes do texto: o pedido do usuário costuma se referir ao
      // anexo ("resume isto"), e o modelo lê melhor o material antes da ordem.
      content: documentos.length + planilhas.length > 0
        ? `${[...documentos, ...planilhas].join('\n\n')}\n\n${message.content}`
        : message.content,
      ...(imagens.length > 0 ? { images: imagens } : {}),
    });
  }
  // Seleção é contexto da pergunta ATUAL, mesmo quando a planilha foi enviada
  // muitos turnos antes. Colocá-la só na mensagem histórica permitiria que o
  // aparo de contexto removesse justamente os dados que a pessoa selecionou.
  if (spreadsheetSelection) {
    const attachment = [...attachmentsByMessage.values()].flat().find((item) => item.id === spreadsheetSelection.attachmentId);
    const newest = context.at(-1);
    if (attachment?.extractedText && newest?.role === 'user') {
      let stored: unknown;
      try { stored = JSON.parse(attachment.extractedText) as unknown; } catch { stored = null; }
      const parsed = SpreadsheetWorkbookSchema.safeParse(stored);
      if (parsed.success) {
        newest.content = `${spreadsheetPromptBlock(attachment.filename, parsed.data, spreadsheetSelection)}\n\n${newest.content}`;
      }
    }
  }
  return context;
}

function requestContext(
  systemPrompt: string | null,
  messages: readonly Message[],
  artifacts: readonly Artifact[],
  contextWindow: number,
  extras: readonly string[] = [],
  attachmentsByMessage: ReadonlyMap<string, readonly AttachmentRecord[]> = new Map(),
  spreadsheetSelection?: SpreadsheetSelection,
): { messages: ContextMessage[]; truncated: boolean } {
  const full = conversationContext(systemPrompt, messages, extras, attachmentsByMessage, spreadsheetSelection);
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

/** O que sai para o navegador: nunca os bytes nem o texto extraído inteiro. */
function toAttachment(record: AttachmentRecord, spreadsheetVersion = 1): Attachment {
  let spreadsheet: Attachment['spreadsheet'];
  if (record.kind === 'spreadsheet' && record.extractedText) {
    try {
      const workbook = SpreadsheetWorkbookSchema.parse(JSON.parse(record.extractedText) as unknown);
      spreadsheet = { sheetNames: workbook.sheets.map((sheet) => sheet.name), version: spreadsheetVersion };
    } catch {
      spreadsheet = { sheetNames: [], version: spreadsheetVersion };
    }
  }
  return {
    id: record.id,
    kind: record.kind,
    filename: record.filename,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    // Quantidade, não conteúdo: é o que deixa a interface dizer se o documento
    // rendeu texto sem trazer o documento de volta a cada abertura da conversa.
    textChars: record.kind === 'document' ? (record.extractedText?.length ?? 0) : null,
    truncated: record.truncated,
    ...(spreadsheet ? { spreadsheet } : {}),
    createdAt: record.createdAt,
  };
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
      const descobertos = await discoverProviderModels(
        resolved.baseURL,
        resolved.apiKey ?? undefined,
        options.fetchImpl ?? fetch,
      );
      // O /models do OpenCode mistura quatro protocolos e só um deles é o que
      // este app fala — ver src/server/opencode.ts. O reconhecimento é pela
      // URL efetiva do usuário, não pelo id.
      const catalogoOpenCode = openCodeCatalogFor(resolved.baseURL);
      const models = catalogoOpenCode ? filterOpenCodeModels(catalogoOpenCode, descobertos) : descobertos;
      if (catalogoOpenCode && models.length === 0) {
        throw new AppError('UNKNOWN', { status: 400, message: OPENCODE_SEM_MODELOS });
      }
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

  // ---------------------------------------------------------------------------
  // Busca na web
  // ---------------------------------------------------------------------------

  app.get('/api/search-settings', async (c) => {
    const userId = c.get('userId');
    const record = await db.getSearchSettings(userId);
    return c.json({
      settings: record ? toSearchSettingsResponse(record) : null,
      secretStorage: getSecretStorageStatus(),
    });
  });

  app.put('/api/search-settings', async (c) => {
    try {
      const userId = c.get('userId');
      const body = await parseJson(c, SearchSettingsInputSchema);

      if (BACKEND_REQUIRES_URL[body.backend]) {
        if (!body.baseURL) {
          throw new AppError('UNKNOWN', { status: 400, message: 'Informe a URL da sua instância SearXNG.' });
        }
        // Mesma regra do endpoint de provedor: HTTPS em produção, sem
        // credenciais embutidas, sem faixa privada. Revalidado a cada busca.
        assertSafeProviderUrl(body.baseURL);
      }

      let apiKeyCipher: string | null | undefined;
      if (body.apiKey === null) {
        apiKeyCipher = null;
      } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        const status = getSecretStorageStatus();
        if (!status.available) {
          throw new AppError('UNKNOWN', { status: 400, message: status.reason ?? 'Não é possível guardar chaves.' });
        }
        // AAD `userId:search:<backend>` — ver encryptionProviderId.
        apiKeyCipher = encryptSecret(body.apiKey.trim(), { userId, providerId: encryptionProviderId(body.backend) });
      }

      const record = await db.upsertSearchSettings(userId, {
        backend: body.backend,
        // O SearXNG é o único que usa URL. Zerar nos demais evita que uma URL
        // deixada de uma configuração anterior volte a valer sem aparecer na
        // tela.
        baseURL: BACKEND_REQUIRES_URL[body.backend] ? body.baseURL ?? null : null,
        apiKeyCipher,
        maxResults: body.maxResults,
        enabled: body.enabled,
      });
      return c.json({ settings: toSearchSettingsResponse(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.delete('/api/search-settings', async (c) => {
    const userId = c.get('userId');
    const deleted = await db.deleteSearchSettings(userId);
    if (!deleted) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Nenhuma busca configurada.' }));
    return c.json({ ok: true as const });
  });

  /**
   * Prova a configuração com uma consulta real.
   *
   * Existe porque erro de busca, sem isto, só apareceria no meio de uma
   * conversa — quando o modelo já parou para esperar e o usuário não tem como
   * saber se a culpa foi da chave, da URL ou do buscador.
   */
  app.post('/api/search-settings/test', async (c) => {
    try {
      const userId = c.get('userId');
      await rateLimit.checkChatStart(userId);
      const resolved = await resolveSearch(userId, db);
      if (!resolved) {
        throw new AppError('UNKNOWN', {
          status: 400,
          message: 'A busca não está configurada, está desligada ou falta a chave/URL que este buscador exige.',
        });
      }
      const outcome = await runSearch(resolved, 'open weight chat', c.req.raw.signal, options.fetchImpl);
      if (outcome.failure) {
        throw new AppError('UNKNOWN', { status: 400, message: outcome.failure });
      }
      return c.json({ ok: true as const, results: outcome.results });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  // ---------------------------------------------------------------------------
  // Anexos
  // ---------------------------------------------------------------------------

  app.post('/api/attachments', async (c) => {
    try {
      const userId = c.get('userId');
      await rateLimit.checkChatStart(userId);
      const body = await parseJson(c, AttachmentUploadSchema);

      const dados = decodeAttachment(body.data);
      // O tipo sai dos BYTES. `body.mime` e a extensão vêm do navegador e
      // repetem o que o usuário mandar — ver attachments.ts.
      const analise = await analyzeAttachment(dados, body.filename);

      const record = await db.createAttachment(userId, {
        kind: analise.kind,
        filename: body.filename,
        mime: analise.mime,
        sizeBytes: dados.length,
        // Planilha mantém o original para rastreabilidade e a representação
        // canônica separada no histórico editável.
        dataBase64: analise.kind === 'image' || analise.kind === 'spreadsheet' ? dados.toString('base64') : null,
        extractedText: analise.kind === 'document'
          ? analise.text
          : analise.workbook ? JSON.stringify(analise.workbook) : null,
        truncated: analise.truncated,
      });
      if (analise.kind === 'spreadsheet' && analise.workbook) {
        const version = await db.insertSpreadsheetVersion(userId, record.id, JSON.stringify(analise.workbook));
        if (!version) {
          await db.deleteAttachment(userId, record.id);
          throw new AppError('UNKNOWN', { status: 500, message: 'Não consegui iniciar o histórico da planilha.' });
        }
      }

      // Faxina oportunista: anexos que subiram e nunca foram enviados. Feita
      // aqui, e não por tarefa agendada, porque a serverless não tem onde
      // rodar uma — e quem sobe um anexo é exatamente quem tende a ter
      // deixado outros para trás.
      void Promise.resolve(db.deleteOrphanAttachments(userId, ORPHAN_ATTACHMENT_MS)).catch(() => {});

      return c.json({ attachment: toAttachment(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.get('/api/attachments/:id/spreadsheet', async (c) => {
    try {
      const userId = c.get('userId');
      const attachment = await db.getAttachment(userId, c.req.param('id'));
      const current = await db.getSpreadsheetVersion(userId, c.req.param('id'));
      const requestedRaw = c.req.query('version');
      const requested = requestedRaw === undefined ? undefined : Number(requestedRaw);
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
        throw new AppError('UNKNOWN', { status: 400, message: 'Versão de planilha inválida.' });
      }
      const stored = requested === undefined ? current : await db.getSpreadsheetVersion(userId, c.req.param('id'), requested);
      if (!attachment || attachment.kind !== 'spreadsheet' || !stored || !current) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Planilha não encontrada.' });
      }
      const workbook = SpreadsheetWorkbookSchema.parse(JSON.parse(stored.workbookJson) as unknown);
      return c.json({ attachment: toAttachment(attachment, current.version), workbook, version: stored.version, currentVersion: current.version });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.put('/api/attachments/:id/spreadsheet', async (c) => {
    try {
      const userId = c.get('userId');
      const body = await parseJson(c, SpreadsheetSaveSchema);
      recalculateWorkbook(body.workbook);
      const saved = await db.insertSpreadsheetVersion(userId, c.req.param('id'), JSON.stringify(body.workbook), body.baseVersion);
      if (!saved) {
        const exists = await db.getAttachment(userId, c.req.param('id'));
        throw new AppError('UNKNOWN', {
          status: exists ? 409 : 404,
          message: exists ? 'A planilha mudou em outra aba. Reabra-a antes de salvar.' : 'Planilha não encontrada.',
        });
      }
      return c.json({ workbook: body.workbook, version: saved.version, createdAt: saved.createdAt });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  app.get('/api/attachments/:id/spreadsheet/export', async (c) => {
    try {
      const userId = c.get('userId');
      const attachment = await db.getAttachment(userId, c.req.param('id'));
      const requestedRaw = c.req.query('version');
      const requested = requestedRaw === undefined ? undefined : Number(requestedRaw);
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
        throw new AppError('UNKNOWN', { status: 400, message: 'Versão de planilha inválida.' });
      }
      const stored = await db.getSpreadsheetVersion(userId, c.req.param('id'), requested);
      if (!attachment || attachment.kind !== 'spreadsheet' || !stored) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Planilha não encontrada.' });
      }
      const workbook = SpreadsheetWorkbookSchema.parse(JSON.parse(stored.workbookJson) as unknown);
      const format = c.req.query('format') === 'csv' ? 'csv' : 'xlsx';
      const body = format === 'csv'
        ? Buffer.from(workbookSheetToCsv(workbook, c.req.query('sheet')), 'utf8')
        : await workbookToXlsx(workbook, attachment.mime.includes('spreadsheetml') && attachment.dataBase64
          ? Buffer.from(attachment.dataBase64, 'base64')
          : undefined);
      const base = attachment.filename.replace(/\.(xlsx|csv)$/iu, '').replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'planilha';
      const asciiBase = base.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^A-Za-z0-9._-]+/gu, '-') || 'planilha';
      const downloadName = `${base}.${format}`;
      return new Response(Uint8Array.from(body).buffer, { headers: {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${asciiBase}.${format}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      } });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });

  /**
   * Bytes da imagem. Rota própria em vez de data URI embutido na conversa:
   * uma conversa com dez imagens carregaria megabytes de base64 em toda
   * abertura, e o navegador não conseguiria cachear nada disso.
   */
  app.get('/api/attachments/:id', async (c) => {
    const userId = c.get('userId');
    const record = await db.getAttachment(userId, c.req.param('id'));
    // Recurso de outro usuário devolve 404, não 403: não confirma que existe.
    if (!record || record.kind !== 'image' || !record.dataBase64) {
      return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Anexo não encontrado.' }));
    }
    return new Response(Buffer.from(record.dataBase64, 'base64'), {
      headers: {
        'content-type': record.mime,
        // Imutável: o id é único por upload, então o conteúdo nunca muda.
        'cache-control': 'private, max-age=31536000, immutable',
        // O arquivo veio de fora: nada de adivinhação de tipo pelo navegador.
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      },
    });
  });

  app.delete('/api/attachments/:id', async (c) => {
    const userId = c.get('userId');
    const deleted = await db.deleteAttachment(userId, c.req.param('id'));
    if (!deleted) {
      return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Anexo não encontrado ou já enviado.' }));
    }
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
        effort: body.effort,
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
    const [messages, anexos] = await Promise.all([
      db.getMessages(userId, id),
      db.listAttachmentsForConversation(userId, id),
    ]);
    const versoesPlanilha = new Map<string, number>();
    await Promise.all(anexos.map(async (anexo) => {
      if (anexo.kind !== 'spreadsheet') return;
      const current = await db.getSpreadsheetVersion(userId, anexo.id);
      if (!current) return;
      anexo.extractedText = current.workbookJson;
      versoesPlanilha.set(anexo.id, current.version);
    }));
    // Anexos vêm junto da mensagem para a interface não precisar de uma
    // requisição por bolha ao abrir a conversa.
    const porMensagem = new Map<string, Attachment[]>();
    for (const anexo of anexos) {
      if (!anexo.messageId) continue;
      const lista = porMensagem.get(anexo.messageId) ?? [];
      lista.push(toAttachment(anexo, versoesPlanilha.get(anexo.id) ?? 1));
      porMensagem.set(anexo.messageId, lista);
    }
    return c.json({
      messages: messages.map((message) => {
        const lista = porMensagem.get(message.id);
        return lista ? { ...message, attachments: lista } : message;
      }),
    });
  });

  app.get('/api/conversations/:id/artifacts', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' }));
    return c.json({ artifacts: await db.getArtifacts(userId, id) });
  });

  /**
   * Edição manual: grava uma versão NOVA, nunca sobrescreve a anterior.
   *
   * O histórico do artefato é a razão de ele ser versionado — poder voltar ao
   * que o modelo escreveu depois de mexer à mão é justamente o que torna
   * seguro mexer à mão. A operação fica como `rewrite` porque é isso que
   * aconteceu com o conteúdo; o que distingue a mão do modelo é `messageId`
   * nulo: nenhuma mensagem gerou esta versão.
   */
  app.put('/api/conversations/:id/artifacts/:slug', async (c) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');
      if (!await db.getConversation(userId, id)) {
        throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      }
      const slug = c.req.param('slug');
      const atual = (await db.getArtifacts(userId, id)).find((item) => item.slug === slug);
      if (!atual) throw new AppError('UNKNOWN', { status: 404, message: 'Artefato não encontrado.' });

      const body = await parseJson(c, ArtifactEditSchema);
      const version = await db.insertArtifactVersion(userId, {
        conversationId: id,
        slug,
        kind: atual.kind,
        language: atual.language,
        title: atual.title,
        content: body.content,
        operation: 'rewrite',
        // Sem mensagem e sem custo: ninguém gastou token para escrever isto, e
        // custo ausente é exibido como indisponível, nunca como zero.
        messageId: null,
        outputTokens: null,
        costUsd: null,
        version: atual.currentVersion + 1,
      });
      return c.json({ version });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
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
      // O nível de esforço acompanha provedor e modelo: vem no envio e a
      // conversa é sincronizada, para que recarregar a página encontre o
      // mesmo nível que estava valendo. Ausente no envio, mantém o da
      // conversa — assim um cliente antigo não zera a escolha do usuário.
      if (!conversation) {
        conversation = await db.createConversation(userId, {
          providerId: selection.provider.id,
          modelId: selection.model.id,
          effort: request.effort,
        });
      } else if (
        conversation.providerId !== selection.provider.id
        || conversation.modelId !== selection.model.id
        || (request.effort !== undefined && request.effort !== conversation.effort)
      ) {
        conversation = await db.updateConversation(userId, conversation.id, {
          providerId: selection.provider.id,
          modelId: selection.model.id,
          effort: request.effort,
        });
        if (!conversation) throw new AppError('UNKNOWN', { status: 404, message: 'Conversa não encontrada.' });
      }

      const mensagemDoUsuario = await db.insertMessage(userId, {
        conversationId: conversation.id,
        role: 'user',
        content: request.content,
        providerId: selection.provider.id,
        modelId: selection.model.id,
      });

      // Anexos: carregados PELO DONO e amarrados à mensagem agora. Um id de
      // outro usuário simplesmente não aparece na consulta, então não há como
      // anexar arquivo alheio a uma conversa própria.
      const idsPedidos = request.attachmentIds ?? [];
      if (idsPedidos.length > 0) {
        const encontrados = await db.getAttachments(userId, idsPedidos);
        const novos = encontrados.filter((anexo) => anexo.messageId === null);
        await db.attachToMessage(
          userId,
          novos.map((anexo) => anexo.id),
          conversation.id,
          mensagemDoUsuario.id,
        );
      }
      const anexosDaConversa = await db.listAttachmentsForConversation(userId, conversation.id);
      // A linha de attachments guarda a versão importada; o contexto deve usar
      // sempre a edição mais recente do histórico da planilha.
      await Promise.all(anexosDaConversa.map(async (anexo) => {
        if (anexo.kind !== 'spreadsheet') return;
        const selectedVersion = request.spreadsheetSelection?.attachmentId === anexo.id
          ? request.spreadsheetSelection.version
          : undefined;
        const current = await db.getSpreadsheetVersion(userId, anexo.id, selectedVersion);
        if (selectedVersion !== undefined && !current) {
          throw new AppError('UNKNOWN', { status: 404, message: 'A versão selecionada da planilha não existe.' });
        }
        if (current) anexo.extractedText = current.workbookJson;
      }));
      if (request.spreadsheetSelection && !anexosDaConversa.some((anexo) => anexo.id === request.spreadsheetSelection?.attachmentId)) {
        throw new AppError('UNKNOWN', { status: 404, message: 'A planilha selecionada não pertence a esta conversa.' });
      }
      const anexosPorMensagem = new Map<string, AttachmentRecord[]>();
      for (const anexo of anexosDaConversa) {
        if (!anexo.messageId) continue;
        const lista = anexosPorMensagem.get(anexo.messageId) ?? [];
        lista.push(anexo);
        anexosPorMensagem.set(anexo.messageId, lista);
      }
      // Modo Science: nível e formato acompanham a conversa, como o esforço.
      // Vindo no envio, sincroniza; ausente, mantém o que já estava — assim um
      // cliente antigo não desliga o modo sem querer.
      const nivelScience = request.scienceLevel ?? conversation.scienceLevel ?? 'off';
      const formatoScience = request.scienceFormat ?? conversation.scienceFormat ?? 'markdown';
      const cadeia = scienceChain(nivelScience);
      if (request.scienceLevel !== undefined || request.scienceFormat !== undefined) {
        const atualizada = await db.updateConversation(userId, conversation.id, {
          scienceLevel: nivelScience,
          scienceFormat: formatoScience,
        });
        if (atualizada) conversation = atualizada;
      }

      // Resolvida DENTRO da requisição, como o provedor. `null` quando não há
      // busca utilizável — e aí o prompt de busca nem é injetado, então o
      // modelo nunca pede algo que não vai chegar.
      const busca = await resolveSearch(userId, db);
      const context = requestContext(
        conversation.systemPrompt,
        await db.getMessages(userId, conversation.id),
        await db.getArtifacts(userId, conversation.id),
        selection.model.ctx,
        busca ? [searchSystemPrompt(MAX_SEARCH_ROUNDS)] : [],
        anexosPorMensagem,
        request.spreadsheetSelection,
      );
      // Cresce a cada round de busca: o prompt real cobrado é a soma de todos,
      // e é ele que serve de base para a estimativa quando o provedor não
      // informa contagem.
      let promptText = context.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
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
      // Um por round; somados no fim (ver sumProviderUsage em cost.ts).
      const usoPorRound: Array<Record<string, unknown> | null> = [];
      let rawUsage: Record<string, unknown> | null = null;
      let finishReason: string | null = null;
      let lastPersistedAt = 0;
      let lastPersistedLength = 0;
      const parser = createArtifactParser();
      const artifactBuffers = new Map<string, string>();
      const openSpreadsheets = new Map<string, { title: string }>();
      const generatedSpreadsheetBodies: string[] = [];
      const generatedSpreadsheetNames: string[] = [];
      const openArtifacts = new Map<string, {
        version: number;
        operation: 'create' | 'rewrite';
        kind: 'markdown' | 'code' | 'svg' | 'mermaid' | 'mindmap' | 'chart';
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

      /**
       * Registro de diagnóstico. Eventos, nunca conteúdo — ver SseTraceSchema.
       *
       * Sempre ligado: o volume é de dezenas de linhas curtas por turno, e um
       * log que só existe quando alguém lembra de ligá-lo nunca está ligado na
       * hora em que o problema aparece.
       */
      const trace = async (
        stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never,
        scope: string,
        event: string,
        detail?: string,
      ) => {
        await emit(stream, {
          type: 'trace',
          scope,
          event,
          detail: detail?.slice(0, 300),
          at: Math.max(0, Date.now() - startedAt),
          conversationId: conversation.id,
          messageId: assistant.id,
        });
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
            if (parserEvent.type === 'spreadsheet') {
              openSpreadsheets.set(parserEvent.slug, { title: parserEvent.title });
              artifactBuffers.set(parserEvent.slug, '');
              continue;
            }
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
            if (openSpreadsheets.has(parserEvent.slug)) continue;
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
            const spreadsheet = openSpreadsheets.get(parserEvent.slug);
            if (spreadsheet) {
              const body = artifactBuffers.get(parserEvent.slug) ?? '';
              generatedSpreadsheetBodies.push(body);
              openSpreadsheets.delete(parserEvent.slug);
              artifactBuffers.delete(parserEvent.slug);
              if (parserEvent.truncated) {
                const warning = `\n\nNão consegui concluir a planilha “${spreadsheet.title}” porque a resposta foi interrompida.\n\n`;
                content += warning;
                await emit(stream, { type: 'text', text: warning, conversationId: conversation.id, messageId: assistant.id });
                continue;
              }
              try {
                const generated = generatedSpreadsheetFromArtifact(body, spreadsheet.title);
                const bytes = await workbookToXlsx(generated.workbook);
                const record = await db.createAttachment(userId, {
                  kind: 'spreadsheet',
                  filename: generated.filename,
                  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  sizeBytes: bytes.length,
                  dataBase64: bytes.toString('base64'),
                  extractedText: JSON.stringify(generated.workbook),
                  truncated: false,
                });
                try {
                  const version = await db.insertSpreadsheetVersion(userId, record.id, JSON.stringify(generated.workbook));
                  if (!version) throw new AppError('UNKNOWN', { status: 500, message: 'Não consegui iniciar o histórico da planilha gerada.' });
                  await db.attachToMessage(userId, [record.id], conversation.id, assistant.id);
                  const attachment = toAttachment(record, version.version);
                  if (attachment.kind !== 'spreadsheet' || !attachment.spreadsheet) {
                    throw new AppError('UNKNOWN', { status: 500, message: 'A planilha gerada não pôde ser preparada para exibição.' });
                  }
                  generatedSpreadsheetNames.push(generated.filename);
                  await emit(stream, {
                    type: 'spreadsheet_ready',
                    attachment: { ...attachment, kind: 'spreadsheet', textChars: null, spreadsheet: attachment.spreadsheet },
                    conversationId: conversation.id,
                    messageId: assistant.id,
                  });
                } catch (cause) {
                  await db.deleteAttachment(userId, record.id);
                  throw cause;
                }
              } catch (cause) {
                const failure = normalizeError(cause);
                const warning = `\n\nNão consegui criar a planilha “${spreadsheet.title}”: ${failure.message}\n\n`;
                content += warning;
                await emit(stream, { type: 'text', text: warning, conversationId: conversation.id, messageId: assistant.id });
              }
              continue;
            }
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

      const completionText = () => `${content}${[...artifactBuffers.values()].join('')}${generatedSpreadsheetBodies.join('')}${producedVersions.map((item) => item.completionText).join('')}`;

      const ensureGeneratedSpreadsheetText = async (
        stream: Parameters<typeof streamSSE>[1] extends (stream: infer T) => Promise<void> ? T : never,
      ) => {
        if (content.trim() || generatedSpreadsheetNames.length === 0) return;
        const names = generatedSpreadsheetNames.map((name) => `“${name}”`).join(', ');
        const text = `Criei a planilha ${names}. Ela já está aberta para edição e também pode ser baixada em XLSX.`;
        content = text;
        await emit(stream, { type: 'text', text, conversationId: conversation.id, messageId: assistant.id });
      };

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
              await trace(stream, 'chat', 'turno iniciado',
                `${selection.provider.id}/${selection.model.id} · esforço ${conversation.effort}`
                + ` · science ${nivelScience}${cadeia ? ` (${cadeia.stages.length} agentes, ${formatoScience})` : ''}`
                + ` · busca ${busca ? 'ligada' : 'desligada'} · contexto ${context.messages.length} mensagens`
                + `${context.truncated ? ' (aparado)' : ''}`);

              /**
               * Modo Science: a mesma pergunta passa por vários agentes, cada
               * um com prompt de sistema próprio, e só o ÚLTIMO escreve na
               * tela. Os intermediários rodam sem emitir texto — o usuário vê
               * o progresso por estágio, não três versões do mesmo documento
               * se sobrepondo.
               *
               * Roda ANTES do laço normal, e o resultado entra como material
               * do turno final. Assim tudo o que já existe (artefatos, busca,
               * anexos) continua valendo para a última passagem.
               */
              let materialScience: string | null = null;
              /** Estágios que caíram; ditos ao usuário no fim, não escondidos. */
              const falhasDeEstagio: string[] = [];
              if (cadeia) {
                const intermediarios = cadeia.stages.slice(0, -1);
                let texto = '';
                for (const [posicao, estagio] of intermediarios.entries()) {
                  await emit(stream, {
                    type: 'science_stage',
                    role: estagio.role,
                    label: estagio.label,
                    index: posicao + 1,
                    total: cadeia.stages.length,
                    status: 'start',
                    conversationId: conversation.id,
                    messageId: assistant.id,
                  });

                  /**
                   * O texto passado adiante é orçado contra a janela do modelo.
                   *
                   * Cada estágio recebe o documento inteiro do anterior, e o
                   * documento cresce a cada passagem — no terceiro estágio a
                   * entrada já é o dobro da do primeiro. Sem teto, uma cadeia
                   * de cinco estoura a janela no meio do caminho e o provedor
                   * recusa a requisição, jogando fora o trabalho todo.
                   *
                   * Metade da janela: a outra metade é para a resposta, que
                   * neste modo é um documento longo por definição.
                   */
                  const tetoDeEntrada = Math.max(2_000, Math.floor(selection.model.ctx * 0.5));
                  const textoOrcado = estimateTokens(texto) > tetoDeEntrada
                    ? `${texto.slice(0, tetoDeEntrada * 4)}\n\n[…texto cortado por tamanho; continue a partir daqui…]`
                    : texto;

                  const entrada: ContextMessage[] = [
                    { role: 'system', content: estagio.systemPrompt(formatoScience) },
                    ...context.messages.filter((m) => m.role !== 'system'),
                    ...(textoOrcado ? [{ role: 'user' as const, content: handoffMessage(estagio.role, textoOrcado) }] : []),
                  ];

                  let produzido = '';
                  let usoDoEstagio: Record<string, unknown> | null = null;
                  let ultimoSinalDeVida = Date.now();
                  let caracteresDeRaciocinio = 0;
                  const comecouEm = Date.now();
                  await trace(stream, 'science', `agente ${posicao + 1}/${cadeia.stages.length} iniciado`,
                    `${estagio.role} · entrada ${estimateTokens(entrada.map((m) => m.content).join('\n'))} tokens estimados`);
                  /**
                   * A falha de um estágio NÃO derruba a cadeia.
                   *
                   * Antes, um erro no terceiro de cinco estágios perdia todo o
                   * trabalho dos dois primeiros — o usuário esperava minutos
                   * para receber "geração interrompida" e nada mais. Agora o
                   * que já foi escrito segue para o revisor, que entrega um
                   * documento mais raso em vez de nenhum. O aviso diz qual
                   * estágio caiu, para a degradação não ser silenciosa.
                   */
                  try {
                  for await (const evento of streamOpenAICompatible({
                    providerId: selection.provider.id,
                    modelId: selection.model.id,
                    baseURL: selection.provider.baseURL,
                    apiKey: selection.provider.apiKey,
                    requiresApiKey: selection.provider.requiresApiKey,
                    messages: entrada,
                    temperature: request.temperature,
                    effort: conversation.effort,
                    signal: upstreamController.signal,
                    fetchImpl: options.fetchImpl,
                    onTrace: (evento, detalhe) => { void trace(stream, 'provedor', `agente ${posicao + 1}: ${evento}`, detalhe); },
                  })) {
                    if (evento.kind === 'text') {
                      produzido += evento.text;
                      // Repassado como bastidor: o usuário acompanha, e a
                      // conexão não fica minutos em silêncio.
                      await emit(stream, {
                        type: 'science_delta',
                        role: estagio.role,
                        index: posicao + 1,
                        text: evento.text,
                        conversationId: conversation.id,
                        messageId: assistant.id,
                      });
                      /**
                       * Renova o slot de stream a cada 30s.
                       *
                       * O slot expira em 10 minutos sem atividade, e quem o
                       * renovava era `persistPartial` — que só roda no laço
                       * principal, nunca aqui. Uma cadeia de três a cinco
                       * estágios passa de 10 minutos com folga, e o slot
                       * expirava no meio do trabalho.
                       */
                      if (Date.now() - ultimoSinalDeVida > 30_000) {
                        ultimoSinalDeVida = Date.now();
                        if (streamSlotId) await rateLimit.touchStream(userId, streamSlotId);
                      }
                    } else if (evento.kind === 'reasoning') {
                      // NÃO entra em `produzido`: raciocínio não é o documento,
                      // e passá-lo adiante contaminaria o texto do próximo
                      // agente. Vai só como sinal de vida e de progresso.
                      caracteresDeRaciocinio += evento.reasoning.length;
                      await emit(stream, {
                        type: 'science_delta',
                        role: estagio.role,
                        index: posicao + 1,
                        text: evento.reasoning,
                        reasoning: true,
                        conversationId: conversation.id,
                        messageId: assistant.id,
                      });
                    } else if (evento.kind === 'usage') usoDoEstagio = evento.usage;
                  }
                  // Cada estágio é uma chamada cobrada; ficar só com a última
                  // faria o custo de uma cadeia de cinco parecer o de uma.
                  } catch (falha) {
                    // Aborto do usuário é decisão dele: propaga e encerra.
                    if (clientAborted || upstreamController.signal.aborted) throw falha;
                    const motivo = normalizeError(falha);
                    falhasDeEstagio.push(`${estagio.label}: ${motivo.message}`);
                    await trace(stream, 'science', `agente ${posicao + 1}/${cadeia.stages.length} FALHOU`,
                      `${motivo.code} · ${motivo.message}`);
                    // Sem texto nenhum até aqui, não há o que revisar.
                    if (!texto.trim() && !produzido.trim()) throw falha;
                  }

                  usoPorRound.push(usoDoEstagio);
                  promptText += `\n${estagio.role}: ${entrada.map((m) => m.content).join('\n')}`;
                  const aproveitou = produzido.trim().length > 0;
                  texto = produzido.trim() || texto;
                  await trace(stream, 'science', `agente ${posicao + 1}/${cadeia.stages.length} concluído`,
                    `${((Date.now() - comecouEm) / 1000).toFixed(1)}s · ${produzido.length} caracteres`
                    + `${caracteresDeRaciocinio > 0 ? ` · ${caracteresDeRaciocinio} de raciocínio` : ''}`
                    + `${usoDoEstagio ? '' : ' · provedor não informou uso'}`
                    + `${aproveitou ? '' : ' · SEM TEXTO, mantido o do estágio anterior'}`);

                  await emit(stream, {
                    type: 'science_stage',
                    role: estagio.role,
                    label: estagio.label,
                    index: posicao + 1,
                    total: cadeia.stages.length,
                    status: 'done',
                    conversationId: conversation.id,
                    messageId: assistant.id,
                  });
                }
                materialScience = texto || null;

                const revisor = cadeia.stages[cadeia.stages.length - 1];
                await emit(stream, {
                  type: 'science_stage',
                  role: revisor.role,
                  label: revisor.label,
                  index: cadeia.stages.length,
                  total: cadeia.stages.length,
                  status: 'start',
                  conversationId: conversation.id,
                  messageId: assistant.id,
                });
              }

              // Rounds: o normal é um só. Cada busca pedida pelo modelo custa
              // um round a mais, porque a única forma de ele VER os resultados
              // é uma nova chamada ao provedor com eles no contexto.
              const mensagens: ContextMessage[] = cadeia
                ? [
                  // O revisor recebe o prompt DELE no lugar do prompt padrão:
                  // as regras de artefato continuam (vêm do extras), mas quem
                  // manda no turno é o papel de revisão.
                  { role: 'system', content: cadeia.stages[cadeia.stages.length - 1].systemPrompt(formatoScience) },
                  ...context.messages.filter((m) => m.role !== 'system'),
                  ...(materialScience ? [{
                    role: 'user' as const,
                    content: handoffMessage('revisao', estimateTokens(materialScience) > Math.floor(selection.model.ctx * 0.5)
                      ? materialScience.slice(0, Math.floor(selection.model.ctx * 0.5) * 4)
                      : materialScience),
                  }] : []),
                ]
                : [...context.messages];
              for (let round = 1; round <= MAX_SEARCH_ROUNDS + 1; round += 1) {
                // Do round, não do turno: uma busca encerra este round sem
                // cancelar a resposta inteira.
                await trace(stream, 'chat', `round ${round} iniciado`, `${mensagens.length} mensagens no contexto`);
                const scanner = createSearchScanner();
                let consultaPedida: string | null = null;
                let textoDoRound = '';
                let usoDoRound: Record<string, unknown> | null = null;
                let descartadoAposMarcador = 0;

                const consumirScanner = async (eventos: ReturnType<typeof scanner.push>) => {
                  for (const evento of eventos) {
                    // Para no primeiro marcador e ABANDONA o resto do lote. O
                    // prompt manda parar de escrever ao fechar o marcador, e o
                    // que vier depois foi escrito sem os resultados — é chute.
                    // Sem este `return`, um chunk único contendo marcador e
                    // continuação entregaria a continuação ao usuário.
                    if (evento.kind === 'search') {
                      consultaPedida = evento.query;
                      return;
                    }
                    textoDoRound += evento.text;
                    await consumeParserEvents(parser.push(evento.text), stream);
                  }
                };

                for await (const event of streamOpenAICompatible({
                  providerId: selection.provider.id,
                  modelId: selection.model.id,
                  // Dados EFETIVOS do usuário, resolvidos dentro da requisição.
                  baseURL: selection.provider.baseURL,
                  apiKey: selection.provider.apiKey,
                  requiresApiKey: selection.provider.requiresApiKey,
                  messages: mensagens,
                  temperature: request.temperature,
                  // Já sincronizado acima: a conversa é a fonte da verdade.
                  effort: conversation.effort,
                  signal: upstreamController.signal,
                  fetchImpl: options.fetchImpl,
                  onTrace: (evento, detalhe) => { void trace(stream, 'provedor', evento, detalhe); },
                })) {
                  if (event.kind === 'text') {
                    if (consultaPedida === null) {
                      await consumirScanner(scanner.push(event.text));
                      await persistPartial();
                      continue;
                    }
                    // Marcador já fechado: o texto daqui em diante é descartado,
                    // mas o round CONTINUA sendo lido. O motivo é o custo — o
                    // `usage` do provedor vem no último chunk, e abortar aqui
                    // faria toda resposta com busca virar custo estimado, num
                    // recurso que justamente gasta mais. O prompt manda o modelo
                    // parar de escrever ao fechar o marcador, então no caso bem
                    // comportado sobra quase nada para drenar.
                    descartadoAposMarcador += event.text.length;
                    // Válvula para o modelo que ignora a instrução: a partir
                    // daqui, contagem exata não vale o que ela custa.
                    if (descartadoAposMarcador > MAX_DESCARTE_APOS_MARCADOR) break;
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
                    usoDoRound = event.usage;
                    rawUsage = event.usage;
                  } else if (event.kind === 'finish') {
                    finishReason = event.finishReason;
                  }
                }

                usoPorRound.push(usoDoRound);

                if (consultaPedida === null) {
                  // Round terminou sem busca: o que sobrou no scanner é texto
                  // (um `<sear` que nunca virou marcador, por exemplo).
                  await consumirScanner(scanner.end());
                  break;
                }

                // `busca` é não-nulo aqui por construção: sem ela o prompt de
                // busca não foi injetado, e o modelo não teria como pedir uma.
                if (!busca || round > MAX_SEARCH_ROUNDS) {
                  const aviso = `\n\n_Limite de ${MAX_SEARCH_ROUNDS} buscas por resposta atingido._\n\n`;
                  await consumeParserEvents(parser.push(aviso), stream);
                  break;
                }

                await emit(stream, {
                  type: 'search_start',
                  query: consultaPedida,
                  round,
                  conversationId: conversation.id,
                  messageId: assistant.id,
                });
                const resultado = await runSearch(busca, consultaPedida, upstreamController.signal, options.fetchImpl);
                await emit(stream, {
                  type: 'search_end',
                  query: consultaPedida,
                  round,
                  results: resultado.results,
                  failure: resultado.failure,
                  conversationId: conversation.id,
                  messageId: assistant.id,
                });

                // O turno do modelo é reconstruído com o marcador para ele se
                // reconhecer; os resultados entram como `user` porque é o único
                // papel que todo endpoint compatível aceita no meio da conversa
                // — `system` fora da primeira posição é recusado por parte dos
                // provedores, e o objetivo aqui é não depender disso.
                const turnoDoModelo = `${textoDoRound}<search>${consultaPedida}</search>`;
                const devolutiva = formatResultsForModel(consultaPedida, resultado);
                mensagens.push({ role: 'assistant', content: turnoDoModelo });
                mensagens.push({ role: 'user', content: devolutiva });
                promptText += `\nassistant: ${turnoDoModelo}\nuser: ${devolutiva}`;
              }

              await finishParser(stream);
              await ensureGeneratedSpreadsheetText(stream);
              await trace(stream, 'chat', 'resposta concluída',
                `${content.length} caracteres · ${producedVersions.length} artefato(s) · ${usoPorRound.length} chamada(s) ao provedor`);

              /**
               * Rede de segurança do modo Science: documento longo VIRA
               * artefato, mesmo que o modelo tenha ignorado a instrução.
               *
               * O prompt do revisor pede o artefato, mas prompt é pedido e não
               * imposição — e aqui a diferença é grande: um documento de
               * milhares de palavras solto no corpo da mensagem some no
               * histórico, não versiona, não tem painel e não dá para baixar.
               * Quando o modelo não abre a tag, o servidor abre por ele.
               */
              if (cadeia && producedVersions.length === 0 && content.trim().length >= MIN_SCIENCE_ARTIFACT_CHARS) {
                const documento = content.trim();
                const kind = formatoScience === 'latex' ? 'code' : 'markdown';
                const language = formatoScience === 'latex' ? 'latex' : null;
                // Título tirado da primeira linha que parece título; sem isso o
                // cartão viria com o slug, que não diz nada.
                const primeiraLinha = documento.split('\n').find((linha) => linha.trim()) ?? '';
                const title = primeiraLinha
                  .replace(/^#{1,6}\s+/u, '')
                  .replace(/^\\(?:title|section|chapter)\s*\{([^{}]*)\}.*$/u, '$1')
                  .trim()
                  .slice(0, 110) || 'Documento';
                const slug = 'documento';
                const existente = (await db.getArtifacts(userId, conversation.id)).find((item) => item.slug === slug);
                const artefato = await db.upsertArtifact(userId, {
                  conversationId: conversation.id, slug, kind, language, title,
                });
                const versao = artefato.currentVersion + 1;
                await db.insertArtifactVersion(userId, {
                  conversationId: conversation.id,
                  slug, kind, language, title,
                  content: documento,
                  operation: existente ? 'rewrite' : 'create',
                  messageId: assistant.id,
                  version: versao,
                });
                producedVersions.push({
                  slug,
                  version: versao,
                  content: documento,
                  completionText: documento,
                  costBasisTokens: Math.max(1, estimateTokens(documento)),
                });
                completedArtifactEnds.push({ slug, version: versao, truncated: false });
                await emit(stream, {
                  type: 'artifact_start',
                  slug, kind, language, title,
                  version: versao,
                  operation: existente ? 'rewrite' : 'create',
                  conversationId: conversation.id,
                  messageId: assistant.id,
                });
                // A mensagem passa a ser a chamada do artefato; o texto inteiro
                // vive nele. Sem esta troca o documento apareceria duas vezes.
                content = `${title}\n\n${artifactMarker(slug, versao)}`;
                await trace(stream, 'artefato', 'documento guardado pelo servidor',
                  `${kind}${language ? `/${language}` : ''} · v${versao} · ${documento.length} caracteres`);
              }

              // Degradação nunca é silenciosa: se um estágio caiu, o documento
              // saiu mais raso e o usuário precisa saber por quê.
              if (falhasDeEstagio.length > 0) {
                const aviso = `\n\n---\n\n_Aviso: ${falhasDeEstagio.length === 1 ? 'um estágio não concluiu' : `${falhasDeEstagio.length} estágios não concluíram`} — ${falhasDeEstagio.join('; ')}. O documento foi montado com o que os demais produziram._`;
                await consumeParserEvents(parser.push(aviso), stream);
                await finishParser(stream);
              }

              const calculated = calculateUsageAndCost(selection.model, {
                // Soma dos rounds. `rawUsage` (o último visto) só entra quando
                // a soma não é possível — é o caso do caminho de erro, em que
                // o round corrente pode ter sido interrompido antes de o uso
                // ser registrado na lista.
                raw: sumProviderUsage(usoPorRound) ?? rawUsage,
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
              await ensureGeneratedSpreadsheetText(stream);
              const calculated = calculateUsageAndCost(selection.model, {
                // Soma dos rounds. `rawUsage` (o último visto) só entra quando
                // a soma não é possível — é o caso do caminho de erro, em que
                // o round corrente pode ter sido interrompido antes de o uso
                // ser registrado na lista.
                raw: sumProviderUsage(usoPorRound) ?? rawUsage,
                promptText,
                completionText: completionText(),
                reasoningText: reasoning,
              });
              await attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
              await emitArtifactEnds(stream);
              const terminalReason = aborted ? 'aborted' : 'error';
              await trace(stream, 'chat', aborted ? 'ABORTADO' : 'ERRO',
                aborted
                  ? `cliente ${clientAborted ? 'desconectou' : 'ainda ligado'} · sinal ${requestSignal.aborted ? 'abortado' : 'ativo'} · stream ${stream.aborted ? 'fechado' : 'aberto'}`
                  : `${normalized.code} · ${normalized.message}`);
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
 * resposta JSON legível (ver src/server/vercel-handler.ts).
 */
export function getApp(): Hono<{ Variables: AppVariables }> {
  cachedApp ??= createApp();
  return cachedApp;
}
