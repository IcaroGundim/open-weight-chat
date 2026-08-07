/**
 * Prévia de documentos LaTeX: converte a fonte para Markdown e deixa a
 * matemática intacta para o KaTeX, que já é usado nas mensagens.
 *
 * **Por que não uma biblioteca.** A opção óbvia era o `latex.js`. Ela foi
 * instalada, testada e descartada: carrega pacotes via `require`, que não
 * existe fora do Node, e não implementa `equation`, `align`, `tabular` nem
 * `\footnote` — some quase tudo que um texto acadêmico usa. Pior, ela **lança
 * exceção** diante do que não conhece, então um único `\begin{equation}`
 * derrubava o documento inteiro. Compilar TeX de verdade (SwiftLaTeX,
 * texlive.wasm) resolveria a fidelidade ao custo de dezenas de megabytes.
 *
 * Este módulo escolhe o meio-termo honesto: nenhuma dependência nova, e o que
 * realmente importa para ler o documento — estrutura e fórmulas. O que ele não
 * entende vira texto legível ou é registrado em `unsupported`, nunca derruba a
 * prévia. É prévia, não compilação, e a interface diz isso.
 *
 * A matemática é a única parte que precisa ser exata, e é justamente a que não
 * é reescrita: o conteúdo entre delimitadores é protegido antes de qualquer
 * transformação e devolvido intocado ao KaTeX.
 */

/**
 * A linguagem do artefato é escrita pelo modelo, então aceita as grafias que
 * ele costuma usar. Uma regra só, para o painel e o renderizador não
 * discordarem sobre o que abrir na prévia.
 */
const LINGUAGENS_LATEX = new Set(['latex', 'tex', 'latex2e', 'xelatex', 'pdflatex']);

export function isLatexLanguage(language?: string | null): boolean {
  return LINGUAGENS_LATEX.has((language ?? '').trim().toLowerCase());
}

export interface LatexDocument {
  readonly title: string | null;
  readonly author: string | null;
  readonly date: string | null;
  readonly markdown: string;
  /** Comandos encontrados e não convertidos, para a interface ser franca. */
  readonly unsupported: readonly string[];
}

/** Ambientes cujo corpo é matemática pura e vai inteiro para o KaTeX. */
const MATH_ENVIRONMENTS: Readonly<Record<string, 'plain' | 'aligned' | 'gathered'>> = {
  equation: 'plain',
  displaymath: 'plain',
  math: 'plain',
  align: 'aligned',
  alignat: 'aligned',
  flalign: 'aligned',
  eqnarray: 'aligned',
  gather: 'gathered',
  multline: 'gathered',
};

const VERBATIM_ENVIRONMENTS = ['verbatim', 'lstlisting', 'minted', 'Verbatim'];

/**
 * Encontra o fecha-chaves correspondente a partir de `{`, respeitando aninhamento.
 * Devolve -1 se não fechar — fonte truncada é comum durante o streaming, e uma
 * busca ingênua por `}` cortaria `\textbf{a \emph{b}}` no lugar errado.
 */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Lê o argumento de `\cmd{...}` em cada ocorrência e o entrega ao tradutor. */
function replaceCommand(source: string, name: string, translate: (arg: string) => string): string {
  const marker = `\\${name}`;
  let out = '';
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf(marker, cursor);
    if (at < 0) break;
    // `\textbf` não pode casar dentro de `\textbfx`: o próximo caractere
    // precisa deixar claro que o nome do comando acabou.
    const after = source[at + marker.length];
    if (after !== undefined && /[a-zA-Z]/u.test(after)) {
      out += source.slice(cursor, at + marker.length);
      cursor = at + marker.length;
      continue;
    }
    const open = source.indexOf('{', at + marker.length);
    const somenteEspaco = open > 0 && !source.slice(at + marker.length, open).trim();
    if (open < 0 || !somenteEspaco) {
      out += source.slice(cursor, at + marker.length);
      cursor = at + marker.length;
      continue;
    }
    const close = matchingBrace(source, open);
    if (close < 0) break;
    out += source.slice(cursor, at) + translate(source.slice(open + 1, close));
    cursor = close + 1;
  }
  return out + source.slice(cursor);
}

/** Lê `\cmd{a}{b}` — dois argumentos, como `\href`. */
function replaceCommand2(source: string, name: string, translate: (a: string, b: string) => string): string {
  const marker = `\\${name}`;
  let out = '';
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf(marker, cursor);
    if (at < 0) break;
    const open1 = source.indexOf('{', at + marker.length);
    if (open1 < 0 || source.slice(at + marker.length, open1).trim()) {
      out += source.slice(cursor, at + marker.length);
      cursor = at + marker.length;
      continue;
    }
    const close1 = matchingBrace(source, open1);
    if (close1 < 0) break;
    const open2 = source.indexOf('{', close1 + 1);
    if (open2 < 0 || source.slice(close1 + 1, open2).trim()) {
      out += source.slice(cursor, close1 + 1);
      cursor = close1 + 1;
      continue;
    }
    const close2 = matchingBrace(source, open2);
    if (close2 < 0) break;
    out += source.slice(cursor, at) + translate(source.slice(open1 + 1, close1), source.slice(open2 + 1, close2));
    cursor = close2 + 1;
  }
  return out + source.slice(cursor);
}

/**
 * Remove comentários `%` até o fim da linha, preservando `\%`.
 * Feito antes de tudo porque um `%` solto comenta o resto da linha em LaTeX e
 * manteria lixo visível na prévia.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\') { i += 1; continue; }
        if (line[i] === '%') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

function firstArgument(source: string, name: string): string | null {
  const at = source.indexOf(`\\${name}`);
  if (at < 0) return null;
  const open = source.indexOf('{', at);
  if (open < 0) return null;
  const close = matchingBrace(source, open);
  return close < 0 ? null : source.slice(open + 1, close).trim();
}

/**
 * Acentos no estilo antigo do LaTeX.
 *
 * O modelo escreve `identifica\c{c}\~ao` e `m\'etodo` em vez de "identificação"
 * e "método" — é LaTeX válido e legado de quando fonte não era UTF-8. Sem
 * traduzir, a limpeza de comandos desconhecidos comia o `\c` e o `\~` e
 * sobrava "identifica ao": a palavra perdia a letra e ficava ilegível.
 *
 * As formas com chave (`\c{c}`) e sem chave (`\'e`) convivem no mesmo
 * documento, então as duas são tratadas.
 */
const ACENTOS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', c: 'ć', n: 'ń', y: 'ý',
    A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '~': { a: 'ã', o: 'õ', n: 'ñ', A: 'Ã', O: 'Õ', N: 'Ñ' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  c: { c: 'ç', C: 'Ç', s: 'ş', t: 'ţ' },
  v: { c: 'č', s: 'š', z: 'ž', C: 'Č', S: 'Š', Z: 'Ž' },
  H: { o: 'ő', u: 'ű' },
  u: { a: 'ă', g: 'ğ' },
  '.': { z: 'ż', e: 'ė' },
};

/** Comandos de símbolo que também aparecem soltos no texto. */
const SIMBOLOS_LATEX: Readonly<Record<string, string>> = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø',
  aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  ldots: '…', dots: '…', textbackslash: '\\', textasciitilde: '~',
  degree: '°', textdegree: '°', pounds: '£', texteuro: '€', copyright: '©',
};

function traduzirAcentos(texto: string): string {
  let saida = texto;
  // Com chave primeiro: `\c{c}` antes de `\c` solto, senão a chave sobraria.
  saida = saida.replace(/\\(['`^~"cvHu.])\{(\w)\}/gu, (todo, acento: string, letra: string) =>
    ACENTOS[acento]?.[letra] ?? todo);
  // Sem chave: `\'e`, `\~ao`. Só uma letra é acentuada — o resto é texto.
  saida = saida.replace(/\\(['`^~"])(\w)/gu, (todo, acento: string, letra: string) =>
    ACENTOS[acento]?.[letra] ?? todo);
  // `\c` e afins sem chave: `\c c` com espaço no meio também acontece.
  saida = saida.replace(/\\([cvHu])\s+(\w)/gu, (todo, acento: string, letra: string) =>
    ACENTOS[acento]?.[letra] ?? todo);
  saida = saida.replace(/\\([a-zA-Z]+)\{\}/gu, (todo, nome: string) => SIMBOLOS_LATEX[nome] ?? todo);
  saida = saida.replace(/\\([a-zA-Z]+)(?![a-zA-Z])/gu, (todo, nome: string) => SIMBOLOS_LATEX[nome] ?? todo);
  return saida;
}

interface Protegido {
  readonly marcador: string;
  readonly conteudo: string;
}

/**
 * Tira de circulação tudo que não pode ser reescrito: matemática e verbatim.
 *
 * Sem isto, `\textbf` dentro de uma fórmula viraria `**` e o KaTeX receberia
 * Markdown; e um exemplo de código contendo `\section` viraria título.
 */
function protect(source: string): { texto: string; protegidos: Protegido[] } {
  const protegidos: Protegido[] = [];
  let texto = source;
  const guardar = (conteudo: string): string => {
    // Marcador sem caractere especial de Markdown, para não ser tocado pelas
    // transformações seguintes nem pelo próprio Markdown.
    const marcador = ` LTX${protegidos.length} `;
    protegidos.push({ marcador, conteudo });
    return marcador;
  };

  for (const nome of VERBATIM_ENVIRONMENTS) {
    const padrao = new RegExp(`\\\\begin\\{${nome}\\}([\\s\\S]*?)\\\\end\\{${nome}\\}`, 'gu');
    texto = texto.replace(padrao, (_todo, corpo: string) => guardar(`\n\`\`\`\n${corpo.replace(/^\n|\n$/gu, '')}\n\`\`\`\n`));
  }

  /**
   * TikZ entra protegido, como o verbatim, e pelo mesmo motivo: o corpo é
   * CÓDIGO DE DESENHO. Solto, ele passaria pelas limpezas seguintes — `\draw`
   * viraria comando desconhecido e sumiria, e `--` viraria travessão. O
   * renderizador de Markdown troca a cerca pela figura desenhada.
   */
  texto = texto.replace(
    /\\begin\{figure\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\}|\\begin\{tikzpicture\}([\s\S]*?)\\end\{tikzpicture\}/gu,
    (todo) => {
      if (!todo.includes('tikzpicture')) return todo;
      const legenda = /\\caption\s*\{([^{}]*)\}/u.exec(todo)?.[1]?.trim();
      const desenho = /\\begin\{tikzpicture\}([\s\S]*?)\\end\{tikzpicture\}/u.exec(todo)?.[1] ?? '';
      // A legenda vai na primeira linha da cerca: o `\caption` fica fora do
      // `tikzpicture`, e a cerca só transporta um bloco de texto.
      return guardar(`\n\n\`\`\`tikz\n${legenda ? `${legenda}\n` : ''}${desenho.trim()}\n\`\`\`\n\n`);
    },
  );

  for (const [nome, forma] of Object.entries(MATH_ENVIRONMENTS)) {
    const padrao = new RegExp(`\\\\begin\\{${nome}\\*?\\}([\\s\\S]*?)\\\\end\\{${nome}\\*?\\}`, 'gu');
    texto = texto.replace(padrao, (_todo, corpo: string) => {
      // `\label` e `\nonumber` moram DENTRO do ambiente e não são
      // matemática: sem tirá-los aqui, o KaTeX recebe o comando e o imprime em
      // vermelho no meio da fórmula. Tirar depois é tarde — a esta altura o
      // corpo já está protegido contra qualquer reescrita.
      let miolo = corpo
        .replace(/\\label\s*\{[^{}]*\}/gu, '')
        .replace(/\\(nonumber|notag)\b/gu, '')
        .trim();
      // `alignat` leva o número de colunas como argumento; o KaTeX não usa.
      if (nome === 'alignat' || nome === 'flalign') miolo = miolo.replace(/^\{\d+\}/u, '').trim();
      // `align` e `gather` de topo não são universalmente aceitos pelo KaTeX;
      // `aligned` e `gathered` são. A semântica de `&` e `\\` é a mesma.
      const envolvido = forma === 'plain'
        ? miolo
        : `\\begin{${forma}}\n${miolo}\n\\end{${forma}}`;
      return guardar(`\n\n$$\n${envolvido}\n$$\n\n`);
    });
  }

  // Delimitadores soltos, do mais longo para o mais curto.
  texto = texto.replace(/\$\$([\s\S]*?)\$\$/gu, (_todo, corpo: string) => guardar(`\n\n$$\n${corpo.trim()}\n$$\n\n`));
  texto = texto.replace(/\\\[([\s\S]*?)\\\]/gu, (_todo, corpo: string) => guardar(`\n\n$$\n${corpo.trim()}\n$$\n\n`));
  texto = texto.replace(/\\\(([\s\S]*?)\\\)/gu, (_todo, corpo: string) => guardar(`$${corpo.trim()}$`));
  // `$...$` por último e sem cruzar linha em branco: um `$` órfão não pode
  // engolir o resto do documento.
  texto = texto.replace(/\$([^$\n]+?)\$/gu, (_todo, corpo: string) => guardar(`$${corpo}$`));

  return { texto, protegidos };
}

function restore(texto: string, protegidos: readonly Protegido[]): string {
  let saida = texto;
  // De trás para a frente: o marcador 1 é prefixo do 10 e seria substituído
  // primeiro, deixando o "0" órfão no texto.
  for (let i = protegidos.length - 1; i >= 0; i -= 1) {
    saida = saida.split(protegidos[i].marcador).join(protegidos[i].conteudo);
  }
  return saida;
}

/** `\begin{tabular}{lcr}` → tabela GFM. A primeira linha vira cabeçalho. */
function convertTabular(source: string): string {
  return source.replace(
    /\\begin\{(tabular|tabularx|longtable)\}\s*(\{[^}]*\}|\[[^\]]*\]\s*\{[^}]*\})?([\s\S]*?)\\end\{\1\}/gu,
    (_todo, _nome: string, _colunas: string | undefined, corpo: string) => {
      const linhas = corpo
        .replace(/\\(hline|toprule|midrule|bottomrule)\b/gu, '')
        .split(/\\\\/u)
        .map((linha) => linha.trim())
        .filter(Boolean)
        .map((linha) => linha.split('&').map((celula) => celula.trim()));
      if (linhas.length === 0) return '';
      const largura = Math.max(...linhas.map((linha) => linha.length));
      const formatar = (celulas: string[]) =>
        `| ${[...celulas, ...Array(largura - celulas.length).fill('')].join(' | ')} |`;
      const [cabecalho, ...resto] = linhas;
      return [
        '',
        formatar(cabecalho),
        `| ${Array(largura).fill('---').join(' | ')} |`,
        ...resto.map(formatar),
        '',
      ].join('\n');
    },
  );
}

/**
 * `itemize`/`enumerate` → listas Markdown, de dentro para fora.
 *
 * O aninhamento é a parte difícil. Uma regex não-gulosa casa o `\end{itemize}`
 * INTERNO com o `\begin` externo, e o resultado é uma lista achatada, sem
 * hierarquia. Por isso a conversão procura sempre o ambiente **mais interno**
 * — aquele que não contém outro `\begin` de lista — converte, e repete. Quando
 * a vez do ambiente externo chega, o interno já é Markdown, e basta recuá-lo
 * junto com o item que o contém.
 */
const AMBIENTES_LISTA = 'itemize|enumerate|description';

function renderList(nome: string, corpo: string): string {
  const itens = corpo
    .split(/\\item\b/u)
    .slice(1)
    .map((item) => item.trim())
    .filter(Boolean);
  if (itens.length === 0) return '';
  const linhas = itens.map((item, indice) => {
    const marca = nome === 'enumerate' ? `${indice + 1}.` : '-';
    const [primeira, ...resto] = item.split('\n');
    // Continuação e sublista recuam dois espaços: é o que torna o item
    // seguinte filho deste, e não irmão.
    const seguintes = resto.map((linha) => (linha.trim() ? `  ${linha}` : ''));
    return [`${marca} ${primeira}`, ...seguintes].join('\n');
  });
  return `\n${linhas.join('\n')}\n`;
}

function convertLists(source: string): string {
  const maisInterno = new RegExp(
    `\\\\begin\\{(${AMBIENTES_LISTA})\\}((?:(?!\\\\begin\\{(?:${AMBIENTES_LISTA})\\})[\\s\\S])*?)\\\\end\\{\\1\\}`,
    'u',
  );
  let saida = source;
  // Teto de segurança: fonte truncada pode deixar um `\begin` sem par, e o
  // laço só termina porque cada passada consome um ambiente.
  for (let passada = 0; passada < 64; passada += 1) {
    const encontrado = maisInterno.exec(saida);
    if (!encontrado) break;
    saida = saida.slice(0, encontrado.index)
      + renderList(encontrado[1], encontrado[2])
      + saida.slice(encontrado.index + encontrado[0].length);
  }
  return saida;
}

const SECOES: ReadonlyArray<readonly [string, string]> = [
  ['subsubsection', '####'],
  ['subsection', '###'],
  ['section', '##'],
  ['chapter', '#'],
  ['paragraph', '#####'],
];

/** Comandos deixados de lado de propósito: não têm o que mostrar numa prévia. */
const DESCARTAVEIS = [
  'label', 'index', 'vspace', 'hspace', 'newpage', 'clearpage', 'pagebreak',
  'centering', 'raggedright', 'noindent', 'bibliographystyle', 'maketitle',
  'tableofcontents', 'listoffigures', 'listoftables',
];

/**
 * Remove o que sobrou com cara de comando, levando o argumento junto.
 *
 * A versão anterior usava uma regex com `\{[^{}]*\}`, que não casa argumento
 * com chave dentro. O efeito era o pior possível: o comando sumia e o
 * argumento ficava, então `\title{Diferenças em Diferenças}` virava
 * `{Diferenças em Diferenças}` na tela, com as chaves à mostra.
 */
function removerComandosDesconhecidos(source: string, registro: Set<string>): string {
  let saida = '';
  let cursor = 0;
  while (cursor < source.length) {
    const barra = source.indexOf('\\', cursor);
    if (barra < 0) break;
    const nome = /^[a-zA-Z]+/u.exec(source.slice(barra + 1))?.[0];
    if (!nome) {
      saida += source.slice(cursor, barra + 2);
      cursor = barra + 2;
      continue;
    }
    registro.add(`\\${nome}`);
    saida += source.slice(cursor, barra);
    cursor = barra + 1 + nome.length;
    if (source[cursor] === '*') cursor += 1;
    // Argumentos opcionais e obrigatórios que venham grudados.
    while (source[cursor] === '[' ) {
      const fecha = source.indexOf(']', cursor);
      if (fecha < 0) break;
      cursor = fecha + 1;
    }
    while (source[cursor] === '{') {
      const fecha = matchingBrace(source, cursor);
      if (fecha < 0) break;
      cursor = fecha + 1;
    }
  }
  return saida + source.slice(cursor);
}

export function latexToMarkdown(source: string): LatexDocument {
  const limpo = stripComments(source);

  const inicio = limpo.indexOf('\\begin{document}');
  const fim = limpo.lastIndexOf('\\end{document}');
  const preambulo = inicio >= 0 ? limpo.slice(0, inicio) : limpo;
  // Sem `\begin{document}` o texto é um fragmento — comum quando o modelo
  // devolve só uma seção. Tratar como corpo inteiro é mais útil que recusar.
  const corpoBruto = inicio >= 0
    ? limpo.slice(inicio + '\\begin{document}'.length, fim > inicio ? fim : undefined)
    : limpo;

  // Título e autor passam pela mesma conversão do corpo: o `\textbf{...}`
  // que muita gente põe dentro de `\title` aparecia literalmente na prévia.
  // A recursão termina: um título não contém `\title`.
  const converterFragmento = (valor: string | null): string | null => {
    if (!valor) return null;
    const convertido = latexToMarkdown(traduzirAcentos(valor)).markdown.trim();
    return convertido || null;
  };
  const title = converterFragmento(firstArgument(preambulo, 'title'));
  const author = converterFragmento(firstArgument(preambulo, 'author'));
  const date = converterFragmento(firstArgument(preambulo, 'date'));

  const { texto, protegidos } = protect(corpoBruto);
  let corpo = texto;

  // Acentos antes de qualquer limpeza de comando: depois seria tarde, porque
  // a limpeza come o `\c` e a letra se perde.
  corpo = traduzirAcentos(corpo);

  // Recuo do fonte LaTeX não significa nada em LaTeX, mas significa tudo em
  // Markdown: quatro espaços viram bloco de código. Um parágrafo indentado
  // depois de uma fórmula aparecia como código, com a matemática dentro dele
  // sem renderizar. Tirar o recuo aqui, antes de qualquer estrutura ser
  // gerada, preserva o recuo que ESTE módulo produz para listas aninhadas.
  corpo = corpo.split('\n').map((linha) => linha.replace(/^[ \t]+/u, '')).join('\n');

  // Tipografia primeiro, antes de existir Markdown gerado.
  // `---` vira travessão, e a tabela GFM que este módulo produz usa `| --- |`
  // como separador: convertendo depois, o separador virava `| — |` e a tabela
  // deixava de ser tabela. A regra só pode alcançar o que o autor escreveu.
  corpo = corpo
    .replace(/---/gu, '—')
    .replace(/(?<!-)--(?!-)/gu, '–')
    .replace(/``/gu, '“')
    .replace(/''/gu, '”');

  corpo = convertTabular(corpo);
  corpo = convertLists(corpo);

  for (const [nome, marca] of SECOES) {
    corpo = replaceCommand(corpo, `${nome}*`, (arg) => `\n\n${marca} ${arg}\n\n`);
    corpo = replaceCommand(corpo, nome, (arg) => `\n\n${marca} ${arg}\n\n`);
  }

  corpo = replaceCommand2(corpo, 'href', (url, texto2) => `[${texto2}](${url})`);
  corpo = replaceCommand(corpo, 'url', (url) => `<${url}>`);
  corpo = replaceCommand(corpo, 'textbf', (arg) => `**${arg}**`);
  corpo = replaceCommand(corpo, 'textit', (arg) => `*${arg}*`);
  corpo = replaceCommand(corpo, 'emph', (arg) => `*${arg}*`);
  corpo = replaceCommand(corpo, 'underline', (arg) => `*${arg}*`);
  corpo = replaceCommand(corpo, 'texttt', (arg) => `\`${arg}\``);
  corpo = replaceCommand(corpo, 'textsc', (arg) => arg);
  corpo = replaceCommand(corpo, 'textsuperscript', (arg) => `^${arg}^`);
  // Nota de rodapé vira parêntese: Markdown de nota exige âncora e retorno,
  // que numa prévia curta atrapalham mais do que ajudam.
  corpo = replaceCommand(corpo, 'footnote', (arg) => ` *(nota: ${arg})*`);
  corpo = replaceCommand(corpo, 'caption', (arg) => `\n\n*${arg}*\n\n`);
  corpo = replaceCommand(corpo, 'cite', (arg) => `[${arg}]`);
  corpo = replaceCommand(corpo, 'citep', (arg) => `[${arg}]`);
  corpo = replaceCommand(corpo, 'citet', (arg) => `${arg}`);
  corpo = replaceCommand(corpo, 'ref', (arg) => `(${arg})`);
  corpo = replaceCommand(corpo, 'eqref', (arg) => `(${arg})`);

  for (const nome of DESCARTAVEIS) {
    corpo = replaceCommand(corpo, nome, () => '');
    corpo = corpo.replace(new RegExp(`\\\\${nome}\\b`, 'gu'), '');
  }

  corpo = corpo
    .replace(/\\begin\{(abstract|quote|quotation)\}([\s\S]*?)\\end\{\1\}/gu,
      (_todo, _nome: string, dentro: string) => `\n\n${dentro.trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`)
    // Ambientes flutuantes não têm posicionamento numa prévia: fica o conteúdo.
    .replace(/\\begin\{(figure|table|center)\*?\}(\[[^\]]*\])?/gu, '\n\n')
    .replace(/\\end\{(figure|table|center)\*?\}/gu, '\n\n')
    .replace(/\\begin\{thebibliography\}\{[^}]*\}/gu, '\n\n## Referências\n\n')
    .replace(/\\end\{thebibliography\}/gu, '\n')
    .replace(/\\bibitem\{[^}]*\}/gu, '\n- ')
    .replace(/\\\\(\[[^\]]*\])?/gu, '  \n')
    .replace(/\\newline\b/gu, '  \n')
    .replace(/\\[,;:!]/gu, ' ')
    .replace(/~/gu, ' ');

  // Escapes do LaTeX viram o caractere literal; `_` e `*` mantêm o escape,
  // senão o Markdown os leria como ênfase.
  corpo = corpo
    .replace(/\\([%&#$])/gu, '$1')
    .replace(/\\([{}])/gu, '$1')
    .replace(/\\_/gu, '\\_')
    .replace(/\\&/gu, '&');

  // O que sobrou com cara de comando não é convertido; some do texto, mas é
  // reportado para a interface poder dizer que a prévia está incompleta.
  const unsupported = new Set<string>();
  // Consome o argumento junto do comando, respeitando aninhamento: a regex de
  // chave simples deixava `{Título do documento}` órfão na tela quando o
  // `\title` caía aqui.
  corpo = removerComandosDesconhecidos(corpo, unsupported);
  corpo = corpo.replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/gu, '');

  const markdown = restore(corpo, protegidos)
    // Linha só de espaços vira linha vazia. Não pode ser um trim geral de fim
    // de linha: dois espaços no fim de uma linha COM texto são a quebra forte
    // do Markdown, que é justamente o que `\\` do LaTeX vira aqui.
    .replace(/^[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return { title, author, date, markdown, unsupported: [...unsupported].sort() };
}
