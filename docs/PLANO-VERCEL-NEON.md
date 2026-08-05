# Plano de migração — Vercel + Neon

Documento de handoff. O app foi desenhado em [PLANO.md](PLANO.md) como "um processo, um disco, SQLite, self-hosted". Publicar na Vercel com Neon é uma mudança de forma, não de configuração: **banco local síncrono → banco remoto assíncrono**, e **processo persistente → função**. Cada uma dessas duas propaga por toda a camada de servidor.

---

## 0. Antes de tudo: o app ficará público com as suas chaves

Isto não é detalhe de implementação. É a decisão mais cara desta migração.

Hoje o app roda em `localhost` e as chaves ficam no processo do servidor — postura correta, documentada no README. Publicado na Vercel, **não há autenticação nenhuma**: não existe login, sessão, nem verificação de origem. `POST /api/chat` aceita qualquer requisição.

Consequência concreta: qualquer pessoa que descubra a URL — e uma URL `*.vercel.app` é descobrível — pode gastar o seu saldo de DeepSeek, Z.ai, Kimi ou OpenRouter até acabar. Não é hipótese: bots varrem deploys da Vercel procurando exatamente proxies de LLM abertos.

**Nenhum deploy público deve acontecer antes de uma das opções abaixo:**

| Opção | Esforço | Observação |
|---|---|---|
| **Vercel Password Protection** | minutos | Proteção nativa da plataforma, exige plano Pro. É a mais barata em tempo. |
| **Senha única via middleware** | ~1h | Cookie assinado + tela de senha. Um segredo em env var. Suficiente para uso pessoal. |
| **Teto de gasto no provedor** | minutos | Não impede o abuso, limita o prejuízo. Faça isso de qualquer forma. |
| **Auth de verdade** | dias | Só se virar produto — ver [PLANO.md §11](PLANO.md). |

O resto deste documento assume que uma dessas está no lugar.

---

## 1. Escolhas de plataforma

### 1.1 Driver do Neon

Duas opções, e a escolha depende do Fluid compute:

- **`pg` + PgBouncer (porta 6432) + `attachDatabasePool` de `@vercel/functions`** — recomendação atual da Vercel quando o Fluid compute está ligado, que é o padrão para funções Hono. O Fluid reaproveita instâncias quentes, o que torna o pool TCP seguro.
- **`@neondatabase/serverless`** — driver HTTP (`neon()`) para consultas avulsas, ou WebSocket (`Pool`) para transações. Vantagem em cold start; a regra dura é que `Pool`/`Client` precisam ser criados, usados e fechados **dentro do mesmo handler** — nunca no escopo do módulo.

**Recomendação: `@neondatabase/serverless` com o driver HTTP.** Motivo: as consultas deste app são todas avulsas e curtas, não há transação de múltiplas etapas, e o driver HTTP elimina a classe inteira de bugs de pool mal escopado. Se algum dia aparecer transação real, troque para `Pool` naquele caminho específico.

### 1.2 Runtime

Com o `node:sqlite` fora, **Node 24 deixa de ser requisito**. Ajuste `engines.node` para o que a Vercel oferece com estabilidade e remova a dependência implícita do 24.

### 1.3 Estrutura de deploy

```
api/index.ts        → handler Vercel que exporta o app Hono
vercel.json         → rewrites: /api/* para a função, resto para o SPA
dist/               → saída do Vite, servida como estático pela Vercel
```

O `serveStatic` do `@hono/node-server` (`src/server/index.ts:654`) **não roda na Vercel** — a plataforma serve o estático. Mantenha-o para `pnpm start` local, atrás de uma checagem de ambiente.

`src/server/index.ts` precisa exportar `createApp`/`app` sem efeitos colaterais de inicialização de servidor; o `startServer()` só roda no entrypoint local, o que já é o caso.

---

## 2. O schema em Postgres

Tradução direta, com as diferenças que importam:

| SQLite | Postgres | Motivo |
|---|---|---|
| `PRAGMA journal_mode`, `foreign_keys` | remover | não existem |
| `INTEGER` para timestamps | `bigint` | ms de epoch estoura `int4` |
| `REAL` | `double precision` | — |
| `INTEGER CHECK (x IN (0,1))` | `boolean` | `archived`, `cost_estimated`, `truncated` |
| `TEXT PRIMARY KEY` | `text primary key` | ids são UUID em texto |
| FTS5 + gatilhos | `tsvector` + índice GIN | §3 |

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  title text,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  system_prompt text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  archived boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('system','user','assistant')),
  content text NOT NULL DEFAULT '',
  reasoning text,
  provider_id text,
  model_id text,
  prompt_tokens integer,
  cached_tokens integer,
  completion_tokens integer,
  reasoning_tokens integer,
  total_tokens integer,
  cost_usd double precision,
  cost_estimated boolean NOT NULL DEFAULT false,
  finish_reason text,
  error_code text,
  created_at bigint NOT NULL,
  latency_ms integer,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_tsv ON messages USING gin(content_tsv);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('markdown','code','svg','mermaid')),
  language text,
  title text NOT NULL,
  current_version integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (conversation_id, slug)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','rewrite','update')),
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  output_tokens integer,
  cost_usd double precision,
  truncated boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
  PRIMARY KEY (artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_tsv ON artifact_versions USING gin(content_tsv);
```

> **Coluna gerada elimina os seis gatilhos.** No SQLite, manter o índice FTS em dia exigia `_ai`/`_ad`/`_au` por tabela. Em Postgres, `GENERATED ALWAYS AS ... STORED` faz isso sozinho, sem chance de sair de sincronia. É o único ponto em que a migração simplifica o código em vez de complicar.

**Aplicação do schema:** não rode `CREATE TABLE` em toda invocação de função. Use um script `pnpm db:migrate` executado manualmente contra a `DATABASE_URL`, ou o console SQL do Neon. Uma função serverless não é lugar de migração.

---

## 3. Busca: FTS5 → `tsvector`

`escapeFtsQuery` ([`queries.ts:331`](../src/server/db/queries.ts)) existe para domar a sintaxe do FTS5. Em Postgres ele **sai inteiro** e é substituído por `websearch_to_tsquery('portuguese', $1)`, que aceita entrada de usuário crua com semântica de buscador (aspas, `or`, `-`) e não explode com caracteres especiais.

O `searchConversations` mantém a mesma forma — união dos dois índices, com o `JOIN` que filtra pela versão corrente do artefato (a regra de deduplicação de [PLANO-ARTEFATOS.md §4.2](PLANO-ARTEFATOS.md)):

```sql
SELECT c.*, COUNT(m.id) AS message_count, COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd
  FROM (
    SELECT conversation_id FROM messages WHERE content_tsv @@ websearch_to_tsquery('portuguese', $1)
    UNION
    SELECT a.conversation_id
      FROM artifact_versions av
      JOIN artifacts a ON a.id = av.artifact_id AND av.version = a.current_version
     WHERE av.content_tsv @@ websearch_to_tsquery('portuguese', $1)
  ) matched
  JOIN conversations c ON c.id = matched.conversation_id
  LEFT JOIN messages m ON m.conversation_id = c.id
 GROUP BY c.id
 ORDER BY c.updated_at DESC, c.id DESC;
```

Remova `escapeFtsQuery` e o teste que o cobre; acrescente um teste que passa `"aspas" -menos or ou` e confirma que não lança.

---

## 4. A camada de dados vira assíncrona — e isso propaga

`ChatDatabase` tem **14 métodos públicos, todos síncronos**, sobre `DatabaseSync.prepare().get()/.all()/.run()`. Todos viram `async`. A propagação:

| Arquivo | O que muda |
|---|---|
| `src/server/db/queries.ts` | reescrita completa: driver, SQL com `$1` em vez de `?`, `boolean` em vez de 0/1, `bigint` chegando como string no `pg` (converta com `Number`) |
| `src/server/index.ts` | **toda rota** vira `await`; o laço de `/api/chat` já é `async`, mas `db.insertMessage`, `db.updateMessage`, `db.upsertArtifact`, `db.insertArtifactVersion`, `db.getArtifacts` passam a exigir `await` dentro de `consumeParserEvents` |
| testes de servidor | `queries.test.ts`, `artifacts.test.ts`, `index.test.ts` precisam de um Postgres real ou de um duplo de teste |

**A armadilha silenciosa:** `persistPartial()` ([`index.ts:313`](../src/server/index.ts)) grava a cada **250ms ou 1.000 caracteres** durante o streaming. Em SQLite local isso é gratuito. Contra um Postgres remoto, é um `UPDATE` pela rede a cada 250ms — latência somada dentro da função (que você paga por segundo) e escrita amplificada no banco.

**Ajuste obrigatório:** subir o intervalo para ~2s e o limiar para ~4.000 caracteres, e garantir que o `persistPartial(true)` do `finally` continue existindo para não perder a cauda. Sem isso, uma resposta de 2 minutos gera ~480 escritas remotas.

---

## 5. Streaming em função

O Hono tem adaptador oficial para Vercel e o `streamSSE` funciona; as rotas viram Vercel Functions com Fluid compute por padrão.

- `export const maxDuration` na função — o teto com Fluid chega a 800s em Pro/Enterprise. Ajuste ao pior caso de um modelo de raciocínio.
- **Custo de infra proporcional ao uso:** a função fica executando enquanto o modelo pensa. Uma resposta de 2 minutos custa 2 minutos de execução. Num app cuja tese é reduzir custo de IA, some isso ao custo por mensagem antes de concluir que ficou mais barato.
- O `AbortController` ponta a ponta ([PLANO.md §8.2](PLANO.md)) fica **mais** importante: cancelar agora economiza tokens **e** tempo de função.

---

## 6. Variáveis de ambiente na Vercel

`DATABASE_URL` (Neon, com pooling), `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, `OPENROUTER_API_KEY`, e o segredo da proteção da §0. `CHAT_DB_PATH` deixa de existir.

Configure pelo painel da Vercel — **não** commite nenhuma delas. Atualize o `.env.example` para refletir a nova lista.

---

## 7. Dev local

Duas opções, e vale decidir explicitamente:

- **Apontar o dev para um branch do Neon** — um só caminho de código, nenhuma divergência entre dev e produção. Custa uma conexão de rede em cada consulta local.
- **Manter os dois drivers atrás da mesma interface** — dev rápido e offline, ao preço de manter duas implementações de 14 métodos em sincronia, e de bugs que só aparecem em produção.

**Recomendação: branch do Neon.** A divergência entre dev e produção é exatamente o tipo de bug que aparece no deploy e não no teste.

---

## 8. Fases

| Fase | Escopo | Pronto quando |
|---|---|---|
| **0 — Proteção** (~1h) | §0: senha ou Password Protection + teto de gasto no provedor | A URL do deploy exige segredo antes de chegar em `/api/chat` |
| **1 — Schema** (~1h) | SQL da §2 aplicado num branch do Neon, script `db:migrate` | `\d messages` mostra `content_tsv` e o índice GIN |
| **2 — Camada de dados** (~3–4h) | `queries.ts` reescrito e assíncrono | Testes de banco passam contra o Neon |
| **3 — Propagação** (~2h) | `await` em todas as rotas, `persistPartial` reajustado (§4) | `pnpm typecheck` e `pnpm test` verdes |
| **4 — Função** (~1–2h) | `api/index.ts`, `vercel.json`, `serveStatic` condicionado, `maxDuration` | Deploy responde `/api/models` e serve o SPA |
| **5 — Streaming** (~1h) | Verificar SSE ponta a ponta em produção | Resposta longa chega token a token, sem buffer, e o botão Parar corta de verdade |
| **6 — Busca** (~1h) | `websearch_to_tsquery`, remoção do `escapeFtsQuery` | Buscar trecho dentro de artefato encontra a conversa |

---

## 9. Riscos

| Risco | Mitigação |
|---|---|
| **App público queimando suas chaves** | §0 — bloqueia o deploy, não é opcional |
| `persistPartial` a cada 250ms contra banco remoto | Intervalo para 2s / 4.000 chars (§4) |
| Custo de função durante o streaming | Medir e somar ao custo por mensagem; `maxDuration` ajustado |
| `Pool` criado fora do handler | Driver HTTP evita a classe inteira (§1.1) |
| `bigint` chegando como string | Converter em `rowTo*`; um teste que verifica `typeof createdAt === 'number'` |
| Divergência dev/produção | Um driver só, branch do Neon (§7) |
| Migração rodando em função | Script manual (§2) |
| Busca em português sem acento | `to_tsvector('portuguese', …)` já faz stemming; validar com um termo acentuado |
