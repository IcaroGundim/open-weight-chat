import { ChevronRight, FileSpreadsheet } from 'lucide-react';
import { useChatStore } from '../store/chat';
import type { Attachment } from '../types';
import { ArtifactWaves } from './ArtifactWaves';

/**
 * Planilha é um artefato do chat, não um anexo passivo. O cartão usa a mesma
 * gramática visual e o mesmo comportamento de interruptor dos demais
 * artefatos; só o painel de destino é especializado na edição tabular.
 */
export function SpreadsheetCard({ attachment }: { attachment: Attachment }) {
  const openSpreadsheetId = useChatStore((state) => state.openSpreadsheetId);
  const openSpreadsheet = useChatStore((state) => state.openSpreadsheet);
  const closeSpreadsheet = useChatStore((state) => state.closeSpreadsheet);
  const isOpen = openSpreadsheetId === attachment.id;
  const sheets = attachment.spreadsheet?.sheetNames.length ?? 0;
  const format = attachment.filename.toLocaleLowerCase('en-US').endsWith('.csv') ? 'CSV' : 'XLSX';

  return (
    <button
      type="button"
      className="artifact-card spreadsheet-artifact-card"
      data-spreadsheet-id={attachment.id}
      onClick={() => (isOpen ? closeSpreadsheet() : openSpreadsheet(attachment.id))}
      aria-expanded={isOpen}
      aria-label={`${isOpen ? 'Fechar' : 'Abrir'} planilha ${attachment.filename}`}
    >
      <ArtifactWaves />
      <span className="artifact-card-mark">
        <FileSpreadsheet size={17} aria-hidden="true" />
      </span>
      <span className="artifact-card-copy">
        <strong>{attachment.filename}</strong>
        <span className="artifact-card-meta">
          Planilha {format}
          {' · '}<span className="num">{sheets}</span> aba{sheets === 1 ? '' : 's'}
        </span>
      </span>
      <ChevronRight className="artifact-card-chevron" size={16} aria-hidden="true" />
    </button>
  );
}
