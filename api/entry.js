// src/server/vercel-handler.ts
import { handle } from "@hono/node-server/vercel";

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
var ArtifactKindSchema = z.enum(["markdown", "code", "svg", "mermaid"]);
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
  pricingAvailable: z.boolean()
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
var SseEnvelopeSchema = z.discriminatedUnion("type", [
  SseTextSchema,
  SseReasoningSchema,
  SseUsageSchema,
  SseErrorSchema,
  SseDoneSchema,
  SseArtifactStartSchema,
  SseArtifactDeltaSchema,
  SseArtifactEndSchema
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
var ChatRequestSchema = z.object({
  conversationId: z.string().min(1).nullable().optional(),
  content: z.string().trim().min(1, "A mensagem n\xE3o pode ficar vazia.").max(2e5),
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2).optional()
});
var CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(1e5).nullable().optional()
});
var UpdateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(1e5).nullable().optional(),
  archived: z.boolean().optional()
});
var MessageSchema = z.object({
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
  id: z.string().min(1),
  title: z.string().nullable(),
  providerId: ProviderIdSchema,
  modelId: z.string(),
  systemPrompt: z.string().nullable(),
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
function estimateTokens(text2) {
  if (!text2) return 0;
  return Math.max(1, Math.ceil(text2.length / 4));
}
function estimateMessageTokens(message2) {
  return estimateTokens(message2.content) + 4;
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
var KINDS = /* @__PURE__ */ new Set(["markdown", "code", "svg", "mermaid"]);
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
function unescapeArtifactClose(text2) {
  return text2.replaceAll("<\\/artifact>", "</artifact>");
}
function createArtifactParser() {
  let state = "prose";
  let buffer = "";
  let metadata = null;
  let patchSlug = null;
  let patchSource = "";
  const emitText = (events, text2) => {
    if (text2) events.push({ kind: "text", text: text2 });
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
Voc\xEA pode produzir artefatos de conte\xFAdo n\xEDvel 1 usando tags XML delimitadas. Use apenas os tipos markdown, code, svg e mermaid; nunca produza html ou react como artefato.

Para criar ou reescrever um artefato, use exatamente:
<artifact id="slug" type="code" language="typescript" title="T\xEDtulo curto">
conte\xFAdo \xEDntegro
</artifact>

O id deve ser est\xE1vel, min\xFAsculo e usar apenas letras, n\xFAmeros e h\xEDfens. type="code" exige language. O conte\xFAdo \xE9 opaco: cercas de markdown e qualquer texto interno n\xE3o devem ser interpretados. Para escrever a sequ\xEAncia literal </artifact> dentro do conte\xFAdo, use <\\/artifact>.

Para revisar um artefato existente sem reescrev\xEA-lo, use:
<artifact-update id="slug">
<find>trecho exato e \xFAnico</find>
<replace>novo trecho</replace>
</artifact-update>

Use um par find/replace para cada edi\xE7\xE3o e preserve a ordem. Se o estado recebido trouxer omitted="true", pe\xE7a o conte\xFAdo completo antes de tentar revis\xE1-lo. Tags malformadas devem ser evitadas. Explique brevemente o que foi criado ou alterado fora das tags.
`.trim();
function composeSystemPrompt(userPrompt) {
  const custom = userPrompt?.trim();
  return custom ? `${ARTIFACT_SYSTEM_PROMPT}

Instru\xE7\xF5es adicionais da conversa:
${custom}` : ARTIFACT_SYSTEM_PROMPT;
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
function calculateCost(model, usage2) {
  const { pricing } = model;
  const pricingAvailable = pricing.inputPerMillion !== null && pricing.outputPerMillion !== null;
  if (!pricingAvailable) {
    return { usd: null, estimated: true, pricingAvailable: false };
  }
  const promptTokens = Math.max(0, usage2.promptTokens);
  const cachedTokens = Math.min(Math.max(0, usage2.cachedTokens), promptTokens);
  const regularInputTokens = promptTokens - cachedTokens;
  const cachedPrice = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const usd = (regularInputTokens * pricing.inputPerMillion + cachedTokens * cachedPrice + Math.max(0, usage2.completionTokens) * pricing.outputPerMillion) / 1e6;
  return {
    usd: Number(usd.toFixed(8)),
    estimated: usage2.estimated,
    pricingAvailable: true
  };
}
function calculateUsageAndCost(model, input) {
  const usage2 = normalizeUsage(input);
  return { usage: usage2, cost: calculateCost(model, usage2) };
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
  const text2 = bodyText(body);
  if (status === 402 || /insufficient|balance|credit|quota|billing|saldo|cr[eé]dito/.test(text2)) {
    return "INSUFFICIENT_BALANCE";
  }
  if (status === 401 || status === 403 || /invalid.*(api)?[_ -]?key|unauthorized|authentication/.test(text2)) {
    return "INVALID_API_KEY";
  }
  if (status === 404 || /model.*(not found|不存在|unknown)|model_not_found/.test(text2)) {
    return "MODEL_NOT_FOUND";
  }
  if (status === 400 || status === 422 || /context.{0,20}(length|window)|too many tokens|maximum context/.test(text2)) {
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

// src/server/llm-client.ts
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
    const text2 = await response.text();
    return text2.slice(0, maxLength);
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
function requestBody(options) {
  const body = {
    model: options.modelId,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (options.temperature !== void 0) body.temperature = options.temperature;
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
            body: requestBody(options),
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
        const upstreamError = new UpstreamHttpError(response.status, body);
        const retryable = response.status === 429 || response.status >= 500;
        if (!emittedToken && retryable && attempt < maxAttempts) {
          const retryAfter = parseRetryAfter(response);
          const backoff = retryAfter ?? Math.min(2e3, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
          await sleepWithAbort(backoff, options.signal);
          continue;
        }
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
var text = (value) => typeof value === "string" ? value : String(value ?? "");
var nullableText = (value) => value == null ? null : String(value);
var number = (value, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
var nullableNumber = (value) => value == null ? null : number(value);
var bool = (value) => value === true || value === 1 || value === "1" || value === "true";
function providerId(value) {
  const parsed = ProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function usage(row) {
  if ([row.prompt_tokens, row.cached_tokens, row.completion_tokens, row.reasoning_tokens, row.total_tokens].every((value) => value == null)) return null;
  const promptTokens = number(row.prompt_tokens);
  const completionTokens = number(row.completion_tokens);
  return {
    promptTokens,
    cachedTokens: Math.min(number(row.cached_tokens), promptTokens),
    completionTokens,
    reasoningTokens: Math.min(number(row.reasoning_tokens), completionTokens || number(row.reasoning_tokens)),
    totalTokens: number(row.total_tokens, promptTokens + completionTokens),
    estimated: bool(row.cost_estimated)
  };
}
function cost(row, value) {
  if (row.cost_usd == null && !value) return null;
  return { usd: nullableNumber(row.cost_usd), estimated: bool(row.cost_estimated), pricingAvailable: row.cost_usd != null };
}
function message(row) {
  const role = MessageRoleSchema.safeParse(row.role);
  const error = ErrorCodeSchema.safeParse(row.error_code);
  const rowUsage = usage(row);
  return {
    id: text(row.id),
    conversationId: text(row.conversation_id),
    role: role.success ? role.data : "assistant",
    content: text(row.content),
    reasoning: nullableText(row.reasoning),
    providerId: providerId(row.provider_id),
    modelId: nullableText(row.model_id),
    usage: rowUsage,
    cost: cost(row, rowUsage),
    finishReason: nullableText(row.finish_reason),
    errorCode: error.success ? error.data : null,
    createdAt: number(row.created_at),
    latencyMs: nullableNumber(row.latency_ms)
  };
}
function version(row) {
  return {
    version: Math.max(1, number(row.version)),
    content: text(row.content),
    operation: row.operation === "update" || row.operation === "rewrite" ? row.operation : "create",
    messageId: nullableText(row.message_id),
    outputTokens: nullableNumber(row.output_tokens),
    costUsd: nullableNumber(row.cost_usd),
    truncated: bool(row.truncated),
    createdAt: number(row.created_at)
  };
}
function conversationBase(row) {
  const id = ProviderIdSchema.parse(row.provider_id);
  return {
    id: text(row.id),
    title: nullableText(row.title),
    providerId: id,
    modelId: text(row.model_id),
    systemPrompt: nullableText(row.system_prompt),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
    archived: bool(row.archived)
  };
}
function summary(row) {
  return { ...conversationBase(row), messageCount: number(row.message_count), totalCostUsd: Math.max(0, number(row.total_cost_usd)) };
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
      `INSERT INTO conversations (id,user_id,title,provider_id,model_id,system_prompt,created_at,updated_at,archived)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,false) RETURNING *`,
      [id, userId, data.title ?? "Nova conversa", data.providerId, data.modelId, data.systemPrompt ?? null, now]
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
      `UPDATE conversations SET title=$3,provider_id=$4,model_id=$5,system_prompt=$6,archived=$7,updated_at=$8
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [
        id,
        userId,
        data.title === void 0 ? current.title : data.title,
        data.providerId ?? current.providerId,
        data.modelId ?? current.modelId,
        data.systemPrompt === void 0 ? current.systemPrompt : data.systemPrompt,
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
      id: text(row.id),
      conversationId: text(row.conversation_id),
      slug: text(row.slug),
      kind,
      language: nullableText(row.language),
      title: text(row.title),
      currentVersion: number(row.current_version),
      createdAt: number(row.created_at),
      updatedAt: number(row.updated_at),
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
        id: text(row.id),
        conversationId: text(row.conversation_id),
        slug: text(row.slug),
        kind: parsed.data,
        language: nullableText(row.language),
        title: text(row.title),
        currentVersion: Math.max(1, number(row.current_version)),
        createdAt: number(row.created_at),
        updatedAt: number(row.updated_at),
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
  async listProviderSettings(userId) {
    return (await this.rows("SELECT * FROM provider_settings WHERE user_id=$1 ORDER BY label ASC,id ASC", [userId])).map((row) => ({
      id: text(row.id),
      label: text(row.label),
      baseURL: text(row.base_url),
      models: Array.isArray(row.models_json) ? row.models_json : [],
      verifiedAt: nullableText(row.verified_at),
      apiKeyCipher: nullableText(row.api_key_cipher),
      createdAt: number(row.created_at),
      updatedAt: number(row.updated_at)
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
      id: text(row.id),
      label: text(row.label),
      baseURL: text(row.base_url),
      models: Array.isArray(row.models_json) ? row.models_json : [],
      verifiedAt: nullableText(row.verified_at),
      apiKeyCipher: nullableText(row.api_key_cipher),
      createdAt: number(row.created_at),
      updatedAt: number(row.updated_at)
    };
  }
  async deleteProviderSettings(userId, id) {
    return (await this.rows("DELETE FROM provider_settings WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId])).length > 0;
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
      totalCostUsd: daily.reduce((sum, row) => sum + number(row.cost_usd), 0),
      daily: daily.map((row) => ({ day: text(row.day), costUsd: number(row.cost_usd), messageCount: number(row.message_count) })),
      byModel: byModel.flatMap((row) => {
        const id = providerId(row.provider_id);
        return id ? [{ providerId: id, modelId: text(row.model_id), costUsd: number(row.cost_usd), messageCount: number(row.message_count) }] : [];
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
  let text2;
  try {
    text2 = readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
  try {
    return JSON.parse(text2);
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
  const reasoning = typeof value.reasoning === "boolean" ? value.reasoning : typeof value.supports_reasoning === "boolean" ? value.supports_reasoning : /reason|think|r1(?:$|[-.])|o[134](?:$|[-.])/iu.test(`${id} ${label}`);
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
    const text2 = await response.text();
    let payload = void 0;
    if (text2.trim()) {
      try {
        payload = JSON.parse(text2);
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
  ready;
  constructor(connectionString, sql = neon2(connectionString)) {
    this.sql = sql;
    this.ready = this.migrate();
  }
  async migrate() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS rate_limit_counters (
        bucket text NOT NULL,
        user_id text NOT NULL,
        count integer NOT NULL,
        window_start bigint NOT NULL,
        PRIMARY KEY (bucket, user_id, window_start)
      )`,
      `CREATE TABLE IF NOT EXISTS rate_limit_streams (
        id text NOT NULL,
        user_id text NOT NULL,
        started_at bigint NOT NULL,
        last_active bigint NOT NULL,
        PRIMARY KEY (id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rate_limit_streams_user ON rate_limit_streams(user_id, started_at)`
    ];
    await this.sql.transaction(statements.map((statement) => this.sql.query(statement)));
  }
  async rows(query, params = []) {
    await this.ready;
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
    await this.ready;
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
function conversationContext(systemPrompt, messages) {
  const context = [{ role: "system", content: composeSystemPrompt(systemPrompt) }];
  for (const message2 of messages) {
    if (message2.role === "system") continue;
    if (message2.role === "assistant" && !message2.content.trim()) continue;
    context.push({ role: message2.role, content: message2.content });
  }
  return context;
}
function requestContext(systemPrompt, messages, artifacts, contextWindow) {
  const full = conversationContext(systemPrompt, messages);
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
      const models = await discoverProviderModels(
        resolved.baseURL,
        resolved.apiKey ?? void 0,
        options.fetchImpl ?? fetch
      );
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
        systemPrompt: body.systemPrompt
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
    return c.json({ messages: await db.getMessages(userId, id) });
  });
  app.get("/api/conversations/:id/artifacts", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!await db.getConversation(userId, id)) return jsonError(c, new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." }));
    return c.json({ artifacts: await db.getArtifacts(userId, id) });
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
        conversation = await db.createConversation(userId, { providerId: selection.provider.id, modelId: selection.model.id });
      } else if (conversation.providerId !== selection.provider.id || conversation.modelId !== selection.model.id) {
        conversation = await db.updateConversation(userId, conversation.id, {
          providerId: selection.provider.id,
          modelId: selection.model.id
        });
        if (!conversation) throw new AppError("UNKNOWN", { status: 404, message: "Conversa n\xE3o encontrada." });
      }
      await db.insertMessage(userId, {
        conversationId: conversation.id,
        role: "user",
        content: request.content,
        providerId: selection.provider.id,
        modelId: selection.model.id
      });
      const context = requestContext(
        conversation.systemPrompt,
        await db.getMessages(userId, conversation.id),
        await db.getArtifacts(userId, conversation.id),
        selection.model.ctx
      );
      const promptText = context.messages.map((message2) => `${message2.role}: ${message2.content}`).join("\n");
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
      let rawUsage = null;
      let finishReason = null;
      let lastPersistedAt = 0;
      let lastPersistedLength = 0;
      const parser = createArtifactParser();
      const artifactBuffers = /* @__PURE__ */ new Map();
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
      const completionText = () => `${content}${[...artifactBuffers.values()].join("")}${producedVersions.map((item) => item.completionText).join("")}`;
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
                fetchImpl: options.fetchImpl
              })) {
                if (event.kind === "text") {
                  await consumeParserEvents(parser.push(event.text), stream);
                  await persistPartial();
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
                } else if (event.kind === "usage") {
                  rawUsage = event.usage;
                } else if (event.kind === "finish") {
                  finishReason = event.finishReason;
                }
              }
              await finishParser(stream);
              const calculated = calculateUsageAndCost(selection.model, {
                raw: rawUsage,
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
              const calculated = calculateUsageAndCost(selection.model, {
                raw: rawUsage,
                promptText,
                completionText: completionText(),
                reasoningText: reasoning
              });
              await attributeArtifactCost(calculated.usage.completionTokens, calculated.cost.usd);
              await emitArtifactEnds(stream);
              const terminalReason = aborted ? "aborted" : "error";
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
    return handle(getApp())(request, response).catch((error) => writeStartupError(response, error));
  } catch (error) {
    return writeStartupError(response, error);
  }
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
  restoreRewrittenApiPath
};
