import { describe, expect, it } from 'vitest';
import { collectIds, layoutMindmap, linkPath, parseMindmap, pathTo } from './mindmap';

const SEM_COLAPSO = new Set<string>();

function rotulos(source: string): string[] {
  return layoutMindmap(parseMindmap(source), SEM_COLAPSO).nodes.map((node) => node.label);
}

describe('leitura do roteiro', () => {
  it('a primeira linha é o centro e o recuo dá a hierarquia', () => {
    const raiz = parseMindmap(['Redes neurais', '- Arquiteturas', '  - CNN', '  - RNN', '- Treinamento'].join('\n'));
    expect(raiz?.label).toBe('Redes neurais');
    expect(raiz?.children.map((filho) => filho.label)).toEqual(['Arquiteturas', 'Treinamento']);
    expect(raiz?.children[0].children.map((neto) => neto.label)).toEqual(['CNN', 'RNN']);
  });

  it('aguenta indentação irregular, que é o que o modelo escreve', () => {
    // Dois espaços num ramo, quatro no outro, tabulação no terceiro. Dividir a
    // indentação por um número fixo quebraria; a pilha de recuos, não.
    const raiz = parseMindmap([
      'Centro',
      '- A',
      '  - A1',
      '- B',
      '    - B1',
      '- C',
      '\t- C1',
    ].join('\n'));
    expect(raiz?.children.map((filho) => filho.label)).toEqual(['A', 'B', 'C']);
    for (const filho of raiz?.children ?? []) expect(filho.children).toHaveLength(1);
  });

  it('volta o nível corretamente ao sair de um ramo fundo', () => {
    const raiz = parseMindmap(['Centro', '- A', '  - A1', '    - A1a', '- B'].join('\n'));
    expect(raiz?.children.map((f) => f.label)).toEqual(['A', 'B']);
    expect(raiz?.children[0].children[0].children[0].label).toBe('A1a');
  });

  it('limpa marcador, ênfase, crase e link do rótulo', () => {
    const raiz = parseMindmap(['# Centro', '- **Forte** e `código`', '- [Link](https://x.com)'].join('\n'));
    expect(raiz?.label).toBe('Centro');
    expect(raiz?.children.map((f) => f.label)).toEqual(['Forte e código', 'Link']);
  });

  it('aceita lista numerada', () => {
    const raiz = parseMindmap(['Centro', '1. Um', '2. Dois'].join('\n'));
    expect(raiz?.children.map((f) => f.label)).toEqual(['Um', 'Dois']);
  });

  it('ignora linhas vazias sem quebrar a hierarquia', () => {
    const raiz = parseMindmap(['Centro', '', '- A', '', '  - A1', ''].join('\n'));
    expect(raiz?.children[0].children[0].label).toBe('A1');
  });

  it('devolve null quando não há nada legível', () => {
    expect(parseMindmap('')).toBeNull();
    expect(parseMindmap('\n\n   \n')).toBeNull();
  });

  it('sobrevive a conteúdo truncado no meio do streaming', () => {
    // A árvore é remontada a cada pedaço; a última linha chega pela metade o
    // tempo todo.
    expect(() => parseMindmap('Centro\n- Ramo\n  - Sub')).not.toThrow();
    expect(rotulos('Centro\n- Ram')).toEqual(['Centro', 'Ram']);
  });
});

describe('posicionamento', () => {
  it('cada nível ocupa uma coluna própria, da esquerda para a direita', () => {
    const layout = layoutMindmap(parseMindmap('Centro\n- A\n  - A1'), SEM_COLAPSO);
    const [centro, a, a1] = ['Centro', 'A', 'A1'].map((rotulo) =>
      layout.nodes.find((node) => node.label === rotulo)!);
    expect(centro.x).toBe(0);
    expect(a.x).toBeGreaterThan(centro.x);
    expect(a1.x).toBeGreaterThan(a.x);
  });

  it('o pai fica centrado entre o primeiro e o último filho', () => {
    const layout = layoutMindmap(parseMindmap('Centro\n- A\n- B\n- C'), SEM_COLAPSO);
    const acha = (rotulo: string) => layout.nodes.find((node) => node.label === rotulo)!;
    expect(acha('Centro').y).toBeCloseTo((acha('A').y + acha('C').y) / 2, 5);
  });

  it('irmãos não se sobrepõem', () => {
    const layout = layoutMindmap(parseMindmap('Centro\n- A\n  - A1\n  - A2\n- B\n  - B1'), SEM_COLAPSO);
    const folhas = layout.nodes.filter((node) => node.childCount === 0).sort((x, y) => x.y - y.y);
    for (let i = 1; i < folhas.length; i += 1) {
      expect(folhas[i].y).toBeGreaterThanOrEqual(folhas[i - 1].y + folhas[i - 1].height);
    }
  });

  it('recolher um ramo tira os descendentes do desenho', () => {
    const raiz = parseMindmap('Centro\n- A\n  - A1\n    - A1a\n- B')!;
    const a = raiz.children[0];
    const layout = layoutMindmap(raiz, new Set([a.id]));
    expect(layout.nodes.map((node) => node.label)).toEqual(['Centro', 'A', 'B']);
    // E o nó recolhido informa quantos filhos escondeu.
    expect(layout.nodes.find((node) => node.label === 'A')?.collapsed).toBe(true);
    expect(layout.nodes.find((node) => node.label === 'A')?.childCount).toBe(1);
  });

  it('recolher encolhe o desenho, que é o motivo de existir', () => {
    const raiz = parseMindmap('Centro\n- A\n  - A1\n  - A2\n  - A3')!;
    const aberto = layoutMindmap(raiz, SEM_COLAPSO);
    const fechado = layoutMindmap(raiz, new Set([raiz.children[0].id]));
    expect(fechado.height).toBeLessThan(aberto.height);
    expect(fechado.width).toBeLessThan(aberto.width);
  });

  it('não posiciona nada quando não há árvore', () => {
    expect(layoutMindmap(null, SEM_COLAPSO)).toEqual({ nodes: [], links: [], width: 0, height: 0 });
  });

  it('há uma ligação para cada nó visível menos a raiz', () => {
    const layout = layoutMindmap(parseMindmap('Centro\n- A\n  - A1\n- B'), SEM_COLAPSO);
    expect(layout.links).toHaveLength(layout.nodes.length - 1);
  });
});

describe('ligação', () => {
  it('sai pela direita do pai e chega pela esquerda do filho', () => {
    const layout = layoutMindmap(parseMindmap('Centro\n- A'), SEM_COLAPSO);
    const { from, to } = layout.links[0];
    const caminho = linkPath(from, to);
    expect(caminho.startsWith(`M ${from.x + from.width} `)).toBe(true);
    expect(caminho).toContain(`${to.x} `);
  });
});

describe('caminho até o tópico', () => {
  const raiz = parseMindmap([
    'Redes Neurais',
    '- Treinamento',
    '  - Retropropagação',
    '- Arquiteturas',
  ].join('\n'))!;

  it('devolve a linhagem da raiz até o nó', () => {
    // É o que dá contexto à pergunta: o modelo não viu o mapa, e
    // "Retropropagação" sozinho é ambíguo.
    const alvo = raiz.children[0].children[0];
    expect(pathTo(raiz, alvo.id)).toEqual(['Redes Neurais', 'Treinamento', 'Retropropagação']);
  });

  it('a raiz é caminho de um elemento só', () => {
    expect(pathTo(raiz, raiz.id)).toEqual(['Redes Neurais']);
  });

  it('não confunde ramos irmãos', () => {
    expect(pathTo(raiz, raiz.children[1].id)).toEqual(['Redes Neurais', 'Arquiteturas']);
  });

  it('devolve vazio para id inexistente ou árvore ausente', () => {
    expect(pathTo(raiz, 'nao-existe')).toEqual([]);
    expect(pathTo(null, 'n0')).toEqual([]);
  });
});

describe('contagem de tópicos', () => {
  it('conta a árvore inteira, inclusive o que está recolhido', () => {
    // O rodapé diz quantos tópicos o mapa TEM, não quantos estão à vista.
    expect(collectIds(parseMindmap('Centro\n- A\n  - A1\n- B'))).toHaveLength(4);
    expect(collectIds(null)).toEqual([]);
  });
});
