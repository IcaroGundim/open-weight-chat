import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Plus, Redo2, Save, Search, Sigma, Undo2, X } from 'lucide-react';
import { downloadSpreadsheet, getSpreadsheet, saveSpreadsheet } from '../api';
import { useChatStore } from '../store/chat';
import type { SpreadsheetCell, SpreadsheetCellValue, SpreadsheetWorkbook } from '../types';
import { ArtifactResizer } from './ArtifactResizer';
import { recalculateWorkbook } from '../../shared/spreadsheet-formulas';

const ROW_HEIGHT = 30;
const COLUMN_WIDTH = 132;
const ROW_HEADER_WIDTH = 52;
const VISIBLE_ROWS = 28;
const VISIBLE_COLUMNS = 12;

type Coordinate = { row: number; column: number };

function columnLabel(column: number): string {
  let value = column;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function keyOf(row: number, column: number): string { return `${row}:${column}`; }
function cellReference(row: number, column: number): string { return `${columnLabel(column)}${row}`; }

function cloneWorkbook(workbook: SpreadsheetWorkbook): SpreadsheetWorkbook {
  return typeof structuredClone === 'function'
    ? structuredClone(workbook)
    : JSON.parse(JSON.stringify(workbook)) as SpreadsheetWorkbook;
}

/** A barra de fórmulas edita a expressão; a grade mostra o resultado. */
function inputValue(cell?: SpreadsheetCell): string {
  if (!cell) return '';
  return cell.formula ? `=${cell.formula}` : String(cell.value ?? '');
}

function displayValue(cell?: SpreadsheetCell): string {
  if (!cell) return '';
  if (cell.formula && cell.value == null) return `=${cell.formula}`;
  return String(cell.value ?? '');
}

function parseInput(input: string): Pick<SpreadsheetCell, 'value' | 'formula'> {
  if (input.startsWith('=')) return { formula: input.slice(1), value: null };
  if (input === '') return { value: null, formula: undefined };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(input)) return { value: Number(input), formula: undefined };
  if (input.toLocaleLowerCase('pt-BR') === 'verdadeiro') return { value: true, formula: undefined };
  if (input.toLocaleLowerCase('pt-BR') === 'falso') return { value: false, formula: undefined };
  return { value: input, formula: undefined };
}

function writeCell(workbook: SpreadsheetWorkbook, sheetIndex: number, coordinate: Coordinate, input: string): void {
  const targetSheet = workbook.sheets[sheetIndex];
  const index = targetSheet.cells.findIndex((cell) => cell.row === coordinate.row && cell.column === coordinate.column);
  const parsed = parseInput(input);
  if (input === '') {
    if (index >= 0) targetSheet.cells.splice(index, 1);
  } else {
    const cell: SpreadsheetCell = {
      row: coordinate.row,
      column: coordinate.column,
      value: parsed.value as SpreadsheetCellValue,
      ...(parsed.formula ? { formula: parsed.formula } : {}),
    };
    if (index >= 0) targetSheet.cells[index] = cell;
    else targetSheet.cells.push(cell);
  }
  targetSheet.rowCount = Math.max(targetSheet.rowCount, coordinate.row);
  targetSheet.columnCount = Math.max(targetSheet.columnCount, coordinate.column);
}

export function SpreadsheetPanel({ attachmentId }: { attachmentId: string }) {
  const closeSpreadsheet = useChatStore((state) => state.closeSpreadsheet);
  const useSelection = useChatStore((state) => state.useSpreadsheetSelection);
  const [filename, setFilename] = useState('planilha');
  const [workbook, setWorkbook] = useState<SpreadsheetWorkbook | null>(null);
  // Mantida apenas como trava otimista de concorrência. A numeração não faz
  // parte da experiência da planilha: para a pessoa existe um documento atual.
  const [version, setVersion] = useState(1);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [anchor, setAnchor] = useState<Coordinate>({ row: 1, column: 1 });
  const [focus, setFocus] = useState<Coordinate>({ row: 1, column: 1 });
  const [editing, setEditing] = useState<Coordinate | null>(null);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [history, setHistory] = useState<SpreadsheetWorkbook[]>([]);
  const [future, setFuture] = useState<SpreadsheetWorkbook[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const editRevisionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getSpreadsheet(attachmentId).then((result) => {
      if (cancelled) return;
      setFilename(result.attachment.filename);
      setWorkbook(recalculateWorkbook(result.workbook));
      setVersion(result.currentVersion);
      setSheetIndex(0);
      setAnchor({ row: 1, column: 1 });
      setFocus({ row: 1, column: 1 });
      setHistory([]);
      setFuture([]);
      setDirty(false);
      editRevisionRef.current = 0;
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Não consegui abrir a planilha.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attachmentId]);

  useEffect(() => {
    const release = () => setDragging(false);
    window.addEventListener('pointerup', release);
    return () => window.removeEventListener('pointerup', release);
  }, []);

  const sheet = workbook?.sheets[sheetIndex];
  const cells = useMemo(() => new Map((sheet?.cells ?? []).map((cell) => [keyOf(cell.row, cell.column), cell])), [sheet]);
  const selectedCell = cells.get(keyOf(focus.row, focus.column));
  const startRow = Math.min(anchor.row, focus.row);
  const endRow = Math.max(anchor.row, focus.row);
  const startColumn = Math.min(anchor.column, focus.column);
  const endColumn = Math.max(anchor.column, focus.column);

  const mutate = useCallback((change: (next: SpreadsheetWorkbook) => void) => {
    setWorkbook((current) => {
      if (!current) return current;
      const next = cloneWorkbook(current);
      change(next);
      recalculateWorkbook(next);
      editRevisionRef.current += 1;
      setHistory((items) => [...items.slice(-29), current]);
      setFuture([]);
      setDirty(true);
      return next;
    });
  }, []);

  const setCell = useCallback((coordinate: Coordinate, input: string) => {
    mutate((next) => writeCell(next, sheetIndex, coordinate, input));
  }, [mutate, sheetIndex]);

  const save = useCallback((): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    if (!workbook || !dirty) return Promise.resolve(true);
    const savedRevision = editRevisionRef.current;
    const task = (async () => {
      setSaving(true);
      setError(null);
      try {
        const result = await saveSpreadsheet(attachmentId, workbook, version);
        setVersion(result.version);
        const fullySaved = editRevisionRef.current === savedRevision;
        if (fullySaved) {
          setWorkbook(result.workbook);
          setHistory([]);
          setFuture([]);
          setDirty(false);
        }
        return fullySaved;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não consegui salvar a planilha.');
        return false;
      } finally {
        setSaving(false);
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = task;
    return task;
  }, [attachmentId, dirty, version, workbook]);

  // Salvamento automático curto: trocar de conversa ou fechar o navegador não
  // deve transformar a grade em um editor que perde trabalho silenciosamente.
  useEffect(() => {
    if (!dirty || saving || editing || dragging) return;
    const timer = window.setTimeout(() => { void save(); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [dirty, dragging, editing, save, saving]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || editing) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      void save().then((ok) => { if (ok) closeSpreadsheet(); });
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [closeSpreadsheet, editing, save]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('en-US') === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  const undo = () => {
    const previous = history.at(-1);
    if (!previous || !workbook) return;
    setFuture((items) => [workbook, ...items].slice(0, 30));
    setHistory((items) => items.slice(0, -1));
    setWorkbook(previous);
    editRevisionRef.current += 1;
    setDirty(true);
  };
  const redo = () => {
    const next = future[0];
    if (!next || !workbook) return;
    setHistory((items) => [...items, workbook].slice(-30));
    setFuture((items) => items.slice(1));
    setWorkbook(next);
    editRevisionRef.current += 1;
    setDirty(true);
  };

  const autoSum = () => {
    if (!sheet) return;
    let formulaStart = startRow;
    let formulaEnd = endRow;
    let formulaStartColumn = startColumn;
    let formulaEndColumn = endColumn;
    let target = { row: endRow + 1, column: startColumn };
    if (startRow === endRow && startColumn === endColumn) {
      target = focus;
      formulaEnd = focus.row - 1;
      formulaStart = formulaEnd;
      formulaStartColumn = focus.column;
      formulaEndColumn = focus.column;
      while (formulaStart > 1 && cells.get(keyOf(formulaStart - 1, focus.column))?.value != null) formulaStart -= 1;
    }
    if (formulaEnd < formulaStart) return;
    setCell(target, `=SOMA(${cellReference(formulaStart, formulaStartColumn)}:${cellReference(formulaEnd, formulaEndColumn)})`);
    setAnchor(target);
    setFocus(target);
  };

  const findNext = () => {
    if (!sheet || !query.trim()) return;
    const ordered = [...sheet.cells].sort((a, b) => a.row - b.row || a.column - b.column);
    const currentIndex = ordered.findIndex((cell) => cell.row === focus.row && cell.column === focus.column);
    const lowered = query.toLocaleLowerCase('pt-BR');
    const rotated = [...ordered.slice(currentIndex + 1), ...ordered.slice(0, currentIndex + 1)];
    const match = rotated.find((cell) => displayValue(cell).toLocaleLowerCase('pt-BR').includes(lowered));
    if (!match) { setError(`Não encontrei “${query}” nesta aba.`); return; }
    setError(null);
    const coordinate = { row: match.row, column: match.column };
    setAnchor(coordinate);
    setFocus(coordinate);
    gridRef.current?.scrollTo({ top: Math.max(0, (match.row - 3) * ROW_HEIGHT), left: Math.max(0, (match.column - 3) * COLUMN_WIDTH), behavior: 'smooth' });
  };

  const exportFile = async (format: 'xlsx' | 'csv') => {
    setError(null);
    try {
      if (dirty && !(await save())) return;
      await downloadSpreadsheet(
        attachmentId,
        format,
        format === 'csv' ? sheet?.name : undefined,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não consegui exportar a planilha.');
    }
  };

  // Uma linha/coluna vazia além do conteúdo funciona como fronteira de
  // crescimento: basta editar a última para a grade se ampliar novamente.
  const totalRows = Math.min(100_000, Math.max(30, (sheet?.rowCount ?? 1) + 1));
  const totalColumns = Math.min(2_000, Math.max(12, (sheet?.columnCount ?? 1) + 1));
  const firstRow = Math.max(1, Math.floor(scroll.top / ROW_HEIGHT));
  const firstColumn = Math.max(1, Math.floor(Math.max(0, scroll.left - ROW_HEADER_WIDTH) / COLUMN_WIDTH) + 1);
  const visibleRows = Array.from({ length: Math.min(VISIBLE_ROWS, totalRows - firstRow + 1) }, (_, index) => firstRow + index);
  const visibleColumns = Array.from({ length: Math.min(VISIBLE_COLUMNS, totalColumns - firstColumn + 1) }, (_, index) => firstColumn + index);

  return (
    <aside className="spreadsheet-panel" aria-label={`Planilha ${filename}`}>
      <ArtifactResizer label="Largura do painel de planilha" />
      <header className="spreadsheet-panel-header">
        <span className="spreadsheet-panel-mark"><FileSpreadsheet size={18} aria-hidden="true" /></span>
        <div><h2>{filename}</h2><p>{saving ? 'salvando…' : dirty ? 'alterações não salvas' : 'salva'}</p></div>
        <button type="button" className="btn btn-icon" onClick={() => { void save().then((ok) => { if (ok) closeSpreadsheet(); }); }} aria-label="Salvar e fechar planilha"><X size={17} /></button>
      </header>

      {loading ? <p className="spreadsheet-state">Abrindo a planilha…</p> : error && !workbook ? <p className="spreadsheet-state spreadsheet-error">{error}</p> : workbook && sheet ? (
        <>
          <div className="spreadsheet-toolbar">
            <button type="button" className="btn btn-icon" onClick={undo} disabled={!history.length} title="Desfazer" aria-label="Desfazer"><Undo2 size={15} /></button>
            <button type="button" className="btn btn-icon" onClick={redo} disabled={!future.length} title="Refazer" aria-label="Refazer"><Redo2 size={15} /></button>
            <button type="button" className="btn" onClick={() => void save()} disabled={!dirty || saving}><Save size={15} />{saving ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" className="btn btn-quiet" onClick={autoSum} title="Somar o intervalo selecionado"><Sigma size={15} />AutoSoma</button>
            <span className="spreadsheet-toolbar-separator" />
            <button type="button" className="btn btn-quiet" onClick={() => void exportFile('xlsx')}><Download size={15} />Baixar .xlsx</button>
            <button type="button" className="btn btn-quiet" onClick={() => void exportFile('csv')}><Download size={15} />Baixar .csv</button>
            <span className="spreadsheet-search">
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') findNext(); }} placeholder="Localizar" aria-label="Localizar na aba" />
            </span>
          </div>
          <div className="spreadsheet-formula-bar">
            <span className="num">{columnLabel(focus.column)}{focus.row}</span>
            <input
              key={`${sheetIndex}:${focus.row}:${focus.column}:${inputValue(selectedCell)}`}
              defaultValue={inputValue(selectedCell)}
              aria-label="Conteúdo da célula selecionada"
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') event.currentTarget.value = inputValue(selectedCell);
              }}
              onBlur={(event) => { if (event.currentTarget.value !== inputValue(selectedCell)) setCell(focus, event.currentTarget.value); }}
            />
          </div>
          <div
            className="spreadsheet-grid"
            ref={gridRef}
            tabIndex={0}
            role="grid"
            aria-label={`Células da aba ${sheet.name}`}
            aria-rowcount={totalRows}
            aria-colcount={totalColumns}
            onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
            onCopy={(event) => {
              const rows: string[] = [];
              for (let row = startRow; row <= endRow; row += 1) {
                const values: string[] = [];
                for (let column = startColumn; column <= endColumn; column += 1) {
                  values.push(inputValue(cells.get(keyOf(row, column))).replaceAll('\t', ' ').replaceAll('\n', ' '));
                }
                rows.push(values.join('\t'));
              }
              event.clipboardData.setData('text/plain', rows.join('\n'));
              event.preventDefault();
            }}
            onPaste={(event) => {
              const rows = event.clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n').split('\n');
              if (rows.at(-1) === '') rows.pop();
              if (rows.length === 0) return;
              event.preventDefault();
              const lastRow = focus.row + rows.length - 1;
              const lastColumn = focus.column + Math.max(...rows.map((line) => line.split('\t').length)) - 1;
              mutate((next) => rows.forEach((line, rowOffset) => line.split('\t').forEach((value, columnOffset) => {
                const coordinate = { row: focus.row + rowOffset, column: focus.column + columnOffset };
                writeCell(next, sheetIndex, coordinate, value);
              })));
              setAnchor(focus);
              setFocus({ row: lastRow, column: lastColumn });
            }}
            onKeyDown={(event) => {
              if (editing) return;
              const delta = event.key === 'ArrowUp' ? [-1, 0] : event.key === 'ArrowDown' ? [1, 0] : event.key === 'ArrowLeft' ? [0, -1] : event.key === 'ArrowRight' || event.key === 'Tab' ? [0, 1] : null;
              if (delta) {
                event.preventDefault();
                const next = { row: Math.max(1, focus.row + delta[0]), column: Math.max(1, focus.column + delta[1]) };
                setAnchor(next); setFocus(next);
              } else if (event.key === 'Enter') {
                setEditing(focus); setDraft(inputValue(selectedCell));
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                mutate((next) => {
                  const target = next.sheets[sheetIndex];
                  target.cells = target.cells.filter((cell) => cell.row < startRow || cell.row > endRow || cell.column < startColumn || cell.column > endColumn);
                });
              }
            }}
          >
            <div className="spreadsheet-canvas" style={{ width: ROW_HEADER_WIDTH + totalColumns * COLUMN_WIDTH, height: (totalRows + 1) * ROW_HEIGHT }}>
              <div className="spreadsheet-corner" style={{ top: scroll.top, left: scroll.left, width: ROW_HEADER_WIDTH, height: ROW_HEIGHT }} />
              {visibleColumns.map((column) => <div key={`h-${column}`} role="columnheader" className="spreadsheet-column-header" style={{ top: scroll.top, left: ROW_HEADER_WIDTH + (column - 1) * COLUMN_WIDTH, width: COLUMN_WIDTH, height: ROW_HEIGHT }}>{columnLabel(column)}</div>)}
              {visibleRows.map((row) => <div key={`r-${row}`} role="rowheader" className="spreadsheet-row-header num" style={{ top: row * ROW_HEIGHT, left: scroll.left, width: ROW_HEADER_WIDTH, height: ROW_HEIGHT }}>{row}</div>)}
              {visibleRows.flatMap((row) => visibleColumns.map((column) => {
                const coordinate = { row, column };
                const cell = cells.get(keyOf(row, column));
                const selected = row >= startRow && row <= endRow && column >= startColumn && column <= endColumn;
                const active = row === focus.row && column === focus.column;
                return <div
                  key={`${row}:${column}`}
                  className="spreadsheet-cell"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={`${columnLabel(column)}${row}: ${displayValue(cell) || 'vazia'}${cell?.formula ? `; fórmula ${cell.formula}` : ''}`}
                  data-selected={selected || undefined}
                  data-active={active || undefined}
                  style={{ top: row * ROW_HEIGHT, left: ROW_HEADER_WIDTH + (column - 1) * COLUMN_WIDTH, width: COLUMN_WIDTH, height: ROW_HEIGHT }}
                  onPointerDown={(event) => { event.preventDefault(); setDragging(true); setAnchor(coordinate); setFocus(coordinate); gridRef.current?.focus(); }}
                  onPointerEnter={() => { if (dragging) setFocus(coordinate); }}
                  onDoubleClick={() => { setEditing(coordinate); setDraft(inputValue(cell)); }}
                  title={cell?.formula ? `${displayValue(cell)} · =${cell.formula}` : displayValue(cell)}
                >
                  {editing?.row === row && editing.column === column ? <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => { setCell(coordinate, draft); setEditing(null); }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                      if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
                    }}
                  /> : displayValue(cell)}
                </div>;
              }))}
            </div>
          </div>
          <div className="spreadsheet-tabs">
            <div className="spreadsheet-tab-list" role="tablist" aria-label="Abas da planilha">
              {workbook.sheets.map((item, index) => <button key={`${item.name}-${index}`} type="button" role="tab" aria-selected={index === sheetIndex} onClick={() => { setSheetIndex(index); setAnchor({ row: 1, column: 1 }); setFocus({ row: 1, column: 1 }); }}>{item.name}</button>)}
              <button type="button" className="spreadsheet-add-sheet" aria-label="Adicionar aba" title="Adicionar aba" disabled={workbook.sheets.length >= 100} onClick={() => mutate((next) => {
                let suffix = next.sheets.length + 1;
                while (next.sheets.some((item) => item.name === `Planilha ${suffix}`)) suffix += 1;
                next.sheets.push({ name: `Planilha ${suffix}`, rowCount: 1, columnCount: 1, cells: [] });
                setSheetIndex(next.sheets.length - 1);
              })}><Plus size={14} /></button>
            </div>
            <button type="button" className="btn btn-primary spreadsheet-use-selection" disabled={saving} onClick={async () => {
              if (!(await save())) return;
              useSelection({ attachmentId, version, filename, sheet: sheet.name, startRow, startColumn, endRow, endColumn });
              closeSpreadsheet();
            }}>
              Usar seleção no chat
            </button>
          </div>
          {error ? <p className="spreadsheet-inline-error" role="alert">{error}</p> : null}
        </>
      ) : null}
    </aside>
  );
}
