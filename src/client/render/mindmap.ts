/**
 * Mapa mental: roteiro indentado → árvore → posições.
 *
 * O conteúdo do artefato é uma lista aninhada de Markdown, não um formato de
 * diagrama próprio. Três razões, nesta ordem:
 *
 * 1. **O modelo já escreve lista aninhada bem.** Uma sintaxe inventada seria
 *    mais uma coisa para ele errar, e errar num formato desconhecido produz
 *    tela em branco em vez de resultado parcial.
 * 2. **Sobrevive ao streaming.** A árvore é remontada a cada pedaço que chega;
 *    uma linha pela metade vira um nó a menos, não um erro de sintaxe.
 * 3. **Continua legível na aba Fonte**, que é o que o usuário copia para levar
 *    o mapa embora.
 *
 * O layout é uma árvore horizontal — a mesma leitura de esquerda para a
 * direita do NotebookLM. Radial ficaria bonito e ilegível: rótulo em português
 * é longo, e texto girando em volta de um centro obriga a virar a cabeça.
 */

export interface MindmapNode {
  readonly id: string;
  readonly label: string;
  readonly children: MindmapNode[];
  readonly depth: number;
}

/** Nó já posicionado, pronto para virar SVG. */
export interface PlacedNode {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly childCount: number;
  readonly collapsed: boolean;
}

export interface MindmapLayout {
  readonly nodes: readonly PlacedNode[];
  readonly links: ReadonlyArray<{ from: PlacedNode; to: PlacedNode }>;
  readonly width: number;
  readonly height: number;
}

const ALTURA = 34;
const ESPACO_VERTICAL = 12;
const ESPACO_HORIZONTAL = 54;
const LARGURA_MINIMA = 92;
const LARGURA_MAXIMA = 260;
/** Aproxima a largura do texto sem medir no DOM — o layout roda fora da tela. */
const LARGURA_POR_CARACTERE = 7.4;
const PADDING_HORIZONTAL = 26;

/** Tira marcador de lista, ênfase e crase, que só atrapalham num nó. */
function limparRotulo(texto: string): string {
  return texto
    // O recuo sai primeiro: sem isto o marcador de uma linha indentada não
    // casa com a âncora `^` e o hífen fica dentro do rótulo.
    .trimStart()
    .replace(/^[-*+]\s+/u, '')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/\*(.+?)\*/gu, '$1')
    .replace(/`(.+?)`/gu, '$1')
    .replace(/\[(.+?)\]\([^)]*\)/gu, '$1')
    .trim();
}

function larguraDe(rotulo: string): number {
  const estimada = rotulo.length * LARGURA_POR_CARACTERE + PADDING_HORIZONTAL;
  return Math.max(LARGURA_MINIMA, Math.min(LARGURA_MAXIMA, estimada));
}

/**
 * Lê o roteiro e devolve a raiz.
 *
 * O nível vem da indentação, mas com uma correção que importa: modelos
 * misturam 2 e 4 espaços no mesmo documento, e às vezes tabulação. Em vez de
 * dividir a indentação por um número fixo, os recuos vistos são empilhados —
 * um recuo maior que o do topo da pilha desce um nível, e recuos iguais são
 * irmãos. Assim o mapa sai certo mesmo com indentação irregular.
 */
export function parseMindmap(source: string): MindmapNode | null {
  const linhas = source.split('\n');
  let raiz: MindmapNode | null = null;
  const pilha: Array<{ recuo: number; node: MindmapNode }> = [];
  let contador = 0;

  const criar = (label: string, depth: number): MindmapNode =>
    ({ id: `n${contador++}`, label, children: [], depth });

  for (const linha of linhas) {
    if (!linha.trim()) continue;
    // Tabulação conta como dois espaços; o que importa é a ordem relativa.
    const recuo = (linha.match(/^[\t ]*/u)?.[0] ?? '').replace(/\t/gu, '  ').length;
    const rotulo = limparRotulo(linha);
    if (!rotulo) continue;

    const ehItem = /^[\t ]*[-*+]\s/u.test(linha) || /^[\t ]*\d+[.)]\s/u.test(linha);

    if (!raiz) {
      // A primeira linha é o centro do mapa, seja ela título ou item.
      raiz = criar(rotulo, 0);
      pilha.push({ recuo: ehItem ? recuo : -1, node: raiz });
      continue;
    }

    while (pilha.length > 1 && recuo <= pilha[pilha.length - 1].recuo) pilha.pop();
    const pai = pilha[pilha.length - 1].node;
    const node = criar(rotulo, pai.depth + 1);
    pai.children.push(node);
    pilha.push({ recuo, node });
  }

  return raiz;
}

/**
 * Caminho da raiz até o nó, pelos rótulos.
 *
 * É o que dá contexto à pergunta: "Retropropagação" sozinho é ambíguo, e o
 * modelo não viu o mapa. "Redes Neurais › Treinamento › Retropropagação" diz
 * de onde o tópico saiu sem precisar mandar o mapa inteiro junto.
 */
export function pathTo(node: MindmapNode | null, id: string): string[] {
  if (!node) return [];
  if (node.id === id) return [node.label];
  for (const filho of node.children) {
    const abaixo = pathTo(filho, id);
    if (abaixo.length > 0) return [node.label, ...abaixo];
  }
  return [];
}

/** Todos os ids da árvore — usado para "expandir tudo". */
export function collectIds(node: MindmapNode | null): string[] {
  if (!node) return [];
  return [node.id, ...node.children.flatMap(collectIds)];
}

/**
 * Posiciona a árvore.
 *
 * Cada folha visível ocupa uma faixa; cada pai é centrado no bloco dos
 * filhos. É o algoritmo de árvore arrumada na sua forma mínima — suficiente
 * porque os nós têm altura fixa e a leitura é sempre da esquerda para a
 * direita, então não há como dois ramos colidirem.
 */
export function layoutMindmap(
  raiz: MindmapNode | null,
  colapsados: ReadonlySet<string>,
): MindmapLayout {
  if (!raiz) return { nodes: [], links: [], width: 0, height: 0 };

  const nodes: PlacedNode[] = [];
  const links: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  const colunas: number[] = [];

  // Largura de cada coluna: a do rótulo mais largo naquele nível. Sem isto,
  // um ramo com nome curto deixaria um vão e o mapa pareceria desalinhado.
  const medir = (node: MindmapNode) => {
    colunas[node.depth] = Math.max(colunas[node.depth] ?? 0, larguraDe(node.label));
    if (!colapsados.has(node.id)) node.children.forEach(medir);
  };
  medir(raiz);

  const xDe = (depth: number): number =>
    colunas.slice(0, depth).reduce((soma, largura) => soma + largura + ESPACO_HORIZONTAL, 0);

  let cursorY = 0;
  const posicionar = (node: MindmapNode): PlacedNode => {
    const colapsado = colapsados.has(node.id) && node.children.length > 0;
    const filhos = colapsado ? [] : node.children.map(posicionar);
    const y = filhos.length > 0
      // Centrado no primeiro e no último filho, e não na média: com um ramo
      // muito mais fundo que o outro, a média puxa o pai para longe da linha
      // que o olho segue.
      ? (filhos[0].y + filhos[filhos.length - 1].y) / 2
      : (cursorY += ALTURA + ESPACO_VERTICAL) - (ALTURA + ESPACO_VERTICAL);

    const colocado: PlacedNode = {
      id: node.id,
      label: node.label,
      depth: node.depth,
      x: xDe(node.depth),
      y,
      width: colunas[node.depth] ?? LARGURA_MINIMA,
      height: ALTURA,
      childCount: node.children.length,
      collapsed: colapsado,
    };
    nodes.push(colocado);
    for (const filho of filhos) links.push({ from: colocado, to: filho });
    return colocado;
  };
  posicionar(raiz);

  // Ordem de documento (nível, depois posição vertical). O posicionamento
  // visita os filhos antes do pai para poder centrá-lo, e essa ordem interna
  // não é a que faz sentido para quem lê a lista de nós — nem para tabulação
  // por teclado, que segue a ordem do DOM.
  nodes.sort((a, b) => (a.depth - b.depth) || (a.y - b.y));

  const larguraTotal = Math.max(...nodes.map((node) => node.x + node.width), 0);
  const alturaTotal = Math.max(...nodes.map((node) => node.y + node.height), 0);
  return { nodes, links, width: larguraTotal, height: alturaTotal };
}

/** Curva de ligação: sai pela direita do pai e chega pela esquerda do filho. */
export function linkPath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const meio = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${meio} ${y1}, ${meio} ${y2}, ${x2} ${y2}`;
}
