import { splitMarkdownSegments } from './math-normalize';

/**
 * Converte code spans que são fórmula em matemática do KaTeX.
 *
 * O prompt de sistema manda o modelo escrever `$...$`, e modelo grande obedece.
 * Modelo menor, não: ele envolve a fórmula em crase e usa expoente Unicode
 * (`σ(x) = 1 / (1 + e⁻ˣ)`), que a interface mostra como caixa de código rosa.
 * Como o aplicativo é BYOK e o usuário aponta para qualquer endpoint, não dá
 * para depender só da obediência ao prompt.
 *
 * **A classificação rejeita antes de aceitar.** Transformar código em
 * matemática é o erro caro — um trecho de shell virando itálico serifado é
 * pior do que uma fórmula continuar feia. Então qualquer marca de código
 * (ponto e vírgula, chaves, aspas, seta, palavra-chave, chamada de método)
 * encerra a análise. Só o que sobra é examinado.
 *
 * O modo de falhar que resta é brando: um falso positivo mostra os MESMOS
 * caracteres, só que compostos como matemática. Nada some.
 */

/** Marcas que só aparecem em código. Qualquer uma reprova o trecho. */
const MARCAS_DE_CODIGO = [
  ';', '{', '}', '[', ']', '=>', '->', '==', '!=', '&&', '||', '//', '/*',
  '"', "'", '`', '#', '\\', '|', '@', '::', '--', '++',
];

const PALAVRAS_DE_CODIGO = new RegExp(
  '\\b(const|let|var|function|def|class|return|import|export|from|require|await|async'
  + '|if|else|for|while|switch|case|try|catch|throw|new|this|self|print|console'
  + '|null|nil|none|true|false|undefined|void|int|float|str|bool'
  + '|npm|pnpm|yarn|pip|git|sudo|cd|ls|mkdir|curl|docker|SELECT|INSERT|UPDATE|DELETE)\\b',
  'iu',
);

/** Funções que o KaTeX escreve em redondo; também servem de sinal de fórmula. */
const FUNCOES = [
  'max', 'min', 'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'tanh', 'sinh', 'cosh',
  'arg', 'det', 'dim', 'lim', 'sup', 'inf', 'gcd', 'deg', 'mod',
];

const GREGAS: Readonly<Record<string, string>> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ζ: '\\zeta',
  η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu',
  ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma', τ: '\\tau',
  υ: '\\upsilon', φ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi',
  Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
};

const SIMBOLOS: Readonly<Record<string, string>> = {
  '−': '-', '–': '-', '×': '\\times', '÷': '\\div', '·': '\\cdot',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv',
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '√': '\\sqrt', '∞': '\\infty',
  '∂': '\\partial', '∇': '\\nabla', '±': '\\pm', '∈': '\\in', '∀': '\\forall',
  '∃': '\\exists', '→': '\\to', '⇒': '\\Rightarrow', '∅': '\\emptyset',
};

const SOBRESCRITO: Readonly<Record<string, string>> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7',
  '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
  'ⁿ': 'n', 'ⁱ': 'i', 'ˣ': 'x', 'ʸ': 'y', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd',
  'ᵀ': 'T', 'ᵏ': 'k', 'ᵐ': 'm', 'ᵗ': 't',
};

const SUBSCRITO: Readonly<Record<string, string>> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7',
  '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k', 'ₙ': 'n', 'ₘ': 'm', 'ₜ': 't', 'ₐ': 'a', 'ₑ': 'e',
  'ₒ': 'o', 'ₓ': 'x', 'ᵣ': 'r', 'ₛ': 's',
};

/** Letras com acento circunflexo, que o modelo escreve como caractere único. */
const CHAPEUS: Readonly<Record<string, string>> = {
  'ŷ': '\\hat{y}', 'x̂': '\\hat{x}', 'â': '\\hat{a}', 'θ̂': '\\hat{\\theta}',
};

const SOBRESCRITOS = Object.keys(SOBRESCRITO).join('');
const SUBSCRITOS = Object.keys(SUBSCRITO).join('');

/** Sinais que, sozinhos, provam que o trecho é matemática e não código. */
function temSinalForte(texto: string): boolean {
  return [...texto].some((char) =>
    char in GREGAS || char in SIMBOLOS || char in SOBRESCRITO || char in SUBSCRITO || char in CHAPEUS);
}

/**
 * O trecho tem forma de expressão: só letras, dígitos, parênteses, vírgula,
 * ponto e operadores — e traz um `=` ou é a chamada de uma função matemática.
 */
function temFormaDeExpressao(texto: string): boolean {
  if (!/^[\p{L}\p{N}\s()+\-*/^_=<>,.!]+$/u.test(texto)) return false;
  // Chamada de método (`array.map`) é código; `1.5` não é.
  if (/\.\p{L}/u.test(texto)) return false;
  if (texto.includes('=')) return /\p{L}/u.test(texto);
  const chamada = /^([a-zA-Z]+)\s*\(/u.exec(texto);
  return chamada ? FUNCOES.includes(chamada[1].toLowerCase()) : false;
}

export function looksLikeFormula(texto: string): boolean {
  const limpo = texto.trim();
  // Trecho longo é código quase sempre; e vazio não é nada.
  if (!limpo || limpo.length > 120) return false;
  if (MARCAS_DE_CODIGO.some((marca) => limpo.includes(marca))) return false;
  if (PALAVRAS_DE_CODIGO.test(limpo)) return false;
  // Opção de linha de comando (`-v`, `--flag`) não é fórmula.
  if (limpo.startsWith('-')) return false;
  return temSinalForte(limpo) || temFormaDeExpressao(limpo);
}

/** Agrupa uma sequência de sobrescritos/subscritos num único `^{}`/`_{}`. */
function converterIndices(texto: string): string {
  return texto
    .replace(new RegExp(`[${SOBRESCRITOS}]+`, 'gu'), (corrida) =>
      `^{${[...corrida].map((char) => SOBRESCRITO[char]).join('')}}`)
    .replace(new RegExp(`[${SUBSCRITOS}]+`, 'gu'), (corrida) =>
      `_{${[...corrida].map((char) => SUBSCRITO[char]).join('')}}`);
}

export function formulaToLatex(texto: string): string {
  let saida = texto.trim();
  for (const [char, comando] of Object.entries(CHAPEUS)) saida = saida.split(char).join(`${comando} `);
  saida = converterIndices(saida);
  for (const [char, comando] of Object.entries(GREGAS)) saida = saida.split(char).join(`${comando} `);
  for (const [char, comando] of Object.entries(SIMBOLOS)) saida = saida.split(char).join(`${comando} `);
  // Nome de função em redondo: sem isto o KaTeX compõe `max` como o produto
  // das variáveis m, a e x.
  for (const nome of FUNCOES) {
    saida = saida.replace(new RegExp(`(?<![\\\\\\p{L}])${nome}(?=\\s*\\()`, 'gu'), `\\${nome}`);
  }
  return saida
    // O espaço depois de cada comando existe para `\sigma` não colar em `x` e
    // virar `\sigmax`. Antes de índice ele é ruído: `\hat{y} _{i}` funciona,
    // mas `\hat{y}_{i}` é o que um humano escreveria.
    .replace(/\s+(?=[_^])/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/**
 * Reescreve os code spans que são fórmula como `$...$`.
 *
 * Roda antes de tudo: o resultado alimenta `hasMathSyntax` (que decide se o
 * KaTeX é carregado) e o normalizador de delimitadores. Blocos cercados não
 * são tocados — `splitMarkdownSegments` já os separa, e um exemplo de código
 * dentro de uma cerca continua sendo exemplo de código.
 */
export function codeSpansToMath(source: string): string {
  if (!source.includes('`')) return source;
  return splitMarkdownSegments(source)
    .map((segmento) => {
      if (!segmento.code) return segmento.value;
      // Só crase simples: cerca de três começa bloco, e `` `` `` com crase
      // dentro é quase sempre código.
      const conteudo = /^`([^`\n]+)`$/u.exec(segmento.value);
      if (!conteudo || !looksLikeFormula(conteudo[1])) return segmento.value;
      return `$${formulaToLatex(conteudo[1])}$`;
    })
    .join('');
}
