import { describe, expect, it } from 'vitest';
import { recalculateWorkbook } from './spreadsheet-formulas';
import type { SpreadsheetWorkbook } from './types';

function valueAt(workbook: SpreadsheetWorkbook, sheet: number, row: number, column: number) {
  return workbook.sheets[sheet].cells.find((cell) => cell.row === row && cell.column === column)?.value;
}

describe('fórmulas de planilha', () => {
  it('recalcula referências, precedência, potência e dependências', () => {
    const workbook: SpreadsheetWorkbook = { sheets: [{ name: 'Dados', rowCount: 3, columnCount: 3, cells: [
      { row: 1, column: 1, value: 2 },
      { row: 1, column: 2, value: 3 },
      { row: 2, column: 1, value: null, formula: 'A1*B1^2' },
      { row: 3, column: 1, value: null, formula: 'A2+1' },
    ] }] };
    recalculateWorkbook(workbook);
    expect(valueAt(workbook, 0, 2, 1)).toBe(18);
    expect(valueAt(workbook, 0, 3, 1)).toBe(19);
  });

  it('aceita funções em português e inglês sobre intervalos', () => {
    const workbook: SpreadsheetWorkbook = { sheets: [{ name: 'Dados', rowCount: 4, columnCount: 2, cells: [
      { row: 1, column: 1, value: 2 }, { row: 2, column: 1, value: 4 }, { row: 3, column: 1, value: 6 },
      { row: 1, column: 2, value: null, formula: 'SOMA(A1:A3)' },
      { row: 2, column: 2, value: null, formula: 'MÉDIA(A1:A3)' },
      { row: 3, column: 2, value: null, formula: 'MAX(A1:A3)-MIN(A1:A3)' },
      { row: 4, column: 2, value: null, formula: 'CONT.NÚM(A1:A3)' },
    ] }] };
    recalculateWorkbook(workbook);
    expect([1, 2, 3, 4].map((row) => valueAt(workbook, 0, row, 2))).toEqual([12, 4, 4, 3]);
  });

  it('calcula a PG da imagem com referências entre abas e SE preguiçoso', () => {
    const workbook: SpreadsheetWorkbook = { sheets: [
      { name: 'Parâmetros', rowCount: 3, columnCount: 2, cells: [
        { row: 2, column: 2, value: 2 }, { row: 3, column: 2, value: 3 },
      ] },
      { name: 'Sequência', rowCount: 2, columnCount: 3, cells: [
        { row: 2, column: 1, value: 1 },
        { row: 2, column: 2, value: null, formula: "'Parâmetros'!$B$2*'Parâmetros'!$B$3^(A2-1)" },
        { row: 2, column: 3, value: null, formula: 'SE(Parâmetros!$B$3=1;Parâmetros!$B$2*A2;Parâmetros!$B$2*(Parâmetros!$B$3^A2-1)/(Parâmetros!$B$3-1))' },
      ] },
    ] };
    recalculateWorkbook(workbook);
    expect(valueAt(workbook, 1, 2, 2)).toBe(2);
    expect(valueAt(workbook, 1, 2, 3)).toBe(2);
  });

  it('preserva o valor anterior de função desconhecida e de referência circular', () => {
    const workbook: SpreadsheetWorkbook = { sheets: [{ name: 'Dados', rowCount: 2, columnCount: 2, cells: [
      { row: 1, column: 1, value: 42, formula: 'FUNCAO.NOVA(1)' },
      { row: 2, column: 1, value: 7, formula: 'B2' },
      { row: 2, column: 2, value: 8, formula: 'A2' },
    ] }] };
    recalculateWorkbook(workbook);
    expect(valueAt(workbook, 0, 1, 1)).toBe(42);
    expect(valueAt(workbook, 0, 2, 1)).toBe(7);
    expect(valueAt(workbook, 0, 2, 2)).toBe(8);
  });
});
