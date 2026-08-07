import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError } from './errors';
import {
  SpreadsheetWorkbookSchema,
  type SpreadsheetCellValue,
  type SpreadsheetSelection,
  type SpreadsheetSheet,
  type SpreadsheetWorkbook,
} from '../shared/types';
import { recalculateWorkbook } from '../shared/spreadsheet-formulas';

const MAX_CELLS = 250_000;
const MAX_SELECTION_CELLS = 5_000;
const XLSX_CONTENT_TYPES = Buffer.from('[Content_Types].xml');
const XLSX_WORKBOOK = Buffer.from('xl/workbook.xml');
const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 20_000;

const GeneratedCellSchema = z.union([
  z.string().max(100_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({
    formula: z.string().min(1).max(8_001),
    value: z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null()]),
  }).strict(),
]);

const GeneratedSpreadsheetSchema = z.object({
  filename: z.string().trim().min(1).max(255).optional(),
  sheets: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    rows: z.array(z.array(GeneratedCellSchema).max(2_000)).max(100_000),
  })).min(1).max(100),
}).strict();

function generatedFilename(value: string | undefined, fallback: string): string {
  const base = (value || fallback || 'planilha')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 250) || 'planilha';
  return base.toLocaleLowerCase('en-US').endsWith('.xlsx') ? base : `${base}.xlsx`;
}

function uniqueSheetName(raw: string, used: Set<string>): string {
  const clean = raw.replace(/[\\/*?:\[\]]/gu, '-').trim().slice(0, 31) || 'Planilha';
  let name = clean;
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase('pt-BR'))) {
    const ending = ` (${suffix})`;
    name = `${clean.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  used.add(name.toLocaleLowerCase('pt-BR'));
  return name;
}

/** Converte o JSON compacto emitido pelo modelo no workbook canônico do app. */
export function generatedSpreadsheetFromArtifact(
  source: string,
  fallbackName: string,
): { filename: string; workbook: SpreadsheetWorkbook } {
  const trimmed = source.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    throw new AppError('UNKNOWN', { status: 400, message: 'A planilha gerada veio com JSON inválido.' });
  }
  const parsed = GeneratedSpreadsheetSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AppError('UNKNOWN', { status: 400, message: 'A estrutura da planilha gerada é inválida.' });
  }

  let cellCount = 0;
  const usedNames = new Set<string>();
  const sheets: SpreadsheetSheet[] = parsed.data.sheets.map((sheet) => {
    const cells: SpreadsheetSheet['cells'] = [];
    let columnCount = 1;
    sheet.rows.forEach((row, rowIndex) => {
      columnCount = Math.max(columnCount, row.length);
      row.forEach((value, columnIndex) => {
        if (value === null || value === '') return;
        cellCount += 1;
        if (cellCount > MAX_CELLS) {
          throw new AppError('UNKNOWN', {
            status: 400,
            message: `A planilha gerada ultrapassou ${MAX_CELLS.toLocaleString('pt-BR')} células preenchidas.`,
          });
        }
        if (typeof value === 'object' && value !== null && 'formula' in value) {
          cells.push({
            row: rowIndex + 1,
            column: columnIndex + 1,
            value: value.value,
            formula: value.formula.startsWith('=') ? value.formula.slice(1) : value.formula,
          });
        } else if (typeof value === 'string' && value.startsWith('=')) {
          // Compatibilidade com modelos que ainda usam o protocolo antigo.
          // Sem resultado calculado, a interface precisa mostrar a expressão.
          cells.push({ row: rowIndex + 1, column: columnIndex + 1, value: null, formula: value.slice(1) });
        } else {
          cells.push({ row: rowIndex + 1, column: columnIndex + 1, value });
        }
      });
    });
    return {
      name: uniqueSheetName(sheet.name, usedNames),
      rowCount: Math.max(1, sheet.rows.length),
      columnCount,
      cells,
    };
  });

  return {
    filename: generatedFilename(parsed.data.filename, fallbackName),
    workbook: recalculateWorkbook(SpreadsheetWorkbookSchema.parse({ sheets })),
  };
}

export interface SpreadsheetAnalysis {
  readonly mime: 'text/csv' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  readonly workbook: SpreadsheetWorkbook;
}

export function looksLikeXlsx(data: Buffer): boolean {
  return data.length >= 4
    && data[0] === 0x50 && data[1] === 0x4b
    && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
    && data.includes(XLSX_CONTENT_TYPES)
    && data.includes(XLSX_WORKBOOK);
}

/** Lê apenas o diretório central do ZIP para barrar expansão desproporcional. */
function validateXlsxArchive(data: Buffer): void {
  let entries = 0;
  let expanded = 0;
  for (let offset = 0; offset + 46 <= data.length; offset += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) continue;
    entries += 1;
    expanded += data.readUInt32LE(offset + 24);
    if (entries > MAX_XLSX_ENTRIES || expanded > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new AppError('UNKNOWN', { status: 400, message: 'O XLSX expande para um tamanho inseguro e não pode ser aberto.' });
    }
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  if (entries === 0) throw new AppError('UNKNOWN', { status: 400, message: 'O diretório interno do XLSX está ausente ou corrompido.' });
}

function scalar(value: unknown): SpreadsheetCellValue {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => {
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
        return '';
      }).join('');
    }
    if ('text' in record) return String(record.text ?? '');
    if ('result' in record) return scalar(record.result);
    if ('error' in record) return String(record.error ?? '');
  }
  return String(value);
}

function normalizeWorkbook(workbook: ExcelJS.Workbook): SpreadsheetWorkbook {
  let cellCount = 0;
  const sheets: SpreadsheetSheet[] = workbook.worksheets.map((worksheet) => {
    const cells: SpreadsheetSheet['cells'] = [];
    let maxRow = 1;
    let maxColumn = 1;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        cellCount += 1;
        if (cellCount > MAX_CELLS) {
          throw new AppError('UNKNOWN', {
            status: 400,
            message: `A planilha tem mais de ${MAX_CELLS.toLocaleString('pt-BR')} células preenchidas. Reduza o arquivo antes de enviar.`,
          });
        }
        const raw = cell.value as unknown;
        const formula = raw && typeof raw === 'object' && 'formula' in raw
          ? String((raw as { formula: unknown }).formula)
          : undefined;
        cells.push({ row: rowNumber, column: columnNumber, value: scalar(raw), ...(formula ? { formula } : {}) });
        maxRow = Math.max(maxRow, rowNumber);
        maxColumn = Math.max(maxColumn, columnNumber);
      });
    });
    return {
      name: worksheet.name.slice(0, 100) || 'Planilha',
      rowCount: Math.min(100_000, maxRow),
      columnCount: Math.min(2_000, maxColumn),
      cells,
    };
  });
  if (sheets.length === 0) sheets.push({ name: 'Planilha 1', rowCount: 1, columnCount: 1, cells: [] });
  return SpreadsheetWorkbookSchema.parse({ sheets });
}

/** Parser CSV RFC 4180, incluindo aspas, vírgulas dentro de célula e CRLF. */
export function parseCsv(text: string): SpreadsheetWorkbook {
  const delimiter = detectCsvDelimiter(text);
  const rows: string[][] = [[]];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === delimiter) { rows.at(-1)?.push(field); field = ''; }
    else if (char === '\n') {
      rows.at(-1)?.push(field.replace(/\r$/u, ''));
      field = '';
      rows.push([]);
    } else field += char;
  }
  rows.at(-1)?.push(field.replace(/\r$/u, ''));
  if (quoted) throw new AppError('UNKNOWN', { status: 400, message: 'O CSV termina dentro de um campo entre aspas.' });
  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '') rows.pop();
  const cells: SpreadsheetSheet['cells'] = [];
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (value !== '') cells.push({ row: rowIndex + 1, column: columnIndex + 1, value });
  }));
  if (cells.length > MAX_CELLS) {
    throw new AppError('UNKNOWN', { status: 400, message: `O CSV tem mais de ${MAX_CELLS.toLocaleString('pt-BR')} células preenchidas.` });
  }
  return SpreadsheetWorkbookSchema.parse({ sheets: [{
    name: 'Planilha 1',
    rowCount: Math.max(1, rows.length),
    columnCount: Math.max(1, ...rows.map((row) => row.length)),
    cells,
  }] });
}

/** Excel em pt-BR costuma exportar `;`; arquivos técnicos usam `,` ou tab. */
function detectCsvDelimiter(text: string): ',' | ';' | '\t' {
  const counts = new Map<',' | ';' | '\t', number>([[',', 0], [';', 0], ['\t', 0]]);
  let quoted = false;
  let lines = 0;
  for (let index = 0; index < text.length && lines < 10; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === ';' || char === '\t')) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    } else if (!quoted && char === '\n') lines += 1;
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ',';
}

export async function analyzeSpreadsheet(data: Buffer, filename: string, text: string | null): Promise<SpreadsheetAnalysis | null> {
  if (looksLikeXlsx(data)) {
    try {
      validateXlsxArchive(data);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      return {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        workbook: normalizeWorkbook(workbook),
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('UNKNOWN', { status: 400, message: `Não consegui abrir "${filename}" como XLSX.` });
    }
  }
  if (text !== null && filename.toLocaleLowerCase('en-US').endsWith('.csv')) {
    return { mime: 'text/csv', workbook: parseCsv(text.replace(/^\uFEFF/u, '')) };
  }
  return null;
}

function cellMap(sheet: SpreadsheetSheet): Map<string, SpreadsheetCellValue> {
  return new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell.formula ? `=${cell.formula}` : cell.value]));
}

function tabular(sheet: SpreadsheetSheet, startRow: number, startColumn: number, endRow: number, endColumn: number): string {
  const values = cellMap(sheet);
  const lines: string[] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    const fields: string[] = [];
    for (let column = startColumn; column <= endColumn; column += 1) {
      fields.push(String(values.get(`${row}:${column}`) ?? '').replaceAll('\t', ' ').replaceAll('\n', ' '));
    }
    lines.push(fields.join('\t'));
  }
  return lines.join('\n');
}

export function spreadsheetPromptBlock(
  filename: string,
  workbook: SpreadsheetWorkbook,
  selection?: SpreadsheetSelection,
): string {
  if (selection) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === selection.sheet);
    if (!sheet) throw new AppError('UNKNOWN', { status: 400, message: `A aba "${selection.sheet}" não existe em "${filename}".` });
    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const startColumn = Math.min(selection.startColumn, selection.endColumn);
    const endColumn = Math.max(selection.startColumn, selection.endColumn);
    if (endRow > sheet.rowCount || endColumn > sheet.columnCount) {
      throw new AppError('UNKNOWN', { status: 400, message: 'A seleção ultrapassa os limites atuais da aba.' });
    }
    if ((endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_SELECTION_CELLS) {
      throw new AppError('UNKNOWN', { status: 400, message: `Selecione no máximo ${MAX_SELECTION_CELLS.toLocaleString('pt-BR')} células por pergunta.` });
    }
    return `<<<PLANILHA "${filename}" ABA "${sheet.name}" INTERVALO R${startRow}C${startColumn}:R${endRow}C${endColumn}>>>\n${tabular(sheet, startRow, startColumn, endRow, endColumn)}\n<<<FIM DA SELEÇÃO>>>`;
  }
  const previews = workbook.sheets.slice(0, 3).map((sheet) => {
    const rows = Math.min(sheet.rowCount, 20);
    const columns = Math.min(sheet.columnCount, 12);
    return `ABA "${sheet.name}" (${sheet.rowCount}×${sheet.columnCount}; amostra ${rows}×${columns})\n${tabular(sheet, 1, 1, rows, columns)}`;
  }).join('\n\n');
  return `<<<PLANILHA "${filename}">>>\n${previews}\n<<<FIM DA PLANILHA>>>`;
}

export async function workbookToXlsx(workbook: SpreadsheetWorkbook, original?: Buffer): Promise<Buffer> {
  recalculateWorkbook(workbook);
  let output = new ExcelJS.Workbook();
  if (original && looksLikeXlsx(original)) {
    try {
      validateXlsxArchive(original);
      await output.xlsx.load(original as unknown as Parameters<typeof output.xlsx.load>[0]);
    } catch {
      // O workbook canônico continua sendo a fonte de verdade; se o original
      // não puder ser reaberto, a exportação perde estilo, nunca os dados.
      output = new ExcelJS.Workbook();
    }
  }
  const desiredNames = new Set(workbook.sheets.map((sheet) => sheet.name));
  for (const existing of [...output.worksheets]) {
    if (!desiredNames.has(existing.name)) output.removeWorksheet(existing.id);
  }
  for (const sheet of workbook.sheets) {
    const worksheet = output.getWorksheet(sheet.name) ?? output.addWorksheet(sheet.name);
    const desiredCells = new Set(sheet.cells.map((cell) => keyOfCell(cell.row, cell.column)));
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        if (!desiredCells.has(keyOfCell(rowNumber, columnNumber))) cell.value = null;
      });
    });
    for (const cell of sheet.cells) {
      const target = worksheet.getCell(cell.row, cell.column);
      target.value = cell.formula ? { formula: cell.formula, result: cell.value ?? undefined } : cell.value;
    }
  }
  // Excel/LibreOffice recalculam fórmulas ao abrir, inclusive depois de o
  // usuário alterar uma célula de parâmetros no editor externo.
  output.calcProperties.fullCalcOnLoad = true;
  const data = await output.xlsx.writeBuffer();
  return Buffer.from(data);
}

function keyOfCell(row: number, column: number): string { return `${row}:${column}`; }

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function workbookSheetToCsv(workbook: SpreadsheetWorkbook, sheetName?: string): string {
  const sheet = sheetName ? workbook.sheets.find((candidate) => candidate.name === sheetName) : workbook.sheets[0];
  if (!sheet) throw new AppError('UNKNOWN', { status: 404, message: 'Aba não encontrada.' });
  const values = cellMap(sheet);
  const lines: string[] = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const fields: string[] = [];
    for (let column = 1; column <= sheet.columnCount; column += 1) fields.push(csvEscape(values.get(`${row}:${column}`)));
    lines.push(fields.join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}
