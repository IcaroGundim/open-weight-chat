import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FileSpreadsheet, FileText, Paperclip, Square, X } from 'lucide-react';
import { EffortPicker } from './EffortPicker';
import { SciencePicker } from './SciencePicker';
import { WebSearchToggle } from './WebSearchToggle';
import { useSettingsStore } from '../store/settings';
import { attachmentUrl, deleteAttachment, uploadAttachment } from '../api';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, type Attachment, type EffortLevel, type ScienceFormat, type ScienceLevel } from '../types';
import { useChatStore } from '../store/chat';

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ComposerProps = {
  onSend: (content: string, attachments: Attachment[]) => void | Promise<void>;
  onStop: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  /**
   * Nível de raciocínio da conversa. Fica aqui, e não no cabeçalho, porque é
   * uma decisão de envio: pertence ao lugar onde se escreve e se despacha a
   * mensagem, junto do custo que ela vai gerar.
   */
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  scienceLevel: ScienceLevel;
  scienceFormat: ScienceFormat;
  onScienceChange: (level: ScienceLevel, format: ScienceFormat) => void;
};

export function Composer({
  onSend,
  onStop,
  isStreaming = false,
  disabled = false,
  effort,
  onEffortChange,
  scienceLevel,
  scienceFormat,
  onScienceChange,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [anexos, setAnexos] = useState<Attachment[]>([]);
  const [subindo, setSubindo] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const openSpreadsheet = useChatStore((state) => state.openSpreadsheet);
  const pendingSelection = useChatStore((state) => state.pendingSpreadsheetSelection);
  const useSpreadsheetSelection = useChatStore((state) => state.useSpreadsheetSelection);
  const searchAvailable = useChatStore((state) => state.searchAvailable);
  const webSearch = useSettingsStore((state) => state.webSearch);
  const setWebSearch = useSettingsStore((state) => state.setWebSearch);

  /**
   * Recebe arquivos de qualquer das três portas: botão, colar e arrastar.
   *
   * O upload acontece AGORA, não no envio: o usuário vê o arquivo ser aceito
   * (ou recusado) enquanto ainda está escrevendo, e não descobre um PDF
   * ilegível depois de mandar a pergunta. É também o que permite remover um
   * anexo antes de enviar.
   */
  const receber = async (arquivos: readonly File[]) => {
    if (arquivos.length === 0) return;
    setErro(null);
    const espaco = MAX_ATTACHMENTS_PER_MESSAGE - anexos.length;
    if (espaco <= 0) {
      setErro(`Máximo de ${MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem.`);
      return;
    }
    const aceitos = arquivos.slice(0, espaco);
    if (arquivos.length > espaco) setErro(`Só cabem mais ${espaco} anexo${espaco === 1 ? '' : 's'} nesta mensagem.`);

    for (const arquivo of aceitos) {
      // Barrado aqui também, e não só no servidor: subir 20 MB para receber
      // uma recusa é gastar a banda do usuário para nada.
      if (arquivo.size > MAX_ATTACHMENT_BYTES) {
        setErro(`"${arquivo.name}" tem ${tamanhoLegivel(arquivo.size)}; o limite é ${tamanhoLegivel(MAX_ATTACHMENT_BYTES)}.`);
        continue;
      }
      setSubindo((n) => n + 1);
      try {
        const anexo = await uploadAttachment(arquivo);
        setAnexos((atuais) => [...atuais, anexo]);
      } catch (motivo) {
        setErro(motivo instanceof Error ? motivo.message : `Não consegui enviar "${arquivo.name}".`);
      } finally {
        setSubindo((n) => n - 1);
      }
    }
  };

  const remover = async (id: string) => {
    setAnexos((atuais) => atuais.filter((anexo) => anexo.id !== id));
    if (pendingSelection?.attachmentId === id) useSpreadsheetSelection(null);
    // Melhor esforço: se a remoção no servidor falhar, o anexo vira órfão e a
    // faxina por idade o recolhe. Travar a interface por isso seria pior.
    try { await deleteAttachment(id); } catch { /* recolhido depois */ }
  };

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight, 190) + 'px';
  }, [value]);

  const submit = async () => {
    const content = value.trim();
    // Só anexo, sem texto, é envio válido — ver o store.
    if ((!content && anexos.length === 0) || disabled || isStreaming || subindo > 0) return;
    setValue('');
    setAnexos([]);
    setErro(null);
    await onSend(content, anexos);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="composer"
      data-arrastando={arrastando || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (disabled || isStreaming) return;
        event.preventDefault();
        setArrastando(true);
      }}
      onDragLeave={(event) => {
        // `relatedTarget` fora do formulário: sem esta checagem, passar por
        // cima de um filho dispara o leave e o destaque pisca.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setArrastando(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setArrastando(false);
        if (disabled || isStreaming) return;
        void receber([...event.dataTransfer.files]);
      }}
    >
      {pendingSelection ? (
        <div className="composer-planilha-contexto">
          <FileSpreadsheet size={15} aria-hidden="true" />
          <span>
            Seleção de <strong>{pendingSelection.filename ?? 'planilha'}</strong> · v{pendingSelection.version} · {pendingSelection.sheet}
            {' '}R{Math.min(pendingSelection.startRow, pendingSelection.endRow)}C{Math.min(pendingSelection.startColumn, pendingSelection.endColumn)}
            :R{Math.max(pendingSelection.startRow, pendingSelection.endRow)}C{Math.max(pendingSelection.startColumn, pendingSelection.endColumn)}
          </span>
          <button type="button" className="composer-anexo-remover" onClick={() => useSpreadsheetSelection(null)} aria-label="Remover seleção da planilha">
            <X size={14} />
          </button>
        </div>
      ) : null}
      {anexos.length > 0 || subindo > 0 ? (
        <ul className="composer-anexos">
          {anexos.map((anexo) => (
            <li className="composer-anexo" key={anexo.id}>
              {anexo.kind === 'image' ? (
                <img src={attachmentUrl(anexo.id)} alt="" className="composer-anexo-thumb" />
              ) : anexo.kind === 'spreadsheet' ? (
                <button type="button" className="composer-anexo-icone composer-planilha-abrir" onClick={() => openSpreadsheet(anexo.id)} aria-label={`Abrir ${anexo.filename}`}>
                  <FileSpreadsheet size={15} aria-hidden="true" />
                </button>
              ) : (
                <span className="composer-anexo-icone"><FileText size={15} aria-hidden="true" /></span>
              )}
              <span className="composer-anexo-texto">
                <strong>{anexo.filename}</strong>
                <small>
                  {tamanhoLegivel(anexo.sizeBytes)}
                  {/* Documento que não rendeu texto precisa ser dito: senão o
                      usuário acha que o modelo leu e ele não leu. */}
                  {anexo.kind === 'document' && anexo.textChars === 0 ? ' · sem texto legível' : ''}
                  {anexo.truncated ? ' · cortado' : ''}
                </small>
              </span>
              <button
                type="button"
                className="composer-anexo-remover"
                onClick={() => void remover(anexo.id)}
                aria-label={`Remover ${anexo.filename}`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
          {subindo > 0 ? <li className="composer-anexo composer-anexo-subindo">Enviando…</li> : null}
        </ul>
      ) : null}
      {erro ? <p className="composer-anexo-erro" role="alert">{erro}</p> : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          // Captura de tela colada é o caso mais comum de anexo de imagem.
          const arquivos = [...event.clipboardData.files];
          if (arquivos.length === 0) return;
          event.preventDefault();
          void receber(arquivos);
        }}
        placeholder={
          disabled
            ? 'Configure um modelo para começar.'
            : isStreaming
              ? 'Gerando resposta…'
              : 'Escreva uma pergunta, um trecho de código ou uma decisão…'
        }
        rows={1}
        disabled={disabled || isStreaming}
        aria-label="Mensagem"
      />
      <div className="composer-footer">
        <div className="composer-leading">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.xlsx,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(event) => {
              void receber([...(event.target.files ?? [])]);
              // Zera o valor: sem isso, escolher o MESMO arquivo de novo não
              // dispara change e o anexo não aparece.
              event.target.value = '';
            }}
          />
          <EffortPicker value={effort} onChange={onEffortChange} disabled={isStreaming} />
          <SciencePicker level={scienceLevel} format={scienceFormat} onChange={onScienceChange} disabled={isStreaming} />
          {searchAvailable ? (
            <WebSearchToggle value={webSearch} onChange={setWebSearch} disabled={isStreaming} />
          ) : null}
          <span className="composer-hint"><b>Enter</b> envia · <b>Shift + Enter</b> quebra linha</span>
        </div>
        <div className="composer-actions">
          {value.length > 0 ? <span className="composer-count">{value.length.toLocaleString('pt-BR')}</span> : null}
          {/* Anexar fica junto de enviar: as duas são ações de despacho, e
              separá-las nas pontas opostas do rodapé obrigava o olho a
              atravessar a barra para completar um envio com arquivo.
              Na MESMA linha, e não empilhado: um ícone de 28px sobre um botão
              de 36px dava 72px de coluna contra 28px do grupo da esquerda — o
              rodapé triplicava de altura e o resto passava a flutuar no meio.
              Alinhar pela linha de base é o que mantém o rodapé com uma
              altura só. */}
          <div className="composer-send-group">
            <button
              type="button"
              className="btn btn-icon composer-anexar"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || isStreaming || anexos.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              aria-label="Anexar arquivo"
              title="Anexar imagem, PDF, XLSX, CSV ou texto"
            >
              <Paperclip size={16} />
            </button>
            {isStreaming ? (
              <button type="button" className="btn btn-danger" onClick={onStop} aria-label="Parar geração">
                <Square size={13} fill="currentColor" />
                Parar
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={disabled || subindo > 0 || (!value.trim() && anexos.length === 0)} aria-label="Enviar mensagem">
                Enviar
                <ArrowUp size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
