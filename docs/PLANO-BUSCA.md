# Busca na web

Como os modelos consultam a web neste app, e por que as escolhas foram estas.

## A decisão de fundo: marcador, não tool calling

O caminho óbvio seria o campo `tools` da OpenAI. Ele foi descartado pela mesma
razão que o `effort.ts` documenta sobre os parâmetros de raciocínio:
**"OpenAI-compatible" para de valer exatamente nos extras.** Suporte a tool
calling varia por provedor e por modelo, vários endpoints devolvem 400 diante
do campo, e alguns aceitam o campo mas nunca emitem uma chamada — o pior dos
casos, porque falha em silêncio.

A premissa do produto é que o usuário aponta para **qualquer** endpoint
compatível. Um recurso que só funciona em parte do catálogo não serve.

Então a busca usa um marcador no próprio stream de texto, como os artefatos já
fazem:

```
<search>termos da consulta</search>
```

Funciona em todo modelo que sabe seguir instrução, que é o mesmo terreno em que
o protocolo de artefatos já se apoia.

## O laço

Uma resposta com busca chama o provedor mais de uma vez. Não há como o modelo
ver os resultados sem uma nova chamada com eles no contexto.

```
round 1  → modelo escreve "vou verificar" e fecha <search>café hoje</search>
           servidor busca
round 2  → modelo recebe os resultados e responde
```

- **Máximo de 3 buscas por resposta** (`MAX_SEARCH_ROUNDS`). O limite é dito ao
  modelo no prompt **e imposto no servidor** — prompt sem imposição é sugestão.
- **O texto depois do marcador é descartado.** Foi escrito sem os resultados;
  é chute.
- **O round continua sendo lido depois do marcador**, com teto de 4 000
  caracteres. Parece contraintuitivo — por que ler o que vai ser jogado fora? —
  mas é o que preserva a contagem exata de custo: o `usage` do provedor vem no
  último chunk. Abortar ali faria **toda** resposta com busca virar custo
  estimado, num recurso que justamente gasta mais.
- **O uso é somado entre os rounds** (`sumProviderUsage`). Um campo só entra na
  soma quando todos os rounds o informaram; se algum faltou, o campo é omitido
  e o cálculo cai na estimativa sobre o texto acumulado — aproximada, mas
  honesta, e já anunciada como estimativa.

## Invariantes

**A busca é resolvida por requisição, nunca em estado global.** Mesma regra de
`provider-resolution.ts`: `resolveSearch(userId, db)` monta a busca efetiva
dentro de cada requisição. Guardar a busca resolvida em módulo faria duas
requisições simultâneas de usuários diferentes compartilharem chave de
buscador — exatamente o que `setRuntimeProviders` fazia antes de ser removido.

**A chave da busca é cifrada com o dono no AAD, com espaço de nomes próprio.**
Formato v2 do `secrets.ts`, AAD = `userId:search:<backend>`. O prefixo
`search:` importa: sem ele, um usuário com um provedor personalizado chamado
`brave` teria o mesmo AAD para duas chaves diferentes.

**Sem busca utilizável, o prompt de busca não é injetado.** `resolveSearch`
devolve `null` para tudo — sem configuração, desligada, sem a chave que o
backend exige, sem a URL que o SearXNG exige. Prometer ao modelo uma
ferramenta que vai falhar é pior do que não oferecê-la: ele gasta o turno
pedindo algo que nunca chega.

**A busca nunca derruba a resposta.** `runSearch` não lança. Uma falha vira
resultado com `failure`, o modelo é informado de que não conseguiu consultar,
e o usuário vê a falha no cartão da busca em vez de ver a mensagem morrer.

**Só trechos, nunca a página.** Buscar o conteúdo de cada resultado seria a
evolução natural, e é por isso que ficou de fora: os endereços vêm de um
buscador, ou seja, de terceiros escolhidos por um modelo, e passariam a ser
alvos de fetch a partir do servidor. Ficar no snippet mantém a superfície de
SSRF restrita ao endpoint do próprio buscador.

**A tabela é própria, não uma linha em `provider_settings`.** Aquela tabela
tem id livre e chave cifrada, e daria para reusar. Mas ela alimenta
`resolveProvider` e o catálogo de modelos: uma linha de busca ali passaria a
depender de um filtro por id em cada consumidor, e esquecer o filtro em um só
ponto faria um buscador aparecer como provedor de chat.

## Backends

| Backend | Chave | URL do usuário | Observação |
| --- | --- | --- | --- |
| `brave` | obrigatória | não | Cabeçalho `x-subscription-token`. O trecho vem com `<strong>`, que é removido antes de entrar no prompt |
| `tavily` | obrigatória | não | Trechos já pensados para consumo por modelo |
| `searxng` | opcional | **sim** | Auto-hospedado. Exige `json` em `search.formats` no `settings.yml` da instância, senão responde 403 |

O endpoint do SearXNG é entrada hostil e passa por `ssrf.ts` **a cada busca**,
não só ao salvar — a mesma regra que o chat aplica ao endpoint do provedor.

## Migração

`005-busca` cria `search_settings`. Como toda migração aqui, **não roda
sozinha**: `pnpm db:migrate up` antes do primeiro deploy que inclua busca.

## Onde as coisas estão

| Arquivo | Papel |
| --- | --- |
| `src/server/search/protocol.ts` | Detector do marcador em stream e o prompt de sistema |
| `src/server/search/backends.ts` | Os três backends e a normalização dos resultados |
| `src/server/search/index.ts` | Resolução por requisição, execução e formatação para o modelo |
| `src/server/index.ts` | O laço de rounds dentro de `/api/chat` e as rotas de configuração |
| `src/client/components/SearchBlock.tsx` | As buscas e fontes dentro da mensagem |
| `src/client/components/SearchSettingsTab.tsx` | A aba de configuração |
