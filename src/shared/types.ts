import { z } from 'zod';

export const BUILTIN_PROVIDER_IDS = ['deepseek', 'glm', 'kimi', 'openrouter', 'ollama'] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

/**
 * Provedores personalizados são declarados em tempo de execução, então o id é
 * validado por formato e não por lista fechada. Conversas antigas continuam
 * válidas mesmo que o provedor que as criou saia da configuração.
 */
export const ProviderIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/u,
    'O id do provedor deve ter de 1 a 32 caracteres: minúsculas, dígitos e hífen.',
  );
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ErrorCodeSchema = z.enum([
  'RATE_LIMIT',
  'INSUFFICIENT_BALANCE',
  'CONTEXT_LENGTH_EXCEEDED',
  'INVALID_API_KEY',
  'MODEL_NOT_FOUND',
  'UPSTREAM_TIMEOUT',
  'UNAUTHORIZED',
  'UNKNOWN',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Nível de raciocínio pedido ao modelo.
 *
 * `auto` é o padrão e significa "não envie parâmetro nenhum": o provedor
 * decide, que é exatamente o comportamento anterior a esta funcionalidade.
 * Isso importa porque cada provedor nomeia o parâmetro de um jeito e um
 * campo desconhecido pode virar 400 — quem não escolhe, não arrisca.
 *
 * `off` pede para suprimir o raciocínio; onde o provedor não sabe desligar,
 * o mapeamento cai no menor esforço possível (ver `src/server/effort.ts`).
 *
 * `xhigh` e `max` são degraus acima de `high` que a OpenRouter declara em
 * `supported_efforts` — 60 e 41 modelos do catálogo dela, respectivamente. Não
 * existem na convenção da OpenAI (`minimal|low|medium|high`), e por isso o
 * mapeamento os fecha em `high` nos outros dialetos, em vez de deixar o 400
 * derrubar tudo para o padrão do provedor.
 */
export const EffortLevelSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/**
 * `mindmap` guarda um roteiro indentado (lista aninhada), não um formato de
 * diagrama. O modelo já escreve lista aninhada muito bem, o formato sobrevive
 * ao streaming pela metade e continua legível na aba Fonte — três coisas que
 * uma sintaxe de diagrama própria não daria.
 */
export const ArtifactKindSchema = z.enum(['markdown', 'code', 'svg', 'mermaid', 'mindmap', 'chart']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const ArtifactVersionSchema = z.object({
  version: z.number().int().positive(),
  content: z.string(),
  operation: z.enum(['create', 'rewrite', 'update']),
  messageId: z.string().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  truncated: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  slug: ArtifactSlugSchema,
  kind: ArtifactKindSchema,
  language: z.string().max(32).nullable(),
  title: z.string().min(1).max(120),
  currentVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  versions: z.array(ArtifactVersionSchema),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const CostSchema = z.object({
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
  reported: z.boolean().default(false),
});
export type Cost = z.infer<typeof CostSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

const SseBaseSchema = z.object({
  conversationId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
});

export const SseTextSchema = SseBaseSchema.extend({
  type: z.literal('text'),
  text: z.string(),
});

export const SseReasoningSchema = SseBaseSchema.extend({
  type: z.literal('reasoning'),
  reasoning: z.string(),
});

export const SseUsageSchema = SseBaseSchema.extend({
  type: z.literal('usage'),
  usage: UsageSchema,
  cost: CostSchema,
});

export const SseErrorSchema = SseBaseSchema.extend({
  type: z.literal('error'),
  error: ApiErrorSchema,
});

export const SseDoneSchema = SseBaseSchema.extend({
  type: z.literal('done'),
  done: z.literal(true),
  finishReason: z.string().optional(),
  truncated: z.boolean().optional(),
  usage: UsageSchema.optional(),
  cost: CostSchema.optional(),
});

export const SseArtifactStartSchema = SseBaseSchema.extend({
  type: z.literal('artifact_start'),
  slug: ArtifactSlugSchema,
  kind: ArtifactKindSchema,
  language: z.string().max(32).nullable(),
  title: z.string().min(1).max(120),
  version: z.number().int().positive(),
  operation: z.enum(['create', 'rewrite', 'update']),
});

export const SseArtifactDeltaSchema = SseBaseSchema.extend({
  type: z.literal('artifact_delta'),
  slug: ArtifactSlugSchema,
  text: z.string(),
});

export const SseArtifactEndSchema = SseBaseSchema.extend({
  type: z.literal('artifact_end'),
  slug: ArtifactSlugSchema,
  version: z.number().int().positive(),
  truncated: z.boolean(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});

/** Um XLSX criado pelo modelo e já persistido como anexo da resposta. */
export const SseSpreadsheetReadySchema = SseBaseSchema.extend({
  type: z.literal('spreadsheet_ready'),
  attachment: z.object({
    id: z.string().min(1),
    kind: z.literal('spreadsheet'),
    filename: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    textChars: z.null(),
    truncated: z.boolean(),
    spreadsheet: z.object({
      sheetNames: z.array(z.string()),
      version: z.number().int().positive(),
    }),
    createdAt: z.number(),
  }),
});

/**
 * Busca na web.
 *
 * `searxng` é o único que aceita URL do usuário, e por isso é o único que
 * exige `baseURL`: os outros dois têm endpoint fixo do fornecedor. Toda
 * chamada passa por ssrf.ts de qualquer forma — endpoint informado por
 * usuário é entrada hostil, e continua sendo mesmo depois de salvo.
 */
/**
 * `openrouter` não é um buscador como os outros três.
 *
 * Brave, Tavily e SearXNG são APIs que ESTE servidor chama, com chave própria,
 * pelo protocolo de marcador (`<search>`). `openrouter` é um plugin no próprio
 * pedido de chat: ela busca, injeta e responde numa requisição só, sem chave
 * de buscador — mas só existe para modelos servidos por ela. A diferença é
 * estrutural e aparece em `ResolvedSearch.kind`.
 */
export const SearchBackendSchema = z.enum(['brave', 'tavily', 'searxng', 'openrouter']);
export type SearchBackend = z.infer<typeof SearchBackendSchema>;

export const SearchResultSchema = z.object({
  title: z.string().min(1).max(300),
  url: z.string().url().max(2048),
  snippet: z.string().max(1200),
  /** Data de publicação quando o backend informa; nunca inventada. */
  publishedAt: z.string().max(40).nullable().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchSettingsInputSchema = z.object({
  backend: SearchBackendSchema,
  /** Obrigatória só no searxng; ignorada nos demais. */
  baseURL: z.string().url().max(2048).optional(),
  /** undefined mantém a chave atual; null apaga; string grava a nova. */
  apiKey: z.string().max(400).nullable().optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
});
export type SearchSettingsInput = z.infer<typeof SearchSettingsInputSchema>;

/** O que volta ao navegador: nunca a chave, só se ela existe. */
export const SearchSettingsSchema = z.object({
  backend: SearchBackendSchema,
  baseURL: z.string().max(2048).nullable(),
  hasKey: z.boolean(),
  maxResults: z.number().int().min(1).max(10),
  enabled: z.boolean(),
  updatedAt: z.number(),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

export const SearchSettingsResponseSchema = z.object({
  settings: SearchSettingsSchema.nullable(),
  /** Mesma disciplina do campo de chave dos provedores (ver secrets.ts). */
  secretStorage: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});

/** O modelo pediu uma busca; a consulta é dele, exibida como ele escreveu. */
export const SseSearchStartSchema = SseBaseSchema.extend({
  type: z.literal('search_start'),
  query: z.string().min(1).max(400),
  round: z.number().int().positive(),
});

export const SseSearchEndSchema = SseBaseSchema.extend({
  type: z.literal('search_end'),
  query: z.string().min(1).max(400),
  round: z.number().int().positive(),
  results: z.array(SearchResultSchema),
  /** Preenchido quando a busca falhou: o modelo segue, o usuário fica sabendo. */
  failure: z.string().max(300).nullable().optional(),
});

export const ScienceLevelSchema = z.enum(['off', 'basic', 'intermediate', 'advanced']);
export type ScienceLevel = z.infer<typeof ScienceLevelSchema>;

/** Formato do documento produzido. Perguntado uma vez por conversa. */
export const ScienceFormatSchema = z.enum(['markdown', 'latex']);
export type ScienceFormat = z.infer<typeof ScienceFormatSchema>;

/** Papel de um agente na cadeia. */
export const ScienceRoleSchema = z.enum(['pesquisa', 'aprofundamento', 'sintese', 'ilustracao', 'revisao']);
export type ScienceRole = z.infer<typeof ScienceRoleSchema>;

/** Progresso da cadeia, para a interface mostrar em que passo está. */
export const SseScienceStageSchema = SseBaseSchema.extend({
  type: z.literal('science_stage'),
  role: ScienceRoleSchema,
  label: z.string().min(1).max(120),
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  status: z.enum(['start', 'done']),
});

/**
 * Texto que um agente intermediário está escrevendo agora.
 *
 * Existe por duas razões, e a segunda é a que importa mais:
 *
 * 1. O usuário vê o trabalho acontecendo em vez de uma barra parada.
 * 2. **Mantém a conexão viva.** Um estágio de redação longa leva minutos, e
 *    até aqui o SSE ficava esse tempo todo sem enviar um byte — proxy,
 *    navegador e plataforma derrubam conexão ociosa, e a tela ficava
 *    "1/2" para sempre sem que nada estivesse travado de fato.
 *
 * O texto NÃO vira a resposta: quem escreve na tela é só o revisor.
 */
export const SseScienceDeltaSchema = SseBaseSchema.extend({
  type: z.literal('science_delta'),
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
  reasoning: z.boolean().optional(),
});

/**
 * Registro de diagnóstico do turno.
 *
 * Eventos, nunca conteúdo: qual agente começou, quanto tempo levou, quantos
 * caracteres produziu, que tentativa falhou e por quê. O texto que o modelo
 * escreve NÃO entra aqui — o log serve para explicar o comportamento, e
 * despejar o documento dentro dele o tornaria ilegível justamente quando
 * fosse preciso ler.
 */
export const SseTraceSchema = SseBaseSchema.extend({
  type: z.literal('trace'),
  /** De onde veio: `chat`, `science`, `busca`, `provedor`, `artefato`. */
  scope: z.string().min(1).max(24),
  event: z.string().min(1).max(80),
  /** Números e rótulos curtos. Sem texto do modelo. */
  detail: z.string().max(300).optional(),
  /** Milissegundos desde o início do turno. */
  at: z.number().int().nonnegative(),
});

export const SseEnvelopeSchema = z.discriminatedUnion('type', [
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
  SseSpreadsheetReadySchema,
]);
export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;

export const ModelPricingSchema = z.object({
  inputPerMillion: z.number().nonnegative().nullable(),
  cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
  outputPerMillion: z.number().nonnegative().nullable(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ModelCatalogItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  reasoning: z.boolean(),
  pricing: ModelPricingSchema,
});
export type ModelCatalogItem = z.infer<typeof ModelCatalogItemSchema>;

export const ProviderCatalogSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  configured: z.boolean(),
  verifiedAt: z.string(),
  stale: z.boolean(),
  /** 'custom' identifica provedores vindos da configuração do usuário. */
  source: z.enum(['builtin', 'custom']),
  models: z.array(ModelCatalogItemSchema),
});
export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

export const ModelsResponseSchema = z.object({
  providers: z.array(ProviderCatalogSchema),
  defaultProviderId: ProviderIdSchema,
  defaultModelId: z.string().min(1),
  /**
   * Erros de configuração de provedores personalizados. Nunca são silenciosos:
   * uma entrada inválida aparece aqui e a interface mostra ao usuário.
   */
  configErrors: z.array(z.string()),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export const ProviderModelInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(160).optional(),
  ctx: z
    .number({ error: 'Informe a janela de contexto do modelo, em tokens.' })
    .int('A janela precisa ser um número inteiro de tokens.')
    .positive('A janela precisa ser maior que zero.'),
  reasoning: z.boolean().optional(),
  pricing: z
    .object({
      inputPerMillion: z.number().nonnegative().nullable().optional(),
      cachedInputPerMillion: z.number().nonnegative().nullable().optional(),
      outputPerMillion: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
});
export type ProviderModelInput = z.infer<typeof ProviderModelInputSchema>;

export const ProviderSettingsInputSchema = z.object({
  label: z.string().trim().min(1, 'Dê um nome ao provedor.').max(80),
  baseURL: z.string().url('A URL base precisa ser absoluta, incluindo https://'),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
  /** A lista é preenchida automaticamente pelo endpoint /models do provedor. */
  models: z.array(ProviderModelInputSchema).default([]),
  /** string grava a chave; null apaga; ausente mantém a que já existe. */
  apiKey: z.string().max(500).nullable().optional(),
});
export type ProviderSettingsInput = z.infer<typeof ProviderSettingsInputSchema>;

/** Forma devolvida ao navegador. Nunca inclui a chave — apenas `hasKey`. */
export const ProviderSettingsSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  baseURL: z.string().min(1),
  verifiedAt: z.string().nullable(),
  models: z.array(ProviderModelInputSchema),
  hasKey: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const ProviderSettingsResponseSchema = z.object({
  providers: z.array(ProviderSettingsSchema),
  secretStorage: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type ProviderSettingsResponse = z.infer<typeof ProviderSettingsResponseSchema>;

/**
 * Anexos.
 *
 * Duas naturezas com destinos diferentes: **imagem** vai para o modelo como
 * parte de conteúdo (quando ele enxerga), e **documento** vira texto extraído
 * no servidor e entra no prompt. Guardar PDF cru e mandar ao modelo não
 * funcionaria — `/chat/completions` não recebe binário — e converter no
 * navegador colocaria a extração numa máquina que não controlamos.
 */
export const AttachmentKindSchema = z.enum(['image', 'document', 'spreadsheet']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/**
 * Representação canônica, pequena e independente de biblioteca, de uma
 * planilha. As células são esparsas: arquivos com formatação em milhares de
 * linhas vazias não viram um JSON gigantesco nem travam a grade no navegador.
 */
export const SpreadsheetCellValueSchema = z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null()]);
export type SpreadsheetCellValue = z.infer<typeof SpreadsheetCellValueSchema>;

export const SpreadsheetCellSchema = z.object({
  row: z.number().int().min(1).max(100_000),
  column: z.number().int().min(1).max(2_000),
  value: SpreadsheetCellValueSchema,
  /** Fórmula sem o '=' inicial; `value` contém o último resultado conhecido. */
  formula: z.string().max(8_000).optional(),
});
export type SpreadsheetCell = z.infer<typeof SpreadsheetCellSchema>;

export const SpreadsheetSheetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rowCount: z.number().int().min(1).max(100_000),
  columnCount: z.number().int().min(1).max(2_000),
  cells: z.array(SpreadsheetCellSchema).max(250_000),
}).superRefine((sheet, context) => {
  for (const cell of sheet.cells) {
    if (cell.row > sheet.rowCount || cell.column > sheet.columnCount) {
      context.addIssue({ code: 'custom', message: 'Há célula fora das dimensões declaradas da aba.' });
      return;
    }
  }
  const coordinates = new Set<string>();
  for (const cell of sheet.cells) {
    const key = `${cell.row}:${cell.column}`;
    if (coordinates.has(key)) {
      context.addIssue({ code: 'custom', message: 'A aba contém a mesma célula mais de uma vez.' });
      return;
    }
    coordinates.add(key);
  }
});
export type SpreadsheetSheet = z.infer<typeof SpreadsheetSheetSchema>;

export const SpreadsheetWorkbookSchema = z.object({
  sheets: z.array(SpreadsheetSheetSchema).min(1).max(100),
}).superRefine((workbook, context) => {
  const names = new Set<string>();
  let cells = 0;
  for (const sheet of workbook.sheets) {
    const folded = sheet.name.toLocaleLowerCase('pt-BR');
    if (names.has(folded)) {
      context.addIssue({ code: 'custom', message: 'Os nomes das abas precisam ser únicos.' });
      return;
    }
    names.add(folded);
    cells += sheet.cells.length;
  }
  if (cells > 250_000) context.addIssue({ code: 'custom', message: 'A planilha excede 250.000 células preenchidas.' });
});
export type SpreadsheetWorkbook = z.infer<typeof SpreadsheetWorkbookSchema>;

export const SpreadsheetSaveSchema = z.object({
  workbook: SpreadsheetWorkbookSchema,
  /** Evita sobrescrever silenciosamente uma edição feita em outra aba. */
  baseVersion: z.number().int().min(1),
});
export type SpreadsheetSave = z.infer<typeof SpreadsheetSaveSchema>;

export const SpreadsheetSelectionSchema = z.object({
  attachmentId: z.string().min(1),
  version: z.number().int().min(1),
  sheet: z.string().trim().min(1).max(100),
  startRow: z.number().int().min(1).max(100_000),
  startColumn: z.number().int().min(1).max(2_000),
  endRow: z.number().int().min(1).max(100_000),
  endColumn: z.number().int().min(1).max(2_000),
});
export type SpreadsheetSelection = z.infer<typeof SpreadsheetSelectionSchema>;

/**
 * Teto por arquivo.
 *
 * 3 MB de bytes reais viram ~4 MB em base64, e o corpo da requisição na
 * Vercel para em 4,5 MB. O limite é do transporte, não do gosto: acima dele a
 * plataforma corta a requisição antes de o servidor ver qualquer coisa.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Anexos por mensagem. Acima disso o contexto some debaixo do próprio anexo. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export const AttachmentUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(1).max(150),
  /** Conteúdo em base64. Ver MAX_ATTACHMENT_BYTES para o teto real. */
  data: z.string().min(1).max(Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 1024),
});
export type AttachmentUpload = z.infer<typeof AttachmentUploadSchema>;

/** O que volta ao navegador: nunca os bytes, que são pedidos por URL própria. */
export const AttachmentSchema = z.object({
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
    version: z.number().int().min(1),
  }).nullable().optional(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Edição manual do artefato.
 *
 * O usuário reescreve a fonte inteira; não há patch aqui. O modelo tem
 * `<artifact-update>` com find/replace porque reescrever tudo custa tokens —
 * uma pessoa editando num campo de texto já tem o conteúdo completo na mão, e
 * um formato de diferença só criaria maneiras novas de errar.
 */
export const ArtifactEditSchema = z.object({
  content: z.string().max(512 * 1024),
});

/**
 * Modo Science: uma cadeia de agentes em vez de uma resposta só.
 *
 * É uma configuração SEPARADA do nível de esforço, e de propósito: esforço
 * regula quanto um modelo pensa antes de responder; o nível aqui regula
 * QUANTAS passagens diferentes o texto sofre, cada uma com um papel próprio.
 * As duas se combinam — dá para usar esforço alto numa cadeia de dois
 * agentes, e o contrário também.
 *
 * O preço é linear no número de agentes: cada estágio é uma chamada cobrada.
 * A interface diz isso antes de rodar, porque a diferença entre o nível 1 e o
 * 3 é de duas para cinco chamadas sobre um texto longo.
 */
export const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).nullable().optional(),
  content: z.string().trim().min(1, 'A mensagem não pode ficar vazia.').max(200_000),
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  /** Ausente equivale a `auto`: nenhum parâmetro de raciocínio é enviado. */
  effort: EffortLevelSchema.optional(),
  /**
   * Buscar na web nesta mensagem.
   *
   * Vale para os dois caminhos de busca — o buscador externo e o plugin da
   * OpenRouter — porque para quem escreve a pergunta é uma decisão só.
   *
   * Ausente equivale a ligado, para não mudar o comportamento de quem chama a
   * API direto. A interface manda o valor sempre, e o botão nasce desligado:
   * o plugin da OpenRouter busca em TODA requisição, e deixá-lo ligado por
   * padrão fazia o modelo consultar a web para perguntas que ele já sabia
   * responder — e cobrava a busca em cada uma.
   */
  webSearch: z.boolean().optional(),
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
  scienceFormat: ScienceFormatSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  effort: EffortLevelSchema.optional(),
});
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  effort: EffortLevelSchema.optional(),
  archived: z.boolean().optional(),
});
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

export const MessageSchema = z.object({
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
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSummarySchema = z.object({
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
  effort: EffortLevelSchema.default('auto'),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationSchema = ConversationSummarySchema.extend({
  messages: z.array(MessageSchema),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});
export type ConversationsResponse = z.infer<typeof ConversationsResponseSchema>;

export const ConversationResponseSchema = z.object({
  conversation: ConversationSchema,
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(ConversationSummarySchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const DeleteResponseSchema = z.object({
  ok: z.literal(true),
});
export type DeleteResponse = z.infer<typeof DeleteResponseSchema>;

export const CostDailyAggregateSchema = z.object({
  day: z.string().min(1),
  costUsd: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});
export type CostDailyAggregate = z.infer<typeof CostDailyAggregateSchema>;

export const CostModelAggregateSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  costUsd: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});
export type CostModelAggregate = z.infer<typeof CostModelAggregateSchema>;

export const CostAnalyticsResponseSchema = z.object({
  totalCostUsd: z.number().nonnegative(),
  daily: z.array(CostDailyAggregateSchema),
  byModel: z.array(CostModelAggregateSchema),
});
export type CostAnalyticsResponse = z.infer<typeof CostAnalyticsResponseSchema>;
