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

## Conectar outros provedores

Além dos cinco embutidos (DeepSeek, GLM/Z.ai, Kimi, OpenRouter e Ollama), **qualquer endpoint OpenAI-compatível pode ser ligado** — OpenCode Zen, Groq, Together, Fireworks, um `llama.cpp` na sua rede. O cliente de streaming é um só; o que muda é `baseURL`, chave e id de modelo.

Três formas, que podem coexistir:

| Onde | Quando usar |
|---|---|
| **Configurações → Provedores** | O caminho normal: cadastra um provedor novo ou configura um embutido (como OpenRouter) pela interface; os modelos aparecem automaticamente. |
| `providers.local.json` na raiz | Configuração versionável fora do Git, útil em desenvolvimento. |
| Variável `CUSTOM_PROVIDERS` (mesmo JSON, uma linha) | Deploy em plataformas que só aceitam variáveis de ambiente. |

### Chaves cadastradas pela interface

A chave sobe uma vez, é cifrada com **AES-256-GCM** e guardada no banco. **Ela nunca volta para o navegador** — a tela só informa se existe. A chave-mestra é criada automaticamente pelo servidor no arquivo local `.provider-secret`, que já está ignorado pelo Git. `PROVIDER_SECRET_KEY` continua disponível apenas como sobrescrita opcional para instalações que já têm uma chave-mestra própria.

Ao salvar um provedor pela interface, o servidor consulta `GET <baseURL>/models`, grava os modelos retornados e atualiza o seletor do chat. Para configurar o OpenRouter, use o identificador `openrouter` e a URL base `https://openrouter.ai/api/v1`; não é preciso criar um duplicado. O provedor precisa expor esse endpoint no formato OpenAI-compatible; quando a resposta não informa a janela de contexto, o app usa uma estimativa conservadora de 131.072 tokens.

Se `.provider-secret` for apagado ou perdido, as chaves antigas não poderão ser decifradas e precisarão ser cadastradas novamente. Inclua esse arquivo junto com o banco em um backup privado. Nos dois arquivos de configuração (`providers.local.json` e `CUSTOM_PROVIDERS`) a regra continua sendo outra: ali só entra o *nome* da variável de ambiente, nunca a chave.

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
