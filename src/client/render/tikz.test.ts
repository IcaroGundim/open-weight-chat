import { describe, expect, it } from 'vitest';
import { encurtar, paraSvg, parseTikz, pontoDoRotulo, tikzBounds } from './tikz';

describe('leitura de TikZ básico', () => {
  it('lê nós com coordenada e rótulo', () => {
    const f = parseTikz(String.raw`
      \node (a) at (0,0) {Entrada};
      \node (b) at (3,0) {Saída};
    `)!;
    expect(f.nodes.map((n) => n.label)).toEqual(['Entrada', 'Saída']);
    expect(f.nodes[1].x).toBe(3);
  });

  it('resolve posicionamento relativo, que é como o modelo dispõe os nós', () => {
    // `positioning` é a biblioteca autorizada no prompt; coordenada explícita
    // é rara no que o modelo escreve.
    const f = parseTikz(String.raw`
      \node (a) at (0,0) {A};
      \node (b) [right=of a] {B};
      \node (c) [below=1 of b] {C};
    `)!;
    const b = f.nodes.find((n) => n.id === 'b')!;
    const c = f.nodes.find((n) => n.id === 'c')!;
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBe(0);
    expect(c.y).toBeLessThan(b.y);
  });

  it('liga arestas por nome de nó, não só por coordenada', () => {
    const f = parseTikz(String.raw`
      \node (a) at (0,0) {A};
      \node (b) at (2,0) {B};
      \draw[->] (a) -- (b);
    `)!;
    expect(f.edges).toHaveLength(1);
    expect(f.edges[0].arrow).toBe('to');
    expect(f.edges[0].to.x).toBe(2);
  });

  it('lê rótulo de aresta e traço tracejado', () => {
    const f = parseTikz(String.raw`\draw[->,dashed] (0,0) -- node[above] {sim} (2,0);`)!;
    expect(f.edges[0].label).toBe('sim');
    expect(f.edges[0].dashed).toBe(true);
  });

  it('lê retângulo e círculo', () => {
    const f = parseTikz(String.raw`
      \draw (0,0) rectangle (2,1);
      \draw (3,0) circle (0.5);
    `)!;
    expect(f.shapes.map((s) => s.kind)).toEqual(['rectangle', 'circle']);
  });

  it('caminho com vários pontos vira várias arestas', () => {
    const f = parseTikz(String.raw`\draw (0,0) -- (1,0) -- (1,1);`)!;
    expect(f.edges).toHaveLength(2);
  });

  it('empilha nós sem posição em vez de sobrepô-los na origem', () => {
    const f = parseTikz(String.raw`\node {Um}; \node {Dois};`)!;
    expect(f.nodes[0].y).not.toBe(f.nodes[1].y);
  });

  it('registra o que não entendeu, em vez de fingir que desenhou', () => {
    const f = parseTikz(String.raw`
      \node (a) at (0,0) {A};
      \foreach \i in {1,...,5} { \draw (\i,0) circle (0.1); }
    `)!;
    expect(f.skipped.length).toBeGreaterThan(0);
  });

  it('devolve null quando não há nada desenhável', () => {
    expect(parseTikz('% só um comentário')).toBeNull();
    expect(parseTikz('')).toBeNull();
  });

  it('limpa marcação do rótulo', () => {
    const f = parseTikz(String.raw`\node at (0,0) {\textbf{Forte} e $x$};`)!;
    expect(f.nodes[0].label).toBe('Forte e x');
  });
});

describe('conversão para o plano do SVG', () => {
  it('inverte o eixo Y: TikZ cresce para cima, SVG para baixo', () => {
    expect(paraSvg(1, 1).y).toBeLessThan(paraSvg(1, 0).y);
  });

  it('os limites cobrem todos os elementos, com folga', () => {
    const f = parseTikz(String.raw`\node (a) at (0,0) {A}; \node (b) at (4,2) {B};`)!;
    const b = tikzBounds(f);
    expect(b.width).toBeGreaterThan(4 * 46);
    expect(b.height).toBeGreaterThan(2 * 46);
  });

  it('encurta a aresta para a ponta da seta não sumir sob o nó', () => {
    const fim = encurtar({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(fim.x).toBe(80);
  });

  it('não encurta além do próprio comprimento', () => {
    expect(encurtar({ x: 0, y: 0 }, { x: 10, y: 0 }, 50)).toEqual({ x: 10, y: 0 });
  });
});

describe('rótulo de aresta', () => {
  it('sai de cima da linha, deslocado perpendicularmente', () => {
    // Deslocar só para cima funciona na horizontal e falha na diagonal, onde
    // o texto cai sobre o próprio traço.
    const diagonal = pontoDoRotulo({ x: 0, y: 0 }, { x: 100, y: 100 });
    // Não pode estar sobre a reta y = x.
    expect(Math.abs(diagonal.x - diagonal.y)).toBeGreaterThan(5);
  });

  it('numa aresta horizontal o rótulo fica acima', () => {
    const p = pontoDoRotulo({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBeLessThan(0);
  });
});
