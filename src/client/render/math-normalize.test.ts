import { describe, expect, it } from 'vitest';
import { hasMathSyntax, normalizeMathDelimiters, prepareMarkdownForRender } from './math-normalize';

describe('normalização de matemática em markdown', () => {
  it('converte delimitadores LaTeX alternativos fora de código', () => {
    const source = String.raw`Inline \(x^2\) e bloco:
\[a^2 + b^2 = c^2\]`;
    const normalized = normalizeMathDelimiters(source);
    expect(normalized).toContain('$x^2$');
    expect(normalized).toContain('$$\na^2 + b^2 = c^2\n$$');
  });

  it('não converte delimitadores dentro de spans ou fences de código', () => {
    const source = [
      String.raw`Use \[i\] no código:`,
      '```python',
      String.raw`value = "\[i\]"`,
      '```',
      '`\\(x\\)`',
    ].join('\n');
    const normalized = normalizeMathDelimiters(source);
    expect(normalized).toContain('value = "\\[i\\]"');
    expect(normalized).toContain('`\\(x\\)`');
    expect(normalized).toContain('$$\ni\n$$');
  });

  it('fecha fences e matemática aberta enquanto o stream está ativo', () => {
    const prepared = prepareMarkdownForRender('```ts\nconst value = 1\n```\n\nResposta: $x^2', true);
    expect(prepared).toContain('```ts\nconst value = 1\n```');
    expect(prepared).toContain('$x^2$');
  });

  it('ignora preços e código ao detectar matemática', () => {
    expect(hasMathSyntax('Custa $50 e o exemplo é `\\(x\\)`.')).toBe(false);
    expect(hasMathSyntax('A fórmula é $x + 1$.')).toBe(true);
  });
});
