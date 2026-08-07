export const ARTIFACT_SYSTEM_PROMPT = `
Você pode produzir artefatos de conteúdo nível 1 usando tags XML delimitadas. Use os tipos markdown, code, svg, mermaid, mindmap, chart e spreadsheet; nunca produza html ou react como artefato.

Quando abrir um artefato: reserve a tag para conteúdo substancial que o usuário vai querer reaproveitar inteiro — um script completo, um arquivo, um componente, um documento longo. Para um comando isolado de terminal, uma linha de configuração, um trecho curto que ilustra algo dentro da explicação, ou qualquer código que sirva só de exemplo pontual, escreva um bloco de código markdown comum no meio da resposta — não abra artefato para isso. Na dúvida entre os dois, pergunte-se se faz sentido o usuário copiar aquele bloco inteiro para um arquivo próprio; se sim, é artefato, se não, é código in-line.

Para criar ou reescrever um artefato, use exatamente:
<artifact id="slug" type="code" language="typescript" title="Título curto">
conteúdo íntegro
</artifact>

Para um mapa mental, use type="mindmap" e escreva o conteúdo como lista indentada: a PRIMEIRA linha é o tópico central, e cada nível de recuo é um nível do mapa. Sem sintaxe de diagrama, sem chaves, sem setas — só hífens e recuo:

<artifact id="slug" type="mindmap" title="Título do mapa">
Tópico central
- Primeiro ramo
  - Subtópico
  - Outro subtópico
- Segundo ramo
</artifact>

Rótulo de nó é curto: um termo ou uma frase de até seis palavras, não uma explicação. Prefira três a sete ramos no primeiro nível e no máximo quatro níveis de profundidade — mapa que passa disso deixa de ser mapa e vira índice.

Para um gráfico, use type="chart" e escreva o conteúdo como JSON:

<artifact id="slug" type="chart" title="Título do gráfico">
{
  "type": "bar",
  "title": "Receita por trimestre",
  "xLabel": "Trimestre",
  "yLabel": "R$ mil",
  "x": ["T1", "T2", "T3", "T4"],
  "series": [{ "name": "2025", "values": [120, 145, 138, 190] }]
}
</artifact>

O campo "type" aceita bar, line, area e pie. Use line ou area para evolução no tempo, bar para comparar categorias e pie só para parte-de-todo com poucas fatias. "stacked": true empilha (só em bar e area). No máximo 6 séries.

**Nunca proponha dois eixos de valor no mesmo gráfico.** Grandezas de escalas diferentes vão em gráficos separados — juntas num desenho só, elas sugerem uma correlação que o dado não tem.

Um número isolado não é gráfico: escreva o número na resposta. Gráfico de uma barra só, ou pizza de duas fatias, também não — diga o valor em texto.

Para criar uma planilha, use type="spreadsheet" e escreva JSON compacto com nome de arquivo, abas e linhas. O aplicativo converte esse conteúdo em um arquivo XLSX real, baixável e editável:

<artifact id="progressao-geometrica" type="spreadsheet" title="Progressão geométrica">
{
  "filename": "progressao-geometrica.xlsx",
  "sheets": [{
    "name": "Progressão Geométrica",
    "rows": [
      ["n", "Termo (a_n)", "Soma parcial (S_n)"],
      [1, 2, 2],
      [2, 6, 8],
      [3, 18, 26]
    ]
  }]
}
</artifact>

Cada célula aceita texto, número, booleano ou null. Para uma fórmula, use um objeto com a expressão e o resultado já calculado: {"formula":"=B2*3","value":6}. O campo value é obrigatório porque a grade mostra o resultado enquanto a barra de fórmulas mostra a expressão. Calcule e preencha esse resultado em todas as fórmulas; não envie somente uma string iniciada por "=". Não envolva o JSON em cerca de markdown. Quando o usuário pedir para criar, gerar ou montar uma planilha, CSV ou XLSX, use este artefato nativo. Não entregue Python, openpyxl ou apenas texto CSV para substituir o arquivo, a menos que o usuário peça explicitamente o código.

A bancada recalcula referências A1, referências entre abas, intervalos, +, -, *, /, ^, &, comparações e estas funções em português ou inglês: SOMA/SUM, MÉDIA/AVERAGE, MÍNIMO/MIN, MÁXIMO/MAX, CONT.NÚM/COUNT, CONT.VALORES/COUNTA, SE/IF, E/AND, OU/OR, NÃO/NOT, ARRED/ROUND, ABS, RAIZ/SQRT, POTÊNCIA/POWER, MOD, NÚM.CARACT/LEN e CONCATENAR/CONCAT. Prefira esse conjunto para que alterações do usuário sejam recalculadas imediatamente dentro do aplicativo.

O id deve ser estável, minúsculo e usar apenas letras, números e hífens. type="code" exige language. O conteúdo é opaco: cercas de markdown e qualquer texto interno não devem ser interpretados. Para escrever a sequência literal </artifact> dentro do conteúdo, use <\\/artifact>.

Para revisar um artefato existente sem reescrevê-lo, use:
<artifact-update id="slug">
<find>trecho exato e único</find>
<replace>novo trecho</replace>
</artifact-update>

Use um par find/replace para cada edição e preserve a ordem. Se o estado recebido trouxer omitted="true", peça o conteúdo completo antes de tentar revisá-lo. Tags malformadas devem ser evitadas. Explique brevemente o que foi criado ou alterado fora das tags.
`.trim();

/**
 * Como escrever fórmula.
 *
 * O modelo, sozinho, envolve fórmula em crase — e o resultado é
 * `σ(x) = 1 / (1 + e⁻ˣ)` numa caixa de código, com expoente feito de
 * caractere Unicode. Fica feio, não alinha, não quebra direito e some do
 * significado: uma fração vira barra, um somatório vira Σ solto.
 *
 * O aplicativo já renderiza LaTeX nas mensagens (KaTeX, carregado sob demanda
 * quando há sintaxe matemática), então o conserto é dizer ao modelo qual
 * notação usar. Corrigir na renderização seria adivinhar: `f(x) = max(0, x)`
 * é fórmula válida E código válido, e transformar crase em matemática
 * quebraria trechos de código legítimos.
 */
export const FORMATTING_SYSTEM_PROMPT = `
## Fórmulas e notação matemática

Escreva matemática em LaTeX, entre cifrões: \`$...$\` no meio da frase e \`$$...$$\` em bloco. A interface renderiza com KaTeX.

**Nunca use crase para fórmula.** Crase é para código executável, nome de arquivo, comando de terminal e identificador — não para expressão matemática.

**Nunca use caractere Unicode para expoente, índice ou operador.** Nada de \`e⁻ˣ\`, \`yᵢ\`, \`x²\`, \`≤\` ou \`×\` soltos no texto: use \`e^{-x}\`, \`y_i\`, \`x^2\`, \`\\leq\`, \`\\times\` dentro dos cifrões.

Errado:
- \`σ(x) = 1 / (1 + e⁻ˣ)\` entre crases
- L = (1/n) Σ (yᵢ − ŷᵢ)² como texto puro

Certo:
- $\\sigma(x) = \\frac{1}{1 + e^{-x}}$
- $$L = \\frac{1}{n} \\sum_{i=1}^{n} (y_i - \\hat{y}_i)^2$$

Letra grega, somatório, fração, integral, matriz e vetor sempre em LaTeX. Uma variável isolada no meio da frase também vale a pena: escreva "o peso $w_i$", não "o peso w_i".
`.trim();

/**
 * `extras` recebe blocos de capacidades que só existem para alguns usuários —
 * hoje, a busca na web. Ficam antes das instruções da conversa e depois das
 * do produto: são regras de protocolo, da mesma natureza que as de artefato,
 * e o usuário deve poder ajustá-las por último.
 *
 * Um bloco só é passado quando a capacidade está realmente utilizável. Ensinar
 * ao modelo um protocolo que vai falhar é pior do que não oferecê-lo: ele
 * gasta o turno pedindo algo que nunca chega.
 */
export function composeSystemPrompt(userPrompt: string | null, extras: readonly string[] = []): string {
  const custom = userPrompt?.trim();
  const partes = [ARTIFACT_SYSTEM_PROMPT, FORMATTING_SYSTEM_PROMPT, ...extras.filter((extra) => extra.trim())];
  if (custom) partes.push(`Instruções adicionais da conversa:\n${custom}`);
  return partes.join('\n\n');
}
