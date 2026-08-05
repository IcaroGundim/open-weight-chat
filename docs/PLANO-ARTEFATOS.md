# Plano de implementação — Artefatos

Documento de handoff. Quem implementa não participou das decisões abaixo; por isso cada seção traz **caminho de arquivo, forma exata do tipo e critério de aceite**. Onde houver ambiguidade, ela foi resolvida aqui de propósito — não reabra sem motivo.

Contexto do projeto: [PLANO.md](PLANO.md) · Regras de interface: [DESIGN.md](DESIGN.md)

---

## 0. A decisão que governa todo o resto

"Artefato como no Claude" abrange dois níveis com custo de engenharia e risco **incomparáveis**:

| Nível | Tipos | O que exige |
|---|---|---|
| **1 — conteúdo** | `markdown`, `code`, `svg`, `mermaid` | Renderiza no pipeline que já existe. **Nenhuma mudança de CSP.** Nenhuma execução de JavaScript do modelo. |
| **2 — execução** | `html`, `react` | Executar JavaScript gerado por modelo: origem separada, `frame-src` novo, transpilador JSX no navegador, e uma superfície real de XSS/exfiltração num app cuja postura declarada é "sem HTML cru, `trust: false`, links sanitizados". |

**Este plano entrega o nível 1.** O nível 2 está na §12, como fase separada com ameaça e orçamento próprios — não como continuação natural.

Motivo de tratar assim: se os dois aparecerem no mesmo roteiro, quem implementa liga um `<iframe>` no primeiro dia e o modelo de ameaça vira comentário. O nível 1 cobre a maior parte do valor (documento longo, código, diagrama, gráfico) sem tocar em uma linha do cabeçalho de segurança.

**Benefício a declarar explicitamente:** no nível 1, o middleware de CSP em [`src/server/index.ts:110`](../src/server/index.ts) **não muda**. Se um PR do nível 1 mexer em `Content-Security-Policy`, ele está errado.

---

## 1. Como o modelo sinaliza um artefato

### 1.1 Por que não é tool-calling

`requestBody()` em [`src/server/llm-client.ts:233`](../src/server/llm-client.ts) envia apenas `model`, `messages`, `stream`, `stream_options` e `temperature`. Não há ferramentas plumbadas, e o suporte a `tools` varia entre DeepSeek, GLM, Kimi, OpenRouter e Ollama. **O protocolo é delimitado por texto**, o que funciona em qualquer endpoint OpenAI-compatível — inclusive num modelo local.

### 1.2 Gramática

Tags em inglês (os modelos aderem melhor a nomes vistos no treino), instruções do system prompt em português.

**Criar ou reescrever:**

```
<artifact id="cliente-sse" type="code" language="typescript" title="Cliente SSE com AbortController">
…corpo íntegro…
</artifact>
```

**Revisar sem reescrever:**

```
<artifact-update id="cliente-sse">
<find>const timeout = 30_000;</find>
<replace>const timeout = 60_000;</replace>
</artifact-update>
```

Regras da gramática:

- `id`: `^[a-z0-9][a-z0-9-]{0,63}$`. É o identificador estável entre versões.
- `type`: `markdown` · `code` · `svg` · `mermaid`. Qualquer outro valor → o bloco é tratado como prosa comum (ver §1.4).
- `language`: obrigatório quando `type="code"`, ignorado nos demais.
- `title`: 1–120 caracteres.
- **O corpo é opaco.** Nada dentro dele é interpretado até o fechamento. Isso é o que permite um artefato `markdown` conter cercas de código sem quebrar o parser.
- `<artifact-update>` aceita vários pares `<find>`/`<replace>`, aplicados em ordem.
- Para emitir a sequência literal `</artifact>` dentro de um corpo, o modelo deve escrever `<\/artifact>`; o parser desfaz o escape.

### 1.3 Onde a instrução mora

Um novo módulo [`src/server/artifacts/system-prompt.ts`](../src/server/artifacts/system-prompt.ts) exporta `ARTIFACT_SYSTEM_PROMPT: string` e `composeSystemPrompt(userPrompt: string | null): string`.

A composição acontece em `conversationContext()` — [`src/server/index.ts:80`](../src/server/index.ts) — e o resultado entra como a **primeira** mensagem do payload.

> **Restrição dura, herdada de PLANO.md §7.3:** este system prompt é grande (~600–900 tokens) e precisa ficar no **prefixo estável** do payload. Nada variável (timestamp, id de conversa, contagem de artefatos) pode entrar nele. O DeepSeek cobra ~50× menos em cache hit; um prefixo instável joga essa economia fora em toda requisição. O estado atual dos artefatos vai na **cauda** do contexto, não aqui — ver §3.2.

### 1.4 Quando o modelo não colabora

Modelos open-weight aderem a protocolos de tag com menos confiabilidade que o Claude. O plano precisa dos três caminhos degradados:

| Situação | Comportamento |
|---|---|
| Modelo emite cerca de código comum em vez da tag | **Nenhuma promoção automática em v1.** O bloco renderiza como hoje, e ganha um botão "Abrir como artefato" que cria o artefato no cliente. Heurística do tipo "código com mais de 15 linhas vira artefato" erra alto e de forma invisível; a promoção manual é honesta e o gatilho automático fica como toggle barato depois. |
| Tag de abertura malformada (atributo faltando, `type` inválido) | O parser não entra em modo artefato. O texto sai como prosa, exatamente como o modelo escreveu. Sem exceção, sem mensagem de erro. |
| Stream termina com tag aberta (`finish_reason: length`, usuário aperta Parar, erro de rede) | Fecha o artefato com o que chegou, grava a versão com `truncated = 1`, emite `artifact_end` com `truncated: true`. O painel mostra o aviso em `--ochre`. **Isto acontece na prática** — artefatos longos estouram `max_tokens` com frequência. |

---

## 2. O parser: máquina de estados no servidor

### 2.1 Por que no servidor

`content` é acumulado no servidor ([`src/server/index.ts:277`](../src/server/index.ts)) e `persistPartial()` grava a cada 250ms. O cliente agrupa texto a cada 50ms em `streamChat`. Se o parser rodasse no cliente, o corpo do artefato chegaria como texto de chat: `Markdown.tsx` renderizaria meio artefato dentro da prosa e ele sumiria depois — exatamente o piscar que a §5.2 do PLANO.md manda evitar.

**O corpo do artefato nunca deve ser emitido como envelope `text`.**

### 2.2 O algoritmo

Novo módulo [`src/server/artifacts/parser.ts`](../src/server/artifacts/parser.ts):

```ts
export type ParserEvent =
  | { kind: 'text'; text: string }
  | { kind: 'artifact_open'; slug: string; type: ArtifactKind; language: string | null; title: string }
  | { kind: 'artifact_body'; slug: string; text: string }
  | { kind: 'artifact_close'; slug: string; truncated: boolean }
  | { kind: 'artifact_patch'; slug: string; edits: Array<{ find: string; replace: string }> };

export function createArtifactParser(): {
  push(chunk: string): ParserEvent[];
  end(): ParserEvent[];   // fecha tags abertas com truncated: true
};
```

Estados: `PROSE` → `OPEN_TAG` → `BODY` → `PROSE`, mais `PATCH_BODY` para `<artifact-update>`.

**O detalhe que quebra implementações ingênuas:** o delimitador chega partido entre chunks. `<arti` pode vir num chunk e `fact id="x">` no seguinte. A regra:

> Em `PROSE`, mantenha uma cauda de até `MAX_DELIM = len('<artifact-update')` caracteres. Só emita como texto a parte do buffer que **não pode** ser prefixo de um delimitador. No fim do stream, a cauda retida é emitida como texto.

O mesmo vale em `BODY` para `</artifact>`.

### 2.3 O que é persistido em `messages.content`

O corpo **não** fica em `messages.content`. No lugar dele, uma linha marcadora **com a versão que aquela mensagem produziu**:

```
[[artefato:cliente-sse@2]]
```

Regex de reconhecimento: `/^\[\[artefato:([a-z0-9][a-z0-9-]{0,63})@(\d+)\]\]$/m`

> A versão no marcador não é enfeite. Sem ela, a mensagem que criou a v1 e a que criou a v2 gravam marcadores idênticos, e os dois cartões resolvem para a versão corrente — o histórico perde exatamente a informação que justifica ter versões dentro de um chat. O cartão abre na versão que aquela mensagem gerou; o painel permite navegar até a corrente.

**`<artifact-update>` também emite marcador.** Um turno de revisão sem cartão nenhum é o pior resultado: o usuário pede a mudança, o modelo aplica, e nada na mensagem mostra que aconteceu. Com o marcador versionado do parágrafo acima, o cartão da revisão aponta para a versão nova e fica correto sem nenhum caso especial.

Três consequências, todas desejadas:

1. `conversationContext()` passa a enviar o marcador em vez do corpo em todos os turnos seguintes — a maior economia de entrada da feature (§3).
2. `MessageBubble` divide `content` por essa regex e intercala `<Markdown>` com `<ArtifactCard>`, **sem tocar no pipeline de markdown**. Nenhum plugin remark novo, nenhum risco no renderer que já foi validado.
3. O artefato aparece na posição exata em que o modelo o emitiu, inclusive no meio de um parágrafo de explicação.

---

## 3. Custo — a parte que este produto não pode errar

Artefatos são o pior caso de custo de um chat, e custo é a tese deste app. Três decisões, todas de primeira classe.

### 3.1 Operação de revisão (`<artifact-update>`)

**A decisão de maior alavancagem da feature.** Sem ela, "muda o timeout para 60s" reescreve 300 linhas — saída inteira cobrada de novo, no token mais caro da tabela.

Aplicação em [`src/server/artifacts/patch.ts`](../src/server/artifacts/patch.ts):

```ts
export function applyEdits(source: string, edits: Array<{ find: string; replace: string }>):
  | { ok: true; content: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; find: string };
```

- `find` deve casar **exatamente uma vez**. Zero ocorrências → `not_found`. Duas ou mais → `ambiguous`.
- Em qualquer falha: **não** grava versão nova, emite envelope `error` com código `UNKNOWN` e mensagem acionável, e a resposta continua. O usuário vê o aviso e pode pedir a reescrita.
- Falha silenciosa aqui é o pior resultado possível: o usuário acha que editou e não editou.

### 3.2 O que entra no contexto nos turnos seguintes

Regra, implementada em `conversationContext()`:

1. O histórico carrega **marcadores**, nunca corpos.
2. Imediatamente antes da nova mensagem do usuário — ou seja, na **cauda** do payload, preservando o prefixo estável para o cache — injete um bloco de estado com `role: 'user'`:

```
Estado atual dos artefatos desta conversa:

<artifact id="cliente-sse" type="code" language="typescript" title="Cliente SSE" version="3">
…corpo da versão corrente…
</artifact>
```

3. **Este bloco é montado em memória a cada requisição e nunca entra em `messages`.** Se for persistido via `db.insertMessage`, ele volta em `getMessages()` no turno seguinte, o histórico passa a conter um corpo de artefato desatualizado, o prefixo muda a cada requisição, e tanto a economia de cache quanto a economia do marcador desaparecem — em silêncio, sem nada quebrar visivelmente.
4. **Orçamento:** o bloco inteiro é limitado a **25% da janela do modelo** (`model.ctx`, já disponível em `providers.config.ts`). Ao estourar, inclua os artefatos por ordem de `updated_at` decrescente até caber; os que ficarem de fora entram só como `<artifact id="…" title="…" version="…" omitted="true" lines="412"/>`, e o system prompt instrui o modelo a pedir o corpo quando precisar.
5. **Ordem em relação a `trimContext()`:** apare o histórico para `ctx − tamanho do bloco de estado − nova mensagem` e **só então** acrescente o bloco e a mensagem do usuário. `trimContext(messages, ctx)` não tem mecanismo de fixar item: recebendo um array, ele corta do array. Dizer "o trim não deve cortar o bloco" não é implementável; reservar o espaço antes é.

Sem essa regra explícita, quem implementa manda tudo — que é a resposta cara.

### 3.3 Atribuição de custo por artefato

`artifact_versions` guarda `output_tokens` e `cost_usd` da versão. Estimativa: proporção do corpo do artefato sobre o total de saída da mensagem, aplicada ao custo já calculado em `calculateUsageAndCost()`.

**É uma estimativa derivada, não um valor medido** — o provedor não separa tokens por região da resposta. Portanto, na interface, esse número usa `--ochre` e o prefixo `≈`, seguindo a regra de DESIGN.md §4.4: a distinção entre exato e estimado nunca se apaga.

O painel mostra, no rodapé: `v3 · ≈$0.0041 · 412 linhas`. E, na troca de versão, quanto a revisão custou comparada a uma reescrita — a prova concreta de que `<artifact-update>` vale a pena.

---

## 4. Contrato de dados

### 4.1 `src/shared/types.ts` — adições

```ts
export const ArtifactKindSchema = z.enum(['markdown', 'code', 'svg', 'mermaid']);
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
```

Três variantes novas de SSE, **acrescentadas a `SseEnvelopeSchema`**:

```ts
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
```

### 4.2 `src/server/db/schema.sql` — adições

```sql
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'code', 'svg', 'mermaid')),
  language TEXT,
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, slug)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'rewrite', 'update')),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  output_tokens INTEGER,
  cost_usd REAL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_versions_fts USING fts5(
  content, content='artifact_versions', content_rowid='rowid'
);
```

Mais três gatilhos `artifact_versions_ai` / `_ad` / `_au`, espelhando exatamente o padrão de `messages_ai` / `_ad` / `_au` já em `schema.sql:45-56`.

> **Regressão de busca, se ignorada:** hoje o código vive em `messages.content` e é indexado por `messages_fts`. Ao mover o corpo para `artifact_versions`, ele **sai do índice**. Por isso a FTS paralela é obrigatória, e `searchConversations()` ([`src/server/db/queries.ts:456`](../src/server/db/queries.ts)) precisa unir os dois índices. Sem isso, buscar por um trecho de código deixa de funcionar — piora em relação a hoje.

**Todas as versões são indexadas; o filtro é na consulta, não no gatilho.** Os gatilhos ficam idênticos aos de `messages` — inserir, apagar, atualizar — e a deduplicação sai de um `JOIN` com `artifacts` filtrando `av.version = a.current_version`:

```sql
SELECT DISTINCT a.conversation_id
FROM artifact_versions_fts f
JOIN artifact_versions av ON av.rowid = f.rowid
JOIN artifacts a ON a.id = av.artifact_id AND av.version = a.current_version
WHERE artifact_versions_fts MATCH ?;
```

A alternativa — fazer o gatilho de inserção remover do índice a versão anterior — exige lógica condicional dentro do gatilho e sai de sincronia se alguém gravar versões fora de ordem. Versões antigas continuam no índice e simplesmente não aparecem nos resultados; o custo em disco é irrelevante para uso local.

### 4.3 Migração

`chat.db` já existe com dados. A criação é toda `IF NOT EXISTS` e nenhuma tabela existente muda de forma — a migração é aditiva e roda sozinha na abertura, como o schema atual já faz.

---

## 5. Servidor — arquivos e mudanças

| Arquivo | Mudança |
|---|---|
| `src/server/artifacts/parser.ts` | **novo** — máquina de estados da §2.2 |
| `src/server/artifacts/patch.ts` | **novo** — `applyEdits` da §3.1 |
| `src/server/artifacts/system-prompt.ts` | **novo** — instrução + `composeSystemPrompt` |
| `src/server/artifacts/context.ts` | **novo** — bloco de estado e orçamento de 25% (§3.2) |
| `src/server/db/schema.sql` | tabelas, índices, FTS, gatilhos |
| `src/server/db/queries.ts` | `upsertArtifact`, `insertArtifactVersion`, `getArtifacts(conversationId)`, `getArtifactVersion(slug, version)`; união de FTS em `searchConversations` |
| `src/server/index.ts` | parser no laço de streaming; `composeSystemPrompt` e bloco de estado em `conversationContext`; rotas `GET /api/conversations/:id/artifacts` e `GET /api/conversations/:id/artifacts/:slug/versions/:version` |
| `src/shared/types.ts` | §4.1 |

**No laço de `/api/chat`** ([`src/server/index.ts:276`](../src/server/index.ts)), o evento `text` do provedor passa a alimentar o parser em vez de ir direto ao envelope:

```ts
for (const event of parser.push(event.text)) {
  // 'text'          → content += …  e  writeEnvelope({ type: 'text' })
  // 'artifact_open' → reserva a versão N no banco, writeEnvelope({ type: 'artifact_start' })
  //                   content += '\n\n[[artefato:' + slug + '@' + N + ']]\n\n'
  // 'artifact_body' → acumula em memória, writeEnvelope({ type: 'artifact_delta' })
  // 'artifact_close'→ grava o corpo da versão N, writeEnvelope({ type: 'artifact_end' })
  // 'artifact_patch'→ applyEdits sobre a versão corrente.
  //                   sucesso: grava versão N+1, escreve o marcador '@N+1' em content,
  //                            emite artifact_start + artifact_end (sem deltas)
  //                   falha:   nenhuma versão nova, nenhum marcador,
  //                            envelope 'error' e a resposta continua
}
```

`persistPartial()` continua gravando `content` — que agora contém o marcador, não o corpo. O corpo em andamento fica em memória e é gravado no `artifact_close`; no `finally`, `parser.end()` fecha o que restou com `truncated`.

**Abortar no meio de um artefato** grava a versão parcial com `truncated = 1`. Já se paga por esses tokens; jogá-los fora é pior.

---

## 6. Cliente — arquivos e mudanças

| Arquivo | Mudança |
|---|---|
| `src/client/api.ts` | `ChatStreamHandlers` ganha `onArtifactStart/Delta/End`; `handleEvent` ganha os três `type` (nomes em minúsculas — a função já faz `toLowerCase()`); o delta entra no mesmo lote de 50ms do texto, com buffer por `slug` |
| `src/client/store/chat.ts` | `artifactsByConversation: Record<string, Artifact[]>`, `streamingArtifacts: Record<string, string>`, `openArtifact: { slug: string; version: number } | null`, e as ações `openArtifact` / `closeArtifact` / `selectArtifactVersion` |
| `src/client/types.ts` | espelho de `Artifact` e `ArtifactVersion` |
| `src/client/components/MessageBubble.tsx` | divide `content` pela regex do marcador e intercala `<ArtifactCard>` |
| `src/client/components/ArtifactCard.tsx` | **novo** — cartão inline: título, tipo, versão, linhas, botão de abrir |
| `src/client/components/ArtifactPanel.tsx` | **novo** — painel lateral |
| `src/client/render/ArtifactRenderer.tsx` | **novo** — despacho por `kind` |
| `src/client/render/sanitize-svg.ts` | **novo** — §8 |
| `src/client/components/ChatView.tsx` | terceira coluna, ordem do `Escape` |
| `src/client/styles.css` | classes do cartão e do painel, com os tokens existentes |

> `handleEvent` ([`src/client/api.ts:488`](../src/client/api.ts)) trata `text`/`reasoning`/`usage`/`error`/`done` e **ignora qualquer outro tipo sem erro nem log**. Enquanto os ramos novos não existirem, o artefato simplesmente não aparece e nada acusa — perda de tempo garantida em depuração. Implemente cliente e servidor na mesma fase.

---

## 7. Interface

Governada por [DESIGN.md](DESIGN.md). Nenhum token novo, nenhuma cor nova.

### 7.1 Cartão inline (`ArtifactCard`)

Fundo `--surface`, raio `--r-3`, sem borda — o tom já separa (DESIGN.md §7.1). Título em 14px peso 600; abaixo, em 12px `--ink-3`, o tipo e a linguagem. À direita, `v3` e a contagem de linhas em **mono tabular**, porque são valores medidos (§5.3). Clique abre o painel. Durante o streaming, o cartão mostra o indicador de três pontos já existente.

### 7.2 Painel lateral (`ArtifactPanel`)

- **Cabeçalho:** título, seletor de versão, botões copiar e baixar.
- **Abas:** `Visualizar` / `Fonte`. Para `code`, `Fonte` é a aba padrão. Rótulos em caixa normal — sem caixa alta espaçada.
- **Rodapé:** `v3 · ≈$0.0041 · 412 linhas`, com o custo em `--ochre` por ser estimado (§3.3).
- **Fonte** reaproveita o caminho do Shiki que já existe, inclusive o `!important` do fundo (DESIGN.md §9.3).
- **Diagramas mermaid** usam `theme: 'base'` com `themeVariables` derivados dos tokens (§8). O tema padrão da biblioteca é lavanda e azul-arroxeado — proibido por DESIGN.md §3.1, e invisível para `pnpm design`.
- Baixar usa a extensão certa por tipo/linguagem, no mesmo padrão de `exportConversation`.

### 7.3 Layout

`.chat-app` passa a `grid-template-columns: [lateral] [chat] [painel]`, com o painel em `minmax(360px, 42%)`.

| Largura | Comportamento |
|---|---|
| ≥ 1280px | Três colunas. Abrir o painel não fecha a barra lateral. |
| 900–1280px | Abrir o painel **recolhe** a barra lateral (a classe `sidebar-collapsed` já existe em `ChatView`). |
| < 900px | Painel vira sobreposição de tela cheia com `--shadow`, mesmo padrão da gaveta da lateral. |

**Ordem do `Escape`** — o handler único em `ChatView.tsx:108` passa a ser: `costOverview` → `settings` → `artifactPanel` → `sidebar`. Modais primeiro, painel depois, lateral por último.

**Atalhos:** se o painel exibir qualquer `<kbd>`, o handler tem que existir. É regra de DESIGN.md §3.2, e a auditoria não pega isso — revisão humana pega.

### 7.4 Conformidade

`pnpm design` hoje reporta 18 divergências, todas do `SettingsPanel` (DESIGN.md §11). **O painel de artefatos não pode adicionar a décima nona.** Sem `font-size` abaixo de 12px, sem `font-weight: 650`, sem rótulo em caixa alta, sem hexadecimal literal.

---

## 8. Segurança do nível 1

`markdown` e `code` passam pelo pipeline já validado — sem HTML cru, links sanitizados, KaTeX com `trust: false`. Nada novo.

**`svg` é o risco real deste nível.** SVG não é imagem inerte: aceita `<script>`, manipuladores `on*`, `<foreignObject>` com HTML dentro, e referências externas por `href`/`xlink:href`.

Defesa em duas camadas, ambas obrigatórias:

1. **Sanitizar** em `src/client/render/sanitize-svg.ts`: `DOMParser` com `image/svg+xml`, allowlist de elementos (`svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, defs, linearGradient, radialGradient, stop, use, title, desc`) e de atributos; remoção incondicional de todo atributo `on*`, de `<script>`, `<style>`, `<foreignObject>`, e de qualquer `href`/`xlink:href` que não comece com `#`.
2. **Renderizar como `<img src="data:image/svg+xml;base64,…">`**, nunca como SVG inline. Navegador não executa script dentro de `<img>`. A sanitização sozinha já deveria bastar; a segunda camada é o que sobra quando a primeira tem um furo.

**`mermaid`:** dependência nova, carregada sob demanda como o KaTeX já é. Configuração obrigatória `securityLevel: 'strict'` e `htmlLabels: false`. A saída do mermaid é SVG e passa **pelo mesmo sanitizador** — não confie na biblioteca.

**O tema padrão do mermaid é a paleta do slop.** Fora da caixa ele desenha nós lavanda com bordas azul-arroxeadas — exatamente a estética que DESIGN.md §1 existe para proibir, largada sobre um canvas marrom e vinho. `pnpm design` **não pega isso**, porque as cores são injetadas em tempo de execução, não estão na folha. Configure `theme: 'base'` e mapeie `themeVariables` a partir de `--paper`, `--surface`, `--ink`, `--rule` e `--wine`, lidos de `getComputedStyle(document.documentElement)`. Reconfigure e redesenhe ao trocar de tema — o diagrama não pode ficar com as cores do tema anterior.

Limites: corpo de artefato no máximo **512 KB**; SVG e mermaid no máximo **128 KB**. Acima disso, grava mas renderiza só a aba `Fonte`, com aviso.

Teste obrigatório de aceite: um SVG com `<script>alert(1)</script>`, um com `onload=`, e um com `<foreignObject>` contendo `<img onerror>` — nenhum executa.

---

## 9. Fases

| Fase | Escopo | Pronto quando |
|---|---|---|
| **0 — Contrato** (~½ dia) | Tipos de §4.1, schema de §4.2, migração | `pnpm typecheck` e `pnpm test` verdes; abrir um `chat.db` existente cria as tabelas sem perder dado |
| **1 — Parser** (~1–1½ dia) | `parser.ts` + envelopes SSE + branches no `api.ts` | Suíte que alimenta o parser **caractere a caractere** com o delimitador partido em toda posição possível, e nenhum byte de corpo sai como envelope `text` |
| **2 — Persistência** (~1 dia) | Gravação de artefato e versões, rotas GET, marcador em `content` | Fechar e reabrir a conversa reconstrói artefatos e versões idênticos |
| **3 — Cartão inline** (~1 dia) | Store, `MessageBubble`, `ArtifactCard` | O cartão aparece na posição exata onde o modelo emitiu, inclusive no meio de um parágrafo; numa conversa em que o mesmo artefato foi tocado duas vezes, cada mensagem abre **a sua** versão |
| **4 — Painel e renderers** (~2 dias) | `ArtifactPanel`, `ArtifactRenderer`, sanitização, layout de §7.3 | Os três payloads maliciosos de §8 não executam; `pnpm design` continua em 18 divergências |
| **5 — Revisão e custo** (~1½ dia) | `<artifact-update>`, `applyEdits`, bloco de estado com orçamento, custo por versão | Uma revisão de uma linha num artefato de 300 linhas custa **menos de 20% de uma reescrita**, medido com `usage` real e mostrado no painel |
| **6 — Busca e exportação** (~1 dia) | FTS paralela, união em `searchConversations`, baixar | Buscar um trecho que só existe dentro de um artefato encontra a conversa |

Fases 0–3 já entregam algo utilizável. **A fase 5 é a que justifica a feature neste produto** — sem ela, artefatos só encarecem o chat.

---

## 10. Testes

| Arquivo | Cobre |
|---|---|
| `src/server/artifacts/parser.test.ts` | delimitador partido em toda posição; tag malformada vira prosa; tag não fechada no fim; `<\/artifact>` escapado; artefato markdown contendo cercas de código |
| `src/server/artifacts/patch.test.ts` | `find` único aplica; zero ocorrências → `not_found`; múltiplas → `ambiguous`; edições em sequência; falha **não** grava versão nem marcador |
| `src/server/artifacts/marker.test.ts` | marcador versionado gravado na criação e na revisão; duas mensagens que tocam o mesmo artefato geram `@1` e `@2` distintos; a regex não casa texto do usuário parecido |
| `src/server/artifacts/context.test.ts` | orçamento de 25%; artefatos excedentes viram `omitted`; prefixo estável não muda entre turnos |
| `src/server/db/artifacts.test.ts` | versionamento; cascade ao apagar conversa; FTS acha só a versão corrente |
| `src/client/render/sanitize-svg.test.ts` | os três payloads de §8 e mais `<use href="http://externo">` |

O teste do prefixo estável merece destaque: ele é o que impede alguém de "melhorar" o system prompt inserindo a data e destruir o cache sem ninguém perceber.

---

## 11. Riscos

| Risco | Mitigação |
|---|---|
| Modelo open-weight ignora o protocolo | Promoção manual (§1.4); medir taxa de adesão por modelo antes de considerar heurística automática |
| Corpo de artefato vaza como texto de chat | Parser no servidor (§2.1) + o teste caractere a caractere da fase 1 |
| Custo **sobe** em vez de cair | `<artifact-update>` e o orçamento de contexto na fase 5, com critério de aceite numérico |
| Busca regride | FTS paralela desde a fase 6, marcada como obrigatória em §4.2 |
| SVG executa script | Sanitizar **e** renderizar por `<img>` (§8) |
| Painel quebra o layout no meio | Regras de §7.3 declaradas por faixa; testar em 1440/1280/900/400 |
| Escopo escorregar para HTML/React | §0 e §12 são fases distintas com orçamento próprio |
| `artifact_delta` sem branch no cliente | Falha silenciosa conhecida — implementar servidor e cliente na mesma fase (§6) |
| Mermaid entra com o tema lavanda padrão | `themeVariables` a partir dos tokens (§8); a auditoria não detecta cor injetada em runtime, então cai na revisão visual da fase 4 |
| Bloco de estado persistido por engano | §3.2 item 3; o teste de prefixo estável em `context.test.ts` falha se isso acontecer |

---

## 12. Nível 2 — HTML e React (fase separada, não incluída)

Registrado para dimensionar, **não** para implementar junto.

**O que muda de verdade:**

- `sandbox="allow-scripts"` **sem** `allow-same-origin`. As duas juntas permitem que o frame remova o próprio sandbox — é a falha clássica, e ela anula a proteção inteira.
- O CSP atual (`default-src 'self'`, sem `frame-src`) bloqueia iframe de `srcdoc`/`blob:`. Exige diretiva nova — a primeira mudança de segurança do projeto.
- Isolamento real pede **origem separada**. Num app self-hosted de porta única isso não existe de graça; o caminho prático é uma rota `/sandbox/:token` com CSP próprio e token aleatório por artefato. **Declare o risco residual em vez de fingir isolamento completo.**
- Artefato React precisa de transformação de JSX no navegador. Babel standalone pesa ~2,7 MB — contradiz frontalmente a meta de leveza do PLANO.md. `esbuild-wasm` é menor mas ainda é ordens de grandeza acima de tudo que o app carrega hoje.

**Recomendação:** se um dia entrar, entre com `html` apenas, sem React. O ganho de React sobre HTML com um `<script>` é pequeno perto do que ele custa em peso e em superfície de ataque.
