/**
 * Gráfico: especificação JSON → escalas → geometria das marcas.
 *
 * A especificação é JSON porque o dado de um gráfico é estruturado — série,
 * rótulo, número — e inventar uma sintaxe de texto para isso só criaria
 * maneiras novas de o modelo errar. O preço é que JSON pela metade não parseia
 * durante o streaming; quem chama mostra "montando o gráfico" até fechar.
 *
 * **Um eixo só, sempre.** A especificação não tem como declarar um segundo eixo
 * y, e isso é intencional: dois eixos com escalas diferentes no mesmo desenho
 * fazem o leitor enxergar uma correlação que não está no dado. Duas grandezas
 * incomparáveis pedem dois gráficos.
 *
 * As cores são atribuídas por POSIÇÃO da série na especificação, nunca por
 * ordem de grandeza: se fosse por tamanho, filtrar ou reordenar repintaria as
 * séries e quem aprendeu "receita é a azul" passaria a ler errado.
 */

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
}

export interface ChartSpec {
  readonly type: ChartType;
  readonly title: string | null;
  readonly xLabel: string | null;
  readonly yLabel: string | null;
  readonly x: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Empilha as séries em vez de agrupá-las. Só barra e área. */
  readonly stacked: boolean;
}

export interface ChartParseResult {
  readonly spec: ChartSpec | null;
  /** Mensagem para a interface quando não deu para ler. */
  readonly error: string | null;
  /** Ajustes silenciosos que o usuário precisa saber (ex.: séries cortadas). */
  readonly notes: readonly string[];
}

/**
 * Seis é o teto de séries, e não uma preferência.
 *
 * A paleta categórica tem seis posições validadas contra as duas superfícies
 * do app; a sétima cor teria de ser gerada, e cor gerada é indistinguível de
 * alguma das outras para quem tem daltonismo. Além disso, gráfico de chat com
 * sete séries não se lê.
 */
export const MAX_SERIES = 6;
/** Fatias de pizza: acima disso as menores viram "Outros". */
export const MAX_PIE_SLICES = 6;

const TIPOS = new Set<ChartType>(['bar', 'line', 'area', 'pie']);

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

function numero(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  // O modelo às vezes manda "1.234" ou "12%"; recusar por isso seria perder o
  // gráfico inteiro por causa de formatação.
  if (typeof valor === 'string') {
    const limpo = valor.replace(/[%\s]/gu, '').replace(/\.(?=\d{3}\b)/gu, '').replace(',', '.');
    const convertido = Number(limpo);
    if (Number.isFinite(convertido)) return convertido;
  }
  return null;
}

export function parseChartSpec(source: string): ChartParseResult {
  const bruto = source.trim();
  if (!bruto) return { spec: null, error: null, notes: [] };

  let dados: unknown;
  try {
    dados = JSON.parse(bruto);
  } catch {
    // Durante o streaming isto acontece a cada pedaço; quem chama trata como
    // "ainda montando", não como erro.
    return { spec: null, error: null, notes: [] };
  }
  if (typeof dados !== 'object' || dados === null) {
    return { spec: null, error: 'A especificação do gráfico precisa ser um objeto JSON.', notes: [] };
  }

  const registro = dados as Record<string, unknown>;
  const tipoBruto = texto(registro.type)?.toLowerCase() ?? 'bar';
  const type = (TIPOS.has(tipoBruto as ChartType) ? tipoBruto : 'bar') as ChartType;
  const notes: string[] = [];

  const x = Array.isArray(registro.x) ? registro.x.map((item) => texto(item) ?? String(item)) : [];
  const seriesBruta = Array.isArray(registro.series) ? registro.series : [];

  let series: ChartSeries[] = seriesBruta.flatMap((item, indice) => {
    if (typeof item !== 'object' || item === null) return [];
    const registroSerie = item as Record<string, unknown>;
    const valores = Array.isArray(registroSerie.values) ? registroSerie.values.map(numero) : [];
    // Valor ilegível vira 0 em vez de derrubar a série: um buraco num ponto é
    // menos ruim do que a série sumir do gráfico sem explicação.
    const limpos = valores.map((valor) => valor ?? 0);
    if (limpos.length === 0) return [];
    return [{ name: texto(registroSerie.name) ?? `Série ${indice + 1}`, values: limpos }];
  });

  if (series.length === 0) {
    return { spec: null, error: 'O gráfico não tem nenhuma série com valores.', notes: [] };
  }

  if (type !== 'pie' && series.length > MAX_SERIES) {
    notes.push(`Só as ${MAX_SERIES} primeiras séries são desenhadas; as demais estão na tabela.`);
    series = series.slice(0, MAX_SERIES);
  }
  if (type === 'pie' && series.length > 1) {
    notes.push('Um gráfico de pizza mostra uma série; as demais estão na tabela.');
    series = series.slice(0, 1);
  }

  // Categorias faltando viram rótulo posicional, e sobrando são cortadas: o
  // desenho precisa de x e valores do mesmo tamanho.
  const tamanho = Math.max(...series.map((serie) => serie.values.length));
  const categorias = Array.from({ length: tamanho }, (_, indice) => x[indice] ?? `${indice + 1}`);

  return {
    spec: {
      type,
      title: texto(registro.title),
      xLabel: texto(registro.xLabel),
      yLabel: texto(registro.yLabel),
      x: categorias,
      series: series.map((serie) => ({
        name: serie.name,
        values: Array.from({ length: tamanho }, (_, indice) => serie.values[indice] ?? 0),
      })),
      stacked: registro.stacked === true && (type === 'bar' || type === 'area'),
    },
    error: null,
    notes,
  };
}

/** Extremos do eixo de valor, já considerando empilhamento. */
export function valueExtent(spec: ChartSpec): { min: number; max: number } {
  if (spec.stacked) {
    const somas = spec.x.map((_, indice) =>
      spec.series.reduce((soma, serie) => soma + Math.max(0, serie.values[indice]), 0));
    return { min: 0, max: Math.max(...somas, 0) };
  }
  const todos = spec.series.flatMap((serie) => serie.values);
  const maiorDado = Math.max(...todos);
  const menorDado = Math.min(...todos);

  // **Barra sempre inclui o zero.** O comprimento da barra É a magnitude:
  // cortar a base transforma uma diferença de 5% num degrau visual enorme.
  if (spec.type === 'bar') return { min: Math.min(menorDado, 0), max: Math.max(maiorDado, 0) };

  // Linha e área codificam VARIAÇÃO, não magnitude, e aí forçar o zero é o
  // erro oposto: uma série entre 8 e 31 ficaria espremida no terço de cima do
  // desenho, escondendo justamente a variação que o gráfico existe para
  // mostrar. A faixa acompanha o dado; `niceTicks` arredonda para fora.
  if (menorDado >= 0 && menorDado <= maiorDado * 0.35) {
    // Perto do zero, incluí-lo não custa espaço e evita a leitura ambígua.
    return { min: 0, max: maiorDado };
  }
  return { min: menorDado, max: maiorDado };
}

/**
 * Marcas de escala em passos redondos (1, 2, 5 × potência de dez).
 *
 * Escala com números quebrados ("0, 3.7, 7.4") força o leitor a calcular para
 * ler o gráfico, que é justamente o trabalho que o gráfico deveria poupar.
 */
export function niceTicks(min: number, max: number, alvo = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min || 0];
  const bruto = (max - min) / alvo;
  const magnitude = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 5, 10].map((fator) => fator * magnitude).find((candidato) => candidato >= bruto) ?? magnitude * 10;
  const inicio = Math.floor(min / passo) * passo;
  const fim = Math.ceil(max / passo) * passo;
  const marcas: number[] = [];
  // Tolerância pela imprecisão de ponto flutuante: sem ela a última marca
  // some quando `fim` cai um epsilon abaixo dele mesmo.
  for (let valor = inicio; valor <= fim + passo * 1e-9; valor += passo) {
    marcas.push(Number(valor.toFixed(10)));
  }
  return marcas;
}

/** Abrevia para caber no eixo: 12.400 → 12,4 mil. */
export function formatValue(valor: number): string {
  const absoluto = Math.abs(valor);
  if (absoluto >= 1_000_000) return `${Number((valor / 1_000_000).toFixed(1)).toLocaleString('pt-BR')} mi`;
  if (absoluto >= 1_000) return `${Number((valor / 1_000).toFixed(1)).toLocaleString('pt-BR')} mil`;
  return Number(valor.toFixed(2)).toLocaleString('pt-BR');
}

export interface PieSlice {
  readonly label: string;
  readonly value: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly percent: number;
  /** Índice na paleta; "Outros" recebe o último. */
  readonly colorIndex: number;
}

/**
 * Fatias da pizza, com as menores agrupadas em "Outros".
 *
 * Agrupar é honesto e some com o problema de sete cores: a fatia "Outros"
 * existe, é rotulada e o valor de cada componente continua na tabela. Cortar
 * as menores fora, isso sim, esconderia dado.
 */
export function pieSlices(spec: ChartSpec): PieSlice[] {
  const serie = spec.series[0];
  const entradas = spec.x
    .map((label, indice) => ({ label, value: Math.max(0, serie.values[indice]) }))
    .filter((entrada) => entrada.value > 0)
    .sort((a, b) => b.value - a.value);

  const principais = entradas.slice(0, MAX_PIE_SLICES - 1);
  const resto = entradas.slice(MAX_PIE_SLICES - 1);
  const agrupadas = resto.length > 1
    ? [...principais, { label: 'Outros', value: resto.reduce((soma, item) => soma + item.value, 0) }]
    : entradas.slice(0, MAX_PIE_SLICES);

  const total = agrupadas.reduce((soma, item) => soma + item.value, 0);
  if (total <= 0) return [];

  let angulo = -Math.PI / 2;
  return agrupadas.map((entrada, indice) => {
    const fracao = entrada.value / total;
    const inicio = angulo;
    angulo += fracao * Math.PI * 2;
    return {
      label: entrada.label,
      value: entrada.value,
      startAngle: inicio,
      endAngle: angulo,
      percent: fracao * 100,
      colorIndex: indice,
    };
  });
}

/** Caminho de um setor de pizza (ou de rosca, com `raioInterno`). */
export function arcPath(cx: number, cy: number, raio: number, inicio: number, fim: number, raioInterno = 0): string {
  const grande = fim - inicio > Math.PI ? 1 : 0;
  const x1 = cx + raio * Math.cos(inicio);
  const y1 = cy + raio * Math.sin(inicio);
  const x2 = cx + raio * Math.cos(fim);
  const y2 = cy + raio * Math.sin(fim);
  if (raioInterno <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${raio} ${raio} 0 ${grande} 1 ${x2} ${y2} Z`;
  }
  const ix1 = cx + raioInterno * Math.cos(fim);
  const iy1 = cy + raioInterno * Math.sin(fim);
  const ix2 = cx + raioInterno * Math.cos(inicio);
  const iy2 = cy + raioInterno * Math.sin(inicio);
  return `M ${x1} ${y1} A ${raio} ${raio} 0 ${grande} 1 ${x2} ${y2} `
    + `L ${ix1} ${iy1} A ${raioInterno} ${raioInterno} 0 ${grande} 0 ${ix2} ${iy2} Z`;
}

/**
 * Barra com o topo arredondado e a base reta.
 *
 * O arredondado marca onde o dado termina; a base é reta porque encosta na
 * linha de zero, e cantos redondos ali sugeririam que a barra não começa no
 * zero. Some quando a barra é baixa demais para comportar o raio.
 */
export function barPath(x: number, y: number, largura: number, altura: number, raio = 4): string {
  const r = Math.max(0, Math.min(raio, largura / 2, altura));
  if (r === 0) return `M ${x} ${y} h ${largura} v ${altura} h ${-largura} Z`;
  return `M ${x} ${y + altura} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} `
    + `H ${x + largura - r} A ${r} ${r} 0 0 1 ${x + largura} ${y + r} V ${y + altura} Z`;
}
