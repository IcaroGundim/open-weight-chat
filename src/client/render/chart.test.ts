import { describe, expect, it } from 'vitest';
import {
  MAX_SERIES,
  barPath,
  formatValue,
  niceTicks,
  parseChartSpec,
  pieSlices,
  valueExtent,
} from './chart';

const BARRA = JSON.stringify({
  type: 'bar',
  title: 'Receita',
  x: ['T1', 'T2'],
  series: [{ name: '2025', values: [10, 20] }],
});

describe('leitura da especificação', () => {
  it('lê tipo, título, categorias e séries', () => {
    const { spec } = parseChartSpec(BARRA);
    expect(spec?.type).toBe('bar');
    expect(spec?.title).toBe('Receita');
    expect(spec?.x).toEqual(['T1', 'T2']);
    expect(spec?.series[0].values).toEqual([10, 20]);
  });

  it('trata JSON incompleto como "ainda montando", não como erro', () => {
    // Durante o streaming isto acontece a cada pedaço que chega.
    const { spec, error } = parseChartSpec('{"type":"bar","series":[{"name":"a","val');
    expect(spec).toBeNull();
    expect(error).toBeNull();
  });

  it('aceita número escrito como texto, inclusive no formato brasileiro', () => {
    // Recusar por formatação perderia o gráfico inteiro.
    const { spec } = parseChartSpec(JSON.stringify({
      x: ['a', 'b', 'c'],
      series: [{ name: 's', values: ['1.234', '12%', 3.5] }],
    }));
    expect(spec?.series[0].values).toEqual([1234, 12, 3.5]);
  });

  it('completa categorias faltando em vez de descartar valores', () => {
    const { spec } = parseChartSpec(JSON.stringify({ x: ['a'], series: [{ name: 's', values: [1, 2, 3] }] }));
    expect(spec?.x).toEqual(['a', '2', '3']);
  });

  it('preenche com zero os pontos que faltam numa série', () => {
    const { spec } = parseChartSpec(JSON.stringify({
      x: ['a', 'b'],
      series: [{ name: 'longa', values: [1, 2] }, { name: 'curta', values: [5] }],
    }));
    expect(spec?.series[1].values).toEqual([5, 0]);
  });

  it('corta séries acima do teto e avisa em vez de gerar cor nova', () => {
    // Uma sétima cor seria indistinguível de outra sob daltonismo.
    const series = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, values: [i] }));
    const { spec, notes } = parseChartSpec(JSON.stringify({ x: ['a'], series }));
    expect(spec?.series).toHaveLength(MAX_SERIES);
    expect(notes.join(' ')).toMatch(/tabela/u);
  });

  it('recusa especificação sem série com valores', () => {
    expect(parseChartSpec('{"type":"bar","series":[]}').error).toMatch(/nenhuma série/u);
  });

  it('só empilha onde empilhar faz sentido', () => {
    const linha = parseChartSpec(JSON.stringify({ type: 'line', stacked: true, x: ['a'], series: [{ name: 's', values: [1] }] }));
    expect(linha.spec?.stacked).toBe(false);
    const barra = parseChartSpec(JSON.stringify({ type: 'bar', stacked: true, x: ['a'], series: [{ name: 's', values: [1] }] }));
    expect(barra.spec?.stacked).toBe(true);
  });

  it('tipo desconhecido cai em barra em vez de quebrar', () => {
    expect(parseChartSpec(JSON.stringify({ type: 'radar', x: ['a'], series: [{ name: 's', values: [1] }] })).spec?.type).toBe('bar');
  });
});

describe('escala de valor', () => {
  it('inclui o zero: barra que não nasce do zero exagera a diferença', () => {
    const { spec } = parseChartSpec(JSON.stringify({ x: ['a', 'b'], series: [{ name: 's', values: [100, 110] }] }));
    expect(valueExtent(spec!).min).toBe(0);
  });

  it('linha longe do zero acompanha o dado, para não espremer a variação', () => {
    // Forçar o zero numa série 220–280 jogaria a curva no topo do desenho e
    // esconderia justamente a variação que o gráfico existe para mostrar.
    const { spec } = parseChartSpec(JSON.stringify({
      type: 'line', x: ['a', 'b'], series: [{ name: 's', values: [220, 280] }],
    }));
    expect(valueExtent(spec!).min).toBe(220);
  });

  it('linha perto do zero ainda inclui o zero', () => {
    // Aqui incluí-lo não custa espaço e evita leitura ambígua.
    const { spec } = parseChartSpec(JSON.stringify({
      type: 'line', x: ['a', 'b'], series: [{ name: 's', values: [2, 30] }],
    }));
    expect(valueExtent(spec!).min).toBe(0);
  });

  it('empilhado mede a soma da coluna, não o maior valor', () => {
    const { spec } = parseChartSpec(JSON.stringify({
      type: 'bar', stacked: true, x: ['a'],
      series: [{ name: 'x', values: [10] }, { name: 'y', values: [15] }],
    }));
    expect(valueExtent(spec!).max).toBe(25);
  });
});

describe('marcas do eixo', () => {
  it('usa passos redondos, para o leitor não ter de calcular', () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it('não perde a última marca por imprecisão de ponto flutuante', () => {
    expect(niceTicks(0, 0.3).at(-1)).toBeGreaterThanOrEqual(0.3);
  });

  it('degrada quando não há intervalo', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe('pizza', () => {
  it('agrupa as menores em "Outros" em vez de escondê-las', () => {
    const { spec } = parseChartSpec(JSON.stringify({
      type: 'pie',
      x: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      series: [{ name: 's', values: [50, 20, 10, 8, 5, 3, 2, 2] }],
    }));
    const fatias = pieSlices(spec!);
    expect(fatias).toHaveLength(6);
    expect(fatias.at(-1)?.label).toBe('Outros');
    // Nada some: a soma continua sendo o total.
    expect(fatias.reduce((s, f) => s + f.value, 0)).toBe(100);
  });

  it('ignora valores não positivos, que não têm ângulo', () => {
    const { spec } = parseChartSpec(JSON.stringify({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', values: [10, -5] }] }));
    expect(pieSlices(spec!)).toHaveLength(1);
  });

  it('os ângulos cobrem a volta inteira', () => {
    const { spec } = parseChartSpec(JSON.stringify({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', values: [1, 3] }] }));
    const fatias = pieSlices(spec!);
    expect(fatias.at(-1)!.endAngle - fatias[0].startAngle).toBeCloseTo(Math.PI * 2, 6);
    expect(fatias[0].percent).toBeCloseTo(75, 6);
  });
});

describe('geometria da barra', () => {
  it('arredonda o topo e mantém a base reta na linha de zero', () => {
    const d = barPath(0, 10, 20, 40);
    expect(d).toContain('A 4 4');
    // Fecha voltando pela base, sem arco embaixo.
    expect(d.trim().endsWith('Z')).toBe(true);
  });

  it('encaixa o raio na altura da barra em vez de estourar para fora dela', () => {
    // Uma barra de 2px com raio de 4px teria o arco maior que a própria
    // barra: o raio acompanha, e só some quando não há altura nenhuma.
    expect(barPath(0, 10, 20, 2)).toContain('A 2 2');
    expect(barPath(0, 10, 20, 0)).not.toContain('A ');
  });
});

describe('formatação de valor', () => {
  it('abrevia milhar e milhão para caber no eixo', () => {
    expect(formatValue(12_400)).toBe('12,4 mil');
    expect(formatValue(3_200_000)).toBe('3,2 mi');
    expect(formatValue(42)).toBe('42');
  });
});
