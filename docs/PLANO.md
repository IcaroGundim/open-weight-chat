# Plano de Implementação — Chatbot para IAs Open‑Weight via API

> **Premissa assumida (declarada de propósito):** aplicação **self‑hosted / uso individual**, com **BYOK** (você traz suas próprias chaves de API), rodando como **um único processo Node**. Não é um SaaS multiusuário com login e cobrança. A seção 11 descreve exatamente o que muda se virar produto.
>
> Nota de terminologia: DeepSeek, GLM e Kimi são modelos **open‑weight** consumidos via API de nuvem — não são inferência local. A boa notícia é que a arquitetura abaixo cobre inferência local de verdade (Ollama / llama.cpp) sem nenhuma mudança estrutural, porque todos falam o mesmo protocolo.

---

## 1. Objetivo e critérios de sucesso

Construir um cliente de chat que:

1. Converse com múltiplos provedores open‑weight trocando apenas `baseURL` + `apiKey` + `model`.
2. Renderize **LaTeX** e **blocos de código** corretamente **durante o streaming**, sem piscar nem quebrar.
3. Mostre **custo real por mensagem e por conversa** — essa é a tese do produto, não um extra.
4. Seja leve: sem Next.js, sem Docker, sem Postgres, sem fila. Um `node server.js` e pronto.

**Critérios objetivos de aceite** (medir, não achar):
- Bundle JS inicial ≤ 250 KB gzip (sem contar fontes do KaTeX e gramáticas de código, que são lazy).
- Primeiro token na tela em < 1,5 s após envio (dominado pela latência do provedor).
- Renderização estável a 60 fps com resposta de 4.000 tokens streamando.
- Uso de RAM do processo Node em repouso < 120 MB.

---

## 2. Stack recomendado (uma escolha, não um cardápio)

| Camada | Escolha | Motivo em uma linha |
|---|---|---|
| Runtime | **Node 24.16 + pnpm 11** | Já instalado na máquina; `node:sqlite` embutido (testado e funcionando aqui). |
| Backend | **Hono** | ~14 KB, serve estáticos + rotas `/api`, streaming SSE nativo, roda em Node sem adaptador. |
| Frontend | **React 19 + Vite** | O ecossistema de renderização de markdown streaming maduro é React; framework leve, sem SSR desnecessário. |
| Renderização | **Streamdown** (`streamdown`) | Já resolve markdown incompleto, KaTeX e Shiki no streaming — é o pedaço mais difícil do projeto, não reinvente. |
| Matemática | **KaTeX** (lazy) | Ordens de grandeza mais rápido que MathJax; CSS + fontes carregados só quando há matemática. |
| Código | **Shiki fine‑grained com engine JS** | Qualidade de tema TextMate sem o WASM de 250 KB (ver §5.3). |
| Estado | **Zustand** + **TanStack Query** (opcional) | ~3 KB; sem Redux, sem context hell. |
| Estilo | **Tailwind 4** | Zero runtime, purge agressivo. |
| Banco | **`node:sqlite`** (embutido no Node 24) | Zero dependência nativa, zero build step, arquivo único `chat.db`. |
| Validação | **Zod** | Contratos de config e request em um lugar só. |
| Build/deploy | `vite build` → Hono serve `dist/` | Um processo, uma porta, um binário de deploy. |

**Se você já domina Svelte:** SvelteKit 2 + `svelte-streamdown` entrega o mesmo com bundle menor e deploy único nativo — mas o renderer é um port comunitário, e o renderer é justamente onde você não quer risco.

**O que NÃO usar e por quê:** Next.js (peso e complexidade de RSC sem ganho aqui), Docker/Postgres (não há Docker na máquina e SQLite basta), LangChain (abstração cara para 3 chamadas HTTP), Prisma (gerador + engine binária pesam mais que o app).

---

## 3. Provedores — dados verificados e onde eles moram no código

### 3.1 Endpoints (todos OpenAI‑compatíveis — verificado)

| Provedor | Base URL | Formato |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` (ou `/v1`) | OpenAI `/chat/completions` |
| Kimi (Moonshot) | `https://api.kimi.ai/v1` **ou** `https://api.moonshot.ai/v1` | OpenAI `/chat/completions` |
| GLM (Z.ai) | `https://api.z.ai/api/paas/v4` | OpenAI `/chat/completions` |
| OpenRouter (agregador) | `https://openrouter.ai/api/v1` | OpenAI `/chat/completions` |
| Ollama (local, futuro) | `http://localhost:11434/v1` | OpenAI `/chat/completions` |

Os dois hosts da Kimi aparecem documentados; confirme empiricamente qual responde à **sua** chave antes de fixar no config.

**Consequência arquitetural:** um único cliente HTTP serve todos. Não escreva adapters por provedor — escreva **um** cliente e uma **tabela de configuração**.

### 3.2 Preços verificados em **04/08/2026** (USD por 1M tokens)

> ⚠️ **Esses números envelhecem rápido.** Eles vivem em `src/server/providers.config.ts`, não espalhados pelo código. Reverifique nas URLs da §13 antes de confiar em qualquer projeção de custo.

| Modelo | Input (cache miss) | Input (cache hit) | Output | Contexto | Confiança |
|---|---|---|---|---|---|
| `deepseek-v4-flash` | $0,14 ⚠️ | $0,0028 ⚠️ | $0,28 ⚠️ | 1.048.576 | **Baixa** — ver nota 1 |
| `deepseek-v4-pro` | $0,435 ⚠️ | — | $0,87 ⚠️ | 1M | **Baixa** — ver nota 1 |
| `glm-4.7-flashx` | $0,07 | — | $0,40 | ? | Alta (docs Z.ai) |
| `glm-4.5-air` | $0,20 | — | $1,10 | ? | Alta (docs Z.ai) |
| `glm-4.7` | $0,60 | — | $2,20 | ? | Alta (docs Z.ai) |
| `glm-5` | $1,00 | — | $3,20 | ? | Alta (docs Z.ai) |
| `glm-5.2` | $1,40 | — | $4,40 | 1.048.576 | Alta |
| `glm-4.7-flash` | grátis | — | grátis | ? | Alta (docs Z.ai) |
| `kimi-k3` | $3,00 | $0,30 | $15,00 | 1.048.576 | Alta (docs Kimi) |

**Quatro leituras importantes desses dados:**

1. **Os preços do DeepSeek são o ponto fraco desta tabela — trate‑os como provisórios.** A página oficial de preços (`api-docs.deepseek.com`) estava inacessível desta máquina, então os valores vieram de busca. Uma checagem cruzada no catálogo do OpenRouter mostra `deepseek-v4-flash` a **$0,09 / $0,18** por 1M — divergente dos $0,14 / $0,28 acima. Pode ser desconto do agregador ou pode ser o número da busca estar errado. **Meça com uma chamada real antes de exibir custo ao usuário.**
2. **Os IDs de modelo do DeepSeek, esses sim, estão confirmados.** O site oficial e o catálogo do OpenRouter listam apenas **V4‑Flash** e **V4‑Pro**; `deepseek-chat` e `deepseek-reasoner` não aparecem em nenhum dos dois. Tutoriais que usam esses nomes antigos estão desatualizados. O OpenRouter expõe snapshots datados (`deepseek-v4-flash-0731`) e um alias `-latest` — decida no config se quer fixar snapshot (reprodutível) ou seguir o latest (sempre atual). Observação: o V4‑Pro **não** apareceu no catálogo do OpenRouter, só na API direta.
3. **Kimi K3 não é a opção barata.** A $3/$15 ele custa mais que a maioria dos modelos proprietários de gama média. Posicione‑o como "modelo caro para tarefas difíceis", não como economia. Os campeões de custo aqui são `glm-4.7-flashx` ($0,07) e o `deepseek-v4-flash`.
4. **Cache de prompt é o maior alavancador de economia**: DeepSeek cobra ~50× menos no cache hit. Isso torna *system prompts estáveis e no início da mensagem* uma decisão de arquitetura, não de estilo (§7.3).

### 3.3 Formato da configuração

```ts
// src/server/providers.config.ts — única fonte de verdade
export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-v4-flash', ctx: 1_000_000, in: 0.14, cachedIn: 0.0028, out: 0.28, reasoning: true },
      { id: 'deepseek-v4-pro',   ctx: 1_000_000, in: 0.435, out: 0.87, reasoning: true },
    ],
  },
  // glm, kimi, openrouter, ollama…
} satisfies Record<string, ProviderConfig>;
```

Uma flag `verifiedAt: '2026-08-04'` por provedor + um aviso na UI quando a data passar de 90 dias. Barato de implementar, evita mostrar custo errado ao usuário por meses.

**`ctx` é campo obrigatório, não opcional.** Ele alimenta o truncamento de contexto da §8.4 — um valor errado ou ausente quebra o corte **silenciosamente** (você só descobre quando a API devolve `context_length_exceeded` em produção). As janelas de GLM 4.5/4.6/4.7 não constavam na documentação consultada: descubra o valor real antes de habilitar cada modelo, e faça o tipo TypeScript exigir o campo para que esquecer não compile.

---

## 4. Arquitetura

```
Browser (React + Vite)
  │  POST /api/chat  (SSE)          ← nunca fala direto com o provedor
  ▼
Hono (Node 24)
  ├── /api/chat        → proxy de streaming, injeta a chave, normaliza erros
  ├── /api/models      → catálogo derivado de providers.config.ts
  ├── /api/conversations → CRUD em SQLite
  └── /*               → serve dist/ (build do Vite)
  │
  ▼  fetch com stream: true
Provedor (DeepSeek / GLM / Kimi / OpenRouter)
```

**Decisão de segurança:** as chaves ficam **no servidor** (`.env`), nunca no browser. Mesmo em uso local isso importa: evita chave em `localStorage` (exfiltrável por qualquer XSS via markdown malicioso — e você está renderizando conteúdo não confiável de LLM). Se em algum momento você optar por BYOK no browser para facilitar distribuição, **isso é um tradeoff consciente**, não um detalhe: documente e aceite.

**Fluxo de uma mensagem:**
1. Cliente envia `{conversationId, content, providerId, modelId}`.
2. Servidor carrega histórico do SQLite, aplica trimming de contexto (§8.4), monta o payload.
3. `fetch` com `stream: true` e `stream_options: {include_usage: true}`.
4. Servidor repassa os deltas como SSE, já normalizados em um envelope próprio:
   `{type: 'text'|'reasoning'|'usage'|'error'|'done', ...}`.
   Normalizar aqui — e não no cliente — é o que impede que diferenças entre provedores vazem para a UI.
5. Ao finalizar, servidor persiste mensagem + `usage` + custo calculado.

---

## 5. O núcleo difícil: renderização durante o streaming

Esta é a seção que decide se o projeto fica bom ou fica um demo. "Leve" e "LaTeX + código + streaming" estão em tensão direta — as bibliotecas de renderização *são* o peso.

### 5.1 Re‑render por token é o assassino de performance

Um stream token a token significa reparsear markdown incompleto a cada chunk. Renderização ingênua reparseia a mensagem inteira ~2.000 vezes.

**Estratégia:**
- Dividir a mensagem em **blocos** (parágrafo, fence de código, bloco de matemática) e memoizar cada bloco. Só o **último bloco** reparseia enquanto streama; os anteriores estão congelados.
- Fazer **batch dos chunks SSE** em ~50 ms (`requestAnimationFrame` ou throttle) em vez de setState por token. Ninguém percebe 50 ms; o navegador percebe muito.
- `content-visibility: auto` nas mensagens fora da viewport; virtualização só se a conversa passar de ~200 mensagens (não otimize antes).

### 5.2 Markdown incompleto durante o stream

Enquanto streama, o usuário vê estados intermediários inválidos: fence ``` aberta sem fechar, `$$` sem par, link `[texto](` pela metade. Sem tratamento, isso pisca como texto cru em toda mensagem.

**Estratégia:** o Streamdown já faz auto‑fechamento de sintaxe não terminada. **Valide esse comportamento no dia 1** com um teste que streama uma resposta contendo código + matemática caractere a caractere e verifica que nunca aparece `$$` ou ``` literal na tela. Se falhar, o fallback é um pré‑processador próprio que fecha fences/delimitadores abertos antes de cada parse.

### 5.3 LaTeX: os delimitadores são a armadilha real

**Problema:** modelos emitem matemática de forma inconsistente — `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, e às vezes blocos `\begin{align}`. O `remark-math` só entende `$` e `$$` por padrão.

**Estratégia — pipeline de normalização antes do parse:**
1. Converter `\(...\)` → `$...$` e `\[...\]` → `$$...$$`.
2. **Nunca aplicar a conversão dentro de code spans ou fences** — senão `\[i\]` em código Python vira matemática.
3. Exigir que `$` inline não tenha espaço logo após a abertura, para não transformar "custa $50 e depois $30" em matemática. Essa regra sozinha elimina a maior parte dos falsos positivos.
4. Detecção prévia: se a mensagem não contém nenhum delimitador de matemática, **não carregar o KaTeX**. Import dinâmico do renderer + CSS + fontes só no primeiro bloco de matemática da sessão.
5. `trust: false` e `strict: 'ignore'` no KaTeX (§5.5).

Reserve tempo explícito para isso no cronograma. É o bug que come uma semana quando não está no plano.

### 5.4 Highlighter: a decisão de peso

**Escolha: Shiki com bundle fine‑grained + engine JavaScript** (`createHighlighterCore` + `@shikijs/engine-javascript`), não o bundle completo.

Justificativa: o Shiki completo traz WASM (~250 KB) e centenas de gramáticas — inaceitável para "leve". A engine JS elimina o WASM; importar ~12 linguagens elimina o resto. Lista inicial: `ts, tsx, js, python, json, bash, sql, html, css, go, rust, markdown`. Linguagens fora da lista caem em texto simples — comportamento aceitável e silencioso.

Carregamento: `import()` dinâmico no **primeiro bloco de código** renderizado na sessão. Um tema só (`github-dark` + variáveis CSS para o modo claro), não dois.

**Validar no dia 1 da fase 2 (é bloqueador, não polimento):** verificar se o Streamdown aceita **injetar** uma instância própria de `createHighlighterCore` em vez de importar o Shiki completo por conta dele. Se não aceitar, o orçamento de peso desta seção e o critério de aceite de ≤ 250 KB gzip caem juntos — e a decisão vira usar o renderer de markdown direto (`react-markdown` + `remark-math` + plugin de highlight próprio) com o tratamento de streaming feito à mão (§5.1/§5.2). Descubra isso antes de construir a UI em cima, não depois.

Se mesmo assim ficar pesado na medição, o plano B é `highlight.js` com subset curado — visivelmente inferior, mas metade do peso e mais rápido.

### 5.5 Sanitização — requisito implícito, fácil de esquecer

Você está renderizando **saída não confiável de um modelo** como HTML. Isso é uma superfície de XSS real.

- HTML cru **desabilitado** no markdown (sem `rehype-raw`).
- `rehype-sanitize` (ou equivalente do Streamdown) com allowlist estrita.
- KaTeX com `trust: false` — sem isso, `\href` e `\includegraphics` viram vetor.
- Links externos: `rel="noopener noreferrer nofollow"`, `target="_blank"`.
- CSP no Hono: `default-src 'self'`, sem `unsafe-inline` para scripts.
- Botão "copiar" no bloco de código copia o **texto original**, não o DOM destacado.

---

## 6. Contabilidade de custo — a tese do produto

Não é feature extra; é a razão de o projeto existir. Entra no schema e na UI desde a fase 1.

- Pedir `stream_options: {include_usage: true}` em toda chamada streamada. Sem isso, o chunk final de `usage` simplesmente não vem em endpoints OpenAI‑compatíveis. **Verifique provedor a provedor** — a compatibilidade desse campo específico varia mais que o resto.
- **Fallback obrigatório:** se `usage` não vier, estimar com um tokenizador aproximado (`gpt-tokenizer` ou heurística de ~4 chars/token) e **marcar o registro como estimado**. Custo estimado exibido como exato é pior que não exibir.
- Contabilizar separadamente `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens` (nomes variam — normalize no servidor) e **tokens de raciocínio**, que são cobrados como output.
- UI: custo por mensagem (discreto, no rodapé da bolha), total da conversa no cabeçalho, e uma tela de agregados por dia/modelo. Um `SELECT` com `GROUP BY`, não um dashboard de BI.

---

## 7. Detalhes de provedor que mudam o design

### 7.1 Modelos de raciocínio
DeepSeek V4 (thinking) e similares retornam o raciocínio em um campo separado (`reasoning_content`), não no `content`. Precisa de: canal `reasoning` no envelope SSE, bloco recolhível "Raciocínio" na UI (fechado por padrão, aberto com contador de tokens), e contagem desses tokens no custo.

### 7.2 Erros normalizados
Mapeie no servidor para um enum próprio, com mensagem acionável em PT‑BR:
`RATE_LIMIT` (429) · `INSUFFICIENT_BALANCE` · `CONTEXT_LENGTH_EXCEEDED` · `INVALID_API_KEY` · `MODEL_NOT_FOUND` · `UPSTREAM_TIMEOUT` · `UNKNOWN`.
Retry com backoff exponencial + jitter **apenas** em 429 e 5xx, no máximo 2 tentativas, e **nunca** depois que o primeiro token já foi emitido (senão o usuário vê a resposta duplicar).

### 7.3 Cache de prompt
Com DeepSeek cobrando 50× menos em cache hit, vale desenhar o payload para maximizar prefixo estável: system prompt fixo primeiro, histórico depois, mensagem nova por último. Nunca injetar timestamp ou ID variável no system prompt — isso invalida o cache inteiro a cada requisição.

---

## 8. Persistência e robustez

### 8.1 Schema (SQLite via `node:sqlite`)

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT, provider_id TEXT, model_id TEXT,
  system_prompt TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT, content TEXT, reasoning TEXT,
  provider_id TEXT, model_id TEXT,
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
  cost_usd REAL, cost_estimated INTEGER DEFAULT 0,
  finish_reason TEXT, error_code TEXT,
  created_at INTEGER, latency_ms INTEGER
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=rowid);
```

`PRAGMA journal_mode=WAL` e `PRAGMA foreign_keys=ON` na abertura. FTS5 dá busca full‑text nas conversas de graça — vem embutido no SQLite.

### 8.2 Cancelamento
`AbortController` ponta a ponta: botão "Parar" → `abort()` no fetch do cliente → Hono detecta `request.signal` abortado → `abort()` no fetch upstream. Sem isso você continua **pagando** por tokens que ninguém vai ler. Persistir a resposta parcial com `finish_reason: 'aborted'`.

### 8.3 Timeouts
Timeout de conexão de 30 s e timeout de *inatividade do stream* de 60 s (não timeout total — respostas longas legitimamente demoram minutos).

### 8.4 Janela de contexto
Antes de enviar: estimar tokens do histórico; se passar de ~70% da janela do modelo, cortar as mensagens mais antigas mantendo sempre o system prompt e as N últimas trocas. Avisar na UI que houve truncamento. Sumarização automática do histórico antigo fica para depois — é uma chamada extra de API e portanto custo extra, o oposto do objetivo.

---

## 9. Estrutura de pastas

```
projeto-chat/
├─ src/
│  ├─ server/
│  │  ├─ index.ts              # Hono: rotas + estáticos
│  │  ├─ providers.config.ts   # ÚNICA fonte de verdade de modelos e preços
│  │  ├─ llm-client.ts         # um cliente OpenAI-compatível para todos
│  │  ├─ stream.ts             # SSE, envelope normalizado, abort
│  │  ├─ cost.ts               # cálculo + fallback estimado
│  │  ├─ errors.ts             # normalização de erros
│  │  └─ db/{schema.sql,queries.ts}
│  ├─ client/
│  │  ├─ components/{ChatView,MessageBubble,Composer,ModelPicker,CostBadge,ReasoningBlock}.tsx
│  │  ├─ render/{Markdown.tsx,math-normalize.ts,highlighter.ts}
│  │  ├─ store/{chat.ts,settings.ts}
│  │  └─ main.tsx
│  └─ shared/types.ts          # envelope SSE, contratos Zod
├─ .env.example
└─ chat.db
```

---

## 10. Roadmap por fases (com critério de aceite em cada uma)

| Fase | Escopo | Pronto quando |
|---|---|---|
| **0 — Esqueleto** (~½ dia) | Vite + React + Hono servindo `dist/`, Tailwind, `node:sqlite` inicializado | `pnpm build && node dist/server.js` sobe em uma porta e responde |
| **1 — Streaming cru** (~1 dia) | `/api/chat` proxy SSE contra DeepSeek, texto puro na tela, `AbortController` | Token aparece < 1,5 s; botão Parar corta a cobrança de verdade |
| **2 — Renderização** (~2–3 dias) | Streamdown + normalização de LaTeX + Shiki lazy + sanitização | Suite de mensagens‑fixture (código, matemática inline/bloco, tabela, `$50`, `\[i\]` dentro de código) renderiza certo **streamando caractere a caractere** |
| **3 — Multi‑provedor** (~1 dia) | GLM + Kimi + OpenRouter via config, seletor de modelo, erros normalizados | Trocar de provedor no meio da conversa funciona sem recarregar |
| **4 — Custo** (~1 dia) | `include_usage`, cálculo, fallback estimado, badges e agregados | Custo por mensagem confere com o painel de faturamento do provedor |
| **5 — Persistência** (~1 dia) | CRUD de conversas, sidebar, busca FTS5, exportar Markdown | Fechar e reabrir preserva tudo; busca acha texto dentro de blocos de código |
| **6 — Raciocínio + polimento** (~1–2 dias) | Bloco recolhível de raciocínio, editar/reenviar, regenerar, atalhos, tema claro/escuro | Bundle inicial medido ≤ 250 KB gzip |

Fases 0–2 já entregam algo usável no dia a dia. Se o tempo acabar, pare na 4 — persistência é conforto, custo é a tese.

---

## 11. Se virar multiusuário: o que muda

Não construa isso agora; saiba o que quebra.

- **Custódia de chaves:** hoje uma chave no `.env`. Multiusuário exige chave por usuário criptografada em repouso (envelope encryption), ou uma chave da plataforma com **cota por usuário** — o que transfere o risco financeiro para você.
- **Auth:** algo simples e delegado (OAuth) em vez de senha própria; `user_id` em `conversations`.
- **Rate limiting e abuso:** limite por usuário e teto de gasto diário, aplicados no servidor. Sem isso, um usuário zera seu saldo em uma tarde.
- **Banco:** SQLite aguenta bem dezenas de usuários com WAL; acima disso, migrar para Postgres (o schema acima migra quase sem mudança).
- **Streaming em escala:** SSE segura um socket por resposta em andamento — dimensione conexões, não CPU.
- **Jurídico:** ToS, política de privacidade e a informação de que prompts trafegam por provedores em jurisdições específicas (relevante para LGPD).

---

## 12. Riscos e armadilhas conhecidas

| Risco | Mitigação |
|---|---|
| **Preços e IDs de modelo mudam rápido** (`deepseek-chat`/`deepseek-reasoner` sumiram do catálogo; V4‑Flash/Pro os substituíram) | Tudo em `providers.config.ts` com `verifiedAt`; aviso na UI após 90 dias |
| **Preço do DeepSeek divergente entre fontes** ($0,14/$0,28 vs. $0,09/$0,18 no OpenRouter) | Calibrar com chamada real + painel de faturamento antes da fase 4; até lá, marcar custo como estimado |
| `ctx` errado/ausente quebra o truncamento em silêncio | Campo obrigatório no tipo; validar contra o erro real do provedor |
| Streamdown puxar o Shiki completo e estourar o bundle | Checagem bloqueante no início da fase 2 (§5.4) |
| `include_usage` não suportado por algum provedor | Fallback de estimativa marcado como tal, desde a fase 4 |
| Delimitadores de LaTeX inconsistentes | Pipeline de normalização + suíte de fixtures (§5.3) |
| Peso do Shiki/KaTeX estourando "leve" | Import dinâmico, subset de linguagens, engine JS sem WASM, medição como critério de aceite |
| XSS via markdown do modelo | Sem HTML cru, sanitização, `trust:false`, CSP |
| Re‑render por token travando a UI | Memoização por bloco + batching de 50 ms desde a fase 2 |
| Endpoints CN vs. internacional divergindo | Base URL sempre por configuração, nunca hardcoded |
| Ficar pagando por geração cancelada | Abort ponta a ponta na fase 1, não depois |

---

## 13. Verificar antes de codar (preços e IDs)

Dados coletados em **04/08/2026**. Procedência, para você saber no que confiar:

| Fonte | Status | O que veio dela |
|---|---|---|
| https://docs.z.ai/guides/overview/pricing | ✅ lida direto | Toda a tabela GLM (preços confiáveis, janelas ausentes) |
| https://platform.kimi.ai/docs/pricing/chat-k3 | ✅ lida direto | `kimi-k3`: preços + janela de 1.048.576 |
| https://openrouter.ai/api/v1/models | ✅ lida direto | Confirmação dos IDs V4‑Flash, `kimi-k3`, `glm-5.2` e janelas |
| https://www.deepseek.com/ | ✅ lida direto | Confirma V4‑Flash/V4‑Pro; `deepseek-chat` ausente |
| https://api-docs.deepseek.com/quick_start/pricing | ❌ **conexão recusada** | Preços do DeepSeek vieram de busca — **não verificados** |

**Antes da fase 3**, faça uma chamada real de teste em cada provedor e compare o `usage` retornado com o painel de faturamento. Uma tarde gasta aqui evita um mês exibindo custo errado — e resolve de uma vez a divergência de preço do DeepSeek apontada na §3.2.

Faça uma chamada real de teste em cada provedor antes da fase 3 e compare o `usage` retornado com o painel de faturamento. Uma tarde gasta aqui evita um mês exibindo custo errado.
