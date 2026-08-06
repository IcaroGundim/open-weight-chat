# Direção visual — "Bancada"

Documento normativo do frontend do Open Weight Chat. É a fonte de verdade da estética: cores, tipografia, espaçamento, componentes, voz e movimento. **Se um componente novo contradiz este arquivo, o componente está errado.**

Implementação: [`src/client/styles.css`](../src/client/styles.css) · Verificação: `node scripts/contrast.mjs` e `node scripts/audit-design.mjs`

---

## 1. Por que este documento existe

### AI slop, primeira geração

O visual que um gerador produz quando ninguém decidiu nada: gradiente roxo→azul, `Inter` em tudo, borda cinza de 1px em cada card, três cards de feature em linha, `border-radius: 12px`, ícone em círculo pastel, dark mode que ninguém pediu, defaults do shadcn. O roxo tem origem rastreável — `indigo-500` foi a cor inicial do Tailwind desde 2019 e dominou o corpus de treino.

### AI slop, segunda geração

Mais perigoso, porque é o que sai **quando você pede "evite AI slop"**: o pastiche suíço-editorial. Micro-labels em mono maiúsculo com `letter-spacing: 0.12em` em cada seção, numeração decorativa `01 / 02 / 03`, hairlines por toda parte, `border-radius: 0` como declaração de princípios, uma serifada de display gigante. Também é uma média — só que de outro corpus. Esta interface já teve essa versão; ela foi substituída.

### A regra que sustenta as outras

A raiz do slop não é feiura. É **ausência de decisão**. Um gerador prevê o mais provável; o mais provável é a média. A defesa é decidir explicitamente e manter escrito. As seções abaixo são as decisões.

---

## 2. Tese

Isto não é um app de conversa de consumo. É uma **bancada com medidor**: você escolhe o modelo, lê a resposta e vê o que ela custou. Duas consequências governam todo o resto:

**1. O que se lê domina.** A resposta do assistente é o objeto mais importante da tela. Tudo o mais recua. A mensagem do usuário é uma superfície discreta, não um bloco de cor saturada — o elemento mais gritante da tela nunca deve ser a fala de quem já sabe o que escreveu.

**2. O que se mede é tipografado como instrumento.** Custo, tokens, janela de contexto e horários usam mono com algarismos tabulares, sempre no mesmo lugar. **Mono significa "isto é um valor medido".** Nunca é decoração.

---

## 3. Regras

### 3.1 Proibido

| Regra | Motivo |
|---|---|
| ~~Gradientes (`linear-gradient`, `radial-gradient`)~~ | **Revogado em 05/08/2026 — ver §3.3.** Continua proibido como preenchimento decorativo de fundo, que é a forma do tell |
| `Inter` nomeada na pilha de fontes | Tell nº 2; a pilha de sistema resolve melhor e pesa zero |
| Mono para rótulos, títulos, botões ou eyebrows | Mono só mede — ver §2 |
| `text-transform: uppercase` com `letter-spacing` | O tique da segunda geração |
| Numeração decorativa de itens (`01`, `02`, `03`) | Decoração sem função |
| Texto abaixo de 12px | Piso de legibilidade |
| Emoji na interface | — |
| Sombra colorida, glassmorphism, `backdrop-filter` | — |
| `window.alert` / `prompt` / `confirm` | Diálogo nativo é o tell mais alto de UI inacabada |
| Cor literal fora dos tokens | Se não é variável, não entra (exceção única em §9.3) |
| ~~Framework de CSS ou biblioteca de componentes~~ | **Revogado em 05/08/2026 — ver §3.3** |

### 3.2 Obrigatório

- **Hierarquia por tamanho, peso e cor** — nunca por caixa alta.
- **Uma cor de ação: a tinta.** Botão primário é `--ink` com texto `--on-ink`. Atemporal, e não é o que um gerador escolhe sozinho.
- **Vinho é sinalização, não preenchimento:** foco, link, item ativo, indicador de streaming, valores de custo, estado selecionado. Nunca fundo de botão grande.
- **Separação por tom de superfície**, não por hairline em tudo. Hairline só onde há mudança real de função.
- **Algarismos tabulares** (`font-variant-numeric: tabular-nums`) em toda mono, para que valores não dancem durante o streaming.
- **Medida de leitura só para prosa:** parágrafos, listas, citações e títulos da resposta param em 72ch. Código, tabelas e matemática usam a coluna inteira — estreitá-los não ajuda ninguém a ler.
- **Uma sombra só** (`--shadow`), exclusiva de overlay e barra lateral móvel.
- **Contraste verificado por cálculo**, não por olho. Mínimos em §10.
- **Todo rótulo de atalho corresponde a um atalho real.** Um `<kbd>` que mente é pior que sua ausência.

### 3.3 Revogação de 05/08/2026 — biblioteca de componentes e gradientes

Duas linhas da §3.1 foram revogadas por decisão do dono do produto: **biblioteca de componentes** e **gradientes**. O `@usefragments/ui` (construído sobre a Base UI headless) passa a ser permitido, e com ele o efeito de feixe cônico animado do componente `Prompt`.

O motivo é de produto, não de estética: a tela de login é o primeiro contato, e a decisão foi trocar sobriedade por impacto ali. A Base UI ainda entrega foco, papéis ARIA e teclado prontos — o que a §3.1 tratava como custo é, nessa camada, benefício.

**O que a revogação não anula**, porque é a tese e não a regra:

1. **A identidade continua sendo a daqui.** Os componentes da biblioteca são vestidos com os tokens do projeto pelas variáveis `--fui-*` — nunca com o acento, a fonte ou o raio padrão dela. `Inter` na pilha de fontes segue proibido.
2. **Gradiente como efeito, não como preenchimento.** O feixe animado marca um estado (o campo de entrada, vivo). Fundo de seção em `linear-gradient` roxo→azul continua sendo o tell nº 1, e continua fora.
3. **A §13.5 não mudou.** Se a tela ficaria idêntica em qualquer outro app de chat, ela ainda não tem decisão dentro.

Escopo inicial: a tela de login.

**Estendido em 06/08/2026 ao seletor de modelo do chat**, com motivo próprio: um provedor BYOK real devolve cerca de 400 modelos, e um `<select>` nativo com essa lista é inutilizável. O `Combobox` traz busca, navegação por teclado e papéis ARIA prontos da Base UI — resolver isso à mão custaria mais e acertaria menos. Os componentes dentro do chat são vestidos pelo bloco `--fui-*` em `.chat-app`, do mesmo modo que os do painel de login.

---

## 4. Cor

### 4.1 Tema claro (padrão do produto)

| Token | Valor | Uso |
|---|---|---|
| `--paper` | `#FCFAF7` | canvas principal |
| `--surface` | `#F3EEE6` | superfície recuada: mensagem do usuário, hover, abas, raciocínio |
| `--surface-2` | `#E8E0D4` | segundo nível: cabeçalho de tabela, trilho de barra, rodapé de ficha |
| `--rule` | `#DCD2C4` | hairline decorativa |
| `--rule-strong` | `#94836F` | borda funcional de campo/controle — 3.51:1 |
| `--ink` | `#1B1512` | texto principal **e** fundo do botão primário — 17.34:1 |
| `--ink-2` | `#544840` | texto secundário — 8.48:1 |
| `--ink-3` | `#756860` | texto terciário — 5.16:1 |
| `--on-ink` | `#FCFAF7` | texto sobre tinta e sobre erro |
| `--wine` | `#7A2338` | acento: foco, link, ativo, custo — 9.49:1 |
| `--wine-deep` | `#5E1729` | acento pressionado |
| `--wine-tint` | `#F5E4E7` | fundo de código inline, linha selecionada |
| `--ochre` | `#8A6118` | atenção: custo estimado, preço vencido — 5.30:1 |
| `--danger` | `#B3261E` | erro — 6.27:1; matiz laranja-vermelho, distinta do vinho |
| `--danger-tint` | `#FBE4E1` | fundo de banner de erro |
| `--code-bg` | `#241C18` | fundo de bloco de código |
| `--code-ink` | `#E3D8CC` | código **sem destaque** — 11.93:1 |

### 4.2 Tema escuro

| Token | Valor | | Token | Valor |
|---|---|---|---|---|
| `--paper` | `#17120F` | | `--wine` | `#E4879C` |
| `--surface` | `#1F1815` | | `--wine-deep` | `#F2A9B9` |
| `--surface-2` | `#2B221D` | | `--wine-tint` | `#3A1A24` |
| `--rule` | `#392D27` | | `--ochre` | `#D5A45C` |
| `--rule-strong` | `#7C6A5E` | | `--danger` | `#F08579` |
| `--ink` | `#F4EDE5` | | `--danger-tint` | `#3E1C18` |
| `--ink-2` | `#C0B1A6` | | `--code-bg` | `#0F0C0A` |
| `--ink-3` | `#9C8C81` | | `--code-ink` | `#DCD1C6` |
| `--on-ink` | `#17120F` | | | |

### 4.3 Barra lateral — a constante da marca

**Os tokens `--sidebar-*` são definidos uma única vez em `:root` e valem nos dois temas.** A lateral é sempre o mesmo marrom; o canvas é que muda.

| Token | Valor | Uso |
|---|---|---|
| `--sidebar-bg` | `#2A211C` | fundo |
| `--sidebar-2` | `#382C26` | item ativo, campo de busca |
| `--sidebar-hover` | `#463830` | hover |
| `--sidebar-rule` | `#544339` | divisórias e borda direita |
| `--sidebar-ink` | `#F6EFE7` | texto — 13.82:1 |
| `--sidebar-ink-2` | `#C3B2A5` | texto secundário — 7.68:1 |
| `--sidebar-wine` | `#E0899C` | acento — 6.17:1 |

A primeira tentativa afundou a lateral no escuro (`#120E0C` sob canvas `#17120F`) e ela ficou indistinguível do fundo — a identidade sumia justamente no tema onde deveria ancorar a tela. Agora ela fica **acima** do canvas (1.18:1) mais a borda direita.

### 4.4 Uso semântico

| Papel | Cor |
|---|---|
| Ação primária | fundo `--ink`, texto `--on-ink` |
| Ação secundária | texto `--ink-2`, fundo transparente, hover `--surface` |
| Ação destrutiva | fundo `--danger`, texto `--on-ink` |
| Foco (todos os controles) | `outline: 2px solid var(--wine)`, `offset: 2px` |
| Selecionado / ativo | borda ou faixa `--wine`, fundo `--wine-tint` |
| Valor medido | `--wine` em mono tabular |
| Valor **estimado** | `--ochre` — a distinção entre exato e estimado é da tese do produto, nunca a apague |
| Estado de atenção | `--ochre` |
| Estado de erro | `--danger` sobre `--danger-tint` |

---

## 5. Tipografia

### 5.1 Pilhas

Sem webfonts — o orçamento de peso do frontend vai para KaTeX e Shiki, não para tipografia baixada.

```css
--sans:    "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
--display: "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
--mono:    ui-monospace, "Cascadia Mono", "SF Mono", Consolas, "Liberation Mono", monospace;
```

### 5.2 Escala

| Tamanho | Papel | Exemplos |
|---|---|---|
| **12px** | micro | metadados, dicas, contadores, hora, rótulo de custo, `<kbd>` |
| **13px** | denso | código (deliberadamente mais compacto que a prosa), linhas de listagem de painel |
| **14px** | UI padrão | botões, itens de lista, rótulos, campos, título do cabeçalho |
| **15px** | entrada | textarea do compositor, mensagem do usuário, sugestões |
| **16px** | leitura | corpo da resposta do assistente |
| **20–24px** | display de painel | títulos de modal e de seção |
| `clamp(26px, 4vw, 34px)` | display de abertura | título do estado inicial |

Pesos: **500** (números em destaque), **600** (padrão de ênfase e botões), **700** (marca). Não introduza degraus novos sem motivo declarado.

Corpo: `line-height: 1.5` na UI, `1.65` na resposta do assistente.

### 5.3 Quando usar mono

**Só para valores medidos.** Custo, contagem de tokens, janela de contexto, hora, id de modelo, código. Sempre com `font-variant-numeric: tabular-nums`.

Nunca para: rótulos de seção, títulos, botões, textos de estado, dicas.

---

## 6. Espaço, forma e movimento

### 6.1 Raio

| Token | Valor | Uso |
|---|---|---|
| `--r-1` | 2px | chips, `<kbd>`, código inline |
| `--r-2` | 4px | padrão: botões, campos, itens de lista, cards |
| `--r-3` | 8px | superfícies grandes: modal, compositor, ficha do modelo |

Nunca 0 (vira manifesto brutalista), nunca 12px (vira slop de primeira geração).

### 6.2 Espaçamento

Base de 4px. Valores usuais: 4 · 6 · 8 · 10 · 12 · 16 · 20 · 24 · 28. Altura de controle padrão: **34px** (38px em campos de painel).

Colunas: conversa `min(880px, 100%)`, estado inicial `min(760px, …)`, modal `min(720px, 100%)`, painel de configurações `min(900px, 100%)`.

### 6.3 Sombra

Uma só: `--shadow`. Exclusiva de overlay (modal, painel) e da barra lateral em modo gaveta. Nenhuma sombra em card, botão ou campo.

### 6.4 Movimento

Discreto e funcional. Transições de 0.15s ease; gaveta em 0.2s. Animações existentes: `pulse` (indicador de streaming), `typing` (três pontos), `spin` (carregando).

Respeitar **duas** fontes de verdade: `@media (prefers-reduced-motion: reduce)` e o atributo `[data-reduce-motion="true"]` controlado pelo usuário (§8).

---

## 7. Componentes

### 7.1 Superfícies

| Superfície | Fundo | Borda |
|---|---|---|
| Canvas | `--paper` | — |
| Card / bloco recuado | `--surface` | nenhuma (o tom já separa) |
| Campo de entrada | `--paper` | `1px --rule-strong`; foco troca para `--wine` + `box-shadow` de 1px |
| Modal / painel | `--paper` | `1px --rule` + `--shadow` |
| Bloco de código | `--code-bg` | nenhuma |

### 7.2 Botões

| Variante | Classe | Aparência |
|---|---|---|
| Primário | `.btn .btn-primary` | fundo tinta, texto papel, peso 600 |
| Secundário | `.btn` | transparente, texto `--ink-2`, hover `--surface` |
| Destrutivo | `.btn .btn-danger` | fundo `--danger`, texto `--on-ink` |
| Ícone | `.btn .btn-icon` | 34×34, texto `--ink-3`, hover `--surface` |

### 7.3 Mensagens

- **Usuário:** alinhado à direita, `max-width: min(80%, 620px)`, fundo `--surface`, regra `--wine` de 3px à esquerda, raio `0 4px 4px 0`, 15px.
- **Assistente:** largura total da coluna, 16px, `line-height: 1.65`; prosa limitada a 72ch, código e tabelas em largura cheia.
- **Cabeçalho da mensagem:** papel + hora (mono) + indicador `gerando` com ponto pulsante em vinho.
- **Rodapé:** custo, marcação de estimado, estado de interrupção, botão copiar. Só em mensagens do assistente.

### 7.4 Ficha do modelo (`ModelCard`)

A peça que carrega a tese. No estado inicial, antes da primeira mensagem: preço de entrada e saída por 1M, janela de contexto, suporte a raciocínio, e um rodapé com a data de verificação dos preços — em ocre quando vencida ou quando a chave não está configurada. Grade `auto-fit` de 4 células que colapsa em 2×2 abaixo de 640px.

### 7.5 Ícones

[`lucide-react`](https://lucide.dev), traço padrão. Tamanhos: **14px** em rodapé de mensagem, **15–17px** em botões e listas, **18px** em cards informativos. Ícone decorativo leva `aria-hidden="true"`; botão só de ícone leva `aria-label`.

---

## 8. Preferências do usuário

Três eixos, persistidos em `localStorage` e aplicados como atributos em `<html>` por `ChatView`:

| Preferência | Atributo | Valores | Padrão |
|---|---|---|---|
| Tema | `data-theme` | `light` · `dark` | **`light`** |
| Densidade | `data-density` | `comfortable` · `compact` | `comfortable` |
| Movimento | `data-reduce-motion` | `true` · `false` | `false` |

Densidade só altera **espaçamento** (`padding-block` das mensagens, respiro da lista e do compositor). Nunca reduz tamanho de fonte — compactar não pode custar legibilidade.

---

## 9. Conteúdo renderizado

### 9.1 Markdown

Links em `--wine` com sublinhado e `text-underline-offset: 3px`. Código inline em `--wine` sobre `--wine-tint`. Citação com regra `--rule` de 3px. Tabela com cabeçalho em `--surface-2`, rolagem horizontal própria.

### 9.2 Matemática

KaTeX carregado sob demanda, só quando há sintaxe de matemática. `.katex-display` rola horizontalmente por conta própria — equação longa nunca empurra a coluna.

### 9.3 Código destacado — a única exceção de cor

O Shiki emite `style="background-color:#24292e;color:#e1e4e8"` **inline** no `<pre>`. Esse cinza-azulado frio do github-dark cria emenda visível contra a casca marrom logo acima, e é exatamente a "cor fora dos tokens" que §3.1 proíbe.

```css
.markdown-code-highlight pre.shiki { background-color: var(--code-bg) !important; }
```

É o único `!important` de cor da folha — estilo inline de terceiro não se vence de outro jeito. As cores de sintaxe do tema continuam valendo; só o fundo volta para o sistema.

O estado **sem destaque** (primeiros ~260ms de todo bloco streamado, e permanente para linguagens fora do conjunto curado) usa `--code-ink` sobre `--code-bg`. Esse par é obrigatório: era aqui que a versão anterior renderizava marrom escuro sobre quase-preto.

Exceção sancionada: as miniaturas de tema em Configurações usam hexadecimais literais, porque precisam mostrar as cores do tema *oposto* — que por definição não estão nas variáveis ativas. Mantenha-as sincronizadas com §4.1 e §4.2 à mão.

---

## 10. Verificação

### 10.1 Contraste

```bash
node scripts/contrast.mjs
```

26 pares em uso, nos dois temas. Mínimos: texto principal **≥ 7:1**, demais textos **≥ 4.5:1**, bordas funcionais **≥ 3:1** (WCAG 1.4.11), separação lateral/canvas **≥ 1.1:1**. O script sai com código 1 se algo reprovar. Rode a cada mudança de cor.

### 10.2 Auditoria das regras

```bash
node scripts/audit-design.mjs
```

Varre `styles.css` e os componentes atrás das proibições de §3.1: gradientes, `Inter`, caixa alta com espaçamento, fonte abaixo de 12px, `window.prompt`/`confirm`, hex literal fora dos tokens.

### 10.3 Visual

Confira em **claro e escuro**, a **1440 / 700 / 400px**, com uma resposta contendo código destacado, matemática inline e em bloco, tabela e bloco de raciocínio. Sem rolagem horizontal do documento em nenhuma largura.

---

## 11. Divergências conhecidas

Auditado em 04/08/2026. O painel de Configurações entrou depois desta direção e reintroduz três coisas que ela removeu:

| Onde | O quê | Regra violada |
|---|---|---|
| `.settings-kicker` | mono como rótulo, texto em caixa alta escrito no JSX, `letter-spacing: 0.08em` | §3.1 — é o eyebrow da segunda geração, de volta |
| `.settings-kicker`, `.settings-tab small`, `.settings-theme-copy small` | `font-size: 11px` (5 ocorrências) | §3.1 — piso é 12px |
| Vários no painel | `font-weight: 650` (8 ocorrências) | §5.2 — degrau fora do par 500/600 |

Nada disso quebra a interface; são desvios de sistema, e estão listados aqui em vez de silenciados. Alinhar é uma edição pequena e localizada.

---

## 12. Histórico das decisões

O que cada escolha substituiu, e por quê. Serve para não refazer o caminho.

| Antes | Agora | Motivo |
|---|---|---|
| Canvas bege, painéis claros | Canvas papel quase-branco; bege vira superfície recuada | Texto longo se lê melhor sobre papel; o bege passa a marcar recuo, com função |
| Mensagem do usuário em bordô saturado | Bloco discreto em `--surface` com regra vinho | O elemento mais gritante da tela era a fala do próprio usuário |
| Eyebrows em mono maiúsculo por toda parte | Frases em caixa normal | Tique de segunda geração; mono agora só mede |
| Trilhos numerados `01/02/03` | Nada | Decoração sem função |
| Estado inicial como spread de revista | Ficha do modelo ativo | A tese é custo — mostre o medidor antes da primeira mensagem |
| `window.prompt` / `confirm` | Renomear inline; excluir em dois toques na linha | Diálogo nativo quebra a linguagem visual |
| `<kbd>N</kbd>` e `<kbd>/</kbd>` sem handler | `/` foca a busca, `Ctrl/⌘+K` cria conversa, `Esc` fecha | Rótulo que mente é pior que ausência de rótulo |
| `theme-color: #0f172a` (slate-900 do Tailwind) | Papel/tinta por esquema | Resíduo de template genérico dentro de paleta quente |
| 7 tamanhos entre 7px e 14px | Escala declarada, piso 12px | Seis micro-tamanhos quase iguais não são escala |
| Código sem destaque em `#51423e` sobre `#21191a` | `--code-ink` sobre `--code-bg` | Marrom escuro sobre quase-preto; era o estado de todo bloco streamado |
| Bloco destacado sobre `#24292e` | Fundo forçado para `--code-bg` | Emenda fria contra a casca quente — ver §9.3 |
| `<pre>` com padding somado ao do `<code>` | `padding: 0` no `pre` | 13px + 13px = 26px só no caminho destacado |
| Lateral `#120E0C` no escuro | Mesmo marrom nos dois temas | Ela sumia contra o canvas — ver §4.3 |
| Prosa e código ambos em 74ch | Prosa em 72ch, código e tabelas em largura cheia | Estreitar código não ajuda ninguém a ler |
| Ficha de modelo estática na tela de login | Prévia viva do produto: mensagem, raciocínio e campo de entrada com feixe | Descrever a bancada convence menos que mostrá-la funcionando — ver §3.3 |
| Biblioteca de componentes e gradiente proibidos | `@usefragments/ui` permitido, vestido com os tokens daqui | Decisão de produto de 05/08/2026: impacto no primeiro contato; a Base UI ainda dá acessibilidade de graça — ver §3.3 |

---

## 13. Ao adicionar um componente

1. Use apenas tokens existentes. Precisa de cor nova? Quase certamente não precisa.
2. Mono só se o conteúdo for um valor medido.
3. Rótulo de atalho só se o atalho existir.
4. Rode `contrast.mjs` e `audit-design.mjs` antes de commitar.
5. **Se o componente ficaria idêntico em qualquer outro app de chat, ele ainda não tem decisão dentro.**
