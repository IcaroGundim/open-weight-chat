import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { codeSpansToMath, formulaToLatex, looksLikeFormula } from './formula-code';

/**
 * O risco desta conversão é transformar CÓDIGO em matemática. Por isso a
 * metade dos testes é sobre o que NÃO pode ser convertido — se essa metade
 * ficar frouxa, o recurso passa a estragar respostas técnicas.
 */

describe('o que é fórmula', () => {
  it('reconhece as fórmulas que o modelo escreve entre crases', () => {
    expect(looksLikeFormula('σ(x) = 1 / (1 + e⁻ˣ)')).toBe(true);
    expect(looksLikeFormula('L = (1/n) Σ (yᵢ − ŷᵢ)²')).toBe(true);
    expect(looksLikeFormula('f(x) = max(0, x)')).toBe(true);
    expect(looksLikeFormula('tanh(x)')).toBe(true);
    expect(looksLikeFormula('a² + b² = c²')).toBe(true);
  });

  it('não converte código', () => {
    // Cada um destes viraria itálico serifado se a classificação afrouxasse.
    for (const codigo of [
      'const x = 5',
      'npm install react',
      'array.map(f)',
      'git commit -m "x"',
      'if (a && b) { return c; }',
      'useState()',
      'x => x + 1',
      'SELECT * FROM users',
      '--verbose',
      '-v',
      'src/client/render',
      'a[0] = b',
      'print("oi")',
      'return true',
      'docker run',
    ]) {
      expect(looksLikeFormula(codigo), codigo).toBe(false);
    }
  });

  it('recusa trecho longo, que é código quase sempre', () => {
    expect(looksLikeFormula('a = 1 + '.repeat(30))).toBe(false);
  });
});

describe('tradução para LaTeX', () => {
  it('converte expoente Unicode em potência de verdade', () => {
    expect(formulaToLatex('e⁻ˣ')).toBe('e^{-x}');
    expect(formulaToLatex('x²')).toBe('x^{2}');
  });

  it('agrupa uma sequência de índices num só', () => {
    // `x¹²` é x elevado a doze, não x¹ vezes x².
    expect(formulaToLatex('x¹²')).toBe('x^{12}');
  });

  it('converte subscrito, letra grega e símbolo', () => {
    expect(formulaToLatex('yᵢ')).toBe('y_{i}');
    expect(formulaToLatex('σ(x)')).toContain('\\sigma');
    expect(formulaToLatex('a ≤ b')).toContain('\\leq');
    expect(formulaToLatex('Σ x')).toContain('\\Sigma');
  });

  it('converte o chapéu de ŷ, comum em predição', () => {
    expect(formulaToLatex('ŷ')).toContain('\\hat{y}');
  });

  it('põe nome de função em redondo', () => {
    // Sem isto o KaTeX compõe `max` como o produto de m, a e x.
    expect(formulaToLatex('max(0, x)')).toBe('\\max(0, x)');
    expect(formulaToLatex('tanh(x)')).toBe('\\tanh(x)');
  });
});

describe('reescrita do Markdown', () => {
  it('troca o code span pela matemática e deixa a prosa intacta', () => {
    const saida = codeSpansToMath('**Sigmoid**: `σ(x) = 1 / (1 + e⁻ˣ)` — usada em classificação.');
    expect(saida).toContain('$\\sigma');
    expect(saida).toContain('e^{-x}');
    expect(saida).toContain('— usada em classificação.');
    expect(saida).not.toContain('`');
  });

  it('não toca em bloco cercado, nem quando o conteúdo parece fórmula', () => {
    const fonte = '```python\ny = max(0, x)\n```';
    expect(codeSpansToMath(fonte)).toBe(fonte);
  });

  it('deixa o code span de código exatamente como estava', () => {
    const fonte = 'Rode `npm install` e depois `const x = 5`.';
    expect(codeSpansToMath(fonte)).toBe(fonte);
  });

  it('converte vários spans na mesma linha', () => {
    const saida = codeSpansToMath('`x²` e `y²`');
    expect(saida).toBe('$x^{2}$ e $y^{2}$');
  });

  it('sai barato quando não há crase nenhuma', () => {
    const fonte = 'Texto sem código.';
    expect(codeSpansToMath(fonte)).toBe(fonte);
  });
});

describe('o resultado renderiza mesmo', () => {
  it('tudo que a conversão produz é aceito pelo KaTeX', () => {
    // Produzir LaTeX inválido trocaria a caixa rosa por um erro vermelho —
    // pior do que o problema original.
    for (const formula of [
      'σ(x) = 1 / (1 + e⁻ˣ)',
      'L = (1/n) Σ (yᵢ − ŷᵢ)²',
      'f(x) = max(0, x)',
      'tanh(x)',
      'a² + b² = c²',
      'x ≤ y ≥ z',
      'Δw = −η ∂L/∂w',
    ]) {
      const latex = formulaToLatex(formula);
      expect(() => katex.renderToString(latex, { throwOnError: true, strict: 'ignore' }), formula).not.toThrow();
    }
  });
});
