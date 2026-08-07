/**
 * TikZ → geometria, para a prévia desenhar a figura em vez de anunciá-la.
 *
 * **Isto não é um interpretador de TikZ.** TikZ é uma linguagem de programação
 * gráfica completa, com laços, macros e cálculo simbólico; interpretá-la de
 * verdade exigiria um motor TeX, que são dezenas de megabytes de WASM.
 *
 * O que torna o recorte viável é o outro lado: o prompt do modo Science manda
 * o modelo usar **só TikZ básico** — `\node`, `\draw`, setas e `positioning`.
 * Não é um subconjunto arbitrário, é exatamente o que este app pede que seja
 * escrito. Fora dele, a prévia volta a mostrar o cartão com a legenda, que é
 * honesto: o desenho aparece ao compilar o LaTeX.
 *
 * Eixo: TikZ cresce para cima, SVG cresce para baixo. A inversão é feita no
 * fim, ao calcular os limites — antes disso tudo está em coordenadas TikZ.
 */

export interface TikzNode {
  readonly id: string | null;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  /** `rectangle`, `circle` ou nenhum (só texto). */
  readonly shape: 'rectangle' | 'circle' | 'none';
  readonly dashed: boolean;
}

export interface TikzEdge {
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly arrow: 'none' | 'to' | 'both';
  readonly dashed: boolean;
  readonly label: string | null;
}

export interface TikzShape {
  readonly kind: 'rectangle' | 'circle';
  readonly x: number;
  readonly y: number;
  /** Canto oposto no retângulo; raio no círculo. */
  readonly x2: number;
  readonly y2: number;
  readonly dashed: boolean;
}

export interface TikzFigure {
  readonly nodes: readonly TikzNode[];
  readonly edges: readonly TikzEdge[];
  readonly shapes: readonly TikzShape[];
  /** Comandos que não foram entendidos. Vazio = a figura saiu inteira. */
  readonly skipped: readonly string[];
}

/** Uma unidade TikZ (1cm) em pixels. */
export const UNIDADE = 46;
/**
 * Distância entre BORDAS no `positioning`, em unidades TikZ.
 *
 * É a semântica real do `right=of a`: o afastamento é entre as bordas dos
 * nós, não entre os centros. Com distância entre centros, um rótulo largo
 * invade o vizinho — e foi exatamente o que apareceu no primeiro desenho.
 */
const ESPACO_PADRAO = 1;

/** Meia largura do nó a partir do rótulo, em unidades TikZ. */
export function meiaLarguraDe(rotulo: string): number {
  return Math.max(0.55, rotulo.length * 0.115 + 0.28);
}
const MEIA_ALTURA_NO = 0.34;

function limparRotulo(texto: string): string {
  return texto
    .replace(/\\(?:text(?:bf|it|tt|rm)|mathrm|emph)\s*\{([^{}]*)\}/gu, '$1')
    .replace(/\\\\/gu, ' ')
    .replace(/[{}$]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Extrai `[...]` respeitando colchete aninhado. */
function lerOpcoes(texto: string, inicio: number): { opcoes: string; fim: number } {
  if (texto[inicio] !== '[') return { opcoes: '', fim: inicio };
  let profundidade = 0;
  for (let i = inicio; i < texto.length; i += 1) {
    if (texto[i] === '[') profundidade += 1;
    else if (texto[i] === ']') {
      profundidade -= 1;
      if (profundidade === 0) return { opcoes: texto.slice(inicio + 1, i), fim: i + 1 };
    }
  }
  return { opcoes: '', fim: inicio };
}

function lerChaves(texto: string, inicio: number): { conteudo: string; fim: number } {
  if (texto[inicio] !== '{') return { conteudo: '', fim: inicio };
  let profundidade = 0;
  for (let i = inicio; i < texto.length; i += 1) {
    if (texto[i] === '{') profundidade += 1;
    else if (texto[i] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return { conteudo: texto.slice(inicio + 1, i), fim: i + 1 };
    }
  }
  return { conteudo: '', fim: inicio };
}

function seta(opcoes: string): TikzEdge['arrow'] {
  if (/<->|<-\s*>/u.test(opcoes)) return 'both';
  if (/->|-\s*>|latex|stealth/u.test(opcoes)) return 'to';
  if (/<-/u.test(opcoes)) return 'to';
  return 'none';
}

/**
 * Resolve `right=of a`, `below left=of b` e afins.
 *
 * `positioning` é a biblioteca que o prompt autoriza, e é como o modelo
 * costuma dispor os nós — quase nunca com coordenadas explícitas.
 */
function posicaoRelativa(
  opcoes: string,
  porId: ReadonlyMap<string, { x: number; y: number; meiaLargura: number }>,
  meiaLarguraNova: number,
): { x: number; y: number } | null {
  const encontrado = /\b(above|below|left|right)(?:\s+(above|below|left|right))?\s*(?:=\s*(?:([\d.]+)\s*(?:cm)?\s+)?of\s+([A-Za-z0-9_-]+))/u.exec(opcoes);
  if (!encontrado) return null;
  const alvo = porId.get(encontrado[4]);
  if (!alvo) return null;
  const distancia = encontrado[3] ? Number(encontrado[3]) : ESPACO_PADRAO;
  const direcoes = [encontrado[1], encontrado[2]].filter(Boolean) as string[];
  let { x, y } = alvo;
  for (const direcao of direcoes) {
    // Horizontal soma as duas meias larguras; vertical, as duas meias alturas.
    const vaoX = alvo.meiaLargura + distancia + meiaLarguraNova;
    const vaoY = MEIA_ALTURA_NO * 2 + distancia;
    if (direcao === 'above') y += vaoY;
    else if (direcao === 'below') y -= vaoY;
    else if (direcao === 'left') x -= vaoX;
    else if (direcao === 'right') x += vaoX;
  }
  return { x, y };
}

function lerCoordenada(texto: string): { x: number; y: number } | null {
  const encontrado = /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/u.exec(texto);
  if (!encontrado) return null;
  return { x: Number(encontrado[1]), y: Number(encontrado[2]) };
}

/**
 * Lê o corpo de um `tikzpicture`.
 *
 * Devolve `null` quando não sobrou nada desenhável — aí a prévia mostra o
 * cartão com a legenda em vez de um quadro vazio, que seria pior.
 */
export function parseTikz(source: string): TikzFigure | null {
  const nodes: TikzNode[] = [];
  const edges: TikzEdge[] = [];
  const shapes: TikzShape[] = [];
  const skipped: string[] = [];
  const porId = new Map<string, { x: number; y: number; meiaLargura: number }>();
  // Sem coordenada nem posição relativa, os nós entram em coluna: melhor um
  // empilhamento legível do que todos sobrepostos na origem.
  let proximaLinha = 0;

  const corpo = source.replace(/%[^\n]*/gu, '');
  for (const bruto of corpo.split(';')) {
    const comando = bruto.trim();
    if (!comando) continue;

    if (comando.startsWith('\\node') || comando.startsWith('\\coordinate')) {
      let cursor = comando.startsWith('\\coordinate') ? 11 : 5;
      // As opções, quando existem, vêm coladas ao comando: `\node[opts]`.
      let opcoes = '';
      while (/\s/u.test(comando[cursor] ?? '')) cursor += 1;
      if (comando[cursor] === '[') {
        const lido = lerOpcoes(comando, cursor);
        cursor = lido.fim;
        opcoes = lido.opcoes;
      }
      const nome = /^\s*\(([A-Za-z0-9_-]+)\)/u.exec(comando.slice(cursor));
      if (nome) cursor += nome[0].length;
      // TikZ aceita as opções antes OU depois do nome — `\node[o] (a)` e
      // `\node (a) [o]` são a mesma coisa, e o modelo usa as duas formas.
      while (/\s/u.test(comando[cursor] ?? '')) cursor += 1;
      if (comando[cursor] === '[') {
        const depois = lerOpcoes(comando, cursor);
        opcoes = opcoes ? `${opcoes},${depois.opcoes}` : depois.opcoes;
        cursor = depois.fim;
      }
      const emCoordenada = /^\s*at\s*(\([^)]*\))/u.exec(comando.slice(cursor));
      let posicao: { x: number; y: number } | null = null;
      if (emCoordenada) {
        posicao = lerCoordenada(emCoordenada[1]);
        cursor += emCoordenada[0].length;
      }
      // O rótulo é lido ANTES da posição: o afastamento entre bordas depende
      // da largura deste nó, que vem do tamanho do rótulo.
      const abre = comando.indexOf('{', cursor);
      const rotulo = abre >= 0 ? limparRotulo(lerChaves(comando, abre).conteudo) : '';
      const meia = meiaLarguraDe(rotulo);
      posicao = posicao ?? posicaoRelativa(opcoes, porId, meia);
      if (!posicao) {
        posicao = { x: 0, y: -proximaLinha * 1.4 };
        proximaLinha += 1;
      }
      const id = nome ? nome[1] : null;
      if (id) porId.set(id, { ...posicao, meiaLargura: meia });
      nodes.push({
        id,
        label: rotulo,
        x: posicao.x,
        y: posicao.y,
        shape: /\bcircle\b/u.test(opcoes) ? 'circle' : /\b(rectangle|draw|box|block)\b/u.test(opcoes) || rotulo ? 'rectangle' : 'none',
        dashed: /\bdashed\b/u.test(opcoes),
      });
      continue;
    }

    if (comando.startsWith('\\draw') || comando.startsWith('\\path')) {
      const inicioOpcoes = comando.indexOf('[');
      const temOpcoes = inicioOpcoes >= 0 && inicioOpcoes < (comando.indexOf('(') === -1 ? comando.length : comando.indexOf('('));
      const { opcoes } = temOpcoes ? lerOpcoes(comando, inicioOpcoes) : { opcoes: '' };
      const tracejado = /\bdashed\b/u.test(opcoes);

      const retangulo = /\(([^)]+)\)\s*rectangle\s*\(([^)]+)\)/u.exec(comando);
      if (retangulo) {
        const a = lerCoordenada(`(${retangulo[1]})`);
        const b = lerCoordenada(`(${retangulo[2]})`);
        if (a && b) {
          shapes.push({ kind: 'rectangle', x: a.x, y: a.y, x2: b.x, y2: b.y, dashed: tracejado });
          continue;
        }
      }
      const circulo = /\(([^)]+)\)\s*circle\s*\(?\s*([\d.]+)/u.exec(comando);
      if (circulo) {
        const centro = lerCoordenada(`(${circulo[1]})`) ?? porId.get(circulo[1].trim()) ?? null;
        if (centro) {
          shapes.push({ kind: 'circle', x: centro.x, y: centro.y, x2: Number(circulo[2]), y2: 0, dashed: tracejado });
          continue;
        }
      }

      // Caminho: sequência de pontos ligados por `--`, `->` ou `to`.
      const pontos = [...comando.matchAll(/\(([^)]+)\)/gu)]
        .map((achado) => {
          const texto = achado[1].trim();
          return lerCoordenada(`(${texto})`) ?? porId.get(texto) ?? null;
        })
        .filter((ponto): ponto is { x: number; y: number } => ponto !== null);
      const rotuloAresta = /node\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/u.exec(comando);
      if (pontos.length >= 2) {
        for (let i = 1; i < pontos.length; i += 1) {
          edges.push({
            from: pontos[i - 1],
            to: pontos[i],
            arrow: seta(opcoes),
            dashed: tracejado,
            label: i === 1 && rotuloAresta ? limparRotulo(rotuloAresta[1]) : null,
          });
        }
        continue;
      }
      skipped.push(comando.slice(0, 40));
      continue;
    }

    if (comando.startsWith('\\')) skipped.push(comando.slice(0, 40));
  }

  if (nodes.length === 0 && edges.length === 0 && shapes.length === 0) return null;
  return { nodes, edges, shapes, skipped };
}

export interface TikzBounds {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/** Limites em pixels, já com o eixo Y invertido para o SVG. */
export function tikzBounds(figura: TikzFigure, margem = 0.6): TikzBounds {
  const xs: number[] = [];
  const ys: number[] = [];
  const registrar = (x: number, y: number) => { xs.push(x); ys.push(y); };
  // Nó ocupa área, não um ponto: sem a folga o rótulo sai do quadro.
  for (const node of figura.nodes) {
    const meiaLargura = meiaLarguraDe(node.label);
    registrar(node.x - meiaLargura, node.y - 0.4);
    registrar(node.x + meiaLargura, node.y + 0.4);
  }
  for (const edge of figura.edges) {
    registrar(edge.from.x, edge.from.y);
    registrar(edge.to.x, edge.to.y);
  }
  for (const shape of figura.shapes) {
    if (shape.kind === 'circle') {
      registrar(shape.x - shape.x2, shape.y - shape.x2);
      registrar(shape.x + shape.x2, shape.y + shape.x2);
    } else {
      registrar(shape.x, shape.y);
      registrar(shape.x2, shape.y2);
    }
  }
  if (xs.length === 0) return { minX: 0, minY: 0, width: UNIDADE, height: UNIDADE };

  const minX = Math.min(...xs) - margem;
  const maxX = Math.max(...xs) + margem;
  const minY = Math.min(...ys) - margem;
  const maxY = Math.max(...ys) + margem;
  return {
    minX: minX * UNIDADE,
    // Y invertido: o topo do SVG é o maior Y do TikZ.
    minY: -maxY * UNIDADE,
    width: Math.max(1, (maxX - minX) * UNIDADE),
    height: Math.max(1, (maxY - minY) * UNIDADE),
  };
}

/**
 * Ponto de um rótulo de aresta: no meio, deslocado PERPENDICULARMENTE à
 * linha.
 *
 * Deslocar só para cima funciona em aresta horizontal e falha na diagonal,
 * onde o texto cai em cima do próprio traço.
 */
export function pontoDoRotulo(
  de: { x: number; y: number },
  para: { x: number; y: number },
  afastamento = 10,
): { x: number; y: number } {
  const meioX = (de.x + para.x) / 2;
  const meioY = (de.y + para.y) / 2;
  const dx = para.x - de.x;
  const dy = para.y - de.y;
  const comprimento = Math.hypot(dx, dy) || 1;
  // Normal à direção, sempre apontando para cima na tela.
  const nx = -dy / comprimento;
  const ny = dx / comprimento;
  const sinal = ny > 0 ? -1 : 1;
  return { x: meioX + nx * afastamento * sinal, y: meioY + ny * afastamento * sinal };
}

/** Ponto TikZ → ponto SVG. */
export function paraSvg(x: number, y: number): { x: number; y: number } {
  return { x: x * UNIDADE, y: -y * UNIDADE };
}

/**
 * Encolhe a aresta para ela parar na borda do nó, não no centro dele.
 *
 * Sem isso a ponta da seta fica escondida sob o retângulo do destino, e o
 * desenho parece ter linhas que somem.
 */
export function encurtar(
  de: { x: number; y: number },
  para: { x: number; y: number },
  recuo: number,
): { x: number; y: number } {
  const dx = para.x - de.x;
  const dy = para.y - de.y;
  const distancia = Math.hypot(dx, dy);
  if (distancia <= recuo) return para;
  return { x: para.x - (dx / distancia) * recuo, y: para.y - (dy / distancia) * recuo };
}
