import type { SpreadsheetCellValue, SpreadsheetWorkbook } from './types';

type Scalar = SpreadsheetCellValue;
type TokenKind = 'number' | 'string' | 'word' | 'sheet' | 'operator' | 'left' | 'right' | 'separator' | 'colon' | 'bang' | 'eof';
type Token = { kind: TokenKind; value: string };

type Reference = { kind: 'reference'; sheet: string | null; row: number; column: number };
type Expression =
  | { kind: 'literal'; value: Scalar }
  | Reference
  | { kind: 'range'; start: Reference; end: Reference }
  | { kind: 'unary'; operator: '+' | '-'; value: Expression }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression }
  | { kind: 'call'; name: string; arguments: Expression[] };

type Evaluated = Scalar | Scalar[];
type Evaluation = { ok: true; value: Scalar } | { ok: false };

const CELL_REFERENCE = /^\$?([A-Z]{1,3})\$?(\d{1,6})$/iu;
const COMPARISON = new Set(['=', '<>', '<', '<=', '>', '>=']);

function columnNumber(label: string): number {
  let result = 0;
  for (const char of label.toLocaleUpperCase('en-US')) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/u.test(char)) { cursor += 1; continue; }
    if (char === '"') {
      let value = '';
      cursor += 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') { value += '"'; cursor += 2; continue; }
        if (source[cursor] === '"') { cursor += 1; closed = true; break; }
        value += source[cursor]; cursor += 1;
      }
      if (!closed) throw new Error('string');
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (char === "'") {
      let value = '';
      cursor += 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === "'" && source[cursor + 1] === "'") { value += "'"; cursor += 2; continue; }
        if (source[cursor] === "'") { cursor += 1; closed = true; break; }
        value += source[cursor]; cursor += 1;
      }
      if (!closed) throw new Error('sheet');
      tokens.push({ kind: 'sheet', value });
      continue;
    }
    if (/\d/u.test(char) || (char === '.' && /\d/u.test(source[cursor + 1] ?? ''))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/u.exec(source.slice(cursor));
      if (!match) throw new Error('number');
      tokens.push({ kind: 'number', value: match[0] });
      cursor += match[0].length;
      continue;
    }
    if (char === '(') { tokens.push({ kind: 'left', value: char }); cursor += 1; continue; }
    if (char === ')') { tokens.push({ kind: 'right', value: char }); cursor += 1; continue; }
    if (char === ',' || char === ';') { tokens.push({ kind: 'separator', value: char }); cursor += 1; continue; }
    if (char === ':') { tokens.push({ kind: 'colon', value: char }); cursor += 1; continue; }
    if (char === '!') { tokens.push({ kind: 'bang', value: char }); cursor += 1; continue; }
    if ('+-*/^&=<>'.includes(char)) {
      const pair = source.slice(cursor, cursor + 2);
      const value = pair === '<=' || pair === '>=' || pair === '<>' ? pair : char;
      tokens.push({ kind: 'operator', value });
      cursor += value.length;
      continue;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s()+\-*/^&=<>!,;:]/u.test(source[cursor])) cursor += 1;
    if (cursor === start) throw new Error('token');
    tokens.push({ kind: 'word', value: source.slice(start, cursor) });
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class FormulaParser {
  private cursor = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expression {
    const expression = this.comparison();
    if (this.peek().kind !== 'eof') throw new Error('trailing');
    return expression;
  }

  private peek(): Token { return this.tokens[this.cursor]; }
  private take(): Token { const token = this.peek(); this.cursor += 1; return token; }
  private accept(kind: TokenKind, value?: string): Token | null {
    const token = this.peek();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) return null;
    this.cursor += 1;
    return token;
  }
  private require(kind: TokenKind): Token {
    const token = this.accept(kind);
    if (!token) throw new Error(kind);
    return token;
  }

  private comparison(): Expression {
    let left = this.concat();
    while (this.peek().kind === 'operator' && COMPARISON.has(this.peek().value)) {
      left = { kind: 'binary', operator: this.take().value, left, right: this.concat() };
    }
    return left;
  }

  private concat(): Expression {
    let left = this.addition();
    while (this.accept('operator', '&')) left = { kind: 'binary', operator: '&', left, right: this.addition() };
    return left;
  }

  private addition(): Expression {
    let left = this.multiplication();
    while (this.peek().kind === 'operator' && (this.peek().value === '+' || this.peek().value === '-')) {
      left = { kind: 'binary', operator: this.take().value, left, right: this.multiplication() };
    }
    return left;
  }

  private multiplication(): Expression {
    let left = this.power();
    while (this.peek().kind === 'operator' && (this.peek().value === '*' || this.peek().value === '/')) {
      left = { kind: 'binary', operator: this.take().value, left, right: this.power() };
    }
    return left;
  }

  private power(): Expression {
    const left = this.unary();
    return this.accept('operator', '^') ? { kind: 'binary', operator: '^', left, right: this.power() } : left;
  }

  private unary(): Expression {
    const operator = this.peek().kind === 'operator' && (this.peek().value === '+' || this.peek().value === '-')
      ? this.take().value as '+' | '-'
      : null;
    return operator ? { kind: 'unary', operator, value: this.unary() } : this.primary();
  }

  private reference(token: Token, sheet: string | null): Reference {
    const match = CELL_REFERENCE.exec(token.value);
    if (!match) throw new Error('reference');
    return { kind: 'reference', sheet, column: columnNumber(match[1]), row: Number(match[2]) };
  }

  private primary(): Expression {
    if (this.accept('left')) {
      const value = this.comparison();
      this.require('right');
      return value;
    }
    const number = this.accept('number');
    if (number) return { kind: 'literal', value: Number(number.value) };
    const string = this.accept('string');
    if (string) return { kind: 'literal', value: string.value };

    const token = this.peek();
    if (token.kind !== 'word' && token.kind !== 'sheet') throw new Error('primary');
    this.take();
    if (this.accept('bang')) {
      const start = this.reference(this.require('word'), token.value);
      return this.rangeAfter(start);
    }
    if (token.kind === 'sheet') throw new Error('sheet-reference');
    if (this.accept('left')) {
      const arguments_: Expression[] = [];
      if (!this.accept('right')) {
        do { arguments_.push(this.comparison()); } while (this.accept('separator'));
        this.require('right');
      }
      return { kind: 'call', name: token.value, arguments: arguments_ };
    }
    const normalized = normalizeName(token.value);
    if (normalized === 'TRUE' || normalized === 'VERDADEIRO') return { kind: 'literal', value: true };
    if (normalized === 'FALSE' || normalized === 'FALSO') return { kind: 'literal', value: false };
    return this.rangeAfter(this.reference(token, null));
  }

  private rangeAfter(start: Reference): Expression {
    if (!this.accept('colon')) return start;
    const token = this.require('word');
    const end = this.reference(token, start.sheet);
    return { kind: 'range', start, end };
  }
}

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[._\s]/gu, '').toLocaleUpperCase('en-US');
}

function scalar(value: Evaluated): Scalar {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function number(value: Evaluated): number {
  const item = scalar(value);
  if (item === null || item === '') return 0;
  if (typeof item === 'boolean') return item ? 1 : 0;
  const result = typeof item === 'number' ? item : Number(item);
  if (!Number.isFinite(result)) throw new Error('number');
  return result;
}

function truthy(value: Evaluated): boolean {
  const item = scalar(value);
  if (typeof item === 'string') return item.length > 0 && item.toLocaleUpperCase('pt-BR') !== 'FALSO';
  return Boolean(item);
}

function text(value: Evaluated): string {
  const item = scalar(value);
  if (item === null) return '';
  if (typeof item === 'boolean') return item ? 'VERDADEIRO' : 'FALSO';
  return String(item);
}

function flattened(values: Evaluated[]): Scalar[] {
  return values.flatMap((value) => Array.isArray(value) ? value : [value]);
}

function numeric(values: Evaluated[]): number[] {
  return flattened(values).flatMap((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return [value];
    // CSV não carrega tipos; "10" precisa participar de SOMA/MÉDIA como
    // participaria depois de aberto no Excel, sem converter cabeçalhos.
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value.replace(',', '.'));
      if (Number.isFinite(parsed)) return [parsed];
    }
    return [];
  });
}

function compare(left: Evaluated, right: Evaluated, operator: string): boolean {
  const a = scalar(left);
  const b = scalar(right);
  const comparable = typeof a === 'number' && typeof b === 'number'
    ? [a, b] as const
    : [text(a).toLocaleLowerCase('pt-BR'), text(b).toLocaleLowerCase('pt-BR')] as const;
  if (operator === '=') return comparable[0] === comparable[1];
  if (operator === '<>') return comparable[0] !== comparable[1];
  if (operator === '<') return comparable[0] < comparable[1];
  if (operator === '<=') return comparable[0] <= comparable[1];
  if (operator === '>') return comparable[0] > comparable[1];
  return comparable[0] >= comparable[1];
}

/** Recalcula, em ordem de dependência, o subconjunto seguro de fórmulas Excel suportado pela bancada. */
export function recalculateWorkbook(workbook: SpreadsheetWorkbook): SpreadsheetWorkbook {
  const sheets = new Map(workbook.sheets.map((sheet, index) => [sheet.name.toLocaleLowerCase('pt-BR'), { sheet, index }]));
  const cellMaps = workbook.sheets.map((sheet) => new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])));
  const memo = new Map<string, Evaluation>();
  const visiting = new Set<string>();

  const evaluateCell = (sheetIndex: number, row: number, column: number): Evaluation => {
    const key = `${sheetIndex}:${row}:${column}`;
    const remembered = memo.get(key);
    if (remembered) return remembered;
    const cell = cellMaps[sheetIndex]?.get(`${row}:${column}`);
    if (!cell?.formula) return { ok: true, value: cell?.value ?? null };
    if (visiting.has(key)) return { ok: false };
    visiting.add(key);
    try {
      const tree = new FormulaParser(tokenize(cell.formula.replace(/^=/u, ''))).parse();
      const value = evaluate(tree, sheetIndex);
      const result: Evaluation = Array.isArray(value) ? { ok: false } : { ok: true, value };
      memo.set(key, result);
      return result;
    } catch {
      const result: Evaluation = { ok: false };
      memo.set(key, result);
      return result;
    } finally {
      visiting.delete(key);
    }
  };

  const resolveReference = (reference: Reference, currentSheet: number): Evaluation => {
    const target = reference.sheet === null ? currentSheet : sheets.get(reference.sheet.toLocaleLowerCase('pt-BR'))?.index;
    return target === undefined ? { ok: false } : evaluateCell(target, reference.row, reference.column);
  };

  const evaluate = (expression: Expression, currentSheet: number): Evaluated => {
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'reference') {
      const result = resolveReference(expression, currentSheet);
      if (!result.ok) throw new Error('reference');
      return result.value;
    }
    if (expression.kind === 'range') {
      const targetSheet = expression.start.sheet === null
        ? currentSheet
        : sheets.get(expression.start.sheet.toLocaleLowerCase('pt-BR'))?.index;
      if (targetSheet === undefined) throw new Error('range-sheet');
      const values: Scalar[] = [];
      for (let row = Math.min(expression.start.row, expression.end.row); row <= Math.max(expression.start.row, expression.end.row); row += 1) {
        for (let column = Math.min(expression.start.column, expression.end.column); column <= Math.max(expression.start.column, expression.end.column); column += 1) {
          const result = evaluateCell(targetSheet, row, column);
          if (!result.ok) throw new Error('range');
          values.push(result.value);
        }
      }
      return values;
    }
    if (expression.kind === 'unary') {
      const value = number(evaluate(expression.value, currentSheet));
      return expression.operator === '-' ? -value : value;
    }
    if (expression.kind === 'binary') {
      const left = evaluate(expression.left, currentSheet);
      const right = evaluate(expression.right, currentSheet);
      if (COMPARISON.has(expression.operator)) return compare(left, right, expression.operator);
      if (expression.operator === '&') return `${text(left)}${text(right)}`;
      const a = number(left);
      const b = number(right);
      const result = expression.operator === '+' ? a + b
        : expression.operator === '-' ? a - b
          : expression.operator === '*' ? a * b
            : expression.operator === '/' ? (b === 0 ? Number.NaN : a / b)
              : a ** b;
      if (!Number.isFinite(result)) throw new Error('arithmetic');
      return result;
    }

    const name = normalizeName(expression.name);
    // SE é preguiçoso: a ramificação não escolhida pode conter uma divisão
    // por zero perfeitamente legítima, como a fórmula da soma de uma PG q=1.
    if (name === 'IF' || name === 'SE') {
      if (expression.arguments.length < 2 || expression.arguments.length > 3) throw new Error('if');
      const condition = truthy(evaluate(expression.arguments[0], currentSheet));
      const chosen = condition ? expression.arguments[1] : expression.arguments[2];
      return chosen ? scalar(evaluate(chosen, currentSheet)) : false;
    }
    if (name === 'AND' || name === 'E') return expression.arguments.every((item) => truthy(evaluate(item, currentSheet)));
    if (name === 'OR' || name === 'OU') return expression.arguments.some((item) => truthy(evaluate(item, currentSheet)));
    if (name === 'NOT' || name === 'NAO') return !truthy(evaluate(expression.arguments[0], currentSheet));

    const args = expression.arguments.map((item) => evaluate(item, currentSheet));
    const numbers = numeric(args);
    if (name === 'SUM' || name === 'SOMA') return numbers.reduce((sum, item) => sum + item, 0);
    if (name === 'AVERAGE' || name === 'MEDIA') {
      if (numbers.length === 0) throw new Error('average');
      return numbers.reduce((sum, item) => sum + item, 0) / numbers.length;
    }
    if (name === 'MIN' || name === 'MINIMO') return numbers.length ? Math.min(...numbers) : 0;
    if (name === 'MAX' || name === 'MAXIMO') return numbers.length ? Math.max(...numbers) : 0;
    if (name === 'COUNT' || name === 'CONTNUM' || name === 'CONTAGEM') return numbers.length;
    if (name === 'COUNTA' || name === 'CONTVALORES') return flattened(args).filter((item) => item !== null && item !== '').length;
    if (name === 'ABS') return Math.abs(number(args[0]));
    if (name === 'SQRT' || name === 'RAIZ') return Math.sqrt(number(args[0]));
    if (name === 'POWER' || name === 'POTENCIA') return number(args[0]) ** number(args[1]);
    if (name === 'MOD') return number(args[0]) % number(args[1]);
    if (name === 'ROUND' || name === 'ARRED') {
      const digits = Math.trunc(number(args[1] ?? 0));
      const factor = 10 ** digits;
      return Math.round((number(args[0]) + Number.EPSILON) * factor) / factor;
    }
    if (name === 'ROUNDUP' || name === 'ARREDONDARPARACIMA') {
      const digits = Math.trunc(number(args[1] ?? 0));
      const factor = 10 ** digits;
      const value = number(args[0]) * factor;
      return (value < 0 ? Math.floor(value) : Math.ceil(value)) / factor;
    }
    if (name === 'ROUNDDOWN' || name === 'ARREDONDARPARABAIXO') {
      const digits = Math.trunc(number(args[1] ?? 0));
      const factor = 10 ** digits;
      const value = number(args[0]) * factor;
      return (value < 0 ? Math.ceil(value) : Math.floor(value)) / factor;
    }
    if (name === 'LEN' || name === 'NUMCARACT') return text(args[0]).length;
    if (name === 'CONCAT' || name === 'CONCATENAR') return flattened(args).map((item) => text(item)).join('');
    throw new Error('function');
  };

  workbook.sheets.forEach((sheet, sheetIndex) => {
    for (const cell of sheet.cells) {
      if (!cell.formula) continue;
      const result = evaluateCell(sheetIndex, cell.row, cell.column);
      // Fórmula desconhecida continua intacta e conserva o último resultado
      // importado. Isso permite abrir XLSX complexos sem degradar seus dados.
      if (result.ok) cell.value = result.value;
    }
  });
  return workbook;
}
