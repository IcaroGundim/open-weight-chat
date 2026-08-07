import { describe, expect, it } from 'vitest';
import {
  analyzeSpreadsheet,
  generatedSpreadsheetFromArtifact,
  parseCsv,
  spreadsheetPromptBlock,
  workbookSheetToCsv,
  workbookToXlsx,
} from './spreadsheets';

describe('planilhas', () => {
  it('converte o artefato compacto do modelo em workbook com fórmula e resultado', () => {
    const generated = generatedSpreadsheetFromArtifact(JSON.stringify({
      filename: 'pg.xlsx',
      sheets: [{ name: 'PG', rows: [['n', 'termo'], [1, 2], [2, { formula: '=B2*3', value: 6 }]] }],
    }), 'fallback');
    expect(generated.filename).toBe('pg.xlsx');
    expect(generated.workbook.sheets[0]).toMatchObject({ name: 'PG', rowCount: 3, columnCount: 2 });
    expect(generated.workbook.sheets[0].cells.find((cell) => cell.row === 3 && cell.column === 2)).toMatchObject({ formula: 'B2*3', value: 6 });
  });

  it('lê CSV com aspas, vírgula e quebra de linha dentro de célula', () => {
    const workbook = parseCsv('produto,observação,valor\r\nA,"duas, partes",10\r\nB,"linha 1\nlinha 2",20');
    const sheet = workbook.sheets[0];
    expect(sheet.rowCount).toBe(3);
    expect(sheet.columnCount).toBe(3);
    expect(sheet.cells.find((cell) => cell.row === 2 && cell.column === 2)?.value).toBe('duas, partes');
    expect(sheet.cells.find((cell) => cell.row === 3 && cell.column === 2)?.value).toBe('linha 1\nlinha 2');
  });

  it('reconhece o separador de CSV exportado pelo Excel em pt-BR', () => {
    const workbook = parseCsv('produto;valor\r\nCafé;10');
    expect(workbook.sheets[0].columnCount).toBe(2);
    expect(workbook.sheets[0].cells.find((cell) => cell.row === 2 && cell.column === 2)?.value).toBe('10');
  });

  it('recusa CSV que termina com campo entre aspas aberto', () => {
    expect(() => parseCsv('a,b\n1,"incompleto')).toThrow(/entre aspas/u);
  });

  it('barra XLSX cuja expansão ZIP declarada excede o limite', async () => {
    const fake = Buffer.alloc(256);
    fake.set([0x50, 0x4b, 0x03, 0x04], 0);
    fake.write('[Content_Types].xml', 24, 'ascii');
    fake.write('xl/workbook.xml', 64, 'ascii');
    fake.writeUInt32LE(0x02014b50, 128);
    fake.writeUInt32LE(65 * 1024 * 1024, 128 + 24);
    await expect(analyzeSpreadsheet(fake, 'bomba.xlsx', null)).rejects.toThrow(/tamanho inseguro/u);
  });

  it('faz round-trip XLSX preservando valores e fórmulas', async () => {
    const source = {
      sheets: [{
        name: 'Vendas', rowCount: 2, columnCount: 2,
        cells: [
          { row: 1, column: 1, value: 'Total' },
          { row: 2, column: 1, value: 7 },
          { row: 2, column: 2, value: 7, formula: 'A2' },
        ],
      }],
    };
    const bytes = await workbookToXlsx(source);
    const result = await analyzeSpreadsheet(bytes, 'vendas.xlsx', null);
    expect(result?.mime).toContain('spreadsheetml');
    expect(result?.workbook.sheets[0].name).toBe('Vendas');
    expect(result?.workbook.sheets[0].cells.find((cell) => cell.column === 2)?.formula).toBe('A2');
  });

  it('entrega ao modelo somente o intervalo escolhido', () => {
    const workbook = parseCsv('nome,valor\nA,10\nB,20\nC,30');
    const prompt = spreadsheetPromptBlock('dados.csv', workbook, {
      attachmentId: 'sheet-1', version: 1, sheet: 'Planilha 1', startRow: 2, startColumn: 1, endRow: 3, endColumn: 2,
    });
    expect(prompt).toContain('A\t10');
    expect(prompt).toContain('B\t20');
    expect(prompt).not.toContain('C\t30');
  });

  it('exporta CSV escapando conteúdo perigoso para o formato', () => {
    const csv = workbookSheetToCsv(parseCsv('a,b\n"x,y","x""z"'));
    expect(csv).toContain('"x,y","x""z"');
  });
});
