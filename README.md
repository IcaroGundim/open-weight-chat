# Open Weight Chat

Cliente de chat self-hosted para provedores OpenAI-compatíveis, com streaming SSE, Markdown seguro, LaTeX, destaque de código, persistência SQLite/Postgres (Neon) e custo por mensagem.

## Serviço multiusuário

Este projeto virou um serviço multiusuário **BYOK** (bring your own key): cada pessoa entra com **Google ou e-mail via Clerk**, cadastra as **próprias chaves de provedor** em **Configurações → Provedores** e só vê as próprias conversas, provedores, artefatos e custos. Não há créditos nem cobrança na plataforma — e **nenhuma chave da plataforma é usada em produção**: a única fonte de chaves é o cadastro de cada usuário.

Deslogado, o app mostra a tela de login; depois de entrar, todas as chamadas a `/api/*` levam o token da sessão no header `Authorization` (inclusive o streaming SSE) e o servidor valida o token com o Clerk antes de qualquer acesso ao banco — sem sessão válida, a resposta é `401`. Recursos de outro usuário devolvem `404`, sem revelar que existem. A exceção é `/api/health`, que continua público e mínimo.

> Chaves de ambiente (`DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, `OPENROUTER_API_KEY`) funcionam **apenas em desenvolvimento**, com `ALLOW_ENV_API_KEYS=true` no `.env`. Em produção elas nunca são usadas, nem como fallback.

## Executar

Requer Node 24.16+ e pnpm 11.

1. Crie um app no painel do Clerk (https://dashboard.clerk.com) e copie `CLERK_SECRET_KEY` e `VITE_CLERK_PUBLISHABLE_KEY` para o `.env` (o Vite lê variáveis `VITE_*` do `.env`).
2. No painel do Clerk, habilite os provedores de login **Google** e **e-mail verificado**.
3. Rode:

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Abra `http://localhost:5173` e entre com sua conta. Em desenvolvimento, **sem `DATABASE_URL` o app usa SQLite como antes** (banco em `chat.db`). As chaves de provedor podem ser cadastradas pela interface — ou, só em dev, via `.env` com `ALLOW_ENV_API_KEYS=true`. Ollama pode ser usado sem chave em `http://localhost:11434/v1`.

Para produção:

```powershell
pnpm build
node dist/server.js
```

## Deploy na Vercel com Neon

O projeto usa SQLite quando `DATABASE_URL` não existe e troca automaticamente para o Neon na Vercel. O handler em `api/[...route].ts` mantém todas as rotas `/api/*` na mesma origem do frontend e preserva o streaming SSE.

No painel **Vercel → Project → Settings → Environment Variables**, configure:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | Connection string com pooling copiada em **Neon → Connect** |
| `PROVIDER_SECRET_KEY` | Segredo aleatório estável, com pelo menos 16 caracteres |
| `CLERK_SECRET_KEY` | Chave secreta do app Clerk (Dashboard → API Keys) — valida os tokens em `/api/*` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Chave publicável do Clerk (começa com `pk_`) — é lida pelo Vite **no build** |
| `CLERK_FRONTEND_API_ORIGIN` | Origem do frontend Clerk, ex.: `https://SEU-APP.clerk.accounts.dev` — o valor exato aparece no painel Clerk; o servidor a usa também para montar o CSP automaticamente |
| `APP_ORIGIN` | **Obrigatória em produção.** Origem pública exata do deploy, ex.: `https://SEU-PROJETO.vercel.app`, sem caminho/query/fragmento. É a única origem que recebe CORS para `/api/*`. |

**Variáveis `VITE_*` são embutidas no bundle no momento do build**: depois de alterá-las, é preciso rodar um novo build/deploy na Vercel para valerem. As demais são lidas em runtime.

`PROVIDER_SECRET_KEY` não é uma chave de provedor. Ela cifra as chaves de OpenRouter, DeepSeek etc. guardadas no Neon e precisa permanecer igual entre deploys. Para gerar uma no PowerShell sem exibi-la no histórico do shell:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copie o resultado diretamente para a variável da Vercel. Depois, faça um novo deploy; cada usuário cadastra os próprios provedores em **Configurações → Provedores** (as configurações do SQLite local não são copiadas automaticamente para o Neon).

O schema é versionado em `scripts/db/migrations` e aplicado com `pnpm db:migrate` — não há mais criação automática de tabelas em requisições. Para um banco Neon novo, rode `pnpm db:migrate up` antes do primeiro deploy; para um deploy que já tem dados, siga a seção abaixo.

Depois do deploy, abra `https://SEU-PROJETO.vercel.app/api/health`. A resposta pública correta é apenas `{"ok":true}`; detalhes de banco e armazenamento de chaves não são expostos.

O banco SQLite local é criado em `chat.db`, usa WAL/FTS5 e é ignorado pelo Git.

### Origem, CORS e provedores locais

Em produção, defina `APP_ORIGIN` com a origem HTTPS pública do frontend. A API só emite os cabeçalhos CORS para essa origem; no deploy usual da Vercel, frontend e `/api` compartilham a mesma origem. Em desenvolvimento, `APP_ORIGIN` pode ficar vazia porque o proxy do Vite encaminha `/api` para o backend local.

Ollama em `localhost` e qualquer URL `http`, loopback, privada, link-local ou de metadata são recusados em produção. Para oferecer Ollama no deploy, exponha um endpoint OpenAI-compatível HTTPS publicamente acessível e cadastre essa URL por usuário; o servidor continuará validando DNS e redirecionamentos antes de cada chamada.

## Migração do deploy existente

Se já existe um deploy com dados (conversas e provedores com chaves no formato antigo `v1`), a migração para o multiusuário segue este checklist:

1. **Proteja temporariamente o deploy atual** — ative a Vercel Deployment Protection ou similar, para ninguém usar o serviço aberto durante a transição.
2. **Faça backup do Neon** — painel Neon → Branches/Backups, ou `pg_dump`.
3. **Crie a conta do proprietário no Clerk** (login Google/e-mail) e copie o ID `user_...` (painel Clerk → Users).
4. **Defina `LEGACY_OWNER_CLERK_USER_ID=<user_...>`** na Vercel — apenas durante a migração.
5. **Rode as migrações**: `pnpm db:migrate status`, depois `pnpm db:migrate up --dry-run` (confira as contagens), depois `pnpm db:migrate up`. O script atribui as conversas e provedores antigos ao proprietário e recifra as chaves `v1` → `v2`; ele **aborta sem alterações** se alguma chave não puder ser lida.
6. **Configure as variáveis na Vercel** (incluindo as `VITE_*`) e faça um novo deploy.
7. **Valide**: o login do proprietário mostra o histórico antigo; um segundo usuário não vê nada do proprietário; cada um usa as próprias chaves.
8. **Remova `LEGACY_OWNER_CLERK_USER_ID`** depois da migração.

> ⚠️ **NUNCA troque `PROVIDER_SECRET_KEY` depois de haver chaves `v2` no banco.** As chaves são cifradas com ela (AES-256-GCM) e não poderão mais ser decifradas. A migração `v1 → v2` valida cada chave antes de recifrar e aborta sem alterações se alguma falhar — mas isso protege só a migração; uma troca posterior é irrecuperável.

> ⚠️ **Os preços deste repositório não são autoritativos.** O catálogo de modelos e preços está centralizado em [providers.config.ts](src/server/providers.config.ts) e foi lido em 04/08/2026 — os valores do DeepSeek em particular vieram de busca, não da documentação oficial, e divergem do que o OpenRouter publica. Provedores reprecificam e aposentam IDs com frequência (`deepseek-chat` sumiu do catálogo em julho/2026). **Revalide antes de usar qualquer número como projeção de custo.** A procedência de cada valor está em [PLANO.md §13](docs/PLANO.md).

## Nível de raciocínio

Modelos de raciocínio cobram os tokens que gastam pensando, então **quanto o modelo pensa é uma decisão de custo** — e fica ao lado do seletor de modelo, no cabeçalho, com cinco níveis: **Automático**, **Desligado**, **Baixo**, **Médio** e **Alto**.

Cada conversa guarda o próprio nível; **Configurações → Modelo** define com qual as novas nascem. O reflexo aparece no custo da mensagem e em `reasoningTokens`, que o app já mede.

**Automático é o padrão e não envia parâmetro nenhum** — o provedor decide. Isso é deliberado: o "OpenAI-compatible" diverge exatamente aqui (uns esperam `reasoning_effort`, o OpenRouter usa um objeto `reasoning`, o GLM usa `thinking`), e há endpoint que responde **400** a um campo que não conhece. A tradução por provedor está em [effort.ts](src/server/effort.ts) e **não é autoritativa**, pela mesma razão dos preços; se o provedor recusar a requisição por causa desses campos, o servidor a repete sem eles, para que a preferência nunca derrube a mensagem. Em modelo sem raciocínio o seletor aparece desabilitado, e nada é enviado.

## Conectar outros provedores

Além dos cinco embutidos (DeepSeek, GLM/Z.ai, Kimi, OpenRouter e Ollama), **qualquer endpoint OpenAI-compatível pode ser ligado** — OpenCode Zen, Groq, Together, Fireworks, um `llama.cpp` na sua rede. O cliente de streaming é um só; o que muda é `baseURL`, chave e id de modelo.

| Onde | Quando usar |
|---|---|
| **Configurações → Provedores** | O caminho normal — agora **por usuário**: cada conta cadastra as próprias chaves, que ficam cifradas no banco com contexto do usuário; os modelos aparecem automaticamente após a descoberta. |
| `providers.local.json` na raiz ou variável `CUSTOM_PROVIDERS` (mesmo JSON, uma linha) | **Somente desenvolvimento** (o arquivo é ignorado pelo Git). Em produção a plataforma não usa chaves de ambiente — a única fonte é o cadastro do usuário. |

### Chaves cadastradas pela interface

A chave sobe uma vez e é cifrada com **AES-256-GCM** no formato `v2`, com contexto autenticado `userId + providerId` — ou seja, a chave de um usuário não pode ser decifrada no contexto de outro. Fica guardada no banco e **nunca volta para o navegador** — a tela só informa se existe. Em desenvolvimento, a chave-mestra é criada automaticamente pelo servidor no arquivo local `.provider-secret` (ignorado pelo Git); **na Vercel a chave-mestra vem só de `PROVIDER_SECRET_KEY`**.

Ao salvar um provedor pela interface, o servidor consulta `GET <baseURL>/models`, grava os modelos retornados e atualiza o seletor do chat. Para configurar o OpenRouter, use o identificador `openrouter` e a URL base `https://openrouter.ai/api/v1`; não é preciso criar um duplicado. O provedor precisa expor esse endpoint no formato OpenAI-compatible; quando a resposta não informa a janela de contexto, o app usa uma estimativa conservadora de 131.072 tokens.

Se `.provider-secret` (ou `PROVIDER_SECRET_KEY`) for apagado ou perdido, as chaves antigas não poderão mais ser decifradas e precisarão ser cadastradas novamente. Inclua o arquivo junto com o banco em um backup privado. Nos arquivos de configuração (`providers.local.json` e `CUSTOM_PROVIDERS`) a regra continua sendo outra: ali só entra o *nome* da variável de ambiente, nunca a chave.

```json
[
  {
    "id": "opencode",
    "label": "OpenCode Zen",
    "baseURL": "https://opencode.ai/zen/v1",
    "apiKeyEnv": "OPENCODE_API_KEY",
    "verifiedAt": "2026-08-04",
    "models": [
      {
        "id": "COLOQUE-O-ID-DA-API",
        "label": "GPT 5.6 Luna",
        "ctx": 272000,
        "reasoning": true,
        "pricing": { "inputPerMillion": 0.2, "outputPerMillion": 1.2 }
      }
    ]
  }
]
```

Três regras que o validador aplica, todas com erro visível na interface — nada falha em silêncio:

- **A chave nunca entra no JSON.** Entra o *nome* da variável de ambiente em `apiKeyEnv`; a chave em si vai para o `.env`. Um campo `apiKey` faz o provedor ser recusado.
- **`ctx` é obrigatório.** É ele que dirige o corte de histórico; um valor ausente ou errado quebraria o truncamento em silêncio.
- **`pricing` é opcional.** Sem ele o custo aparece como indisponível — honesto — em vez de zero, que seria mentira. Sem `verifiedAt`, o provedor entra marcado como não verificado.

### Endpoints próprios e proteção SSRF

Endpoints OpenAI-compatíveis próprios passam por validação no servidor:

- **HTTPS obrigatório em produção**; credenciais embutidas na URL são rejeitadas.
- **Redirecionamentos e IPs/hosts privados, loopback, link-local, multicast e metadata são bloqueados**; a resolução DNS usa um agente de conexão restrito (proteção contra SSRF e DNS rebinding).
- Em desenvolvimento, somente `http://localhost` é permitido.

### Limites por usuário

Para proteger o custo de cada conta (BYOK), o servidor aplica limites por usuário, com contadores atômicos compartilhados entre instâncias (Postgres):

- **20 inícios de chat por minuto**;
- **5 descobertas de modelos por minuto**;
- **no máximo 2 streams ativos por usuário**;
- o catálogo descoberto é limitado a **500 modelos**.

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [docs/PLANO.md](docs/PLANO.md) | Decisões de arquitetura, provedores, custo e o roteiro original |
| [docs/PLANO-MULTIUSUARIO.md](docs/PLANO-MULTIUSUARIO.md) | Especificação do serviço multiusuário: Clerk, isolamento, cifragem v2, migração e deploy |
| [docs/DESIGN.md](docs/DESIGN.md) | Direção visual: tokens, regras, componentes e o porquê de cada escolha |
| [docs/PLANO-ARTEFATOS.md](docs/PLANO-ARTEFATOS.md) | Especificação da funcionalidade de artefatos |
| [docs/PLANO-VERCEL-NEON.md](docs/PLANO-VERCEL-NEON.md) | Handoff do deploy na Vercel com Neon: banco assíncrono e função sem estado |
| [CLAUDE.md](CLAUDE.md) | Memória do projeto para agentes: comandos, arquitetura e armadilhas conhecidas |

## Verificações

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm design
```

A direção visual — paleta, tipografia, componentes, regras e as decisões por trás delas — está em [docs/DESIGN.md](docs/DESIGN.md). `pnpm design` verifica contraste (`scripts/contrast.mjs`) e as proibições do sistema (`scripts/audit-design.mjs`).

O frontend usa `react-markdown` como fallback seguro, com `remark-math`/KaTeX lazy e Shiki lazy com engine JavaScript e linguagens curadas. HTML cru não é habilitado, links externos recebem `noopener noreferrer nofollow` e o CSP é aplicado pelo Hono, incluindo a origem do Clerk em `script-src`, `connect-src` e `frame-src`.
