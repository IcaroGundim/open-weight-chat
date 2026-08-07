// src/server/vercel-handler.ts
import { handle } from "@hono/node-server/vercel";
import { Readable } from "node:stream";

// src/server/index.ts
import { existsSync } from "node:fs";
import { join as join3 } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

// src/shared/types.ts
import { z } from "zod";
var BUILTIN_PROVIDER_IDS = ["deepseek", "glm", "kimi", "openrouter", "ollama"];
var ProviderIdSchema = z.string().regex(
  /^[a-z0-9][a-z0-9-]{0,31}$/u,
  "O id do provedor deve ter de 1 a 32 caracteres: min\xFAsculas, d\xEDgitos e h\xEDfen."
);
var MessageRoleSchema = z.enum(["system", "user", "assistant"]);
var ErrorCodeSchema = z.enum([
  "RATE_LIMIT",
  "INSUFFICIENT_BALANCE",
  "CONTEXT_LENGTH_EXCEEDED",
  "INVALID_API_KEY",
  "MODEL_NOT_FOUND",
  "UPSTREAM_TIMEOUT",
  "UNAUTHORIZED",
  "UNKNOWN"
]);
var EffortLevelSchema = z.enum(["auto", "off", "low", "medium", "high", "xhigh", "max"]);
var ArtifactKindSchema = z.enum(["markdown", "code", "svg", "mermaid", "mindmap", "chart"]);
var ArtifactSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
var ArtifactVersionSchema = z.object({
  version: z.number().int().positive(),
  content: z.string(),
  operation: z.enum(["create", "rewrite", "update"]),
  messageId: z.string().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  truncated: z.boolean(),
  createdAt: z.number().int().nonnegative()
});
var ArtifactSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  slug: ArtifactSlugSchema,
  kind: ArtifactKindSchema,
  language: z.string().max(32).nullable(),
  title: z.string().min(1).max(120),
  currentVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  versions: z.array(ArtifactVersionSchema)
});
var UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimated: z.boolean()
});
var CostSchema = z.object({
  usd: z.number().nonnegative().nullable(),
  estimated: z.boolean(),
  pricingAvailable: z.boolean(),
  /**
   * O valor veio do provedor, e não da tabela de `providers.config.ts`.
   *
   * A distinção importa porque a tabela descreve o preço padrão de um id de
   * modelo, e há casos em que ele não é o preço cobrado — na OpenRouter, o
   * endpoint que atende varia (e mais ainda com o roteamento rápido ligado).
   * Quando o provedor informa quanto custou, esse número ganha: ele não é uma
   * projeção nossa sobre a chamada, é a chamada.
   *
   * `default(false)` porque mensagens gravadas antes deste campo existir
   * foram todas calculadas pela tabela.
   */
  reported: z.boolean().default(false)
});
var ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean()
});
var SseBaseSchema = z.object({
  conversationId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional()
});
var SseTextSchema = SseBaseSchema.extend({
  type: z.literal("text"),
  text: z.string()
});
var SseReasoningSchema = SseBaseSchema.extend({
  type: z.literal("reasoning"),
  reasoning: z.string()
});
var SseUsageSchema = SseBaseSchema.extend({
  type: z.literal("usage"),
  usage: UsageSchema,
  cost: CostSchema
});
var SseErrorSchema = SseBaseSchema.extend({
  type: z.literal("error"),
  error: ApiErrorSchema
});
var SseDoneSchema = SseBaseSchema.extend({
  type: z.literal("done"),
  done: z.literal(true),
  finishReason: z.string().optional(),
  truncated: z.boolean().optional(),
  usage: UsageSchema.optional(),
  cost: CostSchema.optional()
});
var SseArtifactStartSchema = SseBaseSchema.extend({
  type: z.literal("artifact_start"),
  slug: ArtifactSlugSchema,
  kind: ArtifactKindSchema,
  language: z.string().max(32).nullable(),
  title: z.string().min(1).max(120),
  version: z.number().int().positive(),
  operation: z.enum(["create", "rewrite", "update"])
});
var SseArtifactDeltaSchema = SseBaseSchema.extend({
  type: z.literal("artifact_delta"),
  slug: ArtifactSlugSchema,
  text: z.string()
});
var SseArtifactEndSchema = SseBaseSchema.extend({
  type: z.literal("artifact_end"),
  slug: ArtifactSlugSchema,
  version: z.number().int().positive(),
  truncated: z.boolean(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable()
});
var SseSpreadsheetReadySchema = SseBaseSchema.extend({
  type: z.literal("spreadsheet_ready"),
  attachment: z.object({
    id: z.string().min(1),
    kind: z.literal("spreadsheet"),
    filename: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    textChars: z.null(),
    truncated: z.boolean(),
    spreadsheet: z.object({
      sheetNames: z.array(z.string()),
      version: z.number().int().positive()
    }),
    createdAt: z.number()
  })
});
var SearchBackendSchema = z.enum(["brave", "tavily", "searxng", "openrouter"]);
var SearchResultSchema = z.object({
  title: z.string().min(1).max(300),
  url: z.string().url().max(2048),
  snippet: z.string().max(1200),
  /** Data de publicação quando o backend informa; nunca inventada. */
  publishedAt: z.string().max(40).nullable().optional()
});
var SearchSettingsInputSchema = z.object({
  backend: SearchBackendSchema,
  /** Obrigatória só no searxng; ignorada nos demais. */
  baseURL: z.string().url().max(2048).optional(),
  /** undefined mantém a chave atual; null apaga; string grava a nova. */
  apiKey: z.string().max(400).nullable().optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional()
});
var SearchSettingsSchema = z.object({
  backend: SearchBackendSchema,
  baseURL: z.string().max(2048).nullable(),
  hasKey: z.boolean(),
  maxResults: z.number().int().min(1).max(10),
  enabled: z.boolean(),
  updatedAt: z.number()
});
var SearchSettingsResponseSchema = z.object({
  settings: SearchSettingsSchema.nullable(),
  /** Mesma disciplina do campo de chave dos provedores (ver secrets.ts). */
  secretStorage: z.object({ available: z.boolean(), reason: z.string().nullable() })
});
var SseSearchStartSchema = SseBaseSchema.extend({
  type: z.literal("search_start"),
  query: z.string().min(1).max(400),
  round: z.number().int().positive()
});
var SseSearchEndSchema = SseBaseSchema.extend({
  type: z.literal("search_end"),
  query: z.string().min(1).max(400),
  round: z.number().int().positive(),
  results: z.array(SearchResultSchema),
  /** Preenchido quando a busca falhou: o modelo segue, o usuário fica sabendo. */
  failure: z.string().max(300).nullable().optional()
});
var ScienceLevelSchema = z.enum(["off", "basic", "intermediate", "advanced"]);
var ScienceFormatSchema = z.enum(["markdown", "latex"]);
var ScienceRoleSchema = z.enum(["pesquisa", "aprofundamento", "sintese", "ilustracao", "revisao"]);
var SseScienceStageSchema = SseBaseSchema.extend({
  type: z.literal("science_stage"),
  role: ScienceRoleSchema,
  label: z.string().min(1).max(120),
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  status: z.enum(["start", "done"])
});
var SseScienceDeltaSchema = SseBaseSchema.extend({
  type: z.literal("science_delta"),
  role: ScienceRoleSchema,
  index: z.number().int().positive(),
  text: z.string(),
  /**
   * O pedaço é raciocínio, não documento.
   *
   * Precisa ser distinguido por duas razões. A primeira é de interface: o
   * usuário não pode confundir o rascunho do texto com o modelo pensando em
   * voz alta. A segunda é a que motivou o campo: com esforço alto o modelo
   * passa MINUTOS só raciocinando antes da primeira palavra escrita, e sem
   * repassar isso a tela ficava parada no primeiro estágio — parecia que a
   * cadeia nunca começava.
   */
  reasoning: z.boolean().optional()
});
var SseTraceSchema = SseBaseSchema.extend({
  type: z.literal("trace"),
  /** De onde veio: `chat`, `science`, `busca`, `provedor`, `artefato`. */
  scope: z.string().min(1).max(24),
  event: z.string().min(1).max(80),
  /** Números e rótulos curtos. Sem texto do modelo. */
  detail: z.string().max(300).optional(),
  /** Milissegundos desde o início do turno. */
  at: z.number().int().nonnegative()
});
var SseEnvelopeSchema = z.discriminatedUnion("type", [
  SseTextSchema,
  SseReasoningSchema,
  SseUsageSchema,
  SseErrorSchema,
  SseDoneSchema,
  SseScienceStageSchema,
  SseScienceDeltaSchema,
  SseTraceSchema,
  SseSearchStartSchema,
  SseSearchEndSchema,
  SseArtifactStartSchema,
  SseArtifactDeltaSchema,
  SseArtifactEndSchema,
  SseSpreadsheetReadySchema
]);
var ModelPricingSchema = z.object({
  inputPerMillion: z.number().nonnegative().nullable(),
  cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
  outputPerMillion: z.number().nonnegative().nullable()
});
var ModelCatalogItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  reasoning: z.boolean(),
  pricing: ModelPricingSchema
});
var ProviderCatalogSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  configured: z.boolean(),
  verifiedAt: z.string(),
  stale: z.boolean(),
  /** 'custom' identifica provedores vindos da configuração do usuário. */
  source: z.enum(["builtin", "custom"]),
  models: z.array(ModelCatalogItemSchema)
});
var ModelsResponseSchema = z.object({
  providers: z.array(ProviderCatalogSchema),
  defaultProviderId: ProviderIdSchema,
  defaultModelId: z.string().min(1),
  /**
   * Erros de configuração de provedores personalizados. Nunca são silenciosos:
   * uma entrada inválida aparece aqui e a interface mostra ao usuário.
   */
  configErrors: z.array(z.string())
});
var ProviderModelInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(160).optional(),
  ctx: z.number({ error: "Informe a janela de contexto do modelo, em tokens." }).int("A janela precisa ser um n\xFAmero inteiro de tokens.").positive("A janela precisa ser maior que zero."),
  reasoning: z.boolean().optional(),
  pricing: z.object({
    inputPerMillion: z.number().nonnegative().nullable().optional(),
    cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
    outputPerMillion: z.number().nonnegative().nullable().optional()
  }).optional()
});
var ProviderSettingsInputSchema = z.object({
  label: z.string().trim().min(1, "D\xEA um nome ao provedor.").max(80),
  baseURL: z.string().url("A URL base precisa ser absoluta, incluindo https://"),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
  /** A lista é preenchida automaticamente pelo endpoint /models do provedor. */
  models: z.array(ProviderModelInputSchema).default([]),
  /** string grava a chave; null apaga; ausente mantém a que já existe. */
  apiKey: z.string().max(500).nullable().optional()
});
var ProviderSettingsSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  baseURL: z.string().min(1),
  verifiedAt: z.string().nullable(),
  models: z.array(ProviderModelInputSchema),
  hasKey: z.boolean(),
  updatedAt: z.number().int().nonnegative()
});
var ProviderSettingsResponseSchema = z.object({
  providers: z.array(ProviderSettingsSchema),
  secretStorage: z.object({ available: z.boolean(), reason: z.string().nullable() })
});
var AttachmentKindSchema = z.enum(["image", "document", "spreadsheet"]);
var SpreadsheetCellValueSchema = z.union([z.string().max(1e5), z.number().finite(), z.boolean(), z.null()]);
var SpreadsheetCellSchema = z.object({
  row: z.number().int().min(1).max(1e5),
  column: z.number().int().min(1).max(2e3),
  value: SpreadsheetCellValueSchema,
  /** Fórmula sem o '=' inicial; `value` contém o último resultado conhecido. */
  formula: z.string().max(8e3).optional()
});
var SpreadsheetSheetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rowCount: z.number().int().min(1).max(1e5),
  columnCount: z.number().int().min(1).max(2e3),
  cells: z.array(SpreadsheetCellSchema).max(25e4)
}).superRefine((sheet, context) => {
  for (const cell of sheet.cells) {
    if (cell.row > sheet.rowCount || cell.column > sheet.columnCount) {
      context.addIssue({ code: "custom", message: "H\xE1 c\xE9lula fora das dimens\xF5es declaradas da aba." });
      return;
    }
  }
  const coordinates = /* @__PURE__ */ new Set();
  for (const cell of sheet.cells) {
    const key = `${cell.row}:${cell.column}`;
    if (coordinates.has(key)) {
      context.addIssue({ code: "custom", message: "A aba cont\xE9m a mesma c\xE9lula mais de uma vez." });
      return;
    }
    coordinates.add(key);
  }
});
var SpreadsheetWorkbookSchema = z.object({
  sheets: z.array(SpreadsheetSheetSchema).min(1).max(100)
}).superRefine((workbook, context) => {
  const names = /* @__PURE__ */ new Set();
  let cells = 0;
  for (const sheet of workbook.sheets) {
    const folded = sheet.name.toLocaleLowerCase("pt-BR");
    if (names.has(folded)) {
      context.addIssue({ code: "custom", message: "Os nomes das abas precisam ser \xFAnicos." });
      return;
    }
    names.add(folded);
    cells += sheet.cells.length;
  }
  if (cells > 25e4) context.addIssue({ code: "custom", message: "A planilha excede 250.000 c\xE9lulas preenchidas." });
});
var SpreadsheetSaveSchema = z.object({
  workbook: SpreadsheetWorkbookSchema,
  /** Evita sobrescrever silenciosamente uma edição feita em outra aba. */
  baseVersion: z.number().int().min(1)
});
var SpreadsheetSelectionSchema = z.object({
  attachmentId: z.string().min(1),
  version: z.number().int().min(1),
  sheet: z.string().trim().min(1).max(100),
  startRow: z.number().int().min(1).max(1e5),
  startColumn: z.number().int().min(1).max(2e3),
  endRow: z.number().int().min(1).max(1e5),
  endColumn: z.number().int().min(1).max(2e3)
});
var MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
var MAX_ATTACHMENTS_PER_MESSAGE = 5;
var AttachmentUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(1).max(150),
  /** Conteúdo em base64. Ver MAX_ATTACHMENT_BYTES para o teto real. */
  data: z.string().min(1).max(Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 1024)
});
var AttachmentSchema = z.object({
  id: z.string().min(1),
  kind: AttachmentKindSchema,
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Só documentos: quantos caracteres de texto foram aproveitados. */
  textChars: z.number().int().nonnegative().nullable(),
  /** O texto do documento não coube inteiro e foi cortado. */
  truncated: z.boolean(),
  /** Metadados leves; o workbook completo só vem quando o painel é aberto. */
  spreadsheet: z.object({
    sheetNames: z.array(z.string()),
    version: z.number().int().min(1)
  }).nullable().optional(),
  createdAt: z.number()
});
var ArtifactEditSchema = z.object({
  content: z.string().max(512 * 1024)
});
var ChatRequestSchema = z.object({
  conversationId: z.string().min(1).nullable().optional(),
  content: z.string().trim().min(1, "A mensagem n\xE3o pode ficar vazia.").max(2e5),
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  /** Ausente equivale a `auto`: nenhum parâmetro de raciocínio é enviado. */
  effort: EffortLevelSchema.optional(),
  /**
   * Anexos já enviados, referenciados por id.
   *
   * O upload é uma requisição separada de propósito: mandar os bytes junto do
   * chat faria o corpo estourar o limite da plataforma e, pior, faria o
   * usuário esperar o upload inteiro sem nenhum retorno antes de a resposta
   * começar.
   */
  attachmentIds: z.array(z.string().min(1)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  /** Intervalo escolhido na grade para esta pergunta; o servidor lê os dados. */
  spreadsheetSelection: SpreadsheetSelectionSchema.optional(),
  /** Ausente ou `off` mantém a resposta normal, de um agente só. */
  scienceLevel: ScienceLevelSchema.optional(),
  scienceFormat: ScienceFormatSchema.optional()
});
var CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(1e5).nullable().optional(),
  effort: EffortLevelSchema.optional()
});
var UpdateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(1e5).nullable().optional(),
  effort: EffortLevelSchema.optional(),
  archived: z.boolean().optional()
});
var MessageSchema = z.object({
  attachments: z.array(AttachmentSchema).optional(),
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  reasoning: z.string().nullable(),
  providerId: ProviderIdSchema.nullable(),
  modelId: z.string().nullable(),
  usage: UsageSchema.nullable(),
  cost: CostSchema.nullable(),
  finishReason: z.string().nullable(),
  errorCode: ErrorCodeSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().nullable()
});
var ConversationSummarySchema = z.object({
  /** Cadeia de agentes desta conversa. `off` é o estado de quem não usa. */
  scienceLevel: ScienceLevelSchema.optional(),
  /** Formato escolhido uma vez, na primeira mensagem em modo Science. */
  scienceFormat: ScienceFormatSchema.optional(),
  id: z.string().min(1),
  title: z.string().nullable(),
  providerId: ProviderIdSchema,
  modelId: z.string(),
  systemPrompt: z.string().nullable(),
  /** Conversas criadas antes desta coluna existir leem como `auto`. */
  effort: EffortLevelSchema.default("auto"),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative()
});
var ConversationSchema = ConversationSummarySchema.extend({
  messages: z.array(MessageSchema)
});
var ConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema)
});
var ConversationResponseSchema = z.object({
  conversation: ConversationSchema
});
var SearchResponseSchema = z.object({
  results: z.array(ConversationSummarySchema)
});
var DeleteResponseSchema = z.object({
  ok: z.literal(true)
});
var CostDailyAggregateSchema = z.object({
  day: z.string().min(1),
  costUsd: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative()
});
var CostModelAggregateSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  costUsd: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative()
});
var CostAnalyticsResponseSchema = z.object({
  totalCostUsd: z.number().nonnegative(),
  daily: z.array(CostDailyAggregateSchema),
  byModel: z.array(CostModelAggregateSchema)
});

// src/shared/spreadsheet-formulas.ts
var CELL_REFERENCE = /^\$?([A-Z]{1,3})\$?(\d{1,6})$/iu;
var COMPARISON = /* @__PURE__ */ new Set(["=", "<>", "<", "<=", ">", ">="]);
function columnNumber(label) {
  let result = 0;
  for (const char of label.toLocaleUpperCase("en-US")) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}
function tokenize(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/u.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '"') {
      let value = "";
      cursor += 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') {
          value += '"';
          cursor += 2;
          continue;
        }
        if (source[cursor] === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        value += source[cursor];
        cursor += 1;
      }
      if (!closed) throw new Error("string");
      tokens.push({ kind: "string", value });
      continue;
    }
    if (char === "'") {
      let value = "";
      cursor += 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === "'" && source[cursor + 1] === "'") {
          value += "'";
          cursor += 2;
          continue;
        }
        if (source[cursor] === "'") {
          cursor += 1;
          closed = true;
          break;
        }
        value += source[cursor];
        cursor += 1;
      }
      if (!closed) throw new Error("sheet");
      tokens.push({ kind: "sheet", value });
      continue;
    }
    if (/\d/u.test(char) || char === "." && /\d/u.test(source[cursor + 1] ?? "")) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/u.exec(source.slice(cursor));
      if (!match) throw new Error("number");
      tokens.push({ kind: "number", value: match[0] });
      cursor += match[0].length;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "left", value: char });
      cursor += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "right", value: char });
      cursor += 1;
      continue;
    }
    if (char === "," || char === ";") {
      tokens.push({ kind: "separator", value: char });
      cursor += 1;
      continue;
    }
    if (char === ":") {
      tokens.push({ kind: "colon", value: char });
      cursor += 1;
      continue;
    }
    if (char === "!") {
      tokens.push({ kind: "bang", value: char });
      cursor += 1;
      continue;
    }
    if ("+-*/^&=<>".includes(char)) {
      const pair = source.slice(cursor, cursor + 2);
      const value = pair === "<=" || pair === ">=" || pair === "<>" ? pair : char;
      tokens.push({ kind: "operator", value });
      cursor += value.length;
      continue;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s()+\-*/^&=<>!,;:]/u.test(source[cursor])) cursor += 1;
    if (cursor === start) throw new Error("token");
    tokens.push({ kind: "word", value: source.slice(start, cursor) });
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}
var FormulaParser = class {
  constructor(tokens) {
    this.tokens = tokens;
  }
  cursor = 0;
  parse() {
    const expression = this.comparison();
    if (this.peek().kind !== "eof") throw new Error("trailing");
    return expression;
  }
  peek() {
    return this.tokens[this.cursor];
  }
  take() {
    const token = this.peek();
    this.cursor += 1;
    return token;
  }
  accept(kind, value) {
    const token = this.peek();
    if (token.kind !== kind || value !== void 0 && token.value !== value) return null;
    this.cursor += 1;
    return token;
  }
  require(kind) {
    const token = this.accept(kind);
    if (!token) throw new Error(kind);
    return token;
  }
  comparison() {
    let left = this.concat();
    while (this.peek().kind === "operator" && COMPARISON.has(this.peek().value)) {
      left = { kind: "binary", operator: this.take().value, left, right: this.concat() };
    }
    return left;
  }
  concat() {
    let left = this.addition();
    while (this.accept("operator", "&")) left = { kind: "binary", operator: "&", left, right: this.addition() };
    return left;
  }
  addition() {
    let left = this.multiplication();
    while (this.peek().kind === "operator" && (this.peek().value === "+" || this.peek().value === "-")) {
      left = { kind: "binary", operator: this.take().value, left, right: this.multiplication() };
    }
    return left;
  }
  multiplication() {
    let left = this.power();
    while (this.peek().kind === "operator" && (this.peek().value === "*" || this.peek().value === "/")) {
      left = { kind: "binary", operator: this.take().value, left, right: this.power() };
    }
    return left;
  }
  power() {
    const left = this.unary();
    return this.accept("operator", "^") ? { kind: "binary", operator: "^", left, right: this.power() } : left;
  }
  unary() {
    const operator = this.peek().kind === "operator" && (this.peek().value === "+" || this.peek().value === "-") ? this.take().value : null;
    return operator ? { kind: "unary", operator, value: this.unary() } : this.primary();
  }
  reference(token, sheet) {
    const match = CELL_REFERENCE.exec(token.value);
    if (!match) throw new Error("reference");
    return { kind: "reference", sheet, column: columnNumber(match[1]), row: Number(match[2]) };
  }
  primary() {
    if (this.accept("left")) {
      const value = this.comparison();
      this.require("right");
      return value;
    }
    const number3 = this.accept("number");
    if (number3) return { kind: "literal", value: Number(number3.value) };
    const string = this.accept("string");
    if (string) return { kind: "literal", value: string.value };
    const token = this.peek();
    if (token.kind !== "word" && token.kind !== "sheet") throw new Error("primary");
    this.take();
    if (this.accept("bang")) {
      const start = this.reference(this.require("word"), token.value);
      return this.rangeAfter(start);
    }
    if (token.kind === "sheet") throw new Error("sheet-reference");
    if (this.accept("left")) {
      const arguments_ = [];
      if (!this.accept("right")) {
        do {
          arguments_.push(this.comparison());
        } while (this.accept("separator"));
        this.require("right");
      }
      return { kind: "call", name: token.value, arguments: arguments_ };
    }
    const normalized = normalizeName(token.value);
    if (normalized === "TRUE" || normalized === "VERDADEIRO") return { kind: "literal", value: true };
    if (normalized === "FALSE" || normalized === "FALSO") return { kind: "literal", value: false };
    return this.rangeAfter(this.reference(token, null));
  }
  rangeAfter(start) {
    if (!this.accept("colon")) return start;
    const token = this.require("word");
    const end = this.reference(token, start.sheet);
    return { kind: "range", start, end };
  }
};
function normalizeName(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").replace(/[._\s]/gu, "").toLocaleUpperCase("en-US");
}
function scalar(value) {
  return Array.isArray(value) ? value[0] ?? null : value;
}
function number(value) {
  const item = scalar(value);
  if (item === null || item === "") return 0;
  if (typeof item === "boolean") return item ? 1 : 0;
  const result = typeof item === "number" ? item : Number(item);
  if (!Number.isFinite(result)) throw new Error("number");
  return result;
}
function truthy(value) {
  const item = scalar(value);
  if (typeof item === "string") return item.length > 0 && item.toLocaleUpperCase("pt-BR") !== "FALSO";
  return Boolean(item);
}
function text(value) {
  const item = scalar(value);
  if (item === null) return "";
  if (typeof item === "boolean") return item ? "VERDADEIRO" : "FALSO";
  return String(item);
}
function flattened(values) {
  return values.flatMap((value) => Array.isArray(value) ? value : [value]);
}
function numeric(values) {
  return flattened(values).flatMap((value) => {
    if (typeof value === "number" && Number.isFinite(value)) return [value];
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(",", "."));
      if (Number.isFinite(parsed)) return [parsed];
    }
    return [];
  });
}
function compare(left, right, operator) {
  const a = scalar(left);
  const b = scalar(right);
  const comparable = typeof a === "number" && typeof b === "number" ? [a, b] : [text(a).toLocaleLowerCase("pt-BR"), text(b).toLocaleLowerCase("pt-BR")];
  if (operator === "=") return comparable[0] === comparable[1];
  if (operator === "<>") return comparable[0] !== comparable[1];
  if (operator === "<") return comparable[0] < comparable[1];
  if (operator === "<=") return comparable[0] <= comparable[1];
  if (operator === ">") return comparable[0] > comparable[1];
  return comparable[0] >= comparable[1];
}
function recalculateWorkbook(workbook) {
  const sheets = new Map(workbook.sheets.map((sheet, index) => [sheet.name.toLocaleLowerCase("pt-BR"), { sheet, index }]));
  const cellMaps = workbook.sheets.map((sheet) => new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])));
  const memo = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  const evaluateCell = (sheetIndex, row, column) => {
    const key = `${sheetIndex}:${row}:${column}`;
    const remembered = memo.get(key);
    if (remembered) return remembered;
    const cell = cellMaps[sheetIndex]?.get(`${row}:${column}`);
    if (!cell?.formula) return { ok: true, value: cell?.value ?? null };
    if (visiting.has(key)) return { ok: false };
    visiting.add(key);
    try {
      const tree = new FormulaParser(tokenize(cell.formula.replace(/^=/u, ""))).parse();
      const value = evaluate(tree, sheetIndex);
      const result = Array.isArray(value) ? { ok: false } : { ok: true, value };
      memo.set(key, result);
      return result;
    } catch {
      const result = { ok: false };
      memo.set(key, result);
      return result;
    } finally {
      visiting.delete(key);
    }
  };
  const resolveReference = (reference, currentSheet) => {
    const target = reference.sheet === null ? currentSheet : sheets.get(reference.sheet.toLocaleLowerCase("pt-BR"))?.index;
    return target === void 0 ? { ok: false } : evaluateCell(target, reference.row, reference.column);
  };
  const evaluate = (expression, currentSheet) => {
    if (expression.kind === "literal") return expression.value;
    if (expression.kind === "reference") {
      const result = resolveReference(expression, currentSheet);
      if (!result.ok) throw new Error("reference");
      return result.value;
    }
    if (expression.kind === "range") {
      const targetSheet = expression.start.sheet === null ? currentSheet : sheets.get(expression.start.sheet.toLocaleLowerCase("pt-BR"))?.index;
      if (targetSheet === void 0) throw new Error("range-sheet");
      const values = [];
      for (let row = Math.min(expression.start.row, expression.end.row); row <= Math.max(expression.start.row, expression.end.row); row += 1) {
        for (let column = Math.min(expression.start.column, expression.end.column); column <= Math.max(expression.start.column, expression.end.column); column += 1) {
          const result = evaluateCell(targetSheet, row, column);
          if (!result.ok) throw new Error("range");
          values.push(result.value);
        }
      }
      return values;
    }
    if (expression.kind === "unary") {
      const value = number(evaluate(expression.value, currentSheet));
      return expression.operator === "-" ? -value : value;
    }
    if (expression.kind === "binary") {
      const left = evaluate(expression.left, currentSheet);
      const right = evaluate(expression.right, currentSheet);
      if (COMPARISON.has(expression.operator)) return compare(left, right, expression.operator);
      if (expression.operator === "&") return `${text(left)}${text(right)}`;
      const a = number(left);
      const b = number(right);
      const result = expression.operator === "+" ? a + b : expression.operator === "-" ? a - b : expression.operator === "*" ? a * b : expression.operator === "/" ? b === 0 ? Number.NaN : a / b : a ** b;
      if (!Number.isFinite(result)) throw new Error("arithmetic");
      return result;
    }
    const name = normalizeName(expression.name);
    if (name === "IF" || name === "SE") {
      if (expression.arguments.length < 2 || expression.arguments.length > 3) throw new Error("if");
      const condition = truthy(evaluate(expression.arguments[0], currentSheet));
      const chosen = condition ? expression.arguments[1] : expression.arguments[2];
      return chosen ? scalar(evaluate(chosen, currentSheet)) : false;
    }
    if (name === "AND" || name === "E") return expression.arguments.every((item) => truthy(evaluate(item, currentSheet)));
    if (name === "OR" || name === "OU") return expression.arguments.some((item) => truthy(evaluate(item, currentSheet)));
    if (name === "NOT" || name === "NAO") return !truthy(evaluate(expression.arguments[0], currentSheet));
    const args = expression.arguments.map((item) => evaluate(item, currentSheet));
    const numbers = numeric(args);
    if (name === "SUM" || name === "SOMA") return numbers.reduce((sum, item) => sum + item, 0);
    if (name === "AVERAGE" || name === "MEDIA") {
      if (numbers.length === 0) throw new Error("average");
      return numbers.reduce((sum, item) => sum + item, 0) / numbers.length;
    }
    if (name === "MIN" || name === "MINIMO") return numbers.length ? Math.min(...numbers) : 0;
    if (name === "MAX" || name === "MAXIMO") return numbers.length ? Math.max(...numbers) : 0;
    if (name === "COUNT" || name === "CONTNUM" || name === "CONTAGEM") return numbers.length;
    if (name === "COUNTA" || name === "CONTVALORES") return flattened(args).filter((item) => item !== null && item !== "").length;
    if (name === "ABS") return Math.abs(number(args[0]));
    if (name === "SQRT" || name === "RAIZ") return Math.sqrt(number(args[0]));
    if (name === "POWER" || name === "POTENCIA") return number(args[0]) ** number(args[1]);
    if (name === "MOD") return number(args[0]) % number(args[1]);
    if (name === "ROUND" || name === "ARRED") {
      const digits = Math.trunc(number(args[1] ?? 0));
      const factor = 10 ** digits;
      return Math.round((number(args[0]) + Number.EPSILON) * factor) / factor;
    }
    if (name === "ROUNDUP" || name === "ARREDONDARPARACIMA") {
      const digits = Math.trunc(number(args[1] ?? 0));
      const factor = 10 ** digits;
      const value = number(args[0]) * factor;
      return (value < 0 ? Math.floor(value) : Math.ceil(value)) / factor;
    }
    if (name === "ROUNDDOWN" || name === "ARREDONDARPARABAIXO") {
      const digits = Math.trunc(number(args[1] ?? 0));
      const factor = 10 ** digits;
      const value = number(args[0]) * factor;
      return (value < 0 ? Math.ceil(value) : Math.floor(value)) / factor;
    }
    if (name === "LEN" || name === "NUMCARACT") return text(args[0]).length;
    if (name === "CONCAT" || name === "CONCATENAR") return flattened(args).map((item) => text(item)).join("");
    throw new Error("function");
  };
  workbook.sheets.forEach((sheet, sheetIndex) => {
    for (const cell of sheet.cells) {
      if (!cell.formula) continue;
      const result = evaluateCell(sheetIndex, cell.row, cell.column);
      if (result.ok) cell.value = result.value;
    }
  });
  return workbook;
}

// src/server/artifacts/patch.ts
function applyEdits(source, edits) {
  let content = source;
  for (const edit of edits) {
    const first = content.indexOf(edit.find);
    if (first < 0) return { ok: false, reason: "not_found", find: edit.find };
    if (content.indexOf(edit.find, first + edit.find.length) >= 0) {
      return { ok: false, reason: "ambiguous", find: edit.find };
    }
    content = `${content.slice(0, first)}${edit.replace}${content.slice(first + edit.find.length)}`;
  }
  return { ok: true, content };
}

// src/server/context.ts
function estimateTokens(text3) {
  if (!text3) return 0;
  return Math.max(1, Math.ceil(text3.length / 4));
}
var IMAGE_TOKEN_ESTIMATE = 1200;
function estimateMessageTokens(message2) {
  const imagens = (message2.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
  return estimateTokens(message2.content) + 4 + imagens;
}
function estimateContextTokens(messages) {
  return messages.reduce((total, message2) => total + estimateMessageTokens(message2), 0);
}
function trimContext(messages, contextWindow, ratio = 0.7) {
  const budgetTokens = Math.max(1, Math.floor(contextWindow * ratio));
  const system = messages.filter((message2) => message2.role === "system").slice(0, 1);
  const conversation = messages.filter((message2) => message2.role !== "system");
  const kept = conversation.map((message2) => ({ ...message2 }));
  let combined = [...system, ...kept];
  let estimatedTokens = estimateContextTokens(combined);
  let truncated = false;
  while (estimatedTokens > budgetTokens && kept.length > 1) {
    kept.shift();
    combined = [...system, ...kept];
    estimatedTokens = estimateContextTokens(combined);
    truncated = true;
  }
  return { messages: combined, truncated, estimatedTokens, budgetTokens };
}

// src/server/artifacts/context.ts
function currentVersion(artifact) {
  return artifact.versions.find((version2) => version2.version === artifact.currentVersion) ?? artifact.versions.at(-1);
}
function lines(content) {
  return content ? content.split("\n").length : 0;
}
function artifactBlock(artifact, version2, omitted = false) {
  const language = artifact.kind === "code" && artifact.language ? ` language="${artifact.language}"` : "";
  if (omitted) {
    return `<artifact id="${artifact.slug}" title="${artifact.title}" version="${version2.version}" omitted="true" lines="${lines(version2.content)}"/>`;
  }
  return `<artifact id="${artifact.slug}" type="${artifact.kind}"${language} title="${artifact.title}" version="${version2.version}">
${version2.content}
</artifact>`;
}
function buildArtifactContext(artifacts, contextWindow) {
  const budgetTokens = Math.max(1, Math.floor(contextWindow * 0.25));
  const ordered = [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
  if (ordered.length === 0) return { message: null, estimatedTokens: 0, includedSlugs: [], omittedSlugs: [] };
  const selected = [];
  const omitted = [];
  let body = "Estado atual dos artefatos desta conversa:\n\n";
  for (const artifact of ordered) {
    const version2 = currentVersion(artifact);
    if (!version2) continue;
    const candidate = `${body}${artifactBlock(artifact, version2)}

`;
    if (estimateMessageTokens({ role: "user", content: candidate }) <= budgetTokens) {
      body = candidate;
      selected.push(artifact.slug);
    } else {
      const omittedBlock = `${body}${artifactBlock(artifact, version2, true)}

`;
      if (estimateMessageTokens({ role: "user", content: omittedBlock }) <= budgetTokens) {
        body = omittedBlock;
      }
      omitted.push(artifact.slug);
    }
  }
  if (selected.length === 0 && omitted.length === 0) return { message: null, estimatedTokens: 0, includedSlugs: [], omittedSlugs: [] };
  const content = body.trimEnd();
  return {
    message: { role: "user", content },
    estimatedTokens: estimateTokens(content) + 4,
    includedSlugs: selected,
    omittedSlugs: omitted
  };
}

// src/server/artifacts/marker.ts
function artifactMarker(slug, version2) {
  return `[[artefato:${slug}@${version2}]]`;
}

// src/server/artifacts/parser.ts
var ARTIFACT_OPEN_PREFIX = "<artifact";
var UPDATE_OPEN_PREFIX = "<artifact-update";
var ARTIFACT_CLOSE = "</artifact>";
var ESCAPED_ARTIFACT_CLOSE = "<\\/artifact>";
var UPDATE_CLOSE = "</artifact-update>";
var SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
var KINDS = /* @__PURE__ */ new Set(["markdown", "code", "svg", "mermaid", "mindmap", "chart", "spreadsheet"]);
function suffixThatCanStart(value, delimiters) {
  const max = Math.min(value.length, Math.max(...delimiters.map((delimiter) => delimiter.length)));
  for (let length = max; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (delimiters.some((delimiter) => delimiter.startsWith(suffix))) return length;
  }
  return 0;
}
function parseAttributes(tag, expectedName) {
  if (!tag.startsWith(`<${expectedName}`) || !tag.endsWith(">")) return null;
  const body = tag.slice(expectedName.length + 1, -1);
  const attributes = {};
  let cursor = 0;
  const attributePattern = /\s+([a-z]+)="([^"]*)"/gu;
  while (cursor < body.length) {
    attributePattern.lastIndex = cursor;
    const match = attributePattern.exec(body);
    if (!match || match.index !== cursor) return null;
    if (attributes[match[1]]) return null;
    attributes[match[1]] = match[2];
    cursor = attributePattern.lastIndex;
  }
  return attributes;
}
function parseArtifactOpening(tag) {
  const attributes = parseAttributes(tag, "artifact");
  if (!attributes || !SLUG_PATTERN.test(attributes.id ?? "")) return null;
  const type = attributes.type;
  if (!KINDS.has(type)) return null;
  const title = attributes.title ?? "";
  if (title.length < 1 || title.length > 120) return null;
  if (type === "code" && (!attributes.language || attributes.language.length > 32)) return null;
  return {
    slug: attributes.id,
    type,
    language: type === "code" ? attributes.language ?? null : null,
    title
  };
}
function parsePatchOpening(tag) {
  const attributes = parseAttributes(tag, "artifact-update");
  const slug = attributes?.id ?? "";
  return SLUG_PATTERN.test(slug) ? slug : null;
}
function parsePatchBody(body) {
  const edits = [];
  let cursor = 0;
  while (cursor < body.length) {
    while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
    if (cursor >= body.length) break;
    if (!body.startsWith("<find>", cursor)) return null;
    const findEnd = body.indexOf("</find>", cursor + 6);
    if (findEnd < 0) return null;
    const find = body.slice(cursor + 6, findEnd);
    cursor = findEnd + "</find>".length;
    while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
    if (!body.startsWith("<replace>", cursor)) return null;
    const replaceEnd = body.indexOf("</replace>", cursor + 9);
    if (replaceEnd < 0) return null;
    const replace = body.slice(cursor + 9, replaceEnd);
    cursor = replaceEnd + "</replace>".length;
    edits.push({ find, replace });
  }
  return edits.length > 0 ? edits : null;
}
function unescapeArtifactClose(text3) {
  return text3.replaceAll("<\\/artifact>", "</artifact>");
}
function createArtifactParser() {
  let state = "prose";
  let buffer = "";
  let metadata = null;
  let patchSlug = null;
  let patchSource = "";
  const emitText = (events, text3) => {
    if (text3) events.push({ kind: "text", text: text3 });
  };
  const processProse = (events) => {
    const artifactIndex = buffer.indexOf(ARTIFACT_OPEN_PREFIX);
    const updateIndex = buffer.indexOf(UPDATE_OPEN_PREFIX);
    const candidates = [artifactIndex, updateIndex].filter((index2) => index2 >= 0);
    if (candidates.length === 0) {
      const keep = suffixThatCanStart(buffer, [ARTIFACT_OPEN_PREFIX, UPDATE_OPEN_PREFIX]);
      emitText(events, buffer.slice(0, buffer.length - keep));
      buffer = buffer.slice(buffer.length - keep);
      return false;
    }
    const index = Math.min(...candidates);
    emitText(events, buffer.slice(0, index));
    buffer = buffer.slice(index);
    if (buffer.startsWith(UPDATE_OPEN_PREFIX) && UPDATE_OPEN_PREFIX.startsWith(buffer) && !buffer.includes(">")) return false;
    if (buffer.startsWith(ARTIFACT_OPEN_PREFIX) && ARTIFACT_OPEN_PREFIX.startsWith(buffer) && !buffer.includes(">")) return false;
    const close = buffer.indexOf(">");
    if (close < 0) return false;
    const tag = buffer.slice(0, close + 1);
    if (tag.startsWith(UPDATE_OPEN_PREFIX)) {
      const slug = parsePatchOpening(tag);
      if (!slug) {
        emitText(events, buffer.slice(0, 1));
        buffer = buffer.slice(1);
        return true;
      }
      patchSlug = slug;
      patchSource = tag;
      buffer = buffer.slice(close + 1);
      state = "patch";
      return true;
    }
    const nextMetadata = parseArtifactOpening(tag);
    if (!nextMetadata) {
      emitText(events, buffer.slice(0, 1));
      buffer = buffer.slice(1);
      return true;
    }
    metadata = nextMetadata;
    buffer = buffer.slice(close + 1);
    state = "artifact";
    events.push({ kind: "artifact_open", ...nextMetadata });
    return true;
  };
  const processArtifact = (events) => {
    if (!metadata) {
      state = "prose";
      return true;
    }
    const close = buffer.indexOf(ARTIFACT_CLOSE);
    if (close < 0) {
      const keep = suffixThatCanStart(buffer, [ARTIFACT_CLOSE, ESCAPED_ARTIFACT_CLOSE]);
      const body2 = buffer.slice(0, buffer.length - keep);
      if (body2) events.push({ kind: "artifact_body", slug: metadata.slug, text: unescapeArtifactClose(body2) });
      buffer = buffer.slice(buffer.length - keep);
      return false;
    }
    const body = buffer.slice(0, close);
    if (body) events.push({ kind: "artifact_body", slug: metadata.slug, text: unescapeArtifactClose(body) });
    buffer = buffer.slice(close + ARTIFACT_CLOSE.length);
    events.push({ kind: "artifact_close", slug: metadata.slug, truncated: false });
    metadata = null;
    state = "prose";
    return true;
  };
  const processPatch = (events) => {
    if (!patchSlug) {
      state = "prose";
      return true;
    }
    const close = buffer.indexOf(UPDATE_CLOSE);
    if (close < 0) {
      const keep = suffixThatCanStart(buffer, [UPDATE_CLOSE]);
      patchSource += buffer.slice(0, buffer.length - keep);
      buffer = buffer.slice(buffer.length - keep);
      return false;
    }
    patchSource += buffer.slice(0, close);
    buffer = buffer.slice(close + UPDATE_CLOSE.length);
    const edits = parsePatchBody(patchSource.slice(patchSource.indexOf(">") + 1));
    if (edits) events.push({ kind: "artifact_patch", slug: patchSlug, edits });
    else emitText(events, `${patchSource}${UPDATE_CLOSE}`);
    patchSlug = null;
    patchSource = "";
    state = "prose";
    return true;
  };
  return {
    push(chunk) {
      if (!chunk) return [];
      buffer += chunk;
      const events = [];
      let progressed = true;
      while (progressed) {
        progressed = state === "prose" ? processProse(events) : state === "artifact" ? processArtifact(events) : processPatch(events);
      }
      return events;
    },
    end() {
      const events = [];
      if (state === "artifact" && metadata) {
        const body = `${buffer}`;
        if (body) events.push({ kind: "artifact_body", slug: metadata.slug, text: unescapeArtifactClose(body) });
        events.push({ kind: "artifact_close", slug: metadata.slug, truncated: true });
      } else if (state === "patch") {
        emitText(events, `${patchSource}${buffer}`);
      } else {
        emitText(events, buffer);
      }
      state = "prose";
      buffer = "";
      metadata = null;
      patchSlug = null;
      patchSource = "";
      return events;
    }
  };
}

// src/server/artifacts/system-prompt.ts
var ARTIFACT_SYSTEM_PROMPT = `
Voc\xEA pode produzir artefatos de conte\xFAdo n\xEDvel 1 usando tags XML delimitadas. Use os tipos markdown, code, svg, mermaid, mindmap, chart e spreadsheet; nunca produza html ou react como artefato.

Quando abrir um artefato: reserve a tag para conte\xFAdo substancial que o usu\xE1rio vai querer reaproveitar inteiro \u2014 um script completo, um arquivo, um componente, um documento longo. Para um comando isolado de terminal, uma linha de configura\xE7\xE3o, um trecho curto que ilustra algo dentro da explica\xE7\xE3o, ou qualquer c\xF3digo que sirva s\xF3 de exemplo pontual, escreva um bloco de c\xF3digo markdown comum no meio da resposta \u2014 n\xE3o abra artefato para isso. Na d\xFAvida entre os dois, pergunte-se se faz sentido o usu\xE1rio copiar aquele bloco inteiro para um arquivo pr\xF3prio; se sim, \xE9 artefato, se n\xE3o, \xE9 c\xF3digo in-line.

Para criar ou reescrever um artefato, use exatamente:
<artifact id="slug" type="code" language="typescript" title="T\xEDtulo curto">
conte\xFAdo \xEDntegro
</artifact>

Para um mapa mental, use type="mindmap" e escreva o conte\xFAdo como lista indentada: a PRIMEIRA linha \xE9 o t\xF3pico central, e cada n\xEDvel de recuo \xE9 um n\xEDvel do mapa. Sem sintaxe de diagrama, sem chaves, sem setas \u2014 s\xF3 h\xEDfens e recuo:

<artifact id="slug" type="mindmap" title="T\xEDtulo do mapa">
T\xF3pico central
- Primeiro ramo
  - Subt\xF3pico
  - Outro subt\xF3pico
- Segundo ramo
</artifact>

R\xF3tulo de n\xF3 \xE9 curto: um termo ou uma frase de at\xE9 seis palavras, n\xE3o uma explica\xE7\xE3o. Prefira tr\xEAs a sete ramos no primeiro n\xEDvel e no m\xE1ximo quatro n\xEDveis de profundidade \u2014 mapa que passa disso deixa de ser mapa e vira \xEDndice.

Para um gr\xE1fico, use type="chart" e escreva o conte\xFAdo como JSON:

<artifact id="slug" type="chart" title="T\xEDtulo do gr\xE1fico">
{
  "type": "bar",
  "title": "Receita por trimestre",
  "xLabel": "Trimestre",
  "yLabel": "R$ mil",
  "x": ["T1", "T2", "T3", "T4"],
  "series": [{ "name": "2025", "values": [120, 145, 138, 190] }]
}
</artifact>

O campo "type" aceita bar, line, area e pie. Use line ou area para evolu\xE7\xE3o no tempo, bar para comparar categorias e pie s\xF3 para parte-de-todo com poucas fatias. "stacked": true empilha (s\xF3 em bar e area). No m\xE1ximo 6 s\xE9ries.

**Nunca proponha dois eixos de valor no mesmo gr\xE1fico.** Grandezas de escalas diferentes v\xE3o em gr\xE1ficos separados \u2014 juntas num desenho s\xF3, elas sugerem uma correla\xE7\xE3o que o dado n\xE3o tem.

Um n\xFAmero isolado n\xE3o \xE9 gr\xE1fico: escreva o n\xFAmero na resposta. Gr\xE1fico de uma barra s\xF3, ou pizza de duas fatias, tamb\xE9m n\xE3o \u2014 diga o valor em texto.

Para criar uma planilha, use type="spreadsheet" e escreva JSON compacto com nome de arquivo, abas e linhas. O aplicativo converte esse conte\xFAdo em um arquivo XLSX real, baix\xE1vel e edit\xE1vel:

<artifact id="progressao-geometrica" type="spreadsheet" title="Progress\xE3o geom\xE9trica">
{
  "filename": "progressao-geometrica.xlsx",
  "sheets": [{
    "name": "Progress\xE3o Geom\xE9trica",
    "rows": [
      ["n", "Termo (a_n)", "Soma parcial (S_n)"],
      [1, 2, 2],
      [2, 6, 8],
      [3, 18, 26]
    ]
  }]
}
</artifact>

Cada c\xE9lula aceita texto, n\xFAmero, booleano ou null. Para uma f\xF3rmula, use um objeto com a express\xE3o e o resultado j\xE1 calculado: {"formula":"=B2*3","value":6}. O campo value \xE9 obrigat\xF3rio porque a grade mostra o resultado enquanto a barra de f\xF3rmulas mostra a express\xE3o. Calcule e preencha esse resultado em todas as f\xF3rmulas; n\xE3o envie somente uma string iniciada por "=". N\xE3o envolva o JSON em cerca de markdown. Quando o usu\xE1rio pedir para criar, gerar ou montar uma planilha, CSV ou XLSX, use este artefato nativo. N\xE3o entregue Python, openpyxl ou apenas texto CSV para substituir o arquivo, a menos que o usu\xE1rio pe\xE7a explicitamente o c\xF3digo.

A bancada recalcula refer\xEAncias A1, refer\xEAncias entre abas, intervalos, +, -, *, /, ^, &, compara\xE7\xF5es e estas fun\xE7\xF5es em portugu\xEAs ou ingl\xEAs: SOMA/SUM, M\xC9DIA/AVERAGE, M\xCDNIMO/MIN, M\xC1XIMO/MAX, CONT.N\xDAM/COUNT, CONT.VALORES/COUNTA, SE/IF, E/AND, OU/OR, N\xC3O/NOT, ARRED/ROUND, ABS, RAIZ/SQRT, POT\xCANCIA/POWER, MOD, N\xDAM.CARACT/LEN e CONCATENAR/CONCAT. Prefira esse conjunto para que altera\xE7\xF5es do usu\xE1rio sejam recalculadas imediatamente dentro do aplicativo.

O id deve ser est\xE1vel, min\xFAsculo e usar apenas letras, n\xFAmeros e h\xEDfens. type="code" exige language. O conte\xFAdo \xE9 opaco: cercas de markdown e qualquer texto interno n\xE3o devem ser interpretados. Para escrever a sequ\xEAncia literal </artifact> dentro do conte\xFAdo, use <\\/artifact>.

Para revisar um artefato existente sem reescrev\xEA-lo, use:
<artifact-update id="slug">
<find>trecho exato e \xFAnico</find>
<replace>novo trecho</replace>
</artifact-update>

Use um par find/replace para cada edi\xE7\xE3o e preserve a ordem. Se o estado recebido trouxer omitted="true", pe\xE7a o conte\xFAdo completo antes de tentar revis\xE1-lo. Tags malformadas devem ser evitadas. Explique brevemente o que foi criado ou alterado fora das tags.
`.trim();
var FORMATTING_SYSTEM_PROMPT = `
## F\xF3rmulas e nota\xE7\xE3o matem\xE1tica

Escreva matem\xE1tica em LaTeX, entre cifr\xF5es: \`$...$\` no meio da frase e \`$$...$$\` em bloco. A interface renderiza com KaTeX.

**Nunca use crase para f\xF3rmula.** Crase \xE9 para c\xF3digo execut\xE1vel, nome de arquivo, comando de terminal e identificador \u2014 n\xE3o para express\xE3o matem\xE1tica.

**Nunca use caractere Unicode para expoente, \xEDndice ou operador.** Nada de \`e\u207B\u02E3\`, \`y\u1D62\`, \`x\xB2\`, \`\u2264\` ou \`\xD7\` soltos no texto: use \`e^{-x}\`, \`y_i\`, \`x^2\`, \`\\leq\`, \`\\times\` dentro dos cifr\xF5es.

Errado:
- \`\u03C3(x) = 1 / (1 + e\u207B\u02E3)\` entre crases
- L = (1/n) \u03A3 (y\u1D62 \u2212 \u0177\u1D62)\xB2 como texto puro

Certo:
- $\\sigma(x) = \\frac{1}{1 + e^{-x}}$
- $$L = \\frac{1}{n} \\sum_{i=1}^{n} (y_i - \\hat{y}_i)^2$$

Letra grega, somat\xF3rio, fra\xE7\xE3o, integral, matriz e vetor sempre em LaTeX. Uma vari\xE1vel isolada no meio da frase tamb\xE9m vale a pena: escreva "o peso $w_i$", n\xE3o "o peso w_i".
`.trim();
function composeSystemPrompt(userPrompt, extras = []) {
  const custom = userPrompt?.trim();
  const partes = [ARTIFACT_SYSTEM_PROMPT, FORMATTING_SYSTEM_PROMPT, ...extras.filter((extra) => extra.trim())];
  if (custom) partes.push(`Instru\xE7\xF5es adicionais da conversa:
${custom}`);
  return partes.join("\n\n");
}

// src/server/cost.ts
function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return void 0;
}
function nestedNumber(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const key of path) {
      if (!value || typeof value !== "object") {
        value = void 0;
        break;
      }
      value = value[key];
    }
    const result = finiteNumber(value);
    if (result !== void 0) return result;
  }
  return void 0;
}
var CAMPOS_SOMAVEIS = [
  "prompt_tokens",
  "completion_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "total_tokens",
  // O custo informado pela OpenRouter entra na soma pela mesma razão dos
  // tokens: cada round é uma cobrança. E pela mesma regra do "tudo ou nada" —
  // um round sem custo informado derruba o campo inteiro para a tabela, que é
  // aproximada mas não omite metade da conta.
  "cost"
];
function sumProviderUsage(rounds) {
  const informados = rounds.filter((round) => Boolean(round));
  if (informados.length === 0) return null;
  if (informados.length !== rounds.length) return null;
  const soma = {};
  for (const campo of CAMPOS_SOMAVEIS) {
    let total = 0;
    let completo = true;
    for (const round of informados) {
      const valor = nestedNumber(round, [[campo]]);
      if (valor === void 0) {
        completo = false;
        break;
      }
      total += valor;
    }
    if (completo) soma[campo] = total;
  }
  return Object.keys(soma).length > 0 ? soma : null;
}
function reportedCostUsd(raw) {
  if (!raw) return void 0;
  return nestedNumber(raw, [["cost"], ["costUsd"]]);
}
function normalizeUsage(input) {
  const raw = input.raw ?? {};
  const rawPrompt = nestedNumber(raw, [["prompt_tokens"], ["input_tokens"], ["promptTokens"]]);
  const rawCached = nestedNumber(raw, [
    ["cached_tokens"],
    ["prompt_cache_hit_tokens"],
    ["prompt_cache_hit_tokens_count"],
    ["prompt_tokens_details", "cached_tokens"],
    ["promptTokensDetails", "cachedTokens"]
  ]);
  const rawCompletion = nestedNumber(raw, [["completion_tokens"], ["output_tokens"], ["completionTokens"]]);
  const rawReasoning = nestedNumber(raw, [
    ["reasoning_tokens"],
    ["completion_tokens_details", "reasoning_tokens"],
    ["completionTokensDetails", "reasoningTokens"]
  ]);
  const rawTotal = nestedNumber(raw, [["total_tokens"], ["totalTokens"]]);
  const promptTokens = rawPrompt ?? estimateTokens(input.promptText);
  const reasoningTokens = rawReasoning ?? 0;
  const completionTokens = rawCompletion ?? Math.max(estimateTokens(input.completionText) + estimateTokens(input.reasoningText ?? ""), reasoningTokens);
  const cachedTokens = Math.min(rawCached ?? 0, promptTokens);
  const totalTokens = rawTotal ?? promptTokens + completionTokens;
  return {
    promptTokens: Math.round(promptTokens),
    cachedTokens: Math.round(cachedTokens),
    completionTokens: Math.round(completionTokens),
    reasoningTokens: Math.min(Math.round(reasoningTokens), Math.round(completionTokens)),
    totalTokens: Math.round(totalTokens),
    estimated: rawPrompt === void 0 || rawCompletion === void 0
  };
}
function calculateCost(model, usage2, reported) {
  if (reported !== void 0) {
    return { usd: Number(reported.toFixed(8)), estimated: false, pricingAvailable: true, reported: true };
  }
  const { pricing } = model;
  const pricingAvailable = pricing.inputPerMillion !== null && pricing.outputPerMillion !== null;
  if (!pricingAvailable) {
    return { usd: null, estimated: true, pricingAvailable: false, reported: false };
  }
  const promptTokens = Math.max(0, usage2.promptTokens);
  const cachedTokens = Math.min(Math.max(0, usage2.cachedTokens), promptTokens);
  const regularInputTokens = promptTokens - cachedTokens;
  const cachedPrice = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const usd = (regularInputTokens * pricing.inputPerMillion + cachedTokens * cachedPrice + Math.max(0, usage2.completionTokens) * pricing.outputPerMillion) / 1e6;
  return {
    usd: Number(usd.toFixed(8)),
    estimated: usage2.estimated,
    pricingAvailable: true,
    reported: false
  };
}
function calculateUsageAndCost(model, input) {
  const usage2 = normalizeUsage(input);
  const informado = input.reportsCostUsd ? reportedCostUsd(input.raw) : void 0;
  return { usage: usage2, cost: calculateCost(model, usage2, informado) };
}

// src/server/openrouter.ts
function isOpenRouterBaseUrl(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}
function webPluginBody(maxResults) {
  return { plugins: [{ id: "web", max_results: Math.max(1, Math.min(10, maxResults)) }] };
}
var MAX_SNIPPET = 400;
function parseCitations(value) {
  if (!Array.isArray(value)) return [];
  const citacoes = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const registro = item;
    if (registro.type !== "url_citation") continue;
    const citacao = registro.url_citation;
    if (!citacao || typeof citacao !== "object") continue;
    const dados = citacao;
    const url = typeof dados.url === "string" ? dados.url : "";
    if (!url) continue;
    const title = typeof dados.title === "string" && dados.title.trim() ? dados.title.trim() : url;
    const content = typeof dados.content === "string" ? dados.content : "";
    citacoes.push({
      title: title.slice(0, 300),
      url: url.slice(0, 2048),
      snippet: content.replace(/\s+/gu, " ").trim().slice(0, MAX_SNIPPET)
    });
  }
  return citacoes;
}

// src/server/errors.ts
var ACTIONABLE_MESSAGES = {
  RATE_LIMIT: "O provedor limitou esta requisi\xE7\xE3o. Aguarde alguns segundos e tente novamente.",
  INSUFFICIENT_BALANCE: "O saldo ou limite da chave do provedor \xE9 insuficiente. Verifique a cobran\xE7a e os limites da conta.",
  CONTEXT_LENGTH_EXCEEDED: "O hist\xF3rico excede a janela de contexto deste modelo. Inicie uma nova conversa ou reduza o contexto.",
  INVALID_API_KEY: "A chave de API n\xE3o foi aceita. Configure a chave correta no servidor e tente novamente.",
  MODEL_NOT_FOUND: "O modelo selecionado n\xE3o foi encontrado pelo provedor. Atualize o modelo configurado e tente novamente.",
  UPSTREAM_TIMEOUT: "O provedor demorou demais para responder. Tente novamente ou escolha outro provedor.",
  UNAUTHORIZED: "Sua sess\xE3o expirou ou o token \xE9 inv\xE1lido. Fa\xE7a login novamente.",
  UNKNOWN: "O provedor retornou um erro inesperado. Confira a configura\xE7\xE3o e tente novamente."
};
var AppError = class extends Error {
  code;
  status;
  retryable;
  providerStatus;
  constructor(code, options = {}) {
    super(options.message ?? ACTIONABLE_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.retryable = options.retryable ?? (code === "RATE_LIMIT" || code === "UPSTREAM_TIMEOUT");
    this.providerStatus = options.providerStatus;
  }
};
var UpstreamHttpError = class extends Error {
  status;
  body;
  constructor(status, body) {
    super(`Upstream HTTP ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.body = body;
  }
};
function statusForCode(code) {
  switch (code) {
    case "RATE_LIMIT":
      return 429;
    case "INVALID_API_KEY":
      return 401;
    case "UNAUTHORIZED":
      return 401;
    case "MODEL_NOT_FOUND":
      return 404;
    case "CONTEXT_LENGTH_EXCEEDED":
      return 400;
    case "UPSTREAM_TIMEOUT":
      return 504;
    case "INSUFFICIENT_BALANCE":
      return 402;
    default:
      return 502;
  }
}
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}
function bodyText(body) {
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed).toLowerCase();
  } catch {
    return body.toLowerCase();
  }
}
function codeForUpstreamStatus(status, body = "") {
  const text3 = bodyText(body);
  if (status === 402 || /insufficient|balance|credit|quota|billing|saldo|cr[eé]dito/.test(text3)) {
    return "INSUFFICIENT_BALANCE";
  }
  if (status === 401 || status === 403 || /invalid.*(api)?[_ -]?key|unauthorized|authentication/.test(text3)) {
    return "INVALID_API_KEY";
  }
  if (status === 404 || /model.*(not found|不存在|unknown)|model_not_found/.test(text3)) {
    return "MODEL_NOT_FOUND";
  }
  if (status === 400 || status === 422 || /context.{0,20}(length|window)|too many tokens|maximum context/.test(text3)) {
    return "CONTEXT_LENGTH_EXCEEDED";
  }
  if (status === 429) return "RATE_LIMIT";
  return "UNKNOWN";
}
function normalizeError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof UpstreamHttpError) {
    const code = codeForUpstreamStatus(error.status, error.body);
    return new AppError(code, {
      providerStatus: error.status,
      retryable: error.status === 429 || error.status >= 500
    });
  }
  if (isAbortError(error)) {
    return new AppError("UPSTREAM_TIMEOUT");
  }
  return new AppError("UNKNOWN");
}
function errorPayload(error) {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable
  };
}

// src/server/ssrf.ts
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var DEFAULT_MAX_REDIRECTS = 5;
function ssrfError(message2) {
  return new AppError("UNKNOWN", { status: 400, message: message2 });
}
function stripIpv6Brackets(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}
function normalizeHostname(hostname) {
  let name = stripIpv6Brackets(hostname.trim()).toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  return name;
}
function parseIpv4(addr) {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}
function parseIpv6(addr) {
  let rest = addr.toLowerCase();
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1 && rest.slice(lastColon + 1).includes(".")) {
    const octets = rest.slice(lastColon + 1).split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const head = rest.slice(0, lastColon);
    const a = (octets[0] << 8 | octets[1]).toString(16);
    const b = (octets[2] << 8 | octets[3]).toString(16);
    rest = `${head}:${a}:${b}`;
  }
  const doubleColon = rest.indexOf("::");
  if (doubleColon === -1) {
    const parts = rest.split(":");
    if (parts.length !== 8) return null;
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    }
    return ipv6Bytes(parts.map((part) => parseInt(part, 16)));
  }
  const left = rest.slice(0, doubleColon).split(":").filter((part) => part !== "");
  const right = rest.slice(doubleColon + 2).split(":").filter((part) => part !== "");
  for (const part of [...left, ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  const expanded = [
    ...left.map((part) => parseInt(part, 16)),
    ...new Array(missing).fill(0),
    ...right.map((part) => parseInt(part, 16))
  ];
  return ipv6Bytes(expanded);
}
function ipv6Bytes(groups) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = groups[i] >> 8 & 255;
    bytes[i * 2 + 1] = groups[i] & 255;
  }
  return bytes;
}
function isIpv4Mapped(bytes) {
  return bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 && bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 255 && bytes[11] === 255;
}
function isBlockedIpv4(octets) {
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && (b & 240) === 16) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224 && a <= 239) return true;
  return false;
}
function isBlockedIpv6(bytes) {
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.every((byte, i) => i === 15 ? byte === 1 : byte === 0)) return true;
  if (bytes[0] === 254 && (bytes[1] & 192) === 128) return true;
  if ((bytes[0] & 254) === 252) return true;
  if (bytes[0] === 255) return true;
  return false;
}
function isBlockedIp(ip) {
  const normalized = stripIpv6Brackets(ip.trim().toLowerCase());
  if (isIP(normalized) === 4) {
    const octets = parseIpv4(normalized);
    return octets !== null && isBlockedIpv4(octets);
  }
  if (isIP(normalized) === 6) {
    const bytes = parseIpv6(normalized);
    if (bytes === null) return false;
    if (isIpv4Mapped(bytes)) {
      return isBlockedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
    return isBlockedIpv6(bytes);
  }
  return false;
}
function isLoopbackLiteral(hostname) {
  const normalized = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (isIP(normalized) === 4) {
    const octets = parseIpv4(normalized);
    return octets !== null && octets[0] === 127;
  }
  if (isIP(normalized) === 6) {
    const bytes = parseIpv6(normalized);
    if (bytes === null) return false;
    if (isIpv4Mapped(bytes)) return bytes[12] === 127;
    return bytes.every((byte, i) => i === 15 ? byte === 1 : byte === 0);
  }
  return false;
}
function resolveOptions(options = {}) {
  const production = options.production ?? (process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL));
  const allowLocalhost = options.allowLocalhost ?? !production;
  return { production, allowLocalhost };
}
function assertSafeUrl(rawUrl, options, prefix) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw ssrfError(`${prefix}'${rawUrl}' n\xE3o \xE9 uma URL absoluta v\xE1lida.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw ssrfError(`${prefix}O esquema precisa ser http ou https (recebido '${url.protocol}').`);
  }
  if (url.username || url.password) {
    throw ssrfError(`${prefix}Credenciais (user:password@) n\xE3o s\xE3o permitidas na URL.`);
  }
  const { production, allowLocalhost } = resolveOptions(options);
  if (production && url.protocol !== "https:") {
    throw ssrfError(`${prefix}Em produ\xE7\xE3o, somente HTTPS \xE9 permitido (recebido '${url.protocol}').`);
  }
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      const liberavel = allowLocalhost && isLoopbackLiteral(hostname);
      if (!liberavel) {
        throw ssrfError(
          `${prefix}O endere\xE7o '${hostname}' est\xE1 em faixa bloqueada (privado, loopback, link-local ou metadata).`
        );
      }
    }
    return;
  }
  if (hostname === "localhost" && !allowLocalhost) {
    throw ssrfError(`${prefix}'localhost' n\xE3o \xE9 permitido em produ\xE7\xE3o.`);
  }
}
function assertSafeProviderUrl(baseURL, options = {}) {
  assertSafeUrl(baseURL, options, "URL de provedor: ");
}
function assertSafeRedirect(url, options = {}) {
  assertSafeUrl(url, options, "Redirecionamento bloqueado: ");
}
async function defaultLookup(hostname) {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}
async function resolveSafeHost(hostname, options = {}) {
  const lookup = options.lookup ?? defaultLookup;
  return lookup(hostname);
}
async function assertSafeHostResolved(hostname, options = {}) {
  const { allowLocalhost } = resolveOptions(options);
  const addresses = await resolveSafeHost(hostname, { lookup: options.lookup });
  for (const address of addresses) {
    if (!isBlockedIp(address)) continue;
    if (allowLocalhost && isLoopbackLiteral(address)) continue;
    throw ssrfError(
      `Host '${hostname}' resolveu para '${address}', que est\xE1 em faixa bloqueada (poss\xEDvel SSRF ou DNS rebinding).`
    );
  }
}
function isRedirectStatus(status) {
  return REDIRECT_STATUSES.has(status);
}
async function safeFetchWithRedirects(input, init = {}, options = {}) {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, fetchImpl = fetch } = options;
  let current;
  try {
    current = new URL(String(input));
  } catch {
    throw ssrfError(`URL de provedor: '${String(input)}' n\xE3o \xE9 uma URL absoluta v\xE1lida.`);
  }
  assertSafeProviderUrl(current.toString(), options);
  await assertSafeHostResolved(current.hostname, options);
  let followed = 0;
  for (; ; ) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (!isRedirectStatus(response.status)) return response;
    if (followed >= maxRedirects) {
      throw ssrfError(`Redirecionamento bloqueado: limite de ${maxRedirects} redirecionamentos excedido.`);
    }
    const location = response.headers.get("location");
    if (!location) return response;
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw ssrfError(`Redirecionamento bloqueado: Location '${location}' inv\xE1lida.`);
    }
    assertSafeRedirect(next.toString(), options);
    await assertSafeHostResolved(next.hostname, options);
    current = next;
    followed += 1;
  }
}

// src/server/effort.ts
function parseEffortColumn(value) {
  const parsed = EffortLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : "auto";
}
var DIALECT_BY_PROVIDER = {
  deepseek: "reasoning_effort",
  kimi: "reasoning_effort",
  ollama: "reasoning_effort",
  openrouter: "reasoning",
  glm: "thinking",
  // O gateway do OpenCode expõe `/chat/completions` pelo mesmo adaptador
  // openai-compatible que os demais deste grupo. Explícito, e não deixado no
  // padrão, porque um leitor precisa saber que a escolha foi verificada e não
  // apenas herdada.
  opencode: "reasoning_effort",
  "opencode-go": "reasoning_effort"
};
var DEFAULT_DIALECT = "reasoning_effort";
var MINIMAL_EFFORT = "minimal";
function nivelNaConvencaoOpenAI(level) {
  if (level === "off") return MINIMAL_EFFORT;
  if (level === "xhigh" || level === "max") return "high";
  return level;
}
function effortRequestParams(level, providerId2) {
  if (!level || level === "auto") return null;
  const dialect = DIALECT_BY_PROVIDER[providerId2] ?? DEFAULT_DIALECT;
  if (dialect === "reasoning") {
    const body2 = level === "off" ? { reasoning: { enabled: false } } : { reasoning: { effort: level } };
    return { body: body2, keys: ["reasoning"] };
  }
  if (dialect === "thinking") {
    const body2 = { thinking: { type: level === "off" ? "disabled" : "enabled" } };
    return { body: body2, keys: ["thinking"] };
  }
  const body = { reasoning_effort: nivelNaConvencaoOpenAI(level) };
  return { body, keys: ["reasoning_effort"] };
}
function isEffortRejection(status, body, keys) {
  if (status !== 400 || keys.length === 0) return false;
  const lowered = body.toLowerCase();
  return keys.some((key) => lowered.includes(key.toLowerCase()));
}

// src/server/llm-client.ts
function serializeMessage(message2) {
  if (!message2.images || message2.images.length === 0) {
    return { role: message2.role, content: message2.content };
  }
  return {
    role: message2.role,
    content: [
      ...message2.content ? [{ type: "text", text: message2.content }] : [],
      ...message2.images.map((url) => ({ type: "image_url", image_url: { url } }))
    ]
  };
}
function isVisionRejection(status, body) {
  if (status !== 400) return false;
  const lowered = body.toLowerCase();
  return ["image_url", "image", "vision", "multimodal", "content parts", "invalid content type"].some((termo) => lowered.includes(termo));
}
var VISION_FALLBACK_NOTE = "[As imagens anexadas n\xE3o puderam ser enviadas: este modelo n\xE3o aceita imagens.]";
function withoutImages(messages) {
  return messages.map((message2) => {
    if (!message2.images || message2.images.length === 0) return message2;
    const aviso = `${message2.content}

${VISION_FALLBACK_NOTE}`.trim();
    return { role: message2.role, content: aviso };
  });
}
var DEFAULT_CONNECTION_TIMEOUT_MS = 3e4;
var DEFAULT_INACTIVITY_TIMEOUT_MS = 6e4;
var DEFAULT_MAX_ATTEMPTS = 2;
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function textFromContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (isRecord(part) && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}
function abortError() {
  return new DOMException("A requisi\xE7\xE3o foi cancelada.", "AbortError");
}
function sleepWithAbort(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function combineSignals(parent, attempt) {
  const controller = new AbortController();
  const abortFrom = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason ?? abortError());
  };
  const parentListener = () => abortFrom(parent);
  const attemptListener = () => abortFrom(attempt);
  if (parent.aborted) abortFrom(parent);
  if (attempt.aborted) abortFrom(attempt);
  parent.addEventListener("abort", parentListener, { once: true });
  attempt.addEventListener("abort", attemptListener, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      parent.removeEventListener("abort", parentListener);
      attempt.removeEventListener("abort", attemptListener);
    }
  };
}
function parseRetryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5e3, seconds * 1e3);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(5e3, Math.max(0, date - Date.now()));
  return void 0;
}
async function readLimitedText(response, maxLength = 32e3) {
  try {
    const text3 = await response.text();
    return text3.slice(0, maxLength);
  } catch {
    return "";
  }
}
function extractChunkData(payload) {
  if (!isRecord(payload)) return { events: [], hasToken: false };
  const events = [];
  let hasToken = false;
  const usage2 = isRecord(payload.usage) ? payload.usage : void 0;
  if (usage2) events.push({ kind: "usage", usage: usage2 });
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : void 0;
  if (!firstChoice) return { events, hasToken };
  const delta = isRecord(firstChoice.delta) ? firstChoice.delta : firstChoice;
  const citations = parseCitations(delta.annotations ?? (isRecord(firstChoice.message) ? firstChoice.message.annotations : void 0));
  if (citations.length > 0) events.push({ kind: "citations", citations });
  const content = textFromContent(delta.content);
  const reasoning = textFromContent(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
  if (content) {
    events.push({ kind: "text", text: content });
    hasToken = true;
  }
  if (reasoning) {
    events.push({ kind: "reasoning", reasoning });
    hasToken = true;
  }
  if (typeof firstChoice.finish_reason === "string" || firstChoice.finish_reason === null) {
    events.push({ kind: "finish", finishReason: firstChoice.finish_reason });
  }
  return { events, hasToken };
}
async function* readSseEvents(body, signal, inactivityTimeoutMs, onInactivityTimeout) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  const emitData = function* () {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    try {
      yield JSON.parse(data);
    } catch {
      throw new AppError("UNKNOWN", { message: "O provedor enviou um evento de streaming inv\xE1lido." });
    }
  };
  const readWithTimeout = async () => {
    if (signal.aborted) throw signal.reason ?? abortError();
    let timeout;
    let abortListener;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            onInactivityTimeout();
            reject(new AppError("UPSTREAM_TIMEOUT"));
          }, inactivityTimeoutMs);
        }),
        new Promise((_, reject) => {
          abortListener = () => reject(signal.reason ?? abortError());
          signal.addEventListener("abort", abortListener, { once: true });
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  };
  try {
    while (true) {
      const result = await readWithTimeout();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines2 = buffer.split(/\r?\n/u);
      buffer = lines2.pop() ?? "";
      for (const line of lines2) {
        if (line === "") {
          yield* emitData();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split(/\r?\n/u)) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        if (line === "") yield* emitData();
      }
    }
    yield* emitData();
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
function requestBody(options, effort, messages) {
  const body = {
    model: options.modelId,
    messages: messages.map(serializeMessage),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (options.temperature !== void 0) body.temperature = options.temperature;
  if (effort) Object.assign(body, effort.body);
  if (options.webSearchResults && isOpenRouterBaseUrl(options.baseURL)) {
    Object.assign(body, webPluginBody(options.webSearchResults));
  }
  return JSON.stringify(body);
}
var OpenAICompatibleClient = class {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }
  async *stream(options) {
    if (!options.baseURL) {
      throw new AppError("MODEL_NOT_FOUND", { message: "O provedor ou modelo selecionado n\xE3o est\xE1 configurado." });
    }
    if (options.requiresApiKey && !options.apiKey) {
      throw new AppError("INVALID_API_KEY", {
        message: "Configure a chave deste provedor em Configura\xE7\xF5es \u2192 Provedores."
      });
    }
    const fetchImpl = options.fetchImpl ?? this.fetchImpl;
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    let emittedToken = false;
    let effort = effortRequestParams(options.effort, options.providerId);
    let mensagens = options.messages;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal.aborted) throw options.signal.reason ?? abortError();
      const attemptController = new AbortController();
      const combined = combineSignals(options.signal, attemptController.signal);
      let connectionTimedOut = false;
      const connectionTimer = setTimeout(() => {
        connectionTimedOut = true;
        attemptController.abort(new AppError("UPSTREAM_TIMEOUT"));
      }, connectionTimeoutMs);
      let response;
      try {
        const headers = { "content-type": "application/json", accept: "text/event-stream" };
        if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
        if (options.providerId === "openrouter") {
          if (process.env.OPENROUTER_HTTP_REFERER) headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER;
          if (process.env.OPENROUTER_APP_TITLE) headers["X-Title"] = process.env.OPENROUTER_APP_TITLE;
        }
        response = await safeFetchWithRedirects(
          `${options.baseURL.replace(/\/+$/u, "")}/chat/completions`,
          {
            method: "POST",
            headers,
            body: requestBody(options, effort, mensagens),
            signal: combined.signal
          },
          { fetchImpl }
        );
      } catch (error) {
        if (connectionTimedOut) throw new AppError("UPSTREAM_TIMEOUT");
        if (options.signal.aborted) throw options.signal.reason ?? error;
        if (isAbortError(error) && attemptController.signal.aborted) {
          throw attemptController.signal.reason ?? error;
        }
        throw error;
      } finally {
        clearTimeout(connectionTimer);
        combined.cleanup();
      }
      if (!response.ok) {
        const body = await readLimitedText(response);
        if (effort && isEffortRejection(response.status, body, effort.keys)) {
          options.onTrace?.("esfor\xE7o recusado pelo provedor", `400 \xB7 refazendo sem ${effort.keys.join(", ")}`);
          effort = null;
          attempt -= 1;
          continue;
        }
        if (mensagens.some((message2) => message2.images?.length) && isVisionRejection(response.status, body)) {
          options.onTrace?.("imagens recusadas pelo provedor", "400 \xB7 refazendo sem as imagens");
          mensagens = withoutImages(mensagens);
          attempt -= 1;
          continue;
        }
        const upstreamError = new UpstreamHttpError(response.status, body);
        const retryable = response.status === 429 || response.status >= 500;
        if (!emittedToken && retryable && attempt < maxAttempts) {
          const retryAfter = parseRetryAfter(response);
          const backoff = retryAfter ?? Math.min(2e3, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
          options.onTrace?.("retentativa", `HTTP ${response.status} \xB7 esperando ${backoff}ms \xB7 tentativa ${attempt + 1}/${maxAttempts}`);
          await sleepWithAbort(backoff, options.signal);
          continue;
        }
        options.onTrace?.("provedor recusou", `HTTP ${response.status}`);
        throw upstreamError;
      }
      if (!response.body) throw new AppError("UNKNOWN", { message: "O provedor retornou um stream vazio." });
      const streamController = new AbortController();
      const streamCombined = combineSignals(options.signal, streamController.signal);
      const idleTimeout = () => streamController.abort(new AppError("UPSTREAM_TIMEOUT"));
      try {
        for await (const payload of readSseEvents(response.body, streamCombined.signal, inactivityTimeoutMs, idleTimeout)) {
          const parsed = extractChunkData(payload);
          for (const event of parsed.events) {
            if (event.kind === "text" || event.kind === "reasoning") emittedToken = true;
            yield event;
          }
        }
        return;
      } catch (error) {
        if (options.signal.aborted) throw options.signal.reason ?? error;
        if (streamController.signal.aborted) {
          throw streamController.signal.reason ?? new AppError("UPSTREAM_TIMEOUT");
        }
        throw normalizeError(error);
      } finally {
        streamCombined.cleanup();
        streamController.abort();
      }
    }
  }
};
async function* streamOpenAICompatible(options) {
  yield* new OpenAICompatibleClient(options.fetchImpl).stream(options);
}

// src/server/db/neon.ts
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
var text2 = (value) => typeof value === "string" ? value : String(value ?? "");
var nullableText = (value) => value == null ? null : String(value);
var number2 = (value, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
var nullableNumber = (value) => value == null ? null : number2(value);
var bool = (value) => value === true || value === 1 || value === "1" || value === "true";
function providerId(value) {
  const parsed = ProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function usage(row) {
  if ([row.prompt_tokens, row.cached_tokens, row.completion_tokens, row.reasoning_tokens, row.total_tokens].every((value) => value == null)) return null;
  const promptTokens = number2(row.prompt_tokens);
  const completionTokens = number2(row.completion_tokens);
  return {
    promptTokens,
    cachedTokens: Math.min(number2(row.cached_tokens), promptTokens),
    completionTokens,
    reasoningTokens: Math.min(number2(row.reasoning_tokens), completionTokens || number2(row.reasoning_tokens)),
    totalTokens: number2(row.total_tokens, promptTokens + completionTokens),
    estimated: bool(row.cost_estimated)
  };
}
function cost(row, value) {
  if (row.cost_usd == null && !value) return null;
  return { usd: nullableNumber(row.cost_usd), estimated: bool(row.cost_estimated), pricingAvailable: row.cost_usd != null, reported: false };
}
function message(row) {
  const role = MessageRoleSchema.safeParse(row.role);
  const error = ErrorCodeSchema.safeParse(row.error_code);
  const rowUsage = usage(row);
  return {
    id: text2(row.id),
    conversationId: text2(row.conversation_id),
    role: role.success ? role.data : "assistant",
    content: text2(row.content),
    reasoning: nullableText(row.reasoning),
    providerId: providerId(row.provider_id),
    modelId: nullableText(row.model_id),
    usage: rowUsage,
    cost: cost(row, rowUsage),
    finishReason: nullableText(row.finish_reason),
    errorCode: error.success ? error.data : null,
    createdAt: number2(row.created_at),
    latencyMs: nullableNumber(row.latency_ms)
  };
}
function version(row) {
  return {
    version: Math.max(1, number2(row.version)),
    content: text2(row.content),
    operation: row.operation === "update" || row.operation === "rewrite" ? row.operation : "create",
    messageId: nullableText(row.message_id),
    outputTokens: nullableNumber(row.output_tokens),
    costUsd: nullableNumber(row.cost_usd),
    truncated: bool(row.truncated),
    createdAt: number2(row.created_at)
  };
}
function conversationBase(row) {
  const id = ProviderIdSchema.parse(row.provider_id);
  return {
    id: text2(row.id),
    title: nullableText(row.title),
    providerId: id,
    modelId: text2(row.model_id),
    systemPrompt: nullableText(row.system_prompt),
    effort: parseEffortColumn(row.effort),
    scienceLevel: row.science_level ?? "off",
    scienceFormat: row.science_format ?? void 0,
    createdAt: number2(row.created_at),
    updatedAt: number2(row.updated_at),
    archived: bool(row.archived)
  };
}
function summary(row) {
  return { ...conversationBase(row), messageCount: number2(row.message_count), totalCostUsd: Math.max(0, number2(row.total_cost_usd)) };
}
function attachmentFromRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    kind: String(row.kind) === "image" ? "image" : "document",
    filename: String(row.filename),
    mime: String(row.mime),
    sizeBytes: Number(row.size_bytes),
    dataBase64: row.data_base64 == null ? null : String(row.data_base64),
    extractedText: row.extracted_text == null ? null : String(row.extracted_text),
    truncated: bool(row.truncated),
    createdAt: number2(row.created_at)
  };
}
var NeonChatDatabase = class {
  sql;
  /**
   * Sem criação automática de schema: desde a migração multiusuário, o schema
   * é aplicado manualmente com `pnpm db:migrate` (scripts/db/migrations) — ver
   * PLANO-MULTIUSUARIO.md. Um banco não migrado falha com erro de relação
   * inexistente, de propósito: schema automático em requisições foi removido.
   */
  constructor(connectionString) {
    this.sql = neon(connectionString);
  }
  async rows(query, params = []) {
    return await this.sql.query(query, params);
  }
  async ensureUser(userId) {
    const now = Date.now();
    await this.rows("INSERT INTO users (id,created_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT (id) DO NOTHING", [userId, now]);
    await this.rows("UPDATE users SET updated_at=$2 WHERE id=$1", [userId, now]);
  }
  async createConversation(userId, data) {
    const id = data.id ?? randomUUID();
    const now = data.createdAt ?? Date.now();
    await this.rows(
      `INSERT INTO conversations (id,user_id,title,provider_id,model_id,system_prompt,effort,science_level,science_format,created_at,updated_at,archived)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,false) RETURNING *`,
      [
        id,
        userId,
        data.title ?? "Nova conversa",
        data.providerId,
        data.modelId,
        data.systemPrompt ?? null,
        data.effort ?? "auto",
        data.scienceLevel ?? "off",
        data.scienceFormat ?? null,
        now
      ]
    );
    return await this.getConversation(userId, id);
  }
  async listConversations(userId, options = {}) {
    const rows = await this.rows(
      `SELECT c.*, COUNT(m.id)::int AS message_count, COALESCE(SUM(m.cost_usd),0) AS total_cost_usd
         FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
        WHERE c.user_id=$1 AND ($2::boolean OR NOT c.archived) GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC`,
      [userId, options.includeArchived === true]
    );
    return rows.map(summary);
  }
  async getConversation(userId, id) {
    const [row] = await this.rows(`SELECT c.*,COUNT(m.id)::int AS message_count,COALESCE(SUM(m.cost_usd),0) AS total_cost_usd
      FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.id=$2 AND c.user_id=$1 GROUP BY c.id`, [userId, id]);
    return row ? { ...summary(row), messages: await this.getMessages(userId, id) } : null;
  }
  async updateConversation(userId, id, data) {
    const current = await this.getConversation(userId, id);
    if (!current) return null;
    await this.rows(
      `UPDATE conversations SET title=$3,provider_id=$4,model_id=$5,system_prompt=$6,effort=$7,science_level=$8,science_format=$9,archived=$10,updated_at=$11
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [
        id,
        userId,
        data.title === void 0 ? current.title : data.title,
        data.providerId ?? current.providerId,
        data.modelId ?? current.modelId,
        data.systemPrompt === void 0 ? current.systemPrompt : data.systemPrompt,
        data.effort ?? current.effort,
        data.scienceLevel ?? current.scienceLevel ?? "off",
        data.scienceFormat ?? current.scienceFormat ?? null,
        data.archived ?? current.archived,
        Date.now()
      ]
    );
    return this.getConversation(userId, id);
  }
  async deleteConversation(userId, id) {
    return (await this.rows("DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId])).length > 0;
  }
  async getMessages(userId, conversationId) {
    return (await this.rows(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.user_id=$1
      WHERE m.conversation_id=$2 ORDER BY m.created_at ASC,m.id ASC`, [userId, conversationId])).map(message);
  }
  async insertMessage(userId, data) {
    const id = data.id ?? randomUUID();
    const now = data.createdAt ?? Date.now();
    const [row] = await this.rows(
      `INSERT INTO messages (id,conversation_id,role,content,reasoning,provider_id,model_id,prompt_tokens,cached_tokens,
       completion_tokens,reasoning_tokens,total_tokens,cost_usd,cost_estimated,finish_reason,error_code,created_at,latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        id,
        data.conversationId,
        data.role,
        data.content ?? "",
        data.reasoning ?? null,
        data.providerId ?? null,
        data.modelId ?? null,
        data.usage?.promptTokens ?? null,
        data.usage?.cachedTokens ?? null,
        data.usage?.completionTokens ?? null,
        data.usage?.reasoningTokens ?? null,
        data.usage?.totalTokens ?? null,
        data.cost?.usd ?? null,
        Boolean(data.cost?.estimated || data.usage?.estimated),
        data.finishReason ?? null,
        data.errorCode ?? null,
        now,
        data.latencyMs ?? null
      ]
    );
    await this.rows("UPDATE conversations SET updated_at=$2 WHERE id=$1", [data.conversationId, now]);
    return message(row);
  }
  async updateMessage(userId, id, data) {
    const [currentRow] = await this.rows(`SELECT m.* FROM messages m
      WHERE m.id=$1 AND m.conversation_id IN (SELECT id FROM conversations WHERE user_id=$2)`, [id, userId]);
    if (!currentRow) return null;
    const current = message(currentRow);
    const nextUsage = data.usage === void 0 ? current.usage : data.usage;
    const nextCost = data.cost === void 0 ? current.cost : data.cost;
    const [row] = await this.rows(
      `UPDATE messages SET content=$2,reasoning=$3,prompt_tokens=$4,cached_tokens=$5,completion_tokens=$6,
       reasoning_tokens=$7,total_tokens=$8,cost_usd=$9,cost_estimated=$10,finish_reason=$11,error_code=$12,latency_ms=$13
       WHERE id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE user_id=$14) RETURNING *`,
      [
        id,
        data.content ?? current.content,
        data.reasoning === void 0 ? current.reasoning : data.reasoning,
        nextUsage?.promptTokens ?? null,
        nextUsage?.cachedTokens ?? null,
        nextUsage?.completionTokens ?? null,
        nextUsage?.reasoningTokens ?? null,
        nextUsage?.totalTokens ?? null,
        nextCost?.usd ?? null,
        Boolean(nextCost?.estimated || nextUsage?.estimated),
        data.finishReason === void 0 ? current.finishReason : data.finishReason,
        data.errorCode === void 0 ? current.errorCode : data.errorCode,
        data.latencyMs === void 0 ? current.latencyMs : data.latencyMs,
        userId
      ]
    );
    await this.rows("UPDATE conversations SET updated_at=$2 WHERE id=$1", [current.conversationId, Date.now()]);
    return row ? message(row) : null;
  }
  async upsertArtifact(userId, data) {
    const now = data.createdAt ?? Date.now();
    const [row] = await this.rows(
      `INSERT INTO artifacts (id,conversation_id,slug,kind,language,title,current_version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$7)
       ON CONFLICT (conversation_id,slug) DO UPDATE SET kind=EXCLUDED.kind,language=EXCLUDED.language,title=EXCLUDED.title,updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [randomUUID(), data.conversationId, data.slug, data.kind, data.language ?? null, data.title, now]
    );
    const kind = ArtifactKindSchema.parse(row.kind);
    return {
      id: text2(row.id),
      conversationId: text2(row.conversation_id),
      slug: text2(row.slug),
      kind,
      language: nullableText(row.language),
      title: text2(row.title),
      currentVersion: number2(row.current_version),
      createdAt: number2(row.created_at),
      updatedAt: number2(row.updated_at),
      versions: []
    };
  }
  async insertArtifactVersion(userId, data) {
    const artifact = await this.upsertArtifact(userId, data);
    const nextVersion = data.version ?? artifact.currentVersion + 1;
    const now = data.createdAt ?? Date.now();
    const [row] = await this.rows(
      `INSERT INTO artifact_versions (artifact_id,version,content,operation,message_id,output_tokens,cost_usd,truncated,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        artifact.id,
        nextVersion,
        data.content,
        data.operation,
        data.messageId ?? null,
        data.outputTokens ?? null,
        data.costUsd ?? null,
        data.truncated === true,
        now
      ]
    );
    await this.rows("UPDATE artifacts SET current_version=GREATEST(current_version,$2),updated_at=$3 WHERE id=$1", [artifact.id, nextVersion, now]);
    return version(row);
  }
  async getArtifacts(userId, conversationId) {
    const artifactRows = await this.rows(`SELECT a.* FROM artifacts a JOIN conversations c ON c.id=a.conversation_id AND c.user_id=$1
      WHERE a.conversation_id=$2 AND a.current_version>0 ORDER BY a.updated_at DESC,a.id DESC`, [userId, conversationId]);
    const result = [];
    for (const row of artifactRows) {
      const parsed = ArtifactKindSchema.safeParse(row.kind);
      if (!parsed.success) continue;
      const versions = (await this.rows("SELECT * FROM artifact_versions WHERE artifact_id=$1 ORDER BY version ASC", [row.id])).map(version);
      result.push({
        id: text2(row.id),
        conversationId: text2(row.conversation_id),
        slug: text2(row.slug),
        kind: parsed.data,
        language: nullableText(row.language),
        title: text2(row.title),
        currentVersion: Math.max(1, number2(row.current_version)),
        createdAt: number2(row.created_at),
        updatedAt: number2(row.updated_at),
        versions
      });
    }
    return result;
  }
  async getArtifactVersion(userId, conversationId, slug, versionNumber) {
    const [row] = await this.rows(`SELECT av.* FROM artifact_versions av JOIN artifacts a ON a.id=av.artifact_id
      JOIN conversations c ON c.id=a.conversation_id AND c.user_id=$1
      WHERE a.conversation_id=$2 AND a.slug=$3 AND av.version=$4`, [userId, conversationId, slug, versionNumber]);
    return row ? version(row) : null;
  }
  async updateArtifactVersionCost(userId, conversationId, slug, versionNumber, outputTokens, costUsd) {
    return (await this.rows(
      `UPDATE artifact_versions SET output_tokens=$5,cost_usd=$6 WHERE version=$4 AND artifact_id IN (
      SELECT a.id FROM artifacts a JOIN conversations c ON c.id=a.conversation_id AND c.user_id=$1
      WHERE a.conversation_id=$2 AND a.slug=$3) RETURNING version`,
      [userId, conversationId, slug, versionNumber, outputTokens, costUsd]
    )).length > 0;
  }
  // --- Anexos -------------------------------------------------------------
  async createAttachment(userId, data) {
    const record = {
      id: data.id ?? randomUUID(),
      userId,
      conversationId: null,
      messageId: null,
      kind: data.kind,
      filename: data.filename,
      mime: data.mime,
      sizeBytes: data.sizeBytes,
      dataBase64: data.dataBase64,
      extractedText: data.extractedText,
      truncated: data.truncated,
      createdAt: Date.now()
    };
    await this.rows(
      `INSERT INTO attachments (id, user_id, conversation_id, message_id, kind, filename, mime, size_bytes, data_base64, extracted_text, truncated, created_at)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.id,
        userId,
        record.kind,
        record.filename,
        record.mime,
        record.sizeBytes,
        record.dataBase64,
        record.extractedText,
        record.truncated,
        record.createdAt
      ]
    );
    return record;
  }
  /** Sempre por dono: anexo de outro usuário não existe para quem pergunta. */
  async getAttachment(userId, id) {
    const rows = await this.rows("SELECT * FROM attachments WHERE user_id=$1 AND id=$2", [userId, id]);
    return rows[0] ? attachmentFromRow(rows[0]) : null;
  }
  async getAttachments(userId, ids) {
    if (ids.length === 0) return [];
    const rows = await this.rows(
      "SELECT * FROM attachments WHERE user_id=$1 AND id = ANY($2) ORDER BY created_at ASC",
      [userId, ids]
    );
    return rows.map(attachmentFromRow);
  }
  async attachToMessage(userId, ids, conversationId, messageId) {
    if (ids.length === 0) return;
    await this.rows(
      `UPDATE attachments SET conversation_id=$1, message_id=$2
       WHERE user_id=$3 AND id = ANY($4) AND message_id IS NULL`,
      [conversationId, messageId, userId, ids]
    );
  }
  async listAttachmentsForConversation(userId, conversationId) {
    const rows = await this.rows(
      "SELECT * FROM attachments WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at ASC",
      [userId, conversationId]
    );
    return rows.map(attachmentFromRow);
  }
  async deleteAttachment(userId, id) {
    const rows = await this.rows(
      "DELETE FROM attachments WHERE user_id=$1 AND id=$2 AND message_id IS NULL RETURNING id",
      [userId, id]
    );
    return rows.length > 0;
  }
  async deleteOrphanAttachments(userId, olderThanMs) {
    const rows = await this.rows(
      "DELETE FROM attachments WHERE user_id=$1 AND message_id IS NULL AND created_at < $2 RETURNING id",
      [userId, Date.now() - olderThanMs]
    );
    return rows.length;
  }
  async getSpreadsheetVersion(userId, attachmentId, versionNumber) {
    const params = [userId, attachmentId];
    const versionClause = versionNumber === void 0 ? "" : "AND sv.version=$3";
    if (versionNumber !== void 0) params.push(versionNumber);
    const [row] = await this.rows(
      `SELECT sv.* FROM spreadsheet_versions sv
       JOIN attachments a ON a.id=sv.attachment_id AND a.user_id=$1 AND a.kind='spreadsheet'
       WHERE sv.attachment_id=$2 ${versionClause} ORDER BY sv.version DESC LIMIT 1`,
      params
    );
    return row ? { attachmentId: text2(row.attachment_id), version: number2(row.version), workbookJson: text2(row.workbook_json), createdAt: number2(row.created_at) } : null;
  }
  async insertSpreadsheetVersion(userId, attachmentId, workbookJson, baseVersion) {
    const expected = baseVersion ?? 0;
    const next = expected + 1;
    const createdAt = Date.now();
    const [row] = await this.rows(
      `INSERT INTO spreadsheet_versions (attachment_id,version,workbook_json,created_at)
       SELECT id,$3,$4,$5 FROM attachments
       WHERE id=$2 AND user_id=$1 AND kind='spreadsheet'
         AND COALESCE((SELECT MAX(version) FROM spreadsheet_versions WHERE attachment_id=$2),0)=$6
       ON CONFLICT (attachment_id,version) DO NOTHING
       RETURNING *`,
      [userId, attachmentId, next, workbookJson, createdAt, expected]
    );
    return row ? { attachmentId: text2(row.attachment_id), version: number2(row.version), workbookJson: text2(row.workbook_json), createdAt: number2(row.created_at) } : null;
  }
  async listProviderSettings(userId) {
    return (await this.rows("SELECT * FROM provider_settings WHERE user_id=$1 ORDER BY label ASC,id ASC", [userId])).map((row) => ({
      id: text2(row.id),
      label: text2(row.label),
      baseURL: text2(row.base_url),
      models: Array.isArray(row.models_json) ? row.models_json : [],
      verifiedAt: nullableText(row.verified_at),
      apiKeyCipher: nullableText(row.api_key_cipher),
      createdAt: number2(row.created_at),
      updatedAt: number2(row.updated_at)
    }));
  }
  async upsertProviderSettings(userId, data) {
    const now = Date.now();
    const [row] = await this.rows(
      `INSERT INTO provider_settings (id,user_id,label,base_url,models_json,verified_at,api_key_cipher,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8)
       ON CONFLICT (user_id,id) DO UPDATE SET label=EXCLUDED.label,base_url=EXCLUDED.base_url,models_json=EXCLUDED.models_json,
       verified_at=EXCLUDED.verified_at,api_key_cipher=CASE WHEN $9::boolean THEN EXCLUDED.api_key_cipher ELSE provider_settings.api_key_cipher END,
       updated_at=EXCLUDED.updated_at RETURNING *`,
      [
        data.id,
        userId,
        data.label,
        data.baseURL,
        JSON.stringify(data.models),
        data.verifiedAt ?? null,
        data.apiKeyCipher ?? null,
        now,
        data.apiKeyCipher !== void 0
      ]
    );
    return {
      id: text2(row.id),
      label: text2(row.label),
      baseURL: text2(row.base_url),
      models: Array.isArray(row.models_json) ? row.models_json : [],
      verifiedAt: nullableText(row.verified_at),
      apiKeyCipher: nullableText(row.api_key_cipher),
      createdAt: number2(row.created_at),
      updatedAt: number2(row.updated_at)
    };
  }
  async deleteProviderSettings(userId, id) {
    return (await this.rows("DELETE FROM provider_settings WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId])).length > 0;
  }
  async getSearchSettings(userId) {
    const rows = await this.rows("SELECT * FROM search_settings WHERE user_id=$1", [userId]);
    const row = rows[0];
    if (!row) return null;
    return {
      backend: String(row.backend),
      baseURL: row.base_url === null || row.base_url === void 0 ? null : String(row.base_url),
      apiKeyCipher: row.api_key_cipher === null || row.api_key_cipher === void 0 ? null : String(row.api_key_cipher),
      maxResults: Number(row.max_results),
      enabled: bool(row.enabled),
      createdAt: number2(row.created_at),
      updatedAt: number2(row.updated_at)
    };
  }
  async upsertSearchSettings(userId, data) {
    const existing = await this.getSearchSettings(userId);
    const now = Date.now();
    const cipher = data.apiKeyCipher === void 0 ? existing?.apiKeyCipher ?? null : data.apiKeyCipher;
    const record = {
      backend: data.backend,
      baseURL: data.baseURL === void 0 ? existing?.baseURL ?? null : data.baseURL,
      apiKeyCipher: cipher,
      maxResults: data.maxResults ?? existing?.maxResults ?? 5,
      enabled: data.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.rows(
      `INSERT INTO search_settings (user_id,backend,base_url,api_key_cipher,max_results,enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET
         backend=EXCLUDED.backend, base_url=EXCLUDED.base_url, api_key_cipher=EXCLUDED.api_key_cipher,
         max_results=EXCLUDED.max_results, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at`,
      [userId, record.backend, record.baseURL, record.apiKeyCipher, record.maxResults, record.enabled, record.createdAt, record.updatedAt]
    );
    return record;
  }
  async deleteSearchSettings(userId) {
    return (await this.rows("DELETE FROM search_settings WHERE user_id=$1 RETURNING user_id", [userId])).length > 0;
  }
  async searchConversations(userId, query) {
    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = await this.rows(
      `SELECT c.*,COUNT(m.id)::int AS message_count,COALESCE(SUM(m.cost_usd),0) AS total_cost_usd
       FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
       WHERE c.user_id=$2 AND (
          EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id=c.id AND sm.content ILIKE $1 ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM artifacts a JOIN artifact_versions av ON av.artifact_id=a.id AND av.version=a.current_version
                     WHERE a.conversation_id=c.id AND av.content ILIKE $1 ESCAPE '\\'))
       GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC`,
      [pattern, userId]
    );
    return rows.map(summary);
  }
  async getCostAnalytics(userId, days = 30) {
    const since = Date.now() - Math.min(365, Math.max(1, Math.trunc(days))) * 864e5;
    const [daily, byModel] = await Promise.all([
      this.rows(`SELECT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD') AS day,COALESCE(SUM(cost_usd),0) AS cost_usd,COUNT(*)::int AS message_count
        FROM messages WHERE role='assistant' AND cost_usd IS NOT NULL AND created_at >= $1
        AND conversation_id IN (SELECT id FROM conversations WHERE user_id=$2) GROUP BY day ORDER BY day DESC`, [since, userId]),
      this.rows(`SELECT provider_id,model_id,COALESCE(SUM(cost_usd),0) AS cost_usd,COUNT(*)::int AS message_count
        FROM messages WHERE role='assistant' AND cost_usd IS NOT NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL AND created_at >= $1
        AND conversation_id IN (SELECT id FROM conversations WHERE user_id=$2)
        GROUP BY provider_id,model_id ORDER BY cost_usd DESC`, [since, userId])
    ]);
    return {
      totalCostUsd: daily.reduce((sum, row) => sum + number2(row.cost_usd), 0),
      daily: daily.map((row) => ({ day: text2(row.day), costUsd: number2(row.cost_usd), messageCount: number2(row.message_count) })),
      byModel: byModel.flatMap((row) => {
        const id = providerId(row.provider_id);
        return id ? [{ providerId: id, modelId: text2(row.model_id), costUsd: number2(row.cost_usd), messageCount: number2(row.message_count) }] : [];
      })
    };
  }
};

// src/server/auth.ts
import { verifyToken as verifyClerkToken } from "@clerk/backend";
var BEARER_PATTERN = /^Bearer\s+(.+)$/iu;
function unauthorized(message2) {
  return new AppError("UNAUTHORIZED", { status: 401, message: message2 });
}
function defaultVerifyToken(clockSkewMs) {
  return async (token) => {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new AppError("UNKNOWN", {
        status: 500,
        message: "Configure CLERK_SECRET_KEY no servidor para habilitar a autentica\xE7\xE3o."
      });
    }
    try {
      const payload = await verifyClerkToken(token, { secretKey, clockSkewInMs: clockSkewMs });
      return payload?.sub ?? null;
    } catch {
      return null;
    }
  };
}
function createAuthMiddleware(options = {}) {
  const clockSkewMs = options.clockSkewMs ?? 5e3;
  const verifyToken = options.verifyToken ?? defaultVerifyToken(clockSkewMs);
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header) {
      return c.json(
        { error: errorPayload(unauthorized("Autentica\xE7\xE3o necess\xE1ria: envie o token de sess\xE3o no header Authorization.")) },
        401
      );
    }
    const match = BEARER_PATTERN.exec(header);
    if (!match || !match[1].trim()) {
      return c.json(
        { error: errorPayload(unauthorized('Header Authorization inv\xE1lido: use o formato "Bearer <token>".')) },
        401
      );
    }
    let userId;
    try {
      userId = await verifyToken(match[1].trim());
    } catch (error) {
      if (error instanceof AppError) {
        return c.json({ error: errorPayload(error) }, error.status);
      }
      return c.json(
        { error: errorPayload(unauthorized("N\xE3o foi poss\xEDvel verificar o token de sess\xE3o.")) },
        401
      );
    }
    if (!userId) {
      return c.json({ error: errorPayload(new AppError("UNAUTHORIZED", { status: 401 })) }, 401);
    }
    c.set("userId", userId);
    await next();
  };
}

// src/server/providers.custom.ts
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z as z2 } from "zod";
var ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
var SECRET_FIELDS = /* @__PURE__ */ new Set(["apikey", "api_key", "key", "token", "secret", "authorization", "bearer"]);
var PricingSchema = z2.object({
  inputPerMillion: z2.number().nonnegative().nullable().optional(),
  cachedInputPerMillion: z2.number().nonnegative().nullable().optional(),
  outputPerMillion: z2.number().nonnegative().nullable().optional()
}).optional();
var CustomModelSchema = z2.object({
  id: z2.string().trim().min(1).max(200),
  label: z2.string().trim().min(1).max(160).optional(),
  // Obrigatório de propósito: um ctx errado ou ausente quebra o corte de
  // contexto em silêncio, e o erro só aparece como falha do provedor.
  ctx: z2.number({ error: "ctx \xE9 obrigat\xF3rio: informe a janela de contexto do modelo, em tokens." }).int("ctx precisa ser um n\xFAmero inteiro de tokens.").positive("ctx precisa ser maior que zero."),
  reasoning: z2.boolean().optional(),
  pricing: PricingSchema
});
var CustomProviderSchema = z2.object({
  id: ProviderIdSchema,
  label: z2.string().trim().min(1).max(80),
  baseURL: z2.string().url("baseURL precisa ser uma URL absoluta, incluindo o esquema."),
  baseURLEnv: z2.string().regex(ENV_NAME).optional(),
  apiKeyEnv: z2.string().regex(ENV_NAME, "apiKeyEnv deve ser o NOME de uma vari\xE1vel de ambiente, em MAI\xDASCULAS.").optional(),
  requiresApiKey: z2.boolean().optional(),
  verifiedAt: z2.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "verifiedAt deve estar no formato AAAA-MM-DD.").optional(),
  models: z2.array(CustomModelSchema).min(1, "Declare ao menos um modelo.")
});
function findInlineSecret(raw) {
  if (!raw || typeof raw !== "object") return null;
  for (const key of Object.keys(raw)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) return key;
  }
  return null;
}
function describeIssues(issues) {
  return issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "raiz"}: ${issue.message}`).join("; ");
}
function toModelConfig(model) {
  return {
    id: model.id,
    label: model.label ?? model.id,
    ctx: model.ctx,
    reasoning: model.reasoning ?? false,
    pricing: {
      inputPerMillion: model.pricing?.inputPerMillion ?? null,
      cachedInputPerMillion: model.pricing?.cachedInputPerMillion ?? null,
      outputPerMillion: model.pricing?.outputPerMillion ?? null
    }
  };
}
function parseSource(raw, origin, seen, into, errors) {
  const entries = Array.isArray(raw) ? raw : [raw];
  entries.forEach((entry, index) => {
    const where = `${origin}[${index}]`;
    const secret = findInlineSecret(entry);
    if (secret) {
      errors.push(
        `${where}: remova o campo "${secret}". Use "apiKeyEnv" com o NOME da vari\xE1vel de ambiente \u2014 esta configura\xE7\xE3o n\xE3o \xE9 secreta e pode acabar num commit.`
      );
      return;
    }
    for (const model of Array.isArray(entry?.models) ? entry.models : []) {
      const modelSecret = findInlineSecret(model);
      if (modelSecret) {
        errors.push(`${where}: remova o campo "${modelSecret}" do modelo. Chaves s\xF3 por vari\xE1vel de ambiente.`);
        return;
      }
    }
    const parsed = CustomProviderSchema.safeParse(entry);
    if (!parsed.success) {
      errors.push(`${where}: ${describeIssues(parsed.error.issues)}`);
      return;
    }
    const provider = parsed.data;
    if (BUILTIN_PROVIDER_IDS.includes(provider.id)) {
      errors.push(
        `${where}: o id "${provider.id}" j\xE1 pertence a um provedor embutido. Escolha outro id \u2014 para corrigir pre\xE7os de um provedor embutido, edite src/server/providers.config.ts.`
      );
      return;
    }
    if (seen.has(provider.id)) {
      errors.push(`${where}: o id "${provider.id}" foi declarado mais de uma vez.`);
      return;
    }
    const duplicateModel = provider.models.map((model) => model.id).find((id, position, all) => all.indexOf(id) !== position);
    if (duplicateModel) {
      errors.push(`${where}: o modelo "${duplicateModel}" aparece mais de uma vez em "${provider.id}".`);
      return;
    }
    seen.add(provider.id);
    into.push({
      id: provider.id,
      label: provider.label,
      baseURL: provider.baseURL,
      baseURLEnv: provider.baseURLEnv,
      apiKeyEnv: provider.apiKeyEnv,
      requiresApiKey: provider.requiresApiKey ?? Boolean(provider.apiKeyEnv),
      // Sem data declarada, o provedor entra como não verificado: os preços são
      // do usuário e a interface já avisa quando falta verificação.
      verifiedAt: provider.verifiedAt ?? "",
      models: provider.models.map(toModelConfig)
    });
  });
}
function readFileSource(errors) {
  const configured = process.env.CUSTOM_PROVIDERS_FILE;
  const path = configured ? isAbsolute(configured) ? configured : join(process.cwd(), configured) : join(process.cwd(), "providers.local.json");
  let text3;
  try {
    text3 = readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
  try {
    return JSON.parse(text3);
  } catch (error) {
    errors.push(`${path}: JSON inv\xE1lido (${error instanceof Error ? error.message : "erro de parse"}).`);
    return void 0;
  }
}
function parseAll() {
  const providers = [];
  const errors = [];
  const seen = /* @__PURE__ */ new Set();
  const fileSource = readFileSource(errors);
  if (fileSource !== void 0) parseSource(fileSource, "providers.local.json", seen, providers, errors);
  const envValue = process.env.CUSTOM_PROVIDERS?.trim();
  if (envValue) {
    try {
      parseSource(JSON.parse(envValue), "CUSTOM_PROVIDERS", seen, providers, errors);
    } catch (error) {
      errors.push(`CUSTOM_PROVIDERS: JSON inv\xE1lido (${error instanceof Error ? error.message : "erro de parse"}).`);
    }
  }
  return { providers, errors };
}
var cache = null;
function getCustomProviders() {
  cache ??= parseAll();
  return cache;
}

// src/server/providers.config.ts
var freePricing = {
  inputPerMillion: 0,
  cachedInputPerMillion: 0,
  outputPerMillion: 0
};
var unknownPricing = {
  inputPerMillion: null,
  cachedInputPerMillion: null,
  outputPerMillion: null
};
var PROVIDERS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    requiresApiKey: true,
    verifiedAt: "2026-08-04",
    models: [
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 28e-4,
          outputPerMillion: 0.28
        }
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.435,
          cachedInputPerMillion: null,
          outputPerMillion: 0.87
        }
      }
    ]
  },
  glm: {
    id: "glm",
    label: "GLM (Z.ai)",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    requiresApiKey: true,
    verifiedAt: "2026-08-04",
    models: [
      {
        id: "glm-4.7-flashx",
        label: "GLM 4.7 FlashX",
        ctx: 1048576,
        reasoning: false,
        pricing: { inputPerMillion: 0.07, cachedInputPerMillion: null, outputPerMillion: 0.4 }
      },
      {
        id: "glm-4.5-air",
        label: "GLM 4.5 Air",
        ctx: 131072,
        reasoning: true,
        pricing: { inputPerMillion: 0.2, cachedInputPerMillion: null, outputPerMillion: 1.1 }
      },
      {
        id: "glm-4.7",
        label: "GLM 4.7",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 0.6, cachedInputPerMillion: null, outputPerMillion: 2.2 }
      },
      {
        id: "glm-5",
        label: "GLM 5",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 1, cachedInputPerMillion: null, outputPerMillion: 3.2 }
      },
      {
        id: "glm-5.2",
        label: "GLM 5.2",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 1.4, cachedInputPerMillion: null, outputPerMillion: 4.4 }
      },
      {
        id: "glm-4.7-flash",
        label: "GLM 4.7 Flash",
        ctx: 1048576,
        reasoning: false,
        pricing: freePricing
      }
    ]
  },
  kimi: {
    id: "kimi",
    label: "Kimi (Moonshot)",
    baseURL: "https://api.kimi.ai/v1",
    apiKeyEnv: "KIMI_API_KEY",
    requiresApiKey: true,
    verifiedAt: "2026-08-04",
    models: [
      {
        id: "kimi-k3",
        label: "Kimi K3",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 }
      }
    ]
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    requiresApiKey: true,
    verifiedAt: "2026-08-04",
    models: [
      {
        id: "openrouter/auto",
        label: "Auto Router",
        ctx: 1048576,
        reasoning: true,
        pricing: unknownPricing
      },
      {
        id: "deepseek/deepseek-v4-flash",
        label: "DeepSeek V4 Flash (OpenRouter)",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 0.09, cachedInputPerMillion: null, outputPerMillion: 0.18 }
      },
      {
        id: "z-ai/glm-5.2",
        label: "GLM 5.2 (OpenRouter)",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 1.4, cachedInputPerMillion: null, outputPerMillion: 4.4 }
      },
      {
        id: "moonshotai/kimi-k3",
        label: "Kimi K3 (OpenRouter)",
        ctx: 1048576,
        reasoning: true,
        pricing: { inputPerMillion: 3, cachedInputPerMillion: null, outputPerMillion: 15 }
      }
    ]
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    baseURLEnv: "OLLAMA_BASE_URL",
    requiresApiKey: false,
    verifiedAt: "2026-08-04",
    models: [
      {
        id: "llama3.2",
        label: "Llama 3.2",
        ctx: 131072,
        reasoning: false,
        pricing: freePricing
      },
      {
        id: "qwen3",
        label: "Qwen 3",
        ctx: 131072,
        reasoning: true,
        pricing: freePricing
      }
    ]
  },
  /**
   * OpenCode Zen e OpenCode Go.
   *
   * Duas assinaturas do mesmo fornecedor, com a MESMA chave
   * (`OPENCODE_API_KEY`) e catálogos/preços diferentes — por isso são dois
   * provedores, e não um com dois modos: `resolveProvider` devolve baseURL por
   * provedor, e o custo de um modelo depende de qual dos dois atendeu.
   *
   * **Só os modelos servidos em `/chat/completions` entram aqui.** O gateway
   * do OpenCode roteia por família: GPT e parte dos demais respondem em
   * `/responses` (protocolo Responses da OpenAI), Claude e Qwen em `/messages`
   * (protocolo da Anthropic) e Gemini em `/models/{id}`. Este app fala
   * `/chat/completions` e só isso, então listar os outros seria oferecer
   * modelos que falham em toda mensagem.
   *
   * A divisão NÃO segue o nome do modelo: `minimax-m3` é `/chat/completions`
   * no Zen e `/messages` no Go; `grok-4.5` é o inverso. Por isso a lista é
   * explícita por provedor, e não uma regra por prefixo — que estaria errada
   * nos dois casos.
   *
   * Preços e endpoints lidos da documentação em 07/08/2026
   * (opencode.ai/docs/zen e /docs/go) e sujeitos à mesma ressalva dos demais:
   * revalide antes de tratar como projeção. `ctx` cai em 131.072 onde não há
   * número verificado — errar para baixo só faz o contexto ser aparado antes
   * do necessário, enquanto errar para cima faz o provedor recusar a
   * requisição inteira. `reasoning` aqui é dica de exibição, não capacidade
   * apurada (ver effort.ts, que de propósito não consulta esse campo).
   */
  "opencode": {
    id: "opencode",
    label: "OpenCode Zen",
    baseURL: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    requiresApiKey: true,
    verifiedAt: "2026-08-07",
    models: [
      {
        id: "big-pickle",
        label: "Big Pickle",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 0.028,
          outputPerMillion: 0.28
        }
      },
      {
        id: "deepseek-v4-flash-free",
        label: "DeepSeek V4 Flash Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.74,
          cachedInputPerMillion: 0.145,
          outputPerMillion: 3.48
        }
      },
      {
        id: "glm-5",
        label: "GLM 5",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1,
          cachedInputPerMillion: 0.2,
          outputPerMillion: 3.2
        }
      },
      {
        id: "glm-5.1",
        label: "GLM 5.1",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4
        }
      },
      {
        id: "glm-5.2",
        label: "GLM 5.2",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4
        }
      },
      {
        id: "kimi-k2.5",
        label: "Kimi K2.5",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.6,
          cachedInputPerMillion: 0.1,
          outputPerMillion: 3
        }
      },
      {
        id: "kimi-k2.6",
        label: "Kimi K2.6",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.16,
          outputPerMillion: 4
        }
      },
      {
        id: "kimi-k2.7-code",
        label: "Kimi K2.7 Code",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.19,
          outputPerMillion: 4
        }
      },
      {
        id: "kimi-k3",
        label: "Kimi K3",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 3,
          cachedInputPerMillion: 0.3,
          outputPerMillion: 15
        }
      },
      {
        id: "laguna-s-2.1-free",
        label: "Laguna S 2.1 Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "ling-3.0-flash-free",
        label: "Ling-3.0-flash Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "longcat-2.0-free",
        label: "LongCat-2.0 Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "mimo-v2.5-free",
        label: "MiMo-V2.5 Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "minimax-m2.5",
        label: "MiniMax M2.5",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.3,
          cachedInputPerMillion: 0.06,
          outputPerMillion: 1.2
        }
      },
      {
        id: "minimax-m2.7",
        label: "MiniMax M2.7",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.3,
          cachedInputPerMillion: 0.06,
          outputPerMillion: 1.2
        }
      },
      {
        id: "minimax-m3",
        label: "MiniMax M3",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.3,
          cachedInputPerMillion: 0.06,
          outputPerMillion: 1.2
        }
      },
      {
        id: "nemotron-3-ultra-free",
        label: "Nemotron 3 Ultra Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      },
      {
        id: "north-mini-code-free",
        label: "North Mini Code Free",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0
        }
      }
    ]
  },
  "opencode-go": {
    id: "opencode-go",
    label: "OpenCode Go",
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    requiresApiKey: true,
    verifiedAt: "2026-08-07",
    models: [
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 28e-4,
          outputPerMillion: 0.28
        }
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.435,
          cachedInputPerMillion: 3625e-6,
          outputPerMillion: 0.87
        }
      },
      {
        id: "glm-5.1",
        label: "GLM-5.1",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4
        }
      },
      {
        id: "glm-5.2",
        label: "GLM-5.2",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 1.4,
          cachedInputPerMillion: 0.26,
          outputPerMillion: 4.4
        }
      },
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 2,
          cachedInputPerMillion: 0.3,
          outputPerMillion: 6
        }
      },
      {
        id: "hy3",
        label: "Hy3",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.14,
          cachedInputPerMillion: 0.035,
          outputPerMillion: 0.58
        }
      },
      {
        id: "kimi-k2.6",
        label: "Kimi K2.6",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.16,
          outputPerMillion: 4
        }
      },
      {
        id: "kimi-k2.7-code",
        label: "Kimi K2.7 Code",
        ctx: 131072,
        reasoning: true,
        pricing: {
          inputPerMillion: 0.95,
          cachedInputPerMillion: 0.19,
          outputPerMillion: 4
        }
      },
      {
        id: "kimi-k3",
        label: "Kimi K3",
        ctx: 1048576,
        reasoning: true,
        pricing: {
          inputPerMillion: 3,
          cachedInputPerMillion: 0.3,
          outputPerMillion: 15
        }
      },
      {
        id: "mimo-v2.5",
        label: "MiMo-V2.5",
        ctx: 131072,
        reasoning: true,
        pricing: unknownPricing
      },
      {
        id: "mimo-v2.5-pro",
        label: "MiMo-V2.5-Pro",
        ctx: 131072,
        reasoning: true,
        pricing: unknownPricing
      }
    ]
  }
};
var STALE_AFTER_DAYS = 90;
function isStale(verifiedAt, now = /* @__PURE__ */ new Date()) {
  const verified = Date.parse(`${verifiedAt}T00:00:00.000Z`);
  if (!Number.isFinite(verified)) return true;
  const age = now.getTime() - verified;
  return age > STALE_AFTER_DAYS * 24 * 60 * 60 * 1e3;
}
var staticCache = null;
function getStaticCatalog() {
  if (staticCache) return staticCache;
  const custom = getCustomProviders();
  const byId = /* @__PURE__ */ new Map();
  for (const provider of Object.values(PROVIDERS)) byId.set(provider.id, provider);
  const customIds = /* @__PURE__ */ new Set();
  for (const provider of custom.providers) {
    byId.set(provider.id, provider);
    customIds.add(provider.id);
  }
  staticCache = { byId, customIds, errors: custom.errors };
  return staticCache;
}
function listStaticProviders() {
  return [...getStaticCatalog().byId.values()];
}

// src/server/secrets.ts
import { chmodSync, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { dirname, isAbsolute as isAbsolute2, join as join2 } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
var V1 = "v1";
var V2 = "v2";
var KEY_LENGTH = 32;
var IV_LENGTH = 12;
var SALT_LENGTH = 16;
var MIN_MASTER_KEY_LENGTH = 16;
var DEFAULT_SECRET_FILE = ".provider-secret";
function contextAad(context) {
  if (!context) return Buffer.alloc(0);
  return Buffer.from(`${context.userId}:${context.providerId}`, "utf8");
}
var generatedSecret = null;
function secretFilePath() {
  const configured = process.env.PROVIDER_SECRET_FILE?.trim();
  if (!configured) return join2(process.cwd(), DEFAULT_SECRET_FILE);
  return isAbsolute2(configured) ? configured : join2(process.cwd(), configured);
}
function readPersistedSecret(path) {
  try {
    const value = readFileSync2(path, "utf8").trim();
    return value.length >= MIN_MASTER_KEY_LENGTH ? value : null;
  } catch {
    return null;
  }
}
function persistSecret(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${value}
`, { encoding: "utf8", flag: "wx", mode: 384 });
    try {
      chmodSync(path, 384);
    } catch {
    }
    return true;
  } catch {
    return false;
  }
}
function automaticMasterSecret() {
  if (process.env.VERCEL) {
    return {
      value: null,
      reason: "Na Vercel, configure PROVIDER_SECRET_KEY com ao menos 16 caracteres. O disco da fun\xE7\xE3o n\xE3o \xE9 persistente."
    };
  }
  const path = secretFilePath();
  if (generatedSecret?.path === path) return { value: generatedSecret.value, reason: null };
  const persisted = readPersistedSecret(path);
  if (persisted) {
    generatedSecret = { path, value: persisted };
    return { value: persisted, reason: null };
  }
  const value = randomBytes(KEY_LENGTH).toString("base64url");
  if (persistSecret(path, value)) {
    generatedSecret = { path, value };
    return { value, reason: null };
  }
  const raced = readPersistedSecret(path);
  if (raced) {
    generatedSecret = { path, value: raced };
    return { value: raced, reason: null };
  }
  return {
    value: null,
    reason: "N\xE3o foi poss\xEDvel criar o armazenamento interno das chaves. Verifique as permiss\xF5es da pasta do aplicativo."
  };
}
function masterSecret() {
  const explicit = process.env.PROVIDER_SECRET_KEY?.trim();
  if (explicit) {
    if (explicit.length < MIN_MASTER_KEY_LENGTH) {
      return { value: null, reason: `PROVIDER_SECRET_KEY precisa ter ao menos ${MIN_MASTER_KEY_LENGTH} caracteres.` };
    }
    const path = secretFilePath();
    if (!readPersistedSecret(path)) persistSecret(path, explicit);
    return { value: explicit, reason: null };
  }
  return automaticMasterSecret();
}
function getSecretStorageStatus() {
  const result = masterSecret();
  return { available: Boolean(result.value), reason: result.reason };
}
function deriveKey(master, salt) {
  return scryptSync(master, salt, KEY_LENGTH);
}
function encryptSecret(plain, context) {
  const result = masterSecret();
  if (!result.value) throw new Error(result.reason ?? "Armazenamento de segredos indispon\xEDvel.");
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(result.value, salt), iv);
  cipher.setAAD(contextAad(context));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V2, salt, iv, tag, ciphertext].map((part) => typeof part === "string" ? part : part.toString("base64")).join(".");
}
function decryptSecret(blob, context) {
  if (!blob) return null;
  const result = masterSecret();
  if (!result.value) return null;
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== V1 && parts[0] !== V2) return null;
  try {
    const [, saltB64, ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(result.value, Buffer.from(saltB64, "base64")), Buffer.from(ivB64, "base64"));
    if (parts[0] === V2) {
      decipher.setAAD(contextAad(context));
    }
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

// src/server/provider-resolution.ts
function allowEnvApiKeys() {
  if (process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL)) return false;
  return process.env.ALLOW_ENV_API_KEYS === "true";
}
function isBuiltin(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}
function staticBase(providerId2) {
  if (isBuiltin(providerId2)) return PROVIDERS[providerId2];
  return getCustomProviders().providers.find((provider) => provider.id === providerId2);
}
function toModelConfig2(input) {
  return {
    id: input.id,
    label: input.label ?? input.id,
    ctx: input.ctx,
    reasoning: input.reasoning ?? false,
    pricing: {
      inputPerMillion: input.pricing?.inputPerMillion ?? null,
      cachedInputPerMillion: input.pricing?.cachedInputPerMillion ?? null,
      outputPerMillion: input.pricing?.outputPerMillion ?? null
    }
  };
}
function recordModels(record) {
  const models = [];
  for (const raw of Array.isArray(record.models) ? record.models : []) {
    const parsed = ProviderModelInputSchema.safeParse(raw);
    if (parsed.success) models.push(toModelConfig2(parsed.data));
  }
  return models;
}
function envApiKeyFallback(base) {
  if (!allowEnvApiKeys()) return null;
  const name = base?.apiKeyEnv;
  if (!name) return null;
  const value = process.env[name];
  return value && value.trim() ? value : null;
}
function hasSafeProviderUrl(baseURL) {
  if (!baseURL.trim()) return false;
  try {
    assertSafeProviderUrl(baseURL);
    return true;
  } catch {
    return false;
  }
}
function resolveProviderParts(userId, providerId2, base, record) {
  const recordModelsList = record ? recordModels(record) : [];
  const models = record && recordModelsList.length > 0 ? recordModelsList : base?.models ?? [];
  let baseURL = "";
  if (record?.baseURL.trim()) baseURL = record.baseURL;
  else if (base) baseURL = base.baseURLEnv && process.env[base.baseURLEnv]?.trim() ? process.env[base.baseURLEnv] : base.baseURL;
  const requiresApiKey = base ? base.requiresApiKey : Boolean(record?.apiKeyCipher);
  const storedKey = record?.apiKeyCipher ? decryptSecret(record.apiKeyCipher, { userId, providerId: providerId2 }) : null;
  const apiKey = storedKey ?? envApiKeyFallback(base);
  const source = base ? isBuiltin(base.id) ? "builtin" : "custom" : "user";
  return {
    id: providerId2,
    label: record?.label || base?.label || providerId2,
    baseURL,
    requiresApiKey,
    apiKey,
    models,
    verifiedAt: (record?.verifiedAt?.trim() || base?.verifiedAt) ?? "",
    source
  };
}
async function resolveProvider(userId, providerId2, db) {
  const base = staticBase(providerId2);
  const records = await db.listProviderSettings(userId);
  const record = records.find((item) => item.id === providerId2);
  if (!base && !record) return null;
  return resolveProviderParts(userId, providerId2, base, record);
}
function toCatalogModel(model) {
  return {
    id: model.id,
    label: model.label,
    contextWindow: model.ctx,
    reasoning: model.reasoning,
    pricing: model.pricing
  };
}
function buildUserCatalog(userId, records, now) {
  const entries = [];
  for (const base of listStaticProviders()) {
    const record = records.find((item) => item.id === base.id);
    const resolved = resolveProviderParts(userId, base.id, base, record);
    entries.push({
      id: resolved.id,
      label: resolved.label,
      configured: hasSafeProviderUrl(resolved.baseURL) && (resolved.requiresApiKey ? Boolean(resolved.apiKey) : true),
      verifiedAt: resolved.verifiedAt,
      stale: isStale(resolved.verifiedAt, now),
      // Usuário que sobrescreve um embutido mantém o source do embutido.
      source: isBuiltin(resolved.id) ? "builtin" : "custom",
      models: resolved.models.map(toCatalogModel)
    });
  }
  const staticIds = new Set(entries.map((entry) => entry.id));
  for (const record of records) {
    if (staticIds.has(record.id)) continue;
    const resolved = resolveProviderParts(userId, record.id, void 0, record);
    entries.push({
      id: resolved.id,
      label: resolved.label,
      configured: hasSafeProviderUrl(resolved.baseURL) && (resolved.requiresApiKey ? Boolean(resolved.apiKey) : true),
      verifiedAt: resolved.verifiedAt,
      stale: isStale(resolved.verifiedAt, now),
      // Provedor criado só pelo usuário não é embutido.
      source: "custom",
      models: resolved.models.map(toCatalogModel)
    });
  }
  return entries;
}
function pickDefault(providers) {
  const envProvider = process.env.DEFAULT_PROVIDER_ID;
  const envModel = process.env.DEFAULT_MODEL_ID;
  if (envProvider && envModel) {
    const provider = providers.find((item) => item.id === envProvider);
    const model = provider?.models.find((item) => item.id === envModel);
    if (provider && model) return { providerId: provider.id, modelId: model.id };
  }
  const firstConfigured = providers.find((provider) => provider.configured && provider.models.length > 0);
  if (firstConfigured) return { providerId: firstConfigured.id, modelId: firstConfigured.models[0].id };
  return { providerId: "deepseek", modelId: PROVIDERS.deepseek.models[0].id };
}
async function resolveModelsCatalog(userId, db) {
  const records = await db.listProviderSettings(userId);
  const providers = buildUserCatalog(userId, records, /* @__PURE__ */ new Date());
  const defaults = pickDefault(providers);
  return {
    providers,
    defaultProviderId: defaults.providerId,
    defaultModelId: defaults.modelId,
    configErrors: [...getCustomProviders().errors]
  };
}
async function resolveDefaultModelSelection(userId, db) {
  const records = await db.listProviderSettings(userId);
  return pickDefault(buildUserCatalog(userId, records, /* @__PURE__ */ new Date()));
}

// src/server/providers.discovery.ts
var DEFAULT_DISCOVERED_CONTEXT_WINDOW = 131072;
var MAX_DISCOVERED_MODELS = 500;
var DISCOVERY_TIMEOUT_MS = 15e3;
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function firstNumber(...values) {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed !== void 0 && parsed >= 0) return parsed;
  }
  return void 0;
}
function modelRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord2(payload)) return [];
  for (const key of ["data", "models", "items", "results"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}
var REASONING_PARAMS = /* @__PURE__ */ new Set(["reasoning", "reasoning_effort", "include_reasoning", "thinking"]);
function detectReasoning(value, id, label) {
  if (typeof value.reasoning === "boolean") return value.reasoning;
  if (typeof value.supports_reasoning === "boolean") return value.supports_reasoning;
  const declarados = value.supported_parameters ?? value.supportedParameters;
  if (Array.isArray(declarados)) {
    return declarados.some((item) => typeof item === "string" && REASONING_PARAMS.has(item.trim().toLowerCase()));
  }
  return /reason|think|r1(?:$|[-.])|o[134](?:$|[-.])/iu.test(`${id} ${label}`);
}
function pricingFrom(row) {
  const pricing = isRecord2(row.pricing) ? row.pricing : void 0;
  const inputPerMillion = firstNumber(
    row.inputPerMillion,
    row.input_price_per_million,
    row.inputPriceUsdPerMillion,
    pricing?.inputPerMillion,
    pricing?.input_price_per_million,
    pricing?.inputPriceUsdPerMillion
  ) ?? (() => {
    const perToken = firstNumber(row.prompt, row.input, pricing?.prompt, pricing?.input);
    return perToken === void 0 ? void 0 : perToken * 1e6;
  })();
  const outputPerMillion = firstNumber(
    row.outputPerMillion,
    row.output_price_per_million,
    row.outputPriceUsdPerMillion,
    pricing?.outputPerMillion,
    pricing?.output_price_per_million,
    pricing?.outputPriceUsdPerMillion
  ) ?? (() => {
    const perToken = firstNumber(row.completion, row.output, pricing?.completion, pricing?.output);
    return perToken === void 0 ? void 0 : perToken * 1e6;
  })();
  if (inputPerMillion === void 0 && outputPerMillion === void 0) return void 0;
  return { inputPerMillion: inputPerMillion ?? null, outputPerMillion: outputPerMillion ?? null };
}
function toModelInput(value) {
  if (typeof value === "string" && value.trim()) {
    return { id: value.trim(), label: value.trim(), ctx: DEFAULT_DISCOVERED_CONTEXT_WINDOW };
  }
  if (!isRecord2(value)) return null;
  const id = asText(value.id ?? value.model ?? value.model_id ?? value.name);
  if (!id) return null;
  const label = asText(value.name ?? value.display_name ?? value.label) || id;
  const context = firstNumber(
    value.context_length,
    value.context_window,
    value.contextWindow,
    value.max_context_length,
    value.max_tokens
  );
  const reasoning = detectReasoning(value, id, label);
  return {
    id,
    label,
    ctx: context && context > 0 ? Math.trunc(context) : DEFAULT_DISCOVERED_CONTEXT_WINDOW,
    reasoning,
    pricing: pricingFrom(value)
  };
}
function responseMessage(payload) {
  if (!isRecord2(payload)) return "";
  const error = isRecord2(payload.error) ? payload.error : void 0;
  return asText(payload.message ?? error?.message ?? payload.detail);
}
function discoveryError(status, payload) {
  if (status === 401 || status === 403) {
    return new AppError("INVALID_API_KEY", {
      status: 400,
      providerStatus: status,
      message: "A chave de API foi recusada pelo provedor. Confira a chave e tente novamente."
    });
  }
  if (status === 404) {
    return new AppError("UNKNOWN", {
      status: 400,
      providerStatus: status,
      message: "O provedor n\xE3o exp\xF4s o endpoint /models. Confira a URL base (por exemplo, terminando em /v1)."
    });
  }
  if (status === 429) {
    return new AppError("RATE_LIMIT", {
      providerStatus: status,
      message: "O provedor limitou a consulta de modelos. Aguarde alguns segundos e tente novamente."
    });
  }
  const upstreamMessage = responseMessage(payload);
  return new AppError("UNKNOWN", {
    status: status >= 500 ? 502 : 400,
    providerStatus: status,
    message: upstreamMessage ? `O provedor n\xE3o conseguiu listar os modelos: ${upstreamMessage.slice(0, 180)}` : `O provedor n\xE3o conseguiu listar os modelos (HTTP ${status}).`
  });
}
async function discoverProviderModels(baseURL, apiKey, fetchImpl = fetch) {
  const url = `${baseURL.replace(/\/+$/u, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  try {
    const headers = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    let response;
    try {
      response = await safeFetchWithRedirects(
        url,
        { method: "GET", headers, signal: controller.signal },
        { fetchImpl, production, allowLocalhost: !production }
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) {
        throw new AppError("UPSTREAM_TIMEOUT", {
          message: "A consulta de modelos demorou demais. Confira a URL e tente novamente."
        });
      }
      throw new AppError("UNKNOWN", { status: 400, message: "N\xE3o foi poss\xEDvel conectar ao endpoint /models do provedor." });
    }
    const text3 = await response.text();
    let payload = void 0;
    if (text3.trim()) {
      try {
        payload = JSON.parse(text3);
      } catch {
        payload = void 0;
      }
    }
    if (!response.ok) throw discoveryError(response.status, payload);
    const discovered = modelRows(payload).map(toModelInput).filter((model) => Boolean(model));
    const unique = new Map(discovered.map((model) => [model.id, model]));
    const models = [...unique.values()].slice(0, MAX_DISCOVERED_MODELS);
    if (models.length === 0) {
      throw new AppError("UNKNOWN", {
        status: 400,
        message: "O provedor respondeu, mas n\xE3o informou nenhum modelo em /models."
      });
    }
    return models;
  } finally {
    clearTimeout(timer);
  }
}

// src/server/opencode.ts
function openCodeCatalogFor(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return null;
  const caminho = url.pathname.replace(/\/+$/u, "");
  if (caminho.startsWith("/zen/go/v1")) return "opencode-go";
  if (caminho.startsWith("/zen/v1")) return "opencode";
  return null;
}
function filterOpenCodeModels(providerId2, discovered) {
  const conhecidos = new Map(
    PROVIDERS[providerId2].models.map((model) => [model.id, model])
  );
  const vistos = /* @__PURE__ */ new Set();
  const compativeis = [];
  for (const model of discovered) {
    const conhecido = conhecidos.get(model.id);
    if (!conhecido || vistos.has(model.id)) continue;
    vistos.add(model.id);
    compativeis.push({
      id: conhecido.id,
      label: conhecido.label,
      ctx: conhecido.ctx,
      reasoning: conhecido.reasoning,
      pricing: {
        inputPerMillion: conhecido.pricing.inputPerMillion,
        cachedInputPerMillion: conhecido.pricing.cachedInputPerMillion,
        outputPerMillion: conhecido.pricing.outputPerMillion
      }
    });
  }
  return compativeis;
}
var OPENCODE_SEM_MODELOS = "O OpenCode respondeu, mas nenhum dos modelos dispon\xEDveis usa o protocolo /chat/completions, que \xE9 o que este aplicativo fala. A chave est\xE1 v\xE1lida \u2014 o cat\xE1logo do provedor \xE9 que mudou.";

// src/server/search/backends.ts
var BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
var TAVILY_ENDPOINT = "https://api.tavily.com/search";
var TIMEOUT_MS = 12e3;
var MAX_BODY = 512e3;
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
function texto(value) {
  return typeof value === "string" ? value : "";
}
function limparTrecho(value) {
  return value.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim().slice(0, 1200);
}
function normalizar(candidatos, maxResults) {
  const resultados = [];
  for (const candidato of candidatos) {
    if (resultados.length >= maxResults) break;
    const parsed = SearchResultSchema.safeParse(candidato);
    if (parsed.success) resultados.push(parsed.data);
  }
  return resultados;
}
async function lerJson(response, backend) {
  const texto2 = (await response.text()).slice(0, MAX_BODY);
  try {
    return JSON.parse(texto2);
  } catch {
    throw new AppError("UNKNOWN", { status: 502, message: `O buscador (${backend}) devolveu uma resposta ileg\xEDvel.` });
  }
}
function erroDeStatus(status, backend) {
  if (status === 401 || status === 403) {
    return new AppError("INVALID_API_KEY", {
      status: 400,
      message: `A chave da busca (${backend}) foi recusada. Revise em Configura\xE7\xF5es \u2192 Busca.`
    });
  }
  if (status === 429) {
    return new AppError("RATE_LIMIT", { status: 429, message: `O buscador (${backend}) recusou por limite de uso.` });
  }
  return new AppError("UNKNOWN", { status: 502, message: `O buscador (${backend}) respondeu ${status}.` });
}
function comPrazo(signal) {
  const controller = new AbortController();
  const temporizador = setTimeout(() => controller.abort(new AppError("UPSTREAM_TIMEOUT")), TIMEOUT_MS);
  const repassar = () => controller.abort(signal.reason);
  if (signal.aborted) repassar();
  else signal.addEventListener("abort", repassar, { once: true });
  return {
    signal: controller.signal,
    cancelar: () => {
      clearTimeout(temporizador);
      signal.removeEventListener("abort", repassar);
    }
  };
}
async function brave(request) {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", request.query);
  url.searchParams.set("count", String(request.maxResults));
  const prazo = comPrazo(request.signal);
  try {
    const response = await safeFetchWithRedirects(
      url.toString(),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          "x-subscription-token": request.apiKey ?? ""
        },
        signal: prazo.signal
      },
      { fetchImpl: request.fetchImpl, lookup: request.lookup }
    );
    if (!response.ok) throw erroDeStatus(response.status, "brave");
    const payload = await lerJson(response, "brave");
    const web = isRecord3(payload) && isRecord3(payload.web) ? payload.web : null;
    const itens = web && Array.isArray(web.results) ? web.results : [];
    return normalizar(
      itens.map((item) => isRecord3(item) ? {
        title: texto(item.title).slice(0, 300),
        url: texto(item.url),
        snippet: limparTrecho(texto(item.description)),
        publishedAt: texto(item.age) || null
      } : null).filter((item) => item !== null),
      request.maxResults
    );
  } finally {
    prazo.cancelar();
  }
}
async function tavily(request) {
  const prazo = comPrazo(request.signal);
  try {
    const response = await safeFetchWithRedirects(
      TAVILY_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          api_key: request.apiKey,
          query: request.query,
          max_results: request.maxResults,
          search_depth: "basic"
        }),
        signal: prazo.signal
      },
      { fetchImpl: request.fetchImpl, lookup: request.lookup }
    );
    if (!response.ok) throw erroDeStatus(response.status, "tavily");
    const payload = await lerJson(response, "tavily");
    const itens = isRecord3(payload) && Array.isArray(payload.results) ? payload.results : [];
    return normalizar(
      itens.map((item) => isRecord3(item) ? {
        title: texto(item.title).slice(0, 300),
        url: texto(item.url),
        snippet: limparTrecho(texto(item.content)),
        publishedAt: texto(item.published_date) || null
      } : null).filter((item) => item !== null),
      request.maxResults
    );
  } finally {
    prazo.cancelar();
  }
}
async function searxng(request) {
  if (!request.baseURL) {
    throw new AppError("UNKNOWN", { status: 400, message: "Informe a URL da sua inst\xE2ncia SearXNG em Configura\xE7\xF5es \u2192 Busca." });
  }
  const url = new URL(`${request.baseURL.replace(/\/+$/u, "")}/search`);
  url.searchParams.set("q", request.query);
  url.searchParams.set("format", "json");
  const prazo = comPrazo(request.signal);
  try {
    const headers = { accept: "application/json" };
    if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
    const response = await safeFetchWithRedirects(
      url.toString(),
      { method: "GET", headers, signal: prazo.signal },
      { fetchImpl: request.fetchImpl, lookup: request.lookup }
    );
    if (!response.ok) {
      if (response.status === 403) {
        throw new AppError("UNKNOWN", {
          status: 400,
          message: 'A inst\xE2ncia SearXNG recusou. Habilite o formato "json" em search.formats no settings.yml dela.'
        });
      }
      throw erroDeStatus(response.status, "searxng");
    }
    const payload = await lerJson(response, "searxng");
    const itens = isRecord3(payload) && Array.isArray(payload.results) ? payload.results : [];
    return normalizar(
      itens.map((item) => isRecord3(item) ? {
        title: texto(item.title).slice(0, 300),
        url: texto(item.url),
        snippet: limparTrecho(texto(item.content)),
        publishedAt: texto(item.publishedDate) || null
      } : null).filter((item) => item !== null),
      request.maxResults
    );
  } finally {
    prazo.cancelar();
  }
}
var BACKENDS = {
  brave,
  tavily,
  searxng
};
var BACKEND_REQUIRES_KEY = {
  brave: true,
  tavily: true,
  searxng: false,
  // A chave é a da própria OpenRouter, já configurada em Provedores. Exigir
  // uma segunda aqui pediria ao usuário algo que ele não tem como fornecer.
  openrouter: false
};
var BACKEND_REQUIRES_URL = {
  brave: false,
  tavily: false,
  searxng: true,
  openrouter: false
};
function runBackend(backend, request) {
  const executor = BACKENDS[backend];
  if (!executor) {
    throw new Error(`A busca "${backend}" \xE9 resolvida pelo provedor e n\xE3o deve ser executada aqui.`);
  }
  return executor(request);
}

// src/server/search/index.ts
function aadProviderId(backend) {
  return `search:${backend}`;
}
function encryptionProviderId(backend) {
  return aadProviderId(backend);
}
function toSearchSettingsResponse(record) {
  const backend = SearchBackendSchema.safeParse(record.backend);
  if (!backend.success) return null;
  return {
    backend: backend.data,
    baseURL: record.baseURL,
    hasKey: Boolean(record.apiKeyCipher),
    maxResults: record.maxResults,
    enabled: record.enabled,
    updatedAt: record.updatedAt
  };
}
async function resolveSearch(userId, db, providerBaseURL) {
  const record = await db.getSearchSettings(userId);
  if (!record || !record.enabled) return null;
  const backend = SearchBackendSchema.safeParse(record.backend);
  if (!backend.success) return null;
  if (backend.data === "openrouter") {
    if (!providerBaseURL || !isOpenRouterBaseUrl(providerBaseURL)) return null;
    return { backend: "openrouter", kind: "provider", baseURL: null, apiKey: null, maxResults: record.maxResults };
  }
  const apiKey = record.apiKeyCipher ? decryptSecret(record.apiKeyCipher, { userId, providerId: aadProviderId(backend.data) }) : null;
  if (BACKEND_REQUIRES_KEY[backend.data] && !apiKey) return null;
  if (BACKEND_REQUIRES_URL[backend.data] && !record.baseURL) return null;
  return {
    backend: backend.data,
    kind: "external",
    baseURL: record.baseURL,
    apiKey,
    maxResults: record.maxResults
  };
}
async function runSearch(resolved, query, signal, fetchImpl) {
  try {
    if (resolved.baseURL) assertSafeProviderUrl(resolved.baseURL);
    const results = await runBackend(resolved.backend, {
      query,
      maxResults: resolved.maxResults,
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      signal,
      fetchImpl
    });
    return { results, failure: null };
  } catch (error) {
    if (signal.aborted) throw error;
    const normalized = error instanceof AppError ? error : normalizeError(error);
    return { results: [], failure: normalized.message.slice(0, 300) };
  }
}
function formatResultsForModel(query, outcome) {
  if (outcome.failure) {
    return [
      `Resultados da busca por "${query}":`,
      "",
      `A busca falhou: ${outcome.failure}`,
      "",
      "Responda com o que voc\xEA j\xE1 sabe e diga claramente ao usu\xE1rio que n\xE3o foi poss\xEDvel consultar a web agora."
    ].join("\n");
  }
  if (outcome.results.length === 0) {
    return [
      `Resultados da busca por "${query}":`,
      "",
      "Nenhum resultado.",
      "",
      "Tente uma consulta diferente, ou diga ao usu\xE1rio que n\xE3o encontrou nada sobre isso."
    ].join("\n");
  }
  const itens = outcome.results.map((resultado, indice) => {
    const data = resultado.publishedAt ? ` (${resultado.publishedAt})` : "";
    return `[${indice + 1}] ${resultado.title}${data}
${resultado.url}
${resultado.snippet}`;
  });
  return [
    `Resultados da busca por "${query}":`,
    "",
    ...itens,
    "",
    "Estes s\xE3o trechos, n\xE3o as p\xE1ginas inteiras. Use-os para responder e cite as URLs que usar. Se um trecho n\xE3o sustenta o que voc\xEA ia afirmar, diga que n\xE3o encontrou \u2014 n\xE3o complete de mem\xF3ria."
  ].join("\n");
}

// src/server/search/protocol.ts
var OPEN = "<search>";
var CLOSE = "</search>";
var MAX_QUERY_LENGTH = 400;
function suffixThatCanStart2(value) {
  const max = Math.min(value.length, OPEN.length);
  for (let length = max; length > 0; length -= 1) {
    if (OPEN.startsWith(value.slice(-length))) return length;
  }
  return 0;
}
function createPassthroughScanner() {
  return {
    push: (chunk) => chunk ? [{ kind: "text", text: chunk }] : [],
    end: () => []
  };
}
function createSearchScanner() {
  let buffer = "";
  const drenar = (events) => {
    const abertura = buffer.indexOf(OPEN);
    if (abertura < 0) {
      const reter = suffixThatCanStart2(buffer);
      const texto2 = buffer.slice(0, buffer.length - reter);
      if (texto2) events.push({ kind: "text", text: texto2 });
      buffer = buffer.slice(buffer.length - reter);
      return false;
    }
    const fechamento = buffer.indexOf(CLOSE, abertura + OPEN.length);
    if (fechamento < 0) {
      const texto2 = buffer.slice(0, abertura);
      if (texto2) events.push({ kind: "text", text: texto2 });
      buffer = buffer.slice(abertura);
      if (buffer.length > OPEN.length + MAX_QUERY_LENGTH + CLOSE.length) {
        events.push({ kind: "text", text: buffer });
        buffer = "";
      }
      return false;
    }
    const anterior = buffer.slice(0, abertura);
    if (anterior) events.push({ kind: "text", text: anterior });
    const consulta = buffer.slice(abertura + OPEN.length, fechamento).trim();
    buffer = buffer.slice(fechamento + CLOSE.length);
    if (!consulta || consulta.length > MAX_QUERY_LENGTH) {
      events.push({ kind: "text", text: `${OPEN}${consulta}${CLOSE}` });
      return true;
    }
    events.push({ kind: "search", query: consulta });
    return true;
  };
  return {
    push(chunk) {
      if (!chunk) return [];
      buffer += chunk;
      const events = [];
      while (drenar(events)) {
      }
      return events;
    },
    end() {
      const events = [];
      if (buffer) events.push({ kind: "text", text: buffer });
      buffer = "";
      return events;
    }
  };
}
function searchSystemPrompt(maxRounds) {
  return [
    "## Busca na web",
    "",
    "Voc\xEA pode consultar a web. Para isso, escreva exatamente:",
    "",
    "<search>os termos da consulta</search>",
    "",
    "Regras:",
    "",
    `- **Pare de escrever ao fechar o marcador.** O que vier depois dele no mesmo turno \xE9 descartado \u2014 os resultados ainda n\xE3o chegaram, ent\xE3o qualquer resposta escrita ali seria um chute.`,
    "- Uma consulta por marcador. Escreva os termos como escreveria num buscador, n\xE3o uma pergunta inteira.",
    `- Voc\xEA tem no m\xE1ximo ${maxRounds} ${maxRounds === 1 ? "busca" : "buscas"} por resposta. Use-as para o que muda com o tempo, para o que voc\xEA n\xE3o sabe e para o que precisa de fonte.`,
    "- **N\xE3o busque o que voc\xEA j\xE1 sabe.** Pergunta de racioc\xEDnio, de c\xF3digo ou sobre a pr\xF3pria conversa n\xE3o precisa de web.",
    "- Depois dos resultados, cite as fontes que usou pela URL, no corpo da resposta.",
    "- Os resultados s\xE3o trechos, n\xE3o a p\xE1gina inteira. Se um trecho n\xE3o sustenta a afirma\xE7\xE3o, diga que n\xE3o encontrou em vez de completar de mem\xF3ria."
  ].join("\n");
}

// src/server/science/levels.ts
function regrasDeFormato(formato) {
  if (formato === "latex") {
    return [
      "Escreva em LaTeX, num documento `article` completo: pre\xE2mbulo, \\begin{document} e \\end{document}.",
      "Use \\section e \\subsection para a estrutura, o ambiente equation para f\xF3rmulas de bloco e $...$ para as de linha.",
      "Cita\xE7\xF5es com \\cite e as refer\xEAncias num thebibliography no fim.",
      "N\xE3o use pacotes ex\xF3ticos: o documento precisa compilar com article, amsmath e hyperref.",
      'Inclua \\usepackage[utf8]{inputenc} e escreva os acentos DIRETO em UTF-8 \u2014 "m\xE9todo", "identifica\xE7\xE3o".',
      "Nunca use as formas antigas \\'e, \\c{c} ou \\~ao: s\xE3o legado de fonte n\xE3o-UTF-8 e deixam o texto ileg\xEDvel fora de um compilador."
    ].join(" ");
  }
  return [
    "Escreva em Markdown.",
    "Use ## e ### para a estrutura, $...$ e $$...$$ para matem\xE1tica (nunca crase para f\xF3rmula) e tabelas do GitHub quando couber.",
    "As refer\xEAncias v\xE3o numa se\xE7\xE3o final, com link quando existir."
  ].join(" ");
}
var RIGOR = [
  "Voc\xEA escreve para um estudante que vai usar este texto para estudar de verdade.",
  "Densidade acima de volume: nada de par\xE1grafo de enrola\xE7\xE3o, frase de efeito ou repeti\xE7\xE3o do enunciado.",
  "**N\xE3o invente fonte, n\xFAmero, data ou cita\xE7\xE3o.** Quando n\xE3o souber, escreva o que se sabe e diga explicitamente o que est\xE1 em aberto \u2014 uma refer\xEAncia inventada destr\xF3i a utilidade do texto inteiro e \xE9 o pior erro poss\xEDvel aqui.",
  "Defina cada termo t\xE9cnico na primeira vez que aparecer."
].join(" ");
var PESQUISA = {
  role: "pesquisa",
  label: "Levantamento e contexto detalhado",
  systemPrompt: (formato) => [
    "# Papel: levantamento e reda\xE7\xE3o",
    "",
    RIGOR,
    "",
    "Sua tarefa \xE9 levantar o que se sabe sobre o tema e escrever um contexto DETALHADO sobre ele.",
    "Comece pelo mapa do assunto \u2014 defini\xE7\xF5es, correntes, resultados centrais, controv\xE9rsias \u2014 e s\xF3 ent\xE3o escreva.",
    "Detalhe: derive o que pode ser derivado, d\xEA exemplos concretos, diga as condi\xE7\xF5es em que cada resultado vale",
    "e explique o passo que um autor apressado pularia por achar \xF3bvio.",
    "Cubra o tema inteiro, mesmo que de forma ainda desigual: quem vem depois aprofunda e revisa, mas n\xE3o adivinha o que voc\xEA deixou de fora.",
    'Estruture com se\xE7\xF5es nomeadas pelo conte\xFAdo, nunca por fun\xE7\xE3o ("Se\xE7\xE3o 2", "Desenvolvimento").',
    "",
    "## Estrutura: poucos t\xEDtulos, par\xE1grafos de tamanho normal",
    "",
    "Duas coisas diferentes, e \xE9 f\xE1cil confundi-las: **menos T\xCDTULOS n\xE3o \xE9 menos QUEBRAS DE PAR\xC1GRAFO.**",
    "O texto tem poucas se\xE7\xF5es e, dentro de cada uma, v\xE1rios par\xE1grafos de tamanho comum.",
    "",
    "Sobre os t\xEDtulos:",
    "- No m\xE1ximo **dois n\xEDveis**. Nada de sub-subse\xE7\xE3o.",
    "- Cada se\xE7\xE3o tem **tr\xEAs par\xE1grafos ou mais**. Se tem um s\xF3, ela n\xE3o era uma se\xE7\xE3o: junte ao texto vizinho.",
    "- S\xF3 abra uma subse\xE7\xE3o quando o assunto realmente mudar; mudan\xE7a de aspecto do MESMO assunto \xE9 par\xE1grafo novo.",
    "- Um t\xEDtulo a cada dois par\xE1grafos transforma o documento numa lista de t\xF3picos, e a conex\xE3o entre as ideias",
    "  \u2014 que \xE9 o que se estuda \u2014 desaparece nos espa\xE7os em branco entre os t\xEDtulos.",
    "",
    "Sobre os par\xE1grafos:",
    "- Cada par\xE1grafo trata de **uma ideia**, em geral de quatro a oito frases.",
    "- Passou de umas dez linhas, quase certamente virou dois assuntos: quebre no ponto em que o segundo come\xE7a.",
    "- Bloco enorme e sem respiro \xE9 t\xE3o ruim de estudar quanto texto picado em t\xEDtulos: no primeiro o leitor",
    "  se perde dentro do par\xE1grafo, no segundo se perde entre eles.",
    "- Lista com marcadores \xE9 para enumera\xE7\xE3o real (condi\xE7\xF5es, propriedades, passos), n\xE3o para picar explica\xE7\xE3o.",
    "",
    // Sem figuras aqui: quem ilustra é o revisor, que vê o texto inteiro
    // pronto e sabe onde o desenho realmente falta. Pedir figura a quem ainda
    // está descobrindo o assunto produz desenho do que era fácil desenhar.
    "N\xE3o desenhe figuras: isso \xE9 trabalho da revis\xE3o.",
    "",
    regrasDeFormato(formato)
  ].join("\n")
};
function mecanismoDeFigura(formato) {
  if (formato === "latex") {
    return [
      "Desenhe em **TikZ**, dentro de um ambiente figure com \\caption e \\label:",
      "",
      "\\begin{figure}[h]",
      "\\centering",
      "\\begin{tikzpicture}",
      "  % n\xF3s, setas e formas",
      "\\end{tikzpicture}",
      "\\caption{O que a figura mostra}",
      "\\label{fig:slug}",
      "\\end{figure}",
      "",
      "Use apenas TikZ b\xE1sico \u2014 \\node, \\draw, \\path, bibliotecas arrows.meta e positioning.",
      "Acrescente \\usepackage{tikz} e \\usetikzlibrary ao pre\xE2mbulo se ainda n\xE3o estiverem l\xE1.",
      "Nada de pgfplots, tikz-3dplot ou biblioteca ex\xF3tica: o documento precisa compilar numa instala\xE7\xE3o comum."
    ].join("\n");
  }
  return [
    "Desenhe em **Mermaid**, numa cerca de c\xF3digo com a linguagem `mermaid`:",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Conceito] --> B[Consequ\xEAncia]",
    "```",
    "",
    "Este aplicativo renderiza essa cerca como figura dentro do texto.",
    'Logo abaixo da cerca, escreva a legenda em it\xE1lico come\xE7ando por "Figura N \u2014".',
    "N\xE3o use SVG nem HTML: o Markdown daqui \xE9 renderizado sem HTML cru, e a marca\xE7\xE3o apareceria como texto.",
    "N\xE3o declare tema no Mermaid; o aplicativo aplica o do projeto."
  ].join("\n");
}
function entregaComoArtefato(formato) {
  const abertura = formato === "latex" ? '<artifact id="documento" type="code" language="latex" title="T\xEDtulo do documento">' : '<artifact id="documento" type="markdown" title="T\xEDtulo do documento">';
  return [
    "## Entrega",
    "",
    "**O documento final vai DENTRO de um artefato**, n\xE3o solto no corpo da mensagem:",
    "",
    abertura,
    "o documento inteiro",
    "</artifact>",
    "",
    "Fora do artefato, escreva **no m\xE1ximo duas frases** dizendo o que o documento cobre. Nada al\xE9m disso.",
    "",
    "**O erro mais comum aqui \xE9 escrever o documento duas vezes** \u2014 uma dentro da tag e outra fora, no corpo",
    "da mensagem. O corpo \xE9 o que o leitor v\xEA primeiro, ent\xE3o o resultado \xE9 um documento gigante no chat com",
    "uma c\xF3pia dele no painel ao lado. Depois de fechar `</artifact>`, pare de escrever.",
    "",
    "N\xE3o parta o documento em v\xE1rios artefatos: \xE9 um s\xF3."
  ].join("\n");
}
var REVISAO = {
  role: "revisao",
  label: "Revis\xE3o, coes\xE3o e ilustra\xE7\xF5es",
  systemPrompt: (formato) => [
    "# Papel: revis\xE3o final",
    "",
    "Voc\xEA recebe um texto escrito por v\xE1rias m\xE3os e o entrega como um documento \xFAnico.",
    "\xC9 o seu texto que o estudante vai ler.",
    "",
    "Corrija, nesta ordem de prioridade:",
    "1. **Contradi\xE7\xE3o entre trechos.** Passagens escritas em momentos diferentes podem afirmar coisas incompat\xEDveis; resolva, n\xE3o some as duas.",
    "2. **Repeti\xE7\xE3o.** O mesmo conceito explicado duas vezes com palavras diferentes \u2014 mantenha a melhor explica\xE7\xE3o, no lugar mais cedo em que fa\xE7a sentido.",
    "3. **Ritmo do texto.** Nos dois sentidos: se\xE7\xE3o com um ou dois par\xE1grafos e sub-subse\xE7\xF5es viram texto",
    "   corrido, com a passagem resolvida por uma transi\xE7\xE3o (no m\xE1ximo dois n\xEDveis de t\xEDtulo no documento);",
    "   e par\xE1grafo que passa de umas dez linhas \xE9 quebrado no ponto onde o segundo assunto come\xE7a.",
    "4. **Costura.** Transi\xE7\xF5es entre se\xE7\xF5es, refer\xEAncia para tr\xE1s e para frente, termo usado antes de ser definido.",
    "5. **Voz \xFAnica.** Um texto por v\xE1rias m\xE3os oscila de registro; unifique.",
    "6. Gram\xE1tica, pontua\xE7\xE3o e concord\xE2ncia.",
    "",
    "**N\xE3o acrescente conte\xFAdo escrito novo e n\xE3o corte conte\xFAdo correto.** Seu trabalho \xE9 sobre a forma;",
    "as exce\xE7\xF5es s\xE3o duas: remover repeti\xE7\xE3o, que \xE9 forma disfar\xE7ada de conte\xFAdo, e acrescentar as figuras abaixo.",
    "",
    "## Figuras",
    "",
    "Voc\xEA tamb\xE9m ilustra. \xC9 seu o trabalho porque voc\xEA \xE9 quem l\xEA o texto inteiro pronto:",
    "quem ainda est\xE1 descobrindo o assunto desenha o que era f\xE1cil desenhar, n\xE3o o que faltava explicar.",
    "",
    "Inclua de duas a cinco figuras, e SOMENTE onde o desenho explica melhor que o par\xE1grafo.",
    "Figura que repete o texto \xE9 ru\xEDdo. Mencione cada figura no ponto certo do texto.",
    "",
    mecanismoDeFigura(formato),
    "",
    "Sem cor decorativa: use forma, posi\xE7\xE3o e r\xF3tulo, para a figura funcionar impressa em preto e branco.",
    "R\xF3tulo curto dentro da figura; a explica\xE7\xE3o fica no texto.",
    "Se encontrar afirma\xE7\xE3o que parece inventada \u2014 fonte, n\xFAmero ou cita\xE7\xE3o que voc\xEA n\xE3o consegue sustentar \u2014",
    "n\xE3o a apague em sil\xEAncio: marque-a no texto como carente de verifica\xE7\xE3o.",
    "",
    entregaComoArtefato(formato),
    "",
    regrasDeFormato(formato)
  ].join("\n")
};
var SCIENCE_CHAINS = {
  basic: {
    level: "basic",
    label: "Ligado",
    description: "2 agentes: um levanta e detalha o assunto, outro revisa a coes\xE3o e ilustra.",
    stages: [PESQUISA, REVISAO]
  }
};
function scienceChain(level) {
  return level === "off" ? null : SCIENCE_CHAINS.basic;
}
function handoffMessage(role, texto2) {
  const cabecalho = role === "revisao" ? "Texto a revisar (entregue apenas o documento final):" : "Texto produzido at\xE9 aqui (devolva-o inteiro, com os seus acr\xE9scimos):";
  return `${cabecalho}

<<<TEXTO>>>
${texto2}
<<<FIM DO TEXTO>>>`;
}

// src/server/spreadsheets.ts
import ExcelJS from "exceljs";
import { z as z3 } from "zod";
var MAX_CELLS = 25e4;
var MAX_SELECTION_CELLS = 5e3;
var XLSX_CONTENT_TYPES = Buffer.from("[Content_Types].xml");
var XLSX_WORKBOOK = Buffer.from("xl/workbook.xml");
var MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
var MAX_XLSX_ENTRIES = 2e4;
var GeneratedCellSchema = z3.union([
  z3.string().max(1e5),
  z3.number().finite(),
  z3.boolean(),
  z3.null(),
  z3.object({
    formula: z3.string().min(1).max(8001),
    value: z3.union([z3.string().max(1e5), z3.number().finite(), z3.boolean(), z3.null()])
  }).strict()
]);
var GeneratedSpreadsheetSchema = z3.object({
  filename: z3.string().trim().min(1).max(255).optional(),
  sheets: z3.array(z3.object({
    name: z3.string().trim().min(1).max(100),
    rows: z3.array(z3.array(GeneratedCellSchema).max(2e3)).max(1e5)
  })).min(1).max(100)
}).strict();
function generatedFilename(value, fallback) {
  const base = (value || fallback || "planilha").replace(/[\\/:*?"<>|\u0000-\u001F]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 250) || "planilha";
  return base.toLocaleLowerCase("en-US").endsWith(".xlsx") ? base : `${base}.xlsx`;
}
function uniqueSheetName(raw, used) {
  const clean = raw.replace(/[\\/*?:\[\]]/gu, "-").trim().slice(0, 31) || "Planilha";
  let name = clean;
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase("pt-BR"))) {
    const ending = ` (${suffix})`;
    name = `${clean.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  used.add(name.toLocaleLowerCase("pt-BR"));
  return name;
}
function generatedSpreadsheetFromArtifact(source, fallbackName) {
  const trimmed = source.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  let decoded;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    throw new AppError("UNKNOWN", { status: 400, message: "A planilha gerada veio com JSON inv\xE1lido." });
  }
  const parsed = GeneratedSpreadsheetSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AppError("UNKNOWN", { status: 400, message: "A estrutura da planilha gerada \xE9 inv\xE1lida." });
  }
  let cellCount = 0;
  const usedNames = /* @__PURE__ */ new Set();
  const sheets = parsed.data.sheets.map((sheet) => {
    const cells = [];
    let columnCount = 1;
    sheet.rows.forEach((row, rowIndex) => {
      columnCount = Math.max(columnCount, row.length);
      row.forEach((value, columnIndex) => {
        if (value === null || value === "") return;
        cellCount += 1;
        if (cellCount > MAX_CELLS) {
          throw new AppError("UNKNOWN", {
            status: 400,
            message: `A planilha gerada ultrapassou ${MAX_CELLS.toLocaleString("pt-BR")} c\xE9lulas preenchidas.`
          });
        }
        if (typeof value === "object" && value !== null && "formula" in value) {
          cells.push({
            row: rowIndex + 1,
            column: columnIndex + 1,
            value: value.value,
            formula: value.formula.startsWith("=") ? value.formula.slice(1) : value.formula
          });
        } else if (typeof value === "string" && value.startsWith("=")) {
          cells.push({ row: rowIndex + 1, column: columnIndex + 1, value: null, formula: value.slice(1) });
        } else {
          cells.push({ row: rowIndex + 1, column: columnIndex + 1, value });
        }
      });
    });
    return {
      name: uniqueSheetName(sheet.name, usedNames),
      rowCount: Math.max(1, sheet.rows.length),
      columnCount,
      cells
    };
  });
  return {
    filename: generatedFilename(parsed.data.filename, fallbackName),
    workbook: recalculateWorkbook(SpreadsheetWorkbookSchema.parse({ sheets }))
  };
}
function looksLikeXlsx(data) {
  return data.length >= 4 && data[0] === 80 && data[1] === 75 && (data[2] === 3 || data[2] === 5 || data[2] === 7) && data.includes(XLSX_CONTENT_TYPES) && data.includes(XLSX_WORKBOOK);
}
function validateXlsxArchive(data) {
  let entries = 0;
  let expanded = 0;
  for (let offset = 0; offset + 46 <= data.length; offset += 1) {
    if (data.readUInt32LE(offset) !== 33639248) continue;
    entries += 1;
    expanded += data.readUInt32LE(offset + 24);
    if (entries > MAX_XLSX_ENTRIES || expanded > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new AppError("UNKNOWN", { status: 400, message: "O XLSX expande para um tamanho inseguro e n\xE3o pode ser aberto." });
    }
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  if (entries === 0) throw new AppError("UNKNOWN", { status: 400, message: "O diret\xF3rio interno do XLSX est\xE1 ausente ou corrompido." });
}
function scalar2(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value;
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => {
        if (part && typeof part === "object" && "text" in part) return String(part.text);
        return "";
      }).join("");
    }
    if ("text" in record) return String(record.text ?? "");
    if ("result" in record) return scalar2(record.result);
    if ("error" in record) return String(record.error ?? "");
  }
  return String(value);
}
function normalizeWorkbook(workbook) {
  let cellCount = 0;
  const sheets = workbook.worksheets.map((worksheet) => {
    const cells = [];
    let maxRow = 1;
    let maxColumn = 1;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber2) => {
        cellCount += 1;
        if (cellCount > MAX_CELLS) {
          throw new AppError("UNKNOWN", {
            status: 400,
            message: `A planilha tem mais de ${MAX_CELLS.toLocaleString("pt-BR")} c\xE9lulas preenchidas. Reduza o arquivo antes de enviar.`
          });
        }
        const raw = cell.value;
        const formula = raw && typeof raw === "object" && "formula" in raw ? String(raw.formula) : void 0;
        cells.push({ row: rowNumber, column: columnNumber2, value: scalar2(raw), ...formula ? { formula } : {} });
        maxRow = Math.max(maxRow, rowNumber);
        maxColumn = Math.max(maxColumn, columnNumber2);
      });
    });
    return {
      name: worksheet.name.slice(0, 100) || "Planilha",
      rowCount: Math.min(1e5, maxRow),
      columnCount: Math.min(2e3, maxColumn),
      cells
    };
  });
  if (sheets.length === 0) sheets.push({ name: "Planilha 1", rowCount: 1, columnCount: 1, cells: [] });
  return SpreadsheetWorkbookSchema.parse({ sheets });
}
function parseCsv(text3) {
  const delimiter = detectCsvDelimiter(text3);
  const rows = [[]];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text3.length; index += 1) {
    const char = text3[index];
    if (quoted) {
      if (char === '"' && text3[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === delimiter) {
      rows.at(-1)?.push(field);
      field = "";
    } else if (char === "\n") {
      rows.at(-1)?.push(field.replace(/\r$/u, ""));
      field = "";
      rows.push([]);
    } else field += char;
  }
  rows.at(-1)?.push(field.replace(/\r$/u, ""));
  if (quoted) throw new AppError("UNKNOWN", { status: 400, message: "O CSV termina dentro de um campo entre aspas." });
  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === "") rows.pop();
  const cells = [];
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (value !== "") cells.push({ row: rowIndex + 1, column: columnIndex + 1, value });
  }));
  if (cells.length > MAX_CELLS) {
    throw new AppError("UNKNOWN", { status: 400, message: `O CSV tem mais de ${MAX_CELLS.toLocaleString("pt-BR")} c\xE9lulas preenchidas.` });
  }
  return SpreadsheetWorkbookSchema.parse({ sheets: [{
    name: "Planilha 1",
    rowCount: Math.max(1, rows.length),
    columnCount: Math.max(1, ...rows.map((row) => row.length)),
    cells
  }] });
}
function detectCsvDelimiter(text3) {
  const counts = /* @__PURE__ */ new Map([[",", 0], [";", 0], ["	", 0]]);
  let quoted = false;
  let lines2 = 0;
  for (let index = 0; index < text3.length && lines2 < 10; index += 1) {
    const char = text3[index];
    if (char === '"') {
      if (quoted && text3[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === "," || char === ";" || char === "	")) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    } else if (!quoted && char === "\n") lines2 += 1;
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ",";
}
async function analyzeSpreadsheet(data, filename, text3) {
  if (looksLikeXlsx(data)) {
    try {
      validateXlsxArchive(data);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(data);
      return {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        workbook: normalizeWorkbook(workbook)
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("UNKNOWN", { status: 400, message: `N\xE3o consegui abrir "${filename}" como XLSX.` });
    }
  }
  if (text3 !== null && filename.toLocaleLowerCase("en-US").endsWith(".csv")) {
    return { mime: "text/csv", workbook: parseCsv(text3.replace(/^\uFEFF/u, "")) };
  }
  return null;
}
function cellMap(sheet) {
  return new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell.formula ? `=${cell.formula}` : cell.value]));
}
function tabular(sheet, startRow, startColumn, endRow, endColumn) {
  const values = cellMap(sheet);
  const lines2 = [];
  for (let row = startRow; row <= endRow; row += 1) {
    const fields = [];
    for (let column = startColumn; column <= endColumn; column += 1) {
      fields.push(String(values.get(`${row}:${column}`) ?? "").replaceAll("	", " ").replaceAll("\n", " "));
    }
    lines2.push(fields.join("	"));
  }
  return lines2.join("\n");
}
function spreadsheetPromptBlock(filename, workbook, selection) {
  if (selection) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === selection.sheet);
    if (!sheet) throw new AppError("UNKNOWN", { status: 400, message: `A aba "${selection.sheet}" n\xE3o existe em "${filename}".` });
    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const startColumn = Math.min(selection.startColumn, selection.endColumn);
    const endColumn = Math.max(selection.startColumn, selection.endColumn);
    if (endRow > sheet.rowCount || endColumn > sheet.columnCount) {
      throw new AppError("UNKNOWN", { status: 400, message: "A sele\xE7\xE3o ultrapassa os limites atuais da aba." });
    }
    if ((endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_SELECTION_CELLS) {
      throw new AppError("UNKNOWN", { status: 400, message: `Selecione no m\xE1ximo ${MAX_SELECTION_CELLS.toLocaleString("pt-BR")} c\xE9lulas por pergunta.` });
    }
    return `<<<PLANILHA "${filename}" ABA "${sheet.name}" INTERVALO R${startRow}C${startColumn}:R${endRow}C${endColumn}>>>
${tabular(sheet, startRow, startColumn, endRow, endColumn)}
<<<FIM DA SELE\xC7\xC3O>>>`;
  }
  const previews = workbook.sheets.slice(0, 3).map((sheet) => {
    const rows = Math.min(sheet.rowCount, 20);
    const columns = Math.min(sheet.columnCount, 12);
    return `ABA "${sheet.name}" (${sheet.rowCount}\xD7${sheet.columnCount}; amostra ${rows}\xD7${columns})
${tabular(sheet, 1, 1, rows, columns)}`;
  }).join("\n\n");
  return `<<<PLANILHA "${filename}">>>
${previews}
<<<FIM DA PLANILHA>>>`;
}
async function workbookToXlsx(workbook, original) {
  recalculateWorkbook(workbook);
  let output = new ExcelJS.Workbook();
  if (original && looksLikeXlsx(original)) {
    try {
      validateXlsxArchive(original);
      await output.xlsx.load(original);
    } catch {
      output = new ExcelJS.Workbook();
    }
  }
  const desiredNames = new Set(workbook.sheets.map((sheet) => sheet.name));
  for (const existing of [...output.worksheets]) {
    if (!desiredNames.has(existing.name)) output.removeWorksheet(existing.id);
  }
  for (const sheet of workbook.sheets) {
    const worksheet = output.getWorksheet(sheet.name) ?? output.addWorksheet(sheet.name);
    const desiredCells = new Set(sheet.cells.map((cell) => keyOfCell(cell.row, cell.column)));
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber2) => {
        if (!desiredCells.has(keyOfCell(rowNumber, columnNumber2))) cell.value = null;
      });
    });
    for (const cell of sheet.cells) {
      const target = worksheet.getCell(cell.row, cell.column);
      target.value = cell.formula ? { formula: cell.formula, result: cell.value ?? void 0 } : cell.value;
    }
  }
  output.calcProperties.fullCalcOnLoad = true;
  const data = await output.xlsx.writeBuffer();
  return Buffer.from(data);
}
function keyOfCell(row, column) {
  return `${row}:${column}`;
}
function csvEscape(value) {
  const text3 = String(value ?? "");
  return /[",\r\n]/u.test(text3) ? `"${text3.replaceAll('"', '""')}"` : text3;
}
function workbookSheetToCsv(workbook, sheetName) {
  const sheet = sheetName ? workbook.sheets.find((candidate) => candidate.name === sheetName) : workbook.sheets[0];
  if (!sheet) throw new AppError("UNKNOWN", { status: 404, message: "Aba n\xE3o encontrada." });
  const values = cellMap(sheet);
  const lines2 = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const fields = [];
    for (let column = 1; column <= sheet.columnCount; column += 1) fields.push(csvEscape(values.get(`${row}:${column}`)));
    lines2.push(fields.join(","));
  }
  return `\uFEFF${lines2.join("\r\n")}`;
}

// src/server/attachments.ts
var MAX_TEXT_CHARS = 12e4;
var ASSINATURAS = [
  { mime: "image/png", kind: "image", bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
  { mime: "image/jpeg", kind: "image", bytes: [255, 216, 255] },
  { mime: "image/gif", kind: "image", bytes: [71, 73, 70, 56] },
  { mime: "image/webp", kind: "image", bytes: [87, 69, 66, 80], offset: 8 },
  { mime: "application/pdf", kind: "document", bytes: [37, 80, 68, 70] }
];
function combina(dados, assinatura) {
  const inicio = assinatura.offset ?? 0;
  if (dados.length < inicio + assinatura.bytes.length) return false;
  return assinatura.bytes.every((byte, indice) => dados[inicio + indice] === byte);
}
function pareceTexto(dados) {
  const amostra = dados.subarray(0, 8192);
  if (amostra.length === 0) return false;
  for (const byte of amostra) {
    if (byte === 0) return false;
    if (byte < 9) return false;
    if (byte > 13 && byte < 32) return false;
  }
  const texto2 = new TextDecoder("utf-8", { fatal: false }).decode(amostra);
  return !texto2.includes("\uFFFD");
}
function limitar(texto2) {
  const limpo = texto2.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").replace(/\n{3,}/gu, "\n\n").trim();
  if (limpo.length <= MAX_TEXT_CHARS) return { text: limpo, truncated: false };
  return { text: limpo.slice(0, MAX_TEXT_CHARS), truncated: true };
}
async function extrairPdf(dados) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const documento = await getDocumentProxy(new Uint8Array(dados));
  const { text: text3 } = await extractText(documento, { mergePages: true });
  return Array.isArray(text3) ? text3.join("\n\n") : text3;
}
function decodeAttachment(base64) {
  const dados = Buffer.from(base64, "base64");
  if (dados.length === 0) {
    throw new AppError("UNKNOWN", { status: 400, message: "O arquivo chegou vazio ou em formato inv\xE1lido." });
  }
  if (dados.length > MAX_ATTACHMENT_BYTES) {
    const limite = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
    throw new AppError("UNKNOWN", { status: 400, message: `Cada arquivo pode ter at\xE9 ${limite} MB.` });
  }
  return dados;
}
async function analyzeAttachment(dados, filename) {
  const xlsx = await analyzeSpreadsheet(dados, filename, null);
  if (xlsx) return { kind: "spreadsheet", mime: xlsx.mime, text: "", truncated: false, workbook: xlsx.workbook };
  const assinatura = ASSINATURAS.find((candidata) => combina(dados, candidata));
  if (assinatura?.kind === "image") {
    return { kind: "image", mime: assinatura.mime, text: "", truncated: false };
  }
  if (assinatura?.mime === "application/pdf") {
    try {
      const bruto = await extrairPdf(dados);
      const { text: text3, truncated } = limitar(bruto);
      return { kind: "document", mime: "application/pdf", text: text3, truncated };
    } catch {
      return { kind: "document", mime: "application/pdf", text: "", truncated: false };
    }
  }
  if (pareceTexto(dados)) {
    const { text: text3, truncated } = limitar(dados.toString("utf8"));
    const csv = await analyzeSpreadsheet(dados, filename, text3);
    if (csv) return { kind: "spreadsheet", mime: csv.mime, text: "", truncated, workbook: csv.workbook };
    return { kind: "document", mime: "text/plain", text: text3, truncated };
  }
  throw new AppError("UNKNOWN", {
    status: 400,
    message: `N\xE3o sei ler "${filename}". Aceito imagens (PNG, JPEG, GIF, WebP), PDF, XLSX, CSV e arquivos de texto.`
  });
}
function documentPromptBlock(filename, text3, truncated) {
  if (!text3.trim()) {
    return `[Anexo "${filename}": n\xE3o foi poss\xEDvel extrair texto \u2014 o arquivo pode ser digitalizado ou conter apenas imagens.]`;
  }
  const aviso = truncated ? "\n[\u2026documento cortado por tamanho\u2026]" : "";
  return `<<<ANEXO "${filename}">>>
${text3}${aviso}
<<<FIM DO ANEXO>>>`;
}
function imageDataUrl(mime, base64) {
  return `data:${mime};base64,${base64}`;
}

// src/server/rate-limit.ts
import { neon as neon2 } from "@neondatabase/serverless";
import { randomUUID as randomUUID2 } from "node:crypto";
var CHAT_START_LIMIT_PER_MINUTE = 20;
var MODEL_DISCOVERY_LIMIT_PER_MINUTE = 5;
var MAX_ACTIVE_STREAMS = 2;
var STREAM_SLOT_EXPIRY_MS = 10 * 6e4;
var WINDOW_MS = 6e4;
var CHAT_START_LIMIT_MESSAGE = "Muitos in\xEDcios de chat por minuto. Aguarde um instante.";
var MODEL_DISCOVERY_LIMIT_MESSAGE = "Muitas descobertas de modelos por minuto. Aguarde um instante.";
var STREAM_LIMIT_MESSAGE = "Voc\xEA j\xE1 tem 2 conversas em andamento. Aguarde uma terminar.";
function rateLimitError(message2) {
  return new AppError("RATE_LIMIT", { status: 429, message: message2 });
}
function currentWindowStart() {
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}
function expiryThreshold(now) {
  return now - STREAM_SLOT_EXPIRY_MS;
}
var InMemoryRateLimitStore = class {
  /** Chave: `bucket:windowStart:userId`. */
  counters = /* @__PURE__ */ new Map();
  slots = /* @__PURE__ */ new Map();
  increment(bucket, userId, limit, message2) {
    const windowStart = currentWindowStart();
    const key = `${bucket}:${windowStart}:${userId}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    if (next > limit) throw rateLimitError(message2);
    this.counters.set(key, next);
    if (this.counters.size > 1024) {
      for (const [candidate] of this.counters) {
        if (!candidate.startsWith(`${bucket}:${windowStart}:`)) this.counters.delete(candidate);
      }
    }
  }
  async checkChatStart(userId) {
    this.increment("chat", userId, CHAT_START_LIMIT_PER_MINUTE, CHAT_START_LIMIT_MESSAGE);
  }
  async checkModelDiscovery(userId) {
    this.increment("discovery", userId, MODEL_DISCOVERY_LIMIT_PER_MINUTE, MODEL_DISCOVERY_LIMIT_MESSAGE);
  }
  async acquireStreamSlot(userId) {
    const now = Date.now();
    const fresh = (this.slots.get(userId) ?? []).filter((slot) => now - slot.lastActive <= STREAM_SLOT_EXPIRY_MS);
    if (fresh.length >= MAX_ACTIVE_STREAMS) throw rateLimitError(STREAM_LIMIT_MESSAGE);
    const slotId = randomUUID2();
    fresh.push({ id: slotId, startedAt: now, lastActive: now });
    this.slots.set(userId, fresh);
    return slotId;
  }
  async releaseStreamSlot(userId, slotId) {
    const slots = this.slots.get(userId);
    if (!slots || slots.length === 0) return;
    const index = slots.findIndex((slot) => slot.id === slotId);
    if (index === -1) return;
    slots.splice(index, 1);
    if (slots.length === 0) this.slots.delete(userId);
  }
  async touchStream(userId, slotId) {
    const slots = this.slots.get(userId);
    if (!slots) return;
    const slot = slots.find((candidate) => candidate.id === slotId);
    if (slot) slot.lastActive = Date.now();
  }
};
var NeonRateLimitStore = class {
  sql;
  constructor(connectionString, sql = neon2(connectionString)) {
    this.sql = sql;
  }
  async rows(query, params = []) {
    return await this.sql.query(query, params);
  }
  async increment(bucket, userId, limit, message2) {
    const windowStart = currentWindowStart();
    const rows = await this.rows(
      `INSERT INTO rate_limit_counters (bucket, user_id, count, window_start)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (bucket, user_id, window_start) DO UPDATE
         SET count = rate_limit_counters.count + 1
         WHERE rate_limit_counters.count < $4
       RETURNING count`,
      [bucket, userId, windowStart, limit]
    );
    if (rows.length === 0) throw rateLimitError(message2);
  }
  async checkChatStart(userId) {
    await this.increment("chat", userId, CHAT_START_LIMIT_PER_MINUTE, CHAT_START_LIMIT_MESSAGE);
  }
  async checkModelDiscovery(userId) {
    await this.increment("discovery", userId, MODEL_DISCOVERY_LIMIT_PER_MINUTE, MODEL_DISCOVERY_LIMIT_MESSAGE);
  }
  async acquireStreamSlot(userId) {
    const now = Date.now();
    const slotId = randomUUID2();
    const results = await this.sql.transaction([
      // Serializa as aquisições concorrentes do mesmo usuário entre instâncias.
      this.sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]),
      // Slots expirados (stream morto sem release) não contam.
      this.sql.query("DELETE FROM rate_limit_streams WHERE user_id = $1 AND last_active <= $2", [userId, expiryThreshold(now)]),
      // Insere apenas se o usuário ainda não tem 2 slots ativos. O lock acima
      // torna count + insert atômicos entre todas as instâncias.
      this.sql.query(
        `INSERT INTO rate_limit_streams (id, user_id, started_at, last_active)
         SELECT $1, $2, $3, $3
          WHERE (SELECT COUNT(*) FROM rate_limit_streams WHERE user_id = $2) < $4
         RETURNING id`,
        [slotId, userId, now, MAX_ACTIVE_STREAMS]
      )
    ]);
    const inserted = results[2];
    if (inserted.length === 0) throw rateLimitError(STREAM_LIMIT_MESSAGE);
    return String(inserted[0].id);
  }
  async releaseStreamSlot(userId, slotId) {
    await this.rows(
      "DELETE FROM rate_limit_streams WHERE user_id = $1 AND id = $2",
      [userId, slotId]
    );
  }
  async touchStream(userId, slotId) {
    await this.rows("UPDATE rate_limit_streams SET last_active = $3 WHERE user_id = $1 AND id = $2", [userId, slotId, Date.now()]);
  }
};
var SqliteRateLimitStore = class {
  db;
  constructor(db) {
    this.db = db;
    this.db.exec(`
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (bucket, user_id, window_start)
);
CREATE TABLE IF NOT EXISTS rate_limit_streams (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_streams_user ON rate_limit_streams(user_id, started_at);
`);
  }
  increment(bucket, userId, limit, message2) {
    const windowStart = currentWindowStart();
    const row = this.db.prepare(
      `INSERT INTO rate_limit_counters (bucket, user_id, count, window_start)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket, user_id, window_start) DO UPDATE
           SET count = rate_limit_counters.count + 1
           WHERE rate_limit_counters.count < ?
         RETURNING count`
    ).get(bucket, userId, windowStart, limit);
    if (!row) throw rateLimitError(message2);
  }
  async checkChatStart(userId) {
    this.increment("chat", userId, CHAT_START_LIMIT_PER_MINUTE, CHAT_START_LIMIT_MESSAGE);
  }
  async checkModelDiscovery(userId) {
    this.increment("discovery", userId, MODEL_DISCOVERY_LIMIT_PER_MINUTE, MODEL_DISCOVERY_LIMIT_MESSAGE);
  }
  async acquireStreamSlot(userId) {
    const now = Date.now();
    const slotId = randomUUID2();
    this.db.exec("BEGIN IMMEDIATE");
    let exceeded = false;
    try {
      this.db.prepare("DELETE FROM rate_limit_streams WHERE user_id = ? AND last_active <= ?").run(userId, expiryThreshold(now));
      const row = this.db.prepare("SELECT COUNT(*) AS active FROM rate_limit_streams WHERE user_id = ?").get(userId);
      exceeded = Number(row?.active ?? 0) >= MAX_ACTIVE_STREAMS;
      if (!exceeded) {
        this.db.prepare(
          `INSERT INTO rate_limit_streams (id, user_id, started_at, last_active)
             VALUES (?, ?, ?, ?)`
        ).run(slotId, userId, now, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (exceeded) throw rateLimitError(STREAM_LIMIT_MESSAGE);
    return slotId;
  }
  async releaseStreamSlot(userId, slotId) {
    this.db.prepare("DELETE FROM rate_limit_streams WHERE user_id = ? AND id = ?").run(userId, slotId);
  }
  async touchStream(userId, slotId) {
    this.db.prepare("UPDATE rate_limit_streams SET last_active = ? WHERE user_id = ? AND id = ?").run(Date.now(), userId, slotId);
  }
};
function pickDefaultRateLimitStore(db) {
  const sqlite = db?.db;
  if (sqlite && typeof sqlite.prepare === "function") {
    return new SqliteRateLimitStore(sqlite);
  }
  if (process.env.DATABASE_URL) return new NeonRateLimitStore(process.env.DATABASE_URL);
  return new InMemoryRateLimitStore();
}

// src/server/index.ts
var ORPHAN_ATTACHMENT_MS = 24 * 60 * 60 * 1e3;
var MAX_SEARCH_ROUNDS = 3;
var MAX_DESCARTE_APOS_MARCADOR = 4e3;
var MIN_SCIENCE_ARTIFACT_CHARS = 1200;
var MAX_SCIENCE_PROSE_CHARS = 600;
try {
  process.loadEnvFile(process.env.ENV_FILE ?? ".env");
} catch {
}
function validationMessage(error) {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}
async function parseJson(c, schema) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("UNKNOWN", { status: 400, message: "O corpo da requisi\xE7\xE3o precisa ser um JSON v\xE1lido." });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("UNKNOWN", { status: 400, message: validationMessage(parsed.error) });
  }
  return parsed.data;
}
function jsonError(c, error) {
  const normalized = normalizeError(error);
  return c.json({ error: errorPayload(normalized) }, normalized.status);
}
function modelNotFound() {
  return new AppError("MODEL_NOT_FOUND", {
    status: 404,
    message: "O provedor ou modelo selecionado n\xE3o est\xE1 configurado no servidor."
  });
}
async function assertUserModelSelection(userId, providerId2, modelId, db) {
  const provider = await resolveProvider(userId, providerId2, db);
  const model = provider?.models.find((item) => item.id === modelId);
  if (!provider || !model) throw modelNotFound();
  assertSafeProviderUrl(provider.baseURL);
  return { provider, model };
}
function conversationContext(systemPrompt, messages, extras = [], attachmentsByMessage = /* @__PURE__ */ new Map(), spreadsheetSelection) {
  const context = [{ role: "system", content: composeSystemPrompt(systemPrompt, extras) }];
  for (const message2 of messages) {
    if (message2.role === "system") continue;
    if (message2.role === "assistant" && !message2.content.trim()) continue;
    const anexos = attachmentsByMessage.get(message2.id) ?? [];
    const documentos = anexos.filter((anexo) => anexo.kind === "document").map((anexo) => documentPromptBlock(anexo.filename, anexo.extractedText ?? "", anexo.truncated));
    const planilhas = anexos.filter((anexo) => anexo.kind === "spreadsheet" && anexo.extractedText).flatMap((anexo) => {
      let stored;
      try {
        stored = JSON.parse(anexo.extractedText);
      } catch {
        return [];
      }
      const parsed = SpreadsheetWorkbookSchema.safeParse(stored);
      if (!parsed.success) return [];
      return [spreadsheetPromptBlock(anexo.filename, parsed.data)];
    });
    const imagens = anexos.filter((anexo) => anexo.kind === "image" && anexo.dataBase64).map((anexo) => imageDataUrl(anexo.mime, anexo.dataBase64));
    context.push({
      role: message2.role,
      // Documento antes do texto: o pedido do usuário costuma se referir ao
      // anexo ("resume isto"), e o modelo lê melhor o material antes da ordem.
      content: documentos.length + planilhas.length > 0 ? `${[...documentos, ...planilhas].join("\n\n")}

${message2.content}` : message2.content,
      ...imagens.length > 0 ? { images: imagens } : {}
    });
  }
  if (spreadsheetSelection) {
    const attachment = [...attachmentsByMessage.values()].flat().find((item) => item.id === spreadsheetSelection.attachmentId);
    const newest = context.at(-1);
    if (attachment?.extractedText && newest?.role === "user") {
      let stored;
      try {
        stored = JSON.parse(attachment.extractedText);
      } catch {
        stored = null;
      }
      const parsed = SpreadsheetWorkbookSchema.safeParse(stored);
      if (parsed.success) {
        newest.content = `${spreadsheetPromptBlock(attachment.filename, parsed.data, spreadsheetSelection)}

${newest.content}`;
      }
    }
  }
  return context;
}
function requestContext(systemPrompt, messages, artifacts, contextWindow, extras = [], attachmentsByMessage = /* @__PURE__ */ new Map(), spreadsheetSelection) {
  const full = conversationContext(systemPrompt, messages, extras, attachmentsByMessage, spreadsheetSelection);
  const newest = full.at(-1)?.role === "user" ? full.at(-1) : null;
  const history = newest ? full.slice(0, -1) : full;
  const artifactState = buildArtifactContext(artifacts, contextWindow);
  const reserved = [newest, artifactState.message].filter((message2) => Boolean(message2));
  const reservedTokens = estimateContextTokens(reserved);
  const targetBudget = Math.max(1, Math.floor(contextWindow * 0.7) - reservedTokens);
  const effectiveWindow = Math.max(1, Math.ceil(targetBudget / 0.7));
  const trimmed = trimContext(history, effectiveWindow);
  return {
    messages: [
      ...trimmed.messages,
      ...artifactState.message ? [artifactState.message] : [],
      ...newest ? [newest] : []
    ],
    truncated: trimmed.truncated
  };
}
function writeEnvelope(stream, envelope) {
  return stream.writeSSE({ event: envelope.type, data: JSON.stringify(envelope) });
}
function routeErrorHandler(error, c) {
  return jsonError(c, error);
}
function toAttachment(record, spreadsheetVersion = 1) {
  let spreadsheet;
  if (record.kind === "spreadsheet" && record.extractedText) {
    try {
      const workbook = SpreadsheetWorkbookSchema.parse(JSON.parse(record.extractedText));
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
    textChars: record.kind === "document" ? record.extractedText?.length ?? 0 : null,
    truncated: record.truncated,
    ...spreadsheet ? { spreadsheet } : {},
    createdAt: record.createdAt
  };
}
function toProviderSettings(record) {
  const models = ProviderSettingsInputSchema.shape.models.safeParse(record.models);
  return {
    id: record.id,
    label: record.label,
    baseURL: record.baseURL,
    verifiedAt: record.verifiedAt,
    models: models.success ? models.data : [],
    // A chave nunca sai daqui; o navegador só sabe se existe.
    hasKey: Boolean(record.apiKeyCipher),
    updatedAt: record.updatedAt
  };
}
function clerkOrigin() {
  return process.env.CLERK_FRONTEND_API_ORIGIN ?? "https://*.clerk.accounts.dev";
}
function contentSecurityPolicy() {
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
    "frame-ancestors 'none'"
  ].join("; ");
}
function isProductionDeployment() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}
function resolveAppOrigin(rawOrigin = process.env.APP_ORIGIN, production = isProductionDeployment()) {
  const value = rawOrigin?.trim();
  if (!value) {
    if (!production) return void 0;
    throw new AppError("UNKNOWN", {
      status: 500,
      message: "Configure APP_ORIGIN com a origem HTTPS p\xFAblica do aplicativo em produ\xE7\xE3o."
    });
  }
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new AppError("UNKNOWN", {
      status: 500,
      message: "APP_ORIGIN precisa ser uma URL absoluta v\xE1lida."
    });
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new AppError("UNKNOWN", {
      status: 500,
      message: "APP_ORIGIN precisa usar http ou https."
    });
  }
  if (production && origin.protocol !== "https:") {
    throw new AppError("UNKNOWN", {
      status: 500,
      message: "APP_ORIGIN precisa usar HTTPS em produ\xE7\xE3o."
    });
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new AppError("UNKNOWN", {
      status: 500,
      message: "APP_ORIGIN deve conter somente a origem (esquema, host e porta opcional), sem caminho, credenciais, query ou fragmento."
    });
  }
  return origin.origin;
}
function createApp(options = {}) {
  if (!options.db && !process.env.DATABASE_URL) {
    throw new AppError("UNKNOWN", {
      status: 500,
      message: "Configure DATABASE_URL (Neon) nas vari\xE1veis de ambiente. O disco da fun\xE7\xE3o \xE9 somente leitura e n\xE3o persiste entre invoca\xE7\xF5es, ent\xE3o o SQLite n\xE3o funciona no deploy."
    });
  }
  const db = options.db ?? new NeonChatDatabase(process.env.DATABASE_URL);
  const rateLimit = options.rateLimit ?? pickDefaultRateLimitStore(db);
  const appOrigin = resolveAppOrigin();
  const authMiddleware = options.auth ?? createAuthMiddleware();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", contentSecurityPolicy());
    await next();
  });
  if (appOrigin) {
    app.use("/api/*", cors({
      origin: appOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400
    }));
  }
  app.get("/api/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
  app.use("/api/*", authMiddleware);
  app.use("/api/*", async (c, next) => {
    await db.ensureUser(c.get("userId"));
    await next();
  });
  app.get("/api/models", async (c) => {
    const userId = c.get("userId");
    return c.json(await resolveModelsCatalog(userId, db));
  });
  app.get("/api/providers", async (c) => {
    const userId = c.get("userId");
    return c.json({
      providers: (await db.listProviderSettings(userId)).map(toProviderSettings),
      secretStorage: getSecretStorageStatus()
    });
  });
  app.put("/api/providers/:id", async (c) => {
    try {
      const userId = c.get("userId");
      const id = c.req.param("id");
      const idCheck = ProviderIdSchema.safeParse(id);
      if (!idCheck.success) {
        throw new AppError("UNKNOWN", { status: 400, message: validationMessage(idCheck.error) });
      }
      const body = await parseJson(c, ProviderSettingsInputSchema);
      assertSafeProviderUrl(body.baseURL);
      let apiKeyCipher;
      if (body.apiKey === null) {
        apiKeyCipher = null;
      } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        const status = getSecretStorageStatus();
        if (!status.available) {
          throw new AppError("UNKNOWN", { status: 400, message: status.reason ?? "N\xE3o \xE9 poss\xEDvel guardar chaves." });
        }
        apiKeyCipher = encryptSecret(body.apiKey.trim(), { userId, providerId: id });
      }
      const record = await db.upsertProviderSettings(userId, {
        id,
        label: body.label,
        baseURL: body.baseURL,
        models: body.models,
        verifiedAt: body.verifiedAt ?? null,
        apiKeyCipher
      });
      return c.json({ provider: toProviderSettings(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.post("/api/providers/:id/discover-models", async (c) => {
    try {
      const userId = c.get("userId");
      const id = c.req.param("id");
      const idCheck = ProviderIdSchema.safeParse(id);
      if (!idCheck.success) {
        throw new AppError("UNKNOWN", { status: 400, message: validationMessage(idCheck.error) });
      }
      await rateLimit.checkModelDiscovery(userId);
      const resolved = await resolveProvider(userId, id, db);
      const record = resolved ? (await db.listProviderSettings(userId)).find((item) => item.id === id) : void 0;
      if (!resolved || !record) {
        throw new AppError("UNKNOWN", { status: 404, message: "Provedor n\xE3o encontrado." });
      }
      const descobertos = await discoverProviderModels(
        resolved.baseURL,
        resolved.apiKey ?? void 0,
        options.fetchImpl ?? fetch
      );
      const catalogoOpenCode = openCodeCatalogFor(resolved.baseURL);
      const models = catalogoOpenCode ? filterOpenCodeModels(catalogoOpenCode, descobertos) : descobertos;
      if (catalogoOpenCode && models.length === 0) {
        throw new AppError("UNKNOWN", { status: 400, message: OPENCODE_SEM_MODELOS });
      }
      const updated = await db.upsertProviderSettings(userId, {
        id,
        label: record.label,
        baseURL: record.baseURL,
        models,
        verifiedAt: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
        // apiKeyCipher indefinido preserva a chave atual do usuário.
      });
      return c.json({ provider: toProviderSettings(updated), discovered: models.length });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.delete("/api/providers/:id", async (c) => {
    const userId = c.get("userId");
    const deleted = await db.deleteProviderSettings(userId, c.req.param("id"));
    if (!deleted) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Provedor n\xE3o encontrado." }));
    return c.json({ ok: true });
  });
  app.get("/api/search-settings", async (c) => {
    const userId = c.get("userId");
    const record = await db.getSearchSettings(userId);
    return c.json({
      settings: record ? toSearchSettingsResponse(record) : null,
      secretStorage: getSecretStorageStatus()
    });
  });
  app.put("/api/search-settings", async (c) => {
    try {
      const userId = c.get("userId");
      const body = await parseJson(c, SearchSettingsInputSchema);
      if (BACKEND_REQUIRES_URL[body.backend]) {
        if (!body.baseURL) {
          throw new AppError("UNKNOWN", { status: 400, message: "Informe a URL da sua inst\xE2ncia SearXNG." });
        }
        assertSafeProviderUrl(body.baseURL);
      }
      let apiKeyCipher;
      if (body.apiKey === null) {
        apiKeyCipher = null;
      } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        const status = getSecretStorageStatus();
        if (!status.available) {
          throw new AppError("UNKNOWN", { status: 400, message: status.reason ?? "N\xE3o \xE9 poss\xEDvel guardar chaves." });
        }
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
        enabled: body.enabled
      });
      return c.json({ settings: toSearchSettingsResponse(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.delete("/api/search-settings", async (c) => {
    const userId = c.get("userId");
    const deleted = await db.deleteSearchSettings(userId);
    if (!deleted) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Nenhuma busca configurada." }));
    return c.json({ ok: true });
  });
  app.post("/api/search-settings/test", async (c) => {
    try {
      const userId = c.get("userId");
      await rateLimit.checkChatStart(userId);
      const resolved = await resolveSearch(userId, db);
      if (!resolved) {
        const settings = await db.getSearchSettings(userId);
        if (settings?.enabled && settings.backend === "openrouter") {
          throw new AppError("UNKNOWN", {
            status: 400,
            message: "A busca da OpenRouter roda junto da mensagem e n\xE3o tem como ser testada isolada. Ela funciona ao enviar com um modelo da OpenRouter selecionado."
          });
        }
        throw new AppError("UNKNOWN", {
          status: 400,
          message: "A busca n\xE3o est\xE1 configurada, est\xE1 desligada ou falta a chave/URL que este buscador exige."
        });
      }
      const outcome = await runSearch(resolved, "open weight chat", c.req.raw.signal, options.fetchImpl);
      if (outcome.failure) {
        throw new AppError("UNKNOWN", { status: 400, message: outcome.failure });
      }
      return c.json({ ok: true, results: outcome.results });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.post("/api/attachments", async (c) => {
    try {
      const userId = c.get("userId");
      await rateLimit.checkChatStart(userId);
      const body = await parseJson(c, AttachmentUploadSchema);
      const dados = decodeAttachment(body.data);
      const analise = await analyzeAttachment(dados, body.filename);
      const record = await db.createAttachment(userId, {
        kind: analise.kind,
        filename: body.filename,
        mime: analise.mime,
        sizeBytes: dados.length,
        // Planilha mantém o original para rastreabilidade e a representação
        // canônica separada no histórico editável.
        dataBase64: analise.kind === "image" || analise.kind === "spreadsheet" ? dados.toString("base64") : null,
        extractedText: analise.kind === "document" ? analise.text : analise.workbook ? JSON.stringify(analise.workbook) : null,
        truncated: analise.truncated
      });
      if (analise.kind === "spreadsheet" && analise.workbook) {
        const version2 = await db.insertSpreadsheetVersion(userId, record.id, JSON.stringify(analise.workbook));
        if (!version2) {
          await db.deleteAttachment(userId, record.id);
          throw new AppError("UNKNOWN", { status: 500, message: "N\xE3o consegui iniciar o hist\xF3rico da planilha." });
        }
      }
      void Promise.resolve(db.deleteOrphanAttachments(userId, ORPHAN_ATTACHMENT_MS)).catch(() => {
      });
      return c.json({ attachment: toAttachment(record) });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.get("/api/attachments/:id/spreadsheet", async (c) => {
    try {
      const userId = c.get("userId");
      const attachment = await db.getAttachment(userId, c.req.param("id"));
      const current = await db.getSpreadsheetVersion(userId, c.req.param("id"));
      const requestedRaw = c.req.query("version");
      const requested = requestedRaw === void 0 ? void 0 : Number(requestedRaw);
      if (requested !== void 0 && (!Number.isInteger(requested) || requested < 1)) {
        throw new AppError("UNKNOWN", { status: 400, message: "Vers\xE3o de planilha inv\xE1lida." });
      }
      const stored = requested === void 0 ? current : await db.getSpreadsheetVersion(userId, c.req.param("id"), requested);
      if (!attachment || attachment.kind !== "spreadsheet" || !stored || !current) {
        throw new AppError("UNKNOWN", { status: 404, message: "Planilha n\xE3o encontrada." });
      }
      const workbook = SpreadsheetWorkbookSchema.parse(JSON.parse(stored.workbookJson));
      return c.json({ attachment: toAttachment(attachment, current.version), workbook, version: stored.version, currentVersion: current.version });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.put("/api/attachments/:id/spreadsheet", async (c) => {
    try {
      const userId = c.get("userId");
      const body = await parseJson(c, SpreadsheetSaveSchema);
      recalculateWorkbook(body.workbook);
      const saved = await db.insertSpreadsheetVersion(userId, c.req.param("id"), JSON.stringify(body.workbook), body.baseVersion);
      if (!saved) {
        const exists = await db.getAttachment(userId, c.req.param("id"));
        throw new AppError("UNKNOWN", {
          status: exists ? 409 : 404,
          message: exists ? "A planilha mudou em outra aba. Reabra-a antes de salvar." : "Planilha n\xE3o encontrada."
        });
      }
      return c.json({ workbook: body.workbook, version: saved.version, createdAt: saved.createdAt });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.get("/api/attachments/:id/spreadsheet/export", async (c) => {
    try {
      const userId = c.get("userId");
      const attachment = await db.getAttachment(userId, c.req.param("id"));
      const requestedRaw = c.req.query("version");
      const requested = requestedRaw === void 0 ? void 0 : Number(requestedRaw);
      if (requested !== void 0 && (!Number.isInteger(requested) || requested < 1)) {
        throw new AppError("UNKNOWN", { status: 400, message: "Vers\xE3o de planilha inv\xE1lida." });
      }
      const stored = await db.getSpreadsheetVersion(userId, c.req.param("id"), requested);
      if (!attachment || attachment.kind !== "spreadsheet" || !stored) {
        throw new AppError("UNKNOWN", { status: 404, message: "Planilha n\xE3o encontrada." });
      }
      const workbook = SpreadsheetWorkbookSchema.parse(JSON.parse(stored.workbookJson));
      const format = c.req.query("format") === "csv" ? "csv" : "xlsx";
      const body = format === "csv" ? Buffer.from(workbookSheetToCsv(workbook, c.req.query("sheet")), "utf8") : await workbookToXlsx(workbook, attachment.mime.includes("spreadsheetml") && attachment.dataBase64 ? Buffer.from(attachment.dataBase64, "base64") : void 0);
      const base = attachment.filename.replace(/\.(xlsx|csv)$/iu, "").replace(/[^\p{L}\p{N}._-]+/gu, "-") || "planilha";
      const asciiBase = base.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^A-Za-z0-9._-]+/gu, "-") || "planilha";
      const downloadName = `${base}.${format}`;
      return new Response(Uint8Array.from(body).buffer, { headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${asciiBase}.${format}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store"
      } });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.get("/api/attachments/:id", async (c) => {
    const userId = c.get("userId");
    const record = await db.getAttachment(userId, c.req.param("id"));
    if (!record || record.kind !== "image" || !record.dataBase64) {
      return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Anexo n\xE3o encontrado." }));
    }
    return new Response(Buffer.from(record.dataBase64, "base64"), {
      headers: {
        "content-type": record.mime,
        // Imutável: o id é único por upload, então o conteúdo nunca muda.
        "cache-control": "private, max-age=31536000, immutable",
        // O arquivo veio de fora: nada de adivinhação de tipo pelo navegador.
        "x-content-type-options": "nosniff",
        "content-disposition": "inline"
      }
    });
  });
  app.delete("/api/attachments/:id", async (c) => {
    const userId = c.get("userId");
    const deleted = await db.deleteAttachment(userId, c.req.param("id"));
    if (!deleted) {
      return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Anexo n\xE3o encontrado ou j\xE1 enviado." }));
    }
    return c.json({ ok: true });
  });
  app.get("/api/analytics/costs", async (c) => {
    const userId = c.get("userId");
    const rawDays = Number(c.req.query("days") ?? 30);
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.trunc(rawDays))) : 30;
    return c.json(await db.getCostAnalytics(userId, days));
  });
  app.get("/api/conversations/search", async (c) => {
    const userId = c.get("userId");
    const query = c.req.query("q")?.trim() ?? "";
    if (!query) return c.json({ results: [] });
    if (query.length > 200) return jsonError(c, new AppError("UNKNOWN", { status: 400, message: "A busca pode ter no m\xE1ximo 200 caracteres." }));
    try {
      return c.json({ results: await db.searchConversations(userId, query) });
    } catch {
      return jsonError(c, new AppError("UNKNOWN", { status: 400, message: "A express\xE3o de busca n\xE3o \xE9 v\xE1lida." }));
    }
  });
  app.get("/api/conversations", async (c) => {
    const userId = c.get("userId");
    const includeArchived = c.req.query("includeArchived") === "true";
    return c.json({ conversations: await db.listConversations(userId, { includeArchived }) });
  });
  app.post("/api/conversations", async (c) => {
    try {
      const userId = c.get("userId");
      const body = await parseJson(c, CreateConversationSchema);
      let providerId2;
      let modelId;
      if (body.providerId) {
        providerId2 = body.providerId;
        const resolved = await resolveProvider(userId, providerId2, db);
        modelId = body.modelId ?? resolved?.models[0]?.id ?? "";
        if (!resolved || !resolved.models.some((model) => model.id === modelId)) throw modelNotFound();
      } else {
        const defaults = await resolveDefaultModelSelection(userId, db);
        providerId2 = defaults.providerId;
        modelId = body.modelId ?? defaults.modelId;
        if (body.modelId) {
          const resolved = await resolveProvider(userId, providerId2, db);
          if (!resolved?.models.some((model) => model.id === modelId)) throw modelNotFound();
        }
      }
      const conversation = await db.createConversation(userId, {
        title: body.title,
        providerId: providerId2,
        modelId,
        systemPrompt: body.systemPrompt,
        effort: body.effort
      });
      return c.json({ conversation }, 201);
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.get("/api/conversations/:id", async (c) => {
    const userId = c.get("userId");
    const conversation = await db.getConversation(userId, c.req.param("id"));
    if (!conversation) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." }));
    return c.json({ conversation });
  });
  app.patch("/api/conversations/:id", async (c) => {
    try {
      const userId = c.get("userId");
      const id = c.req.param("id");
      const body = await parseJson(c, UpdateConversationSchema);
      const current = await db.getConversation(userId, id);
      if (!current) throw new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." });
      const providerId2 = body.providerId ?? current.providerId;
      const modelId = body.modelId ?? current.modelId;
      await assertUserModelSelection(userId, providerId2, modelId, db);
      const conversation = await db.updateConversation(userId, id, { ...body, providerId: providerId2, modelId });
      if (!conversation) throw new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." });
      return c.json({ conversation });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.delete("/api/conversations/:id", async (c) => {
    const userId = c.get("userId");
    const deleted = await db.deleteConversation(userId, c.req.param("id"));
    if (!deleted) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." }));
    return c.json({ ok: true });
  });
  app.get("/api/conversations/:id/messages", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." }));
    const [messages, anexos] = await Promise.all([
      db.getMessages(userId, id),
      db.listAttachmentsForConversation(userId, id)
    ]);
    const versoesPlanilha = /* @__PURE__ */ new Map();
    await Promise.all(anexos.map(async (anexo) => {
      if (anexo.kind !== "spreadsheet") return;
      const current = await db.getSpreadsheetVersion(userId, anexo.id);
      if (!current) return;
      anexo.extractedText = current.workbookJson;
      versoesPlanilha.set(anexo.id, current.version);
    }));
    const porMensagem = /* @__PURE__ */ new Map();
    for (const anexo of anexos) {
      if (!anexo.messageId) continue;
      const lista = porMensagem.get(anexo.messageId) ?? [];
      lista.push(toAttachment(anexo, versoesPlanilha.get(anexo.id) ?? 1));
      porMensagem.set(anexo.messageId, lista);
    }
    return c.json({
      messages: messages.map((message2) => {
        const lista = porMensagem.get(message2.id);
        return lista ? { ...message2, attachments: lista } : message2;
      })
    });
  });
  app.get("/api/conversations/:id/artifacts", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." }));
    return c.json({ artifacts: await db.getArtifacts(userId, id) });
  });
  app.put("/api/conversations/:id/artifacts/:slug", async (c) => {
    try {
      const userId = c.get("userId");
      const id = c.req.param("id");
      if (!await db.getConversation(userId, id)) {
        throw new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." });
      }
      const slug = c.req.param("slug");
      const atual = (await db.getArtifacts(userId, id)).find((item) => item.slug === slug);
      if (!atual) throw new AppError("UNKNOWN", { status: 404, message: "Artefato n\xE3o encontrado." });
      const body = await parseJson(c, ArtifactEditSchema);
      const version2 = await db.insertArtifactVersion(userId, {
        conversationId: id,
        slug,
        kind: atual.kind,
        language: atual.language,
        title: atual.title,
        content: body.content,
        operation: "rewrite",
        // Sem mensagem e sem custo: ninguém gastou token para escrever isto, e
        // custo ausente é exibido como indisponível, nunca como zero.
        messageId: null,
        outputTokens: null,
        costUsd: null,
        version: atual.currentVersion + 1
      });
      return c.json({ version: version2 });
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  app.get("/api/conversations/:id/artifacts/:slug/versions/:version", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." }));
    const version2 = Number(c.req.param("version"));
    if (!Number.isSafeInteger(version2) || version2 < 1) {
      return jsonError(c, new AppError("UNKNOWN", { status: 400, message: "A vers\xE3o do artefato \xE9 inv\xE1lida." }));
    }
    const artifactVersion = await db.getArtifactVersion(userId, id, c.req.param("slug"), version2);
    if (!artifactVersion) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Vers\xE3o do artefato n\xE3o encontrada." }));
    return c.json({ version: artifactVersion });
  });
  app.post("/api/chat", async (c) => {
    try {
      const userId = c.get("userId");
      const request = await parseJson(c, ChatRequestSchema);
      await rateLimit.checkChatStart(userId);
      const selection = await assertUserModelSelection(userId, request.providerId, request.modelId, db);
      let conversation = request.conversationId ? await db.getConversation(userId, request.conversationId) : null;
      if (request.conversationId && !conversation) {
        throw new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." });
      }
      if (!conversation) {
        conversation = await db.createConversation(userId, {
          providerId: selection.provider.id,
          modelId: selection.model.id,
          effort: request.effort
        });
      } else if (conversation.providerId !== selection.provider.id || conversation.modelId !== selection.model.id || request.effort !== void 0 && request.effort !== conversation.effort) {
        conversation = await db.updateConversation(userId, conversation.id, {
          providerId: selection.provider.id,
          modelId: selection.model.id,
          effort: request.effort
        });
        if (!conversation) throw new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." });
      }
      const mensagemDoUsuario = await db.insertMessage(userId, {
        conversationId: conversation.id,
        role: "user",
        content: request.content,
        providerId: selection.provider.id,
        modelId: selection.model.id
      });
      const idsPedidos = request.attachmentIds ?? [];
      if (idsPedidos.length > 0) {
        const encontrados = await db.getAttachments(userId, idsPedidos);
        const novos = encontrados.filter((anexo) => anexo.messageId === null);
        await db.attachToMessage(
          userId,
          novos.map((anexo) => anexo.id),
          conversation.id,
          mensagemDoUsuario.id
        );
      }
      const anexosDaConversa = await db.listAttachmentsForConversation(userId, conversation.id);
      await Promise.all(anexosDaConversa.map(async (anexo) => {
        if (anexo.kind !== "spreadsheet") return;
        const selectedVersion = request.spreadsheetSelection?.attachmentId === anexo.id ? request.spreadsheetSelection.version : void 0;
        const current = await db.getSpreadsheetVersion(userId, anexo.id, selectedVersion);
        if (selectedVersion !== void 0 && !current) {
          throw new AppError("UNKNOWN", { status: 404, message: "A vers\xE3o selecionada da planilha n\xE3o existe." });
        }
        if (current) anexo.extractedText = current.workbookJson;
      }));
      if (request.spreadsheetSelection && !anexosDaConversa.some((anexo) => anexo.id === request.spreadsheetSelection?.attachmentId)) {
        throw new AppError("UNKNOWN", { status: 404, message: "A planilha selecionada n\xE3o pertence a esta conversa." });
      }
      const anexosPorMensagem = /* @__PURE__ */ new Map();
      for (const anexo of anexosDaConversa) {
        if (!anexo.messageId) continue;
        const lista = anexosPorMensagem.get(anexo.messageId) ?? [];
        lista.push(anexo);
        anexosPorMensagem.set(anexo.messageId, lista);
      }
      const nivelScience = request.scienceLevel ?? conversation.scienceLevel ?? "off";
      const formatoScience = request.scienceFormat ?? conversation.scienceFormat ?? "markdown";
      const cadeia = scienceChain(nivelScience);
      if (request.scienceLevel !== void 0 || request.scienceFormat !== void 0) {
        const atualizada = await db.updateConversation(userId, conversation.id, {
          scienceLevel: nivelScience,
          scienceFormat: formatoScience
        });
        if (atualizada) conversation = atualizada;
      }
      const busca = await resolveSearch(userId, db, selection.provider.baseURL);
      const buscaExterna = busca?.kind === "external" ? busca : null;
      const context = requestContext(
        conversation.systemPrompt,
        await db.getMessages(userId, conversation.id),
        await db.getArtifacts(userId, conversation.id),
        selection.model.ctx,
        buscaExterna ? [searchSystemPrompt(MAX_SEARCH_ROUNDS)] : [],
        anexosPorMensagem,
        request.spreadsheetSelection
      );
      let promptText = context.messages.map((message2) => `${message2.role}: ${message2.content}`).join("\n");
      const assistant = await db.insertMessage(userId, {
        conversationId: conversation.id,
        role: "assistant",
        content: "",
        reasoning: "",
        providerId: selection.provider.id,
        modelId: selection.model.id
      });
      const requestSignal = c.req.raw.signal;
      const upstreamController = new AbortController();
      let clientAborted = requestSignal.aborted;
      const abortFromClient = () => {
        clientAborted = true;
        if (!upstreamController.signal.aborted) upstreamController.abort(requestSignal.reason);
      };
      requestSignal.addEventListener("abort", abortFromClient, { once: true });
      if (requestSignal.aborted) abortFromClient();
      const startedAt = Date.now();
      let content = "";
      let reasoning = "";
      const usoPorRound = [];
      let rawUsage = null;
      let finishReason = null;
      let lastPersistedAt = 0;
      let lastPersistedLength = 0;
      const parser = createArtifactParser();
      const artifactBuffers = /* @__PURE__ */ new Map();
      const openSpreadsheets = /* @__PURE__ */ new Map();
      const generatedSpreadsheetBodies = [];
      const generatedSpreadsheetNames = [];
      const openArtifacts = /* @__PURE__ */ new Map();
      const producedVersions = [];
      const completedArtifactEnds = [];
      let parserEnded = false;
      let streamSlotId = null;
      const persistPartial = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastPersistedAt < 2e3 && content.length - lastPersistedLength < 4e3) return;
        await Promise.all([
          db.updateMessage(userId, assistant.id, { content, reasoning }),
          streamSlotId ? rateLimit.touchStream(userId, streamSlotId) : Promise.resolve()
        ]);
        lastPersistedAt = now;
        lastPersistedLength = content.length;
      };
      const emit = async (stream, envelope) => {
        if (!stream.aborted) await writeEnvelope(stream, envelope);
      };
      const trace = async (stream, scope, event, detail) => {
        await emit(stream, {
          type: "trace",
          scope,
          event,
          detail: detail?.slice(0, 300),
          at: Math.max(0, Date.now() - startedAt),
          conversationId: conversation.id,
          messageId: assistant.id
        });
      };
      const consumeParserEvents = async (events, stream) => {
        for (const parserEvent of events) {
          if (parserEvent.kind === "text") {
            content += parserEvent.text;
            await emit(stream, {
              type: "text",
              text: parserEvent.text,
              conversationId: conversation.id,
              messageId: assistant.id
            });
            continue;
          }
          if (parserEvent.kind === "artifact_open") {
            if (parserEvent.type === "spreadsheet") {
              openSpreadsheets.set(parserEvent.slug, { title: parserEvent.title });
              artifactBuffers.set(parserEvent.slug, "");
              continue;
            }
            const existing = (await db.getArtifacts(userId, conversation.id)).find((artifact2) => artifact2.slug === parserEvent.slug);
            const artifact = await db.upsertArtifact(userId, {
              conversationId: conversation.id,
              slug: parserEvent.slug,
              kind: parserEvent.type,
              language: parserEvent.language,
              title: parserEvent.title
            });
            const version3 = artifact.currentVersion + 1;
            openArtifacts.set(parserEvent.slug, {
              version: version3,
              operation: existing ? "rewrite" : "create",
              kind: parserEvent.type,
              language: parserEvent.language,
              title: parserEvent.title
            });
            artifactBuffers.set(parserEvent.slug, "");
            content += `

${artifactMarker(parserEvent.slug, version3)}

`;
            await emit(stream, {
              type: "artifact_start",
              slug: parserEvent.slug,
              kind: parserEvent.type,
              language: parserEvent.language,
              title: parserEvent.title,
              version: version3,
              operation: existing ? "rewrite" : "create",
              conversationId: conversation.id,
              messageId: assistant.id
            });
            continue;
          }
          if (parserEvent.kind === "artifact_body") {
            const current2 = artifactBuffers.get(parserEvent.slug);
            if (current2 === void 0) continue;
            artifactBuffers.set(parserEvent.slug, current2 + parserEvent.text);
            if (openSpreadsheets.has(parserEvent.slug)) continue;
            await emit(stream, {
              type: "artifact_delta",
              slug: parserEvent.slug,
              text: parserEvent.text,
              conversationId: conversation.id,
              messageId: assistant.id
            });
            continue;
          }
          if (parserEvent.kind === "artifact_close") {
            const spreadsheet = openSpreadsheets.get(parserEvent.slug);
            if (spreadsheet) {
              const body2 = artifactBuffers.get(parserEvent.slug) ?? "";
              generatedSpreadsheetBodies.push(body2);
              openSpreadsheets.delete(parserEvent.slug);
              artifactBuffers.delete(parserEvent.slug);
              if (parserEvent.truncated) {
                const warning = `

N\xE3o consegui concluir a planilha \u201C${spreadsheet.title}\u201D porque a resposta foi interrompida.

`;
                content += warning;
                await emit(stream, { type: "text", text: warning, conversationId: conversation.id, messageId: assistant.id });
                continue;
              }
              try {
                const generated = generatedSpreadsheetFromArtifact(body2, spreadsheet.title);
                const bytes = await workbookToXlsx(generated.workbook);
                const record = await db.createAttachment(userId, {
                  kind: "spreadsheet",
                  filename: generated.filename,
                  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  sizeBytes: bytes.length,
                  dataBase64: bytes.toString("base64"),
                  extractedText: JSON.stringify(generated.workbook),
                  truncated: false
                });
                try {
                  const version3 = await db.insertSpreadsheetVersion(userId, record.id, JSON.stringify(generated.workbook));
                  if (!version3) throw new AppError("UNKNOWN", { status: 500, message: "N\xE3o consegui iniciar o hist\xF3rico da planilha gerada." });
                  await db.attachToMessage(userId, [record.id], conversation.id, assistant.id);
                  const attachment = toAttachment(record, version3.version);
                  if (attachment.kind !== "spreadsheet" || !attachment.spreadsheet) {
                    throw new AppError("UNKNOWN", { status: 500, message: "A planilha gerada n\xE3o p\xF4de ser preparada para exibi\xE7\xE3o." });
                  }
                  generatedSpreadsheetNames.push(generated.filename);
                  await emit(stream, {
                    type: "spreadsheet_ready",
                    attachment: { ...attachment, kind: "spreadsheet", textChars: null, spreadsheet: attachment.spreadsheet },
                    conversationId: conversation.id,
                    messageId: assistant.id
                  });
                } catch (cause) {
                  await db.deleteAttachment(userId, record.id);
                  throw cause;
                }
              } catch (cause) {
                const failure = normalizeError(cause);
                const warning = `

N\xE3o consegui criar a planilha \u201C${spreadsheet.title}\u201D: ${failure.message}

`;
                content += warning;
                await emit(stream, { type: "text", text: warning, conversationId: conversation.id, messageId: assistant.id });
              }
              continue;
            }
            const open = openArtifacts.get(parserEvent.slug);
            const body = artifactBuffers.get(parserEvent.slug) ?? "";
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
                version: open.version
              });
              producedVersions.push({
                slug: parserEvent.slug,
                version: open.version,
                content: body,
                completionText: body,
                costBasisTokens: Math.max(1, estimateTokens(body))
              });
              completedArtifactEnds.push({ slug: parserEvent.slug, version: open.version, truncated: parserEvent.truncated });
            }
            openArtifacts.delete(parserEvent.slug);
            artifactBuffers.delete(parserEvent.slug);
            continue;
          }
          const current = (await db.getArtifacts(userId, conversation.id)).find((artifact) => artifact.slug === parserEvent.slug);
          const currentVersion2 = current?.versions.find((version3) => version3.version === current.currentVersion);
          if (!current || !currentVersion2) {
            await emit(stream, {
              type: "error",
              error: errorPayload(new AppError("UNKNOWN", { status: 400, message: `N\xE3o encontrei o artefato \u201C${parserEvent.slug}\u201D para revisar.` })),
              conversationId: conversation.id,
              messageId: assistant.id
            });
            continue;
          }
          const patched = applyEdits(currentVersion2.content, parserEvent.edits);
          if (!patched.ok) {
            const reason = patched.reason === "not_found" ? "n\xE3o foi encontrado" : "n\xE3o \xE9 \xFAnico";
            await emit(stream, {
              type: "error",
              error: errorPayload(new AppError("UNKNOWN", { status: 400, message: `O trecho para revis\xE3o ${reason} no artefato \u201C${parserEvent.slug}\u201D.` })),
              conversationId: conversation.id,
              messageId: assistant.id
            });
            continue;
          }
          const version2 = current.currentVersion + 1;
          const patchText = parserEvent.edits.map((edit) => `${edit.find}
${edit.replace}`).join("\n");
          await db.insertArtifactVersion(userId, {
            conversationId: conversation.id,
            slug: parserEvent.slug,
            kind: current.kind,
            language: current.language,
            title: current.title,
            content: patched.content,
            operation: "update",
            messageId: assistant.id,
            version: version2
          });
          producedVersions.push({
            slug: parserEvent.slug,
            version: version2,
            content: patched.content,
            completionText: patchText,
            costBasisTokens: Math.max(1, estimateTokens(patchText))
          });
          content += `

${artifactMarker(parserEvent.slug, version2)}

`;
          await emit(stream, {
            type: "artifact_start",
            slug: parserEvent.slug,
            kind: current.kind,
            language: current.language,
            title: current.title,
            version: version2,
            operation: "update",
            conversationId: conversation.id,
            messageId: assistant.id
          });
          completedArtifactEnds.push({ slug: parserEvent.slug, version: version2, truncated: false });
        }
      };
      const finishParser = async (stream) => {
        if (parserEnded) return;
        parserEnded = true;
        await consumeParserEvents(parser.end(), stream);
      };
      const completionText = () => `${content}${[...artifactBuffers.values()].join("")}${generatedSpreadsheetBodies.join("")}${producedVersions.map((item) => item.completionText).join("")}`;
      const ensureGeneratedSpreadsheetText = async (stream) => {
        if (content.trim() || generatedSpreadsheetNames.length === 0) return;
        const names = generatedSpreadsheetNames.map((name) => `\u201C${name}\u201D`).join(", ");
        const text3 = `Criei a planilha ${names}. Ela j\xE1 est\xE1 aberta para edi\xE7\xE3o e tamb\xE9m pode ser baixada em XLSX.`;
        content = text3;
        await emit(stream, { type: "text", text: text3, conversationId: conversation.id, messageId: assistant.id });
      };
      const attributeArtifactCost = async (completionTokens, totalCost) => {
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
            totalCost === null ? null : Number((totalCost * share).toFixed(8))
          );
        }));
      };
      const emitArtifactEnds = async (stream) => {
        for (const completed of completedArtifactEnds) {
          const version2 = await db.getArtifactVersion(userId, conversation.id, completed.slug, completed.version);
          await emit(stream, {
            type: "artifact_end",
            slug: completed.slug,
            version: completed.version,
            truncated: completed.truncated,
            outputTokens: version2?.outputTokens ?? null,
            costUsd: version2?.costUsd ?? null,
            conversationId: conversation.id,
            messageId: assistant.id
          });
        }
        completedArtifactEnds.length = 0;
      };
      streamSlotId = await rateLimit.acquireStreamSlot(userId);
      let streamSlotReleased = false;
      const releaseStreamSlot = async () => {
        if (streamSlotReleased) return;
        streamSlotReleased = true;
        try {
          if (streamSlotId) await rateLimit.releaseStreamSlot(userId, streamSlotId);
        } catch {
        }
      };
      let response;
      try {
        response = streamSSE(
          c,
          async (stream) => {
            stream.onAbort(() => {
              clientAborted = true;
              if (!upstreamController.signal.aborted) upstreamController.abort(new DOMException("Cliente desconectou.", "AbortError"));
            });
            try {
              await trace(
                stream,
                "chat",
                "turno iniciado",
                `${selection.provider.id}/${selection.model.id} \xB7 esfor\xE7o ${conversation.effort} \xB7 science ${nivelScience}${cadeia ? ` (${cadeia.stages.length} agentes, ${formatoScience})` : ""} \xB7 busca ${busca ? "ligada" : "desligada"} \xB7 contexto ${context.messages.length} mensagens${context.truncated ? " (aparado)" : ""}`
              );
              let materialScience = null;
              const falhasDeEstagio = [];
              if (cadeia) {
                const intermediarios = cadeia.stages.slice(0, -1);
                let texto2 = "";
                for (const [posicao, estagio] of intermediarios.entries()) {
                  await emit(stream, {
                    type: "science_stage",
                    role: estagio.role,
                    label: estagio.label,
                    index: posicao + 1,
                    total: cadeia.stages.length,
                    status: "start",
                    conversationId: conversation.id,
                    messageId: assistant.id
                  });
                  const tetoDeEntrada = Math.max(2e3, Math.floor(selection.model.ctx * 0.5));
                  const textoOrcado = estimateTokens(texto2) > tetoDeEntrada ? `${texto2.slice(0, tetoDeEntrada * 4)}

[\u2026texto cortado por tamanho; continue a partir daqui\u2026]` : texto2;
                  const entrada = [
                    { role: "system", content: estagio.systemPrompt(formatoScience) },
                    ...context.messages.filter((m) => m.role !== "system"),
                    ...textoOrcado ? [{ role: "user", content: handoffMessage(estagio.role, textoOrcado) }] : []
                  ];
                  let produzido = "";
                  let usoDoEstagio = null;
                  let ultimoSinalDeVida = Date.now();
                  let caracteresDeRaciocinio = 0;
                  const comecouEm = Date.now();
                  await trace(
                    stream,
                    "science",
                    `agente ${posicao + 1}/${cadeia.stages.length} iniciado`,
                    `${estagio.role} \xB7 entrada ${estimateTokens(entrada.map((m) => m.content).join("\n"))} tokens estimados`
                  );
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
                      onTrace: (evento2, detalhe) => {
                        void trace(stream, "provedor", `agente ${posicao + 1}: ${evento2}`, detalhe);
                      }
                    })) {
                      if (evento.kind === "text") {
                        produzido += evento.text;
                        await emit(stream, {
                          type: "science_delta",
                          role: estagio.role,
                          index: posicao + 1,
                          text: evento.text,
                          conversationId: conversation.id,
                          messageId: assistant.id
                        });
                        if (Date.now() - ultimoSinalDeVida > 3e4) {
                          ultimoSinalDeVida = Date.now();
                          if (streamSlotId) await rateLimit.touchStream(userId, streamSlotId);
                        }
                      } else if (evento.kind === "reasoning") {
                        caracteresDeRaciocinio += evento.reasoning.length;
                        await emit(stream, {
                          type: "science_delta",
                          role: estagio.role,
                          index: posicao + 1,
                          text: evento.reasoning,
                          reasoning: true,
                          conversationId: conversation.id,
                          messageId: assistant.id
                        });
                      } else if (evento.kind === "usage") usoDoEstagio = evento.usage;
                    }
                  } catch (falha) {
                    if (clientAborted || upstreamController.signal.aborted) throw falha;
                    const motivo = normalizeError(falha);
                    falhasDeEstagio.push(`${estagio.label}: ${motivo.message}`);
                    await trace(
                      stream,
                      "science",
                      `agente ${posicao + 1}/${cadeia.stages.length} FALHOU`,
                      `${motivo.code} \xB7 ${motivo.message}`
                    );
                    if (!texto2.trim() && !produzido.trim()) throw falha;
                  }
                  usoPorRound.push(usoDoEstagio);
                  promptText += `
${estagio.role}: ${entrada.map((m) => m.content).join("\n")}`;
                  const aproveitou = produzido.trim().length > 0;
                  texto2 = produzido.trim() || texto2;
                  await trace(
                    stream,
                    "science",
                    `agente ${posicao + 1}/${cadeia.stages.length} conclu\xEDdo`,
                    `${((Date.now() - comecouEm) / 1e3).toFixed(1)}s \xB7 ${produzido.length} caracteres${caracteresDeRaciocinio > 0 ? ` \xB7 ${caracteresDeRaciocinio} de racioc\xEDnio` : ""}${usoDoEstagio ? "" : " \xB7 provedor n\xE3o informou uso"}${aproveitou ? "" : " \xB7 SEM TEXTO, mantido o do est\xE1gio anterior"}`
                  );
                  await emit(stream, {
                    type: "science_stage",
                    role: estagio.role,
                    label: estagio.label,
                    index: posicao + 1,
                    total: cadeia.stages.length,
                    status: "done",
                    conversationId: conversation.id,
                    messageId: assistant.id
                  });
                }
                materialScience = texto2 || null;
                const revisor = cadeia.stages[cadeia.stages.length - 1];
                await emit(stream, {
                  type: "science_stage",
                  role: revisor.role,
                  label: revisor.label,
                  index: cadeia.stages.length,
                  total: cadeia.stages.length,
                  status: "start",
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
              }
              const mensagens = cadeia ? [
                // O revisor recebe o prompt DELE no lugar do prompt padrão:
                // as regras de artefato continuam (vêm do extras), mas quem
                // manda no turno é o papel de revisão.
                { role: "system", content: cadeia.stages[cadeia.stages.length - 1].systemPrompt(formatoScience) },
                ...context.messages.filter((m) => m.role !== "system"),
                ...materialScience ? [{
                  role: "user",
                  content: handoffMessage("revisao", estimateTokens(materialScience) > Math.floor(selection.model.ctx * 0.5) ? materialScience.slice(0, Math.floor(selection.model.ctx * 0.5) * 4) : materialScience)
                }] : []
              ] : [...context.messages];
              const citacoes = /* @__PURE__ */ new Map();
              for (let round = 1; round <= MAX_SEARCH_ROUNDS + 1; round += 1) {
                await trace(stream, "chat", `round ${round} iniciado`, `${mensagens.length} mensagens no contexto`);
                const scanner = buscaExterna ? createSearchScanner() : createPassthroughScanner();
                let consultaPedida = null;
                let textoDoRound = "";
                let usoDoRound = null;
                let descartadoAposMarcador = 0;
                const consumirScanner = async (eventos) => {
                  for (const evento of eventos) {
                    if (evento.kind === "search") {
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
                  // Busca nativa: a OpenRouter busca, injeta e responde na
                  // mesma requisição. Não há round nem marcador a tratar.
                  webSearchResults: busca?.kind === "provider" ? busca.maxResults : void 0,
                  signal: upstreamController.signal,
                  fetchImpl: options.fetchImpl,
                  onTrace: (evento, detalhe) => {
                    void trace(stream, "provedor", evento, detalhe);
                  }
                })) {
                  if (event.kind === "text") {
                    if (consultaPedida === null) {
                      await consumirScanner(scanner.push(event.text));
                      await persistPartial();
                      continue;
                    }
                    descartadoAposMarcador += event.text.length;
                    if (descartadoAposMarcador > MAX_DESCARTE_APOS_MARCADOR) break;
                  } else if (event.kind === "reasoning") {
                    reasoning += event.reasoning;
                    if (!stream.aborted) {
                      await writeEnvelope(stream, {
                        type: "reasoning",
                        reasoning: event.reasoning,
                        conversationId: conversation.id,
                        messageId: assistant.id
                      });
                    }
                    await persistPartial();
                  } else if (event.kind === "citations") {
                    for (const citacao of event.citations) citacoes.set(citacao.url, citacao);
                  } else if (event.kind === "usage") {
                    usoDoRound = event.usage;
                    rawUsage = event.usage;
                  } else if (event.kind === "finish") {
                    finishReason = event.finishReason;
                  }
                }
                if (citacoes.size > 0) {
                  await emit(stream, {
                    type: "search_end",
                    query: "busca na web (OpenRouter)",
                    round,
                    results: [...citacoes.values()],
                    failure: null,
                    conversationId: conversation.id,
                    messageId: assistant.id
                  });
                  citacoes.clear();
                }
                usoPorRound.push(usoDoRound);
                if (consultaPedida === null) {
                  await consumirScanner(scanner.end());
                  break;
                }
                if (!buscaExterna || round > MAX_SEARCH_ROUNDS) {
                  const aviso = `

_Limite de ${MAX_SEARCH_ROUNDS} buscas por resposta atingido._

`;
                  await consumeParserEvents(parser.push(aviso), stream);
                  break;
                }
                await emit(stream, {
                  type: "search_start",
                  query: consultaPedida,
                  round,
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
                const resultado = await runSearch(buscaExterna, consultaPedida, upstreamController.signal, options.fetchImpl);
                await emit(stream, {
                  type: "search_end",
                  query: consultaPedida,
                  round,
                  results: resultado.results,
                  failure: resultado.failure,
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
                const turnoDoModelo = `${textoDoRound}<search>${consultaPedida}</search>`;
                const devolutiva = formatResultsForModel(consultaPedida, resultado);
                mensagens.push({ role: "assistant", content: turnoDoModelo });
                mensagens.push({ role: "user", content: devolutiva });
                promptText += `
assistant: ${turnoDoModelo}
user: ${devolutiva}`;
              }
              await finishParser(stream);
              await ensureGeneratedSpreadsheetText(stream);
              await trace(
                stream,
                "chat",
                "resposta conclu\xEDda",
                `${content.length} caracteres \xB7 ${producedVersions.length} artefato(s) \xB7 ${usoPorRound.length} chamada(s) ao provedor`
              );
              if (cadeia && producedVersions.length === 0 && content.trim().length >= MIN_SCIENCE_ARTIFACT_CHARS) {
                const documento = content.trim();
                const kind = formatoScience === "latex" ? "code" : "markdown";
                const language = formatoScience === "latex" ? "latex" : null;
                const primeiraLinha = documento.split("\n").find((linha) => linha.trim()) ?? "";
                const title = primeiraLinha.replace(/^#{1,6}\s+/u, "").replace(/^\\(?:title|section|chapter)\s*\{([^{}]*)\}.*$/u, "$1").trim().slice(0, 110) || "Documento";
                const slug = "documento";
                const existente = (await db.getArtifacts(userId, conversation.id)).find((item) => item.slug === slug);
                const artefato = await db.upsertArtifact(userId, {
                  conversationId: conversation.id,
                  slug,
                  kind,
                  language,
                  title
                });
                const versao = artefato.currentVersion + 1;
                await db.insertArtifactVersion(userId, {
                  conversationId: conversation.id,
                  slug,
                  kind,
                  language,
                  title,
                  content: documento,
                  operation: existente ? "rewrite" : "create",
                  messageId: assistant.id,
                  version: versao
                });
                producedVersions.push({
                  slug,
                  version: versao,
                  content: documento,
                  completionText: documento,
                  costBasisTokens: Math.max(1, estimateTokens(documento))
                });
                completedArtifactEnds.push({ slug, version: versao, truncated: false });
                await emit(stream, {
                  type: "artifact_start",
                  slug,
                  kind,
                  language,
                  title,
                  version: versao,
                  operation: existente ? "rewrite" : "create",
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
                content = `${title}

${artifactMarker(slug, versao)}`;
                await trace(
                  stream,
                  "artefato",
                  "documento guardado pelo servidor",
                  `${kind}${language ? `/${language}` : ""} \xB7 v${versao} \xB7 ${documento.length} caracteres`
                );
              }
              if (cadeia && producedVersions.length > 0) {
                const marcadores = producedVersions.map((item) => artifactMarker(item.slug, item.version));
                let prosa = content;
                for (const marcador of marcadores) prosa = prosa.split(marcador).join("");
                if (prosa.trim().length > MAX_SCIENCE_PROSE_CHARS) {
                  const apresentacao = prosa.trim().split(/(?<=[.!?])\s+/u).slice(0, 2).join(" ").slice(0, 320);
                  content = `${apresentacao}

${marcadores.join("\n\n")}`;
                  await trace(
                    stream,
                    "artefato",
                    "prosa duplicada removida da mensagem",
                    `${prosa.trim().length} caracteres fora do artefato`
                  );
                }
              }
              if (falhasDeEstagio.length > 0) {
                const aviso = `

---

_Aviso: ${falhasDeEstagio.length === 1 ? "um est\xE1gio n\xE3o concluiu" : `${falhasDeEstagio.length} est\xE1gios n\xE3o conclu\xEDram`} \u2014 ${falhasDeEstagio.join("; ")}. O documento foi montado com o que os demais produziram._`;
                await consumeParserEvents(parser.push(aviso), stream);
                await finishParser(stream);
              }
              const calculated = calculateUsageAndCost(selection.model, {
                // Soma dos rounds. `rawUsage` (o último visto) só entra quando
                // a soma não é possível — é o caso do caminho de erro, em que
                // o round corrente pode ter sido interrompido antes de o uso
                // ser registrado na lista.
                raw: sumProviderUsage(usoPorRound) ?? rawUsage,
                reportsCostUsd: isOpenRouterBaseUrl(selection.provider.baseURL),
                promptText,
                completionText: completionText(),
                reasoningText: reasoning
              });
              await attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
              await emitArtifactEnds(stream);
              finishReason = finishReason ?? "stop";
              await db.updateMessage(userId, assistant.id, {
                content,
                reasoning,
                usage: calculated.usage,
                cost: calculated.cost,
                finishReason,
                latencyMs: Date.now() - startedAt
              });
              if (!stream.aborted) {
                await writeEnvelope(stream, {
                  type: "usage",
                  usage: calculated.usage,
                  cost: calculated.cost,
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
                await writeEnvelope(stream, {
                  type: "done",
                  done: true,
                  finishReason,
                  truncated: context.truncated,
                  usage: calculated.usage,
                  cost: calculated.cost,
                  conversationId: conversation.id,
                  messageId: assistant.id
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
                reportsCostUsd: isOpenRouterBaseUrl(selection.provider.baseURL),
                promptText,
                completionText: completionText(),
                reasoningText: reasoning
              });
              await attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
              await emitArtifactEnds(stream);
              const terminalReason = aborted ? "aborted" : "error";
              await trace(
                stream,
                "chat",
                aborted ? "ABORTADO" : "ERRO",
                aborted ? `cliente ${clientAborted ? "desconectou" : "ainda ligado"} \xB7 sinal ${requestSignal.aborted ? "abortado" : "ativo"} \xB7 stream ${stream.aborted ? "fechado" : "aberto"}` : `${normalized.code} \xB7 ${normalized.message}`
              );
              await db.updateMessage(userId, assistant.id, {
                content,
                reasoning,
                usage: calculated.usage,
                cost: calculated.cost,
                finishReason: terminalReason,
                errorCode: aborted ? null : normalized.code,
                latencyMs: Date.now() - startedAt
              });
              if (!aborted && !stream.aborted) {
                await writeEnvelope(stream, {
                  type: "error",
                  error: errorPayload(normalized),
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
                await writeEnvelope(stream, {
                  type: "done",
                  done: true,
                  finishReason: terminalReason,
                  truncated: context.truncated,
                  usage: calculated.usage,
                  cost: calculated.cost,
                  conversationId: conversation.id,
                  messageId: assistant.id
                });
              }
            } finally {
              await persistPartial(true);
              await releaseStreamSlot();
              requestSignal.removeEventListener("abort", abortFromClient);
              if (!upstreamController.signal.aborted && (clientAborted || stream.aborted)) upstreamController.abort();
            }
          },
          async (error, stream) => {
            const normalized = normalizeError(error);
            if (!stream.aborted) {
              await writeEnvelope(stream, {
                type: "error",
                error: errorPayload(normalized),
                conversationId: conversation.id,
                messageId: assistant.id
              });
            }
          }
        );
      } catch (error) {
        await releaseStreamSlot();
        throw error;
      }
      return response;
    } catch (error) {
      return routeErrorHandler(error, c);
    }
  });
  const staticRoot = options.staticRoot ?? "dist";
  const staticIndex = join3(staticRoot, "index.html");
  if (existsSync(staticIndex)) {
    app.use("/*", serveStatic({ root: staticRoot }));
    app.get("/*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: { code: "UNKNOWN", message: "Rota n\xE3o encontrada.", retryable: false } }, 404);
      }
      return serveStatic({ root: staticRoot, path: "index.html" })(c, next);
    });
  }
  app.notFound((c) => c.req.path.startsWith("/api/") ? c.json({ error: { code: "UNKNOWN", message: "Rota n\xE3o encontrada.", retryable: false } }, 404) : c.text("Not found", 404));
  app.onError((error, c) => routeErrorHandler(error, c));
  return app;
}
var cachedApp = null;
function getApp() {
  cachedApp ??= createApp();
  return cachedApp;
}

// src/server/vercel-handler.ts
var maxDuration = 300;
var config = {
  api: {
    bodyParser: false
  }
};
function handler(request, response) {
  try {
    restoreRewrittenApiPath(request);
    const incoming = requestWithRestoredBody(request);
    return handle(getApp())(incoming, response).catch((error) => writeStartupError(response, error));
  } catch (error) {
    return writeStartupError(response, error);
  }
}
var BODYLESS_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);
function requestWithRestoredBody(request) {
  const parsed = request.body;
  if (parsed === void 0 || parsed === null) return request;
  if (BODYLESS_METHODS.has((request.method ?? "GET").toUpperCase())) return request;
  const raw = Buffer.isBuffer(parsed) ? parsed : typeof parsed === "string" ? Buffer.from(parsed, "utf8") : Buffer.from(JSON.stringify(parsed), "utf8");
  const restored = Readable.from(raw.byteLength > 0 ? [raw] : []);
  const headers = { ...request.headers, "content-length": String(raw.byteLength) };
  delete headers["transfer-encoding"];
  restored.headers = headers;
  restored.rawHeaders = request.rawHeaders;
  restored.method = request.method;
  restored.url = request.url;
  restored.httpVersion = request.httpVersion;
  restored.httpVersionMajor = request.httpVersionMajor;
  restored.httpVersionMinor = request.httpVersionMinor;
  restored.socket = request.socket;
  return restored;
}
function restoreRewrittenApiPath(request) {
  if (!request.url) return;
  const url = new URL(request.url, "http://vercel.internal");
  if (url.pathname !== "/api/entry" || !url.searchParams.has("__route")) return;
  const route = url.searchParams.get("__route") ?? "";
  url.searchParams.delete("__route");
  const segments = route.split("/").filter((segment) => segment && segment !== "." && segment !== "..").map((segment) => encodeURIComponent(segment));
  const query = url.searchParams.toString();
  request.url = `/api/${segments.join("/")}${query ? `?${query}` : ""}`;
}
function writeStartupError(response, error) {
  if (response.writableEnded) return Promise.resolve();
  const normalized = normalizeError(error);
  if (!response.headersSent) {
    response.statusCode = normalized.status;
    response.setHeader("content-type", "application/json; charset=utf-8");
  }
  response.end(JSON.stringify({ error: errorPayload(normalized) }));
  return Promise.resolve();
}
export {
  config,
  handler as default,
  maxDuration,
  requestWithRestoredBody,
  restoreRewrittenApiPath
};
