# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

Requer **Node 24.16+** e **pnpm 11**. O `package.json` declara esse engine; o alvo do build é `node24`.

```bash
pnpm dev                    # Vite (5173) + servidor tsx watch (8787), em paralelo
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run — 199 testes
pnpm build                  # cliente (dist/) + função da Vercel (api/entry.js) + dist/server.js
pnpm design                 # contraste + auditoria das proibições visuais
pnpm db:migrate status      # também: up --dry-run | up  (down não é suportado)
```

Um teste isolado:

```bash
pnpm vitest run src/server/secrets.test.ts
pnpm vitest run -t "isolamento de chaves"   # por nome do teste
pnpm test:watch
```

O proxy do Vite encaminha `/api` para `localhost:8787`, então em desenvolvimento frontend e API ficam na mesma origem e `APP_ORIGIN` pode ficar vazia.

`.github/workflows/ci.yml` roda typecheck, testes e build em push para `main` e em pull request. O `pnpm design` entra como `continue-on-error`: ele sai com código 1 pelas 18 divergências conhecidas do `SettingsPanel`, e um sinal permanentemente vermelho deixaria de ser sinal. Se for zerar essas divergências, torne-o obrigatório no mesmo commit.

## O que é

Chat self-hosted **BYOK** (cada usuário traz a própria chave) para qualquer endpoint **OpenAI-compatible**. A plataforma não tem créditos nem cobrança: ela orquestra, mede custo e isola contas. Login por Clerk (Google/e-mail).

## Arquitetura

**Duas entradas de servidor, um app.** `createApp()` em `src/server/index.ts` monta o Hono. `src/server/main.ts` é a entrada local e é **a única que escolhe o SQLite** — isso mantém `node:sqlite` fora do grafo de módulos da serverless, que quebrava a função no carregamento. `src/server/vercel-handler.ts` é empacotado por esbuild em `api/entry.js`; o `vercel.json` reescreve todo `/api/*` para essa função com o caminho original em `?__route=`.

**Um adaptador de banco, duas implementações.** `ChatDatabaseAdapter` (`src/server/db/database.ts`) tem SQLite (`db/queries.ts`) e Neon (`db/neon.ts`). Sem `DATABASE_URL`, é SQLite; com, é Postgres.

**Cliente.** React 19 + Zustand. Toda a lógica de conversa vive em `src/client/store/chat.ts`.

**Contrato compartilhado.** `src/shared/types.ts` define todos os schemas Zod usados pelos dois lados — inclusive os envelopes SSE. Mudanças de protocolo começam aqui.

## Invariantes que não podem ser quebradas

**`userId` é o primeiro parâmetro de todo método do banco.** O isolamento entre contas é imposto pela assinatura da interface, não por disciplina do chamador. Nunca adicione um método sem ele.

**Não existe catálogo global mutável de provedores.** `resolveProvider(userId, providerId, db)` monta o provedor efetivo *dentro de cada requisição*. `setRuntimeProviders` foi removido de propósito: com estado global, requisições simultâneas de usuários diferentes compartilhariam chave. Há um teste de concorrência com `Promise.all` guardando isso.

**As chaves são cifradas com o dono no AAD.** Formato `v2`, AES-256-GCM, AAD = `userId:providerId` (`secrets.ts`). A chave de um usuário é criptograficamente indecifrável no contexto de outro. Ela **nunca** volta ao navegador — a API expõe só `hasKey: boolean`.

**Nunca troque `PROVIDER_SECRET_KEY` depois de existirem chaves `v2`.** É irrecuperável. A migração `v1 → v2` valida cada chave antes de recifrar e **aborta sem alterações** se alguma falhar.

**Em produção, nenhuma chave de ambiente é usada.** `DEEPSEEK_API_KEY` e afins só valem em dev com `ALLOW_ENV_API_KEYS=true`. `allowEnvApiKeys()` retorna false sempre que `NODE_ENV=production` ou `VERCEL` existe.

**Custo ausente aparece como indisponível, nunca como zero.** Zero seria mentira. Valores estimados carregam `estimated: true` e a interface os distingue visualmente.

**Recurso de outro usuário devolve 404, não 403** — não confirma que existe.

**Os preços em `providers.config.ts` não são autoritativos.** Foram lidos em 04/08/2026, alguns por busca e não pela documentação oficial. Revalide antes de tratar qualquer número como projeção.

## Armadilhas conhecidas do deploy

**Corpo da requisição consumido pela plataforma.** Os request helpers da Vercel leem o stream para popular `req.body`; o adaptador do Hono monta a Request com `Readable.toWeb(incoming)`, então um stream drenado vira um corpo que nunca chega e `c.req.json()` espera para sempre — a função só morre no `maxDuration` de 300s. `requestWithRestoredBody()` em `vercel-handler.ts` reconstrói o corpo. **`config.api.bodyParser = false` não resolve**: é convenção do Next.js e não é honrada numa Function Node avulsa. Não remova a reconstrução achando que o `config` cobre.

**`PROVIDER_SECRET_KEY` é obrigatória na Vercel.** O disco da função não persiste, então a geração automática do `.provider-secret` é desligada quando `VERCEL` existe. Sem ela, o campo de chave aparece **desabilitado** na interface e o `PUT` responde 400.

**`APP_ORIGIN` é obrigatória em produção** e a checagem dispara pela presença da variável `VERCEL`, não pelo tipo do deployment — um preview sem ela lança 500 em toda requisição. Ao configurar variáveis, cuide para que Production e Preview tenham o mesmo conjunto.

**Migrações não rodam sozinhas.** Não há criação automática de tabelas em requisições. Banco Neon novo exige `pnpm db:migrate up` antes do primeiro deploy.

**`CLERK_PUBLISHABLE_KEY` (sem o prefixo `VITE_`) não é lida por nenhum código**, apesar de o README a listar. A que importa é `VITE_CLERK_PUBLISHABLE_KEY`, embutida no bundle **no momento do build** — alterá-la exige novo deploy.

## Convenções

Código, comentários, mensagens de erro e interface em **português**. Os comentários explicam *por que*, não *o quê*, e vários registram a falha concreta que motivou a decisão — preserve esse tom ao editar.

O sistema visual é normativo: `docs/DESIGN.md` define tokens e proibições, e `pnpm design` verifica contraste e violações. Nada de hexadecimal literal, `font-size` abaixo de 12px ou o tema padrão do mermaid (a paleta lavanda que o `DESIGN.md` existe para proibir, e que a auditoria **não** pega porque é injetada em runtime).

Endpoints informados pelo usuário são entrada hostil: `ssrf.ts` valida URL, DNS e redirecionamentos **a cada chamada**, não só ao salvar.

## Documentos

`docs/PLANO.md` (arquitetura e custo), `docs/PLANO-MULTIUSUARIO.md` (Clerk, isolamento, cifragem, migração), `docs/PLANO-ARTEFATOS.md` (protocolo de artefatos), `docs/PLANO-VERCEL-NEON.md` (deploy), `docs/DESIGN.md` (direção visual). O `scripts/db/README.md` fica junto das migrações, de propósito.
