# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

Requer **Node 24.16+** e **pnpm 11**. O `package.json` declara esse engine; o alvo do build é `node24`.

```bash
pnpm dev                    # Vite (5173) + servidor tsx watch (8787), em paralelo
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run — 478 testes (1 ignorado)
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

**Planilha não é documento de texto.** `attachments.kind = spreadsheet` guarda
o binário importado em `data_base64`, enquanto `spreadsheet_versions` guarda a
representação canônica esparsa editável. Toda leitura e escrita continua com
`userId` primeiro. O contexto normal recebe apenas amostras; uma seleção feita
na grade é recolocada junto da pergunta mais nova para não desaparecer no
aparo do histórico. Fórmulas são preservadas, não recalculadas. Limites:
3 MB no upload, 250.000 células preenchidas e 5.000 células por seleção.

**Em produção, nenhuma chave de ambiente é usada.** `DEEPSEEK_API_KEY` e afins só valem em dev com `ALLOW_ENV_API_KEYS=true`. `allowEnvApiKeys()` retorna false sempre que `NODE_ENV=production` ou `VERCEL` existe.

**Custo ausente aparece como indisponível, nunca como zero.** Zero seria mentira. Valores estimados carregam `estimated: true` e a interface os distingue visualmente.

**Recurso de outro usuário devolve 404, não 403** — não confirma que existe.

**Os parâmetros de raciocínio não são autoritativos, e por isso `auto` é o padrão.** "OpenAI-compatible" para de valer justamente no nível de esforço: cada provedor batizou o campo de um jeito (`reasoning_effort`, o objeto `reasoning` da OpenRouter, `thinking` no GLM) e parte devolve **400** diante de um campo desconhecido, o que derrubaria a mensagem inteira. A tradução vive só em `src/server/effort.ts`; `auto` não envia campo nenhum; e o `llm-client` repete a requisição **sem** esses campos quando o 400 reclama deles. Ao acrescentar um provedor, acrescente o dialeto lá — não espalhe o `if` pelo cliente HTTP.

**A busca na web é resolvida por requisição, como o provedor.** `resolveSearch(userId, db)` monta a busca efetiva dentro da requisição; não existe catálogo global. A chave usa AAD `userId:search:<backend>` — o prefixo separa o espaço de nomes do de provedores de chat, senão um provedor personalizado chamado `brave` colidiria com o buscador. Sem busca utilizável, o prompt de busca **não é injetado**: prometer ao modelo uma ferramenta que vai falhar faz ele gastar o turno pedindo algo que nunca chega. Detalhes em `docs/PLANO-BUSCA.md`.

**Busca é marcador no stream, não `tools` da OpenAI.** Pela mesma razão do esforço: o suporte a tool calling varia por provedor, alguns devolvem 400 e outros aceitam o campo sem nunca chamar. O modelo escreve `<search>consulta</search>`, o servidor busca e refaz a chamada com os resultados. Máximo de 3 buscas por resposta, **imposto no servidor** e não só pedido no prompt. O uso dos rounds é somado (`sumProviderUsage`) — cada round é uma cobrança, e ficar com o último faria o custo mentir para baixo.

**Gráfico é artefato com especificação JSON, e a paleta é validada, não escolhida.** `type="chart"` guarda `{type, x, series[]}`; JSON porque dado de gráfico é estruturado. Os tokens `--serie-1..6` foram validados por script contra as superfícies REAIS do app (banda de luminosidade, piso de croma, separação para daltonismo, contraste) — nos dois temas, com degraus próprios no escuro, nunca inversão automática. Três cores ficam abaixo de 3:1 contra o papel claro, e é por isso que o gráfico traz **tabela alternativa obrigatória**. Cor segue a POSIÇÃO da série, nunca a grandeza: reordenar não pode repintar. **Nunca dois eixos de valor** — a especificação não tem como declarar o segundo, de propósito. Barra sempre inclui o zero (comprimento é magnitude); linha e área acompanham o dado (codificam variação). Teto de 6 séries: a sétima cor teria de ser gerada, e cor gerada é indistinguível sob daltonismo.

**Mapa mental é um tipo de artefato, e seu conteúdo é lista indentada.** `type="mindmap"` guarda um roteiro em Markdown, não uma sintaxe de diagrama: o modelo já escreve lista aninhada bem, o formato sobrevive ao streaming pela metade (a árvore é remontada a cada pedaço) e continua legível na aba Fonte. O layout e o parser vivem em `src/client/render/mindmap.ts`, puros e testados; o SVG é desenhado à mão, sem biblioteca de grafo — uma árvore horizontal não tem colisão nem aresta cruzada para resolver.

**Migração que reconstrói tabela no SQLite tem de rodar fora da transação.** `Migration.outsideTransaction` existe por causa disso: `PRAGMA foreign_keys` é ignorado dentro de uma transação, e sem ele o `DROP TABLE artifacts` da 007 dispararia os `ON DELETE CASCADE` de `artifact_versions` e apagaria todas as versões. Quem liga a flag assume a atomicidade — a migração só é marcada como aplicada depois de terminar.

**O tipo de um anexo vem dos bytes, nunca do nome nem do `Content-Type`.** Os dois são informados pelo navegador e repetem o que o usuário mandar. A consequência concreta: um `.png` que na verdade é HTML, classificado como imagem, voltaria por `/api/attachments/:id` com `content-type: image/png` e executaria na origem do app. Por isso `attachments.ts` usa assinatura de arquivo, e por isso só `kind === 'image'` tem bytes servidos de volta — documento guarda apenas o texto extraído, que nunca é devolvido como arquivo.

**Documento vira texto no servidor; imagem vira parte de conteúdo.** `/chat/completions` não recebe binário, então PDF é extraído (`unpdf`) e entra no prompt cercado por marcadores — a cerca separa o documento do pedido, senão um arquivo com instruções dentro se confunde com o que o usuário está pedindo. O texto **não** é gravado em `messages.content`: esse campo é o que a interface mostra, e o usuário veria o PDF inteiro despejado dentro da própria pergunta. Ele é reinjetado a cada requisição em `conversationContext`.

**Visão não é consultada no catálogo, pelo mesmo motivo do esforço.** O `/models` padrão não informa a capacidade, então bloquear pelo flag erraria fechado. O `llm-client` manda as imagens, e se o endpoint devolver 400 reclamando delas refaz **uma vez** sem imagens, com aviso no texto para o usuário saber por que foram ignoradas.

**Upload é JSON com base64, não multipart.** Na Vercel o corpo é reconstruído a partir do que a plataforma já leu (`requestWithRestoredBody`), e esse caminho só é confiável para JSON — binário de multipart seria corrompido por `JSON.stringify`. O custo é ~33% de volume, já embutido no limite de 3 MB por arquivo, que por sua vez existe porque o corpo da requisição para em 4,5 MB.

**O OpenCode roteia por família de modelo, e só uma família serve.** O gateway do OpenCode (Zen e Go) responde em quatro protocolos no mesmo host: `/chat/completions` (OpenAI-compatible), `/messages` (Anthropic, para Claude e Qwen), `/responses` (Responses da OpenAI, para GPT) e `/models/{id}` (Google, para Gemini). Este app fala só o primeiro — um modelo das outras famílias não funciona pior, falha em toda mensagem. Por isso `src/server/opencode.ts` filtra a descoberta contra a lista explícita do catálogo. **A divisão não segue o nome do modelo:** `minimax-m3` é `/chat/completions` no Zen e `/messages` no Go; `grok-4.5` é o inverso. Regra por prefixo erra nos dois casos. O reconhecimento do gateway é pela **baseURL efetiva**, nunca pelo id do provedor — id é livre, e alguém pode registrar um provedor chamado `opencode` apontando para outro lugar.

**Zen e Go são dois provedores, não um com dois modos.** Mesma chave (`OPENCODE_API_KEY`), catálogos e **preços diferentes para o mesmo id** — `deepseek-v4-pro` custa 1,74 no Zen e 0,435 no Go por milhão de tokens de entrada. Um provedor só faria o custo mentir conforme o plano em uso.

**O OpenCode não tem OAuth para terceiros.** Não há fluxo de autorização publicado; o acesso programático é por chave de API (o Zed também lê chave, não faz login). `OpenCodeConnect.tsx` faz o que é possível: abre o console na aba certa e valida a chave no ato de colar, buscando o catálogo real. Não invente um fluxo de token aqui.

**A OpenRouter é um balanceador, e por isso o custo dela vem do uso, não da tabela.** O mesmo id de modelo é servido por endpoints com preços diferentes — no `z-ai/glm-5.2`, US$ 1,49 a 7,26 por milhão de saída entre 32 endpoints, medido em 07/08/2026. `usage.cost` traz o valor real da requisição (a OpenRouter sempre o envia; o `usage: {include: true}` da documentação antiga foi descontinuado), e `Cost.reported` marca essa procedência. A leitura é travada por `reportsCostUsd`, decidido pela **baseURL efetiva**: um endpoint qualquer que devolvesse `cost` na própria unidade viraria dólar marcado como exato, que é o pior estado possível para este número. `cost_details.upstream_inference_cost` **não** serve de total — é a parcela do provedor de origem, e usá-la informaria menos do que foi cobrado.

**A busca da OpenRouter é de outra natureza que os buscadores externos, e as duas não convivem.** Brave, Tavily e SearXNG são APIs que este servidor chama pelo protocolo de marcador: até três idas ao provedor, cada uma cobrada. `openrouter` é um plugin no próprio pedido (`plugins: [{id:'web'}]`) — ela busca, injeta e responde numa requisição só, sem chave de buscador, mas **só para modelos servidos por ela**. `ResolvedSearch.kind` separa os dois, e o prompt de marcador é injetado apenas no `external`: ligar os dois faria duas buscas e cobraria as duas. Com a nativa escolhida e um modelo de outro provedor, `resolveSearch` devolve `null` — a mesma invariante de sempre, não prometer ao modelo uma ferramenta que não chega. O custo da busca entra em `usage.cost`, o que é mais uma razão para o custo da OpenRouter não vir da tabela: a tabela não sabe da busca. Duas armadilhas já pagas: a OpenRouter **repete a lista inteira de anotações a cada chunk**, então as citações são acumuladas por URL e viram um cartão só no fim — emitir por chunk empilhava o mesmo resultado; e o scanner de `<search>` **só roda quando há busca externa** (`createPassthroughScanner` no resto), porque o marcador é uma convenção que este servidor pede no prompt: sem o pedido, um `<search>` no texto é o modelo falando sobre buscar, e cortar ali truncava a resposta e colava um "Limite de 3 buscas" sem sentido. Isso valia também para quem não configurou busca nenhuma. **O plugin não decide quando buscar:** ativado, ele busca em toda requisição, inclusive em "resuma este texto", e cobra cada uma — não há modo condicional (o que a OpenRouter oferece para isso é um server tool, com outro contrato). Por isso quem decide é o botão "Buscar" do compositor, `ChatRequest.webSearch`, que nasce desligado e vale para os **dois** caminhos: para quem escreve a pergunta, buscar ou não é uma decisão só. Ausente equivale a ligado, para não mudar o comportamento de quem chama a API direto.

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

`docs/PLANO.md` (arquitetura e custo), `docs/PLANO-MULTIUSUARIO.md` (Clerk, isolamento, cifragem, migração), `docs/PLANO-ARTEFATOS.md` (protocolo de artefatos), `docs/PLANO-VERCEL-NEON.md` (deploy), `docs/PLANO-BUSCA.md` (busca na web), `docs/DESIGN.md` (direção visual). O `scripts/db/README.md` fica junto das migrações, de propósito.
