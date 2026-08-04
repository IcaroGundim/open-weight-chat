# Open Weight Chat

Cliente de chat self-hosted para provedores OpenAI-compatíveis, com streaming SSE, Markdown seguro, LaTeX, destaque de código, persistência SQLite e custo por mensagem.

## Executar

Requer Node 24.16+ e pnpm 11.

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Abra `http://localhost:5173`. As chaves ficam apenas no processo Node; configure no `.env` `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY` e/ou `OPENROUTER_API_KEY`. Ollama pode ser usado sem chave em `http://localhost:11434/v1`.

Para produção:

```powershell
pnpm build
node dist/server.js
```

O banco é criado em `chat.db`, usa WAL/FTS5 e é ignorado pelo Git.

> ⚠️ **Os preços deste repositório não são autoritativos.** O catálogo de modelos e preços está centralizado em [providers.config.ts](src/server/providers.config.ts) e foi lido em 04/08/2026 — os valores do DeepSeek em particular vieram de busca, não da documentação oficial, e divergem do que o OpenRouter publica. Provedores reprecificam e aposentam IDs com frequência (`deepseek-chat` sumiu do catálogo em julho/2026). **Revalide antes de usar qualquer número como projeção de custo.** A procedência de cada valor está em [PLANO.md §13](PLANO.md).

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [PLANO.md](PLANO.md) | Decisões de arquitetura, provedores, custo e o roteiro original |
| [DESIGN.md](DESIGN.md) | Direção visual: tokens, regras, componentes e o porquê de cada escolha |
| [PLANO-ARTEFATOS.md](PLANO-ARTEFATOS.md) | Especificação da funcionalidade de artefatos |

## Verificações

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm design
```

A direção visual — paleta, tipografia, componentes, regras e as decisões por trás delas — está em [DESIGN.md](DESIGN.md). `pnpm design` verifica contraste (`scripts/contrast.mjs`) e as proibições do sistema (`scripts/audit-design.mjs`).

O frontend usa `react-markdown` como fallback seguro, com `remark-math`/KaTeX lazy e Shiki lazy com engine JavaScript e linguagens curadas. HTML cru não é habilitado, links externos recebem `noopener noreferrer nofollow` e o CSP é aplicado pelo Hono.
