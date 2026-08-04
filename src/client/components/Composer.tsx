import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';

type ComposerProps = {
  onSend: (content: string) => void | Promise<void>;
  onStop: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
};

export function Composer({ onSend, onStop, isStreaming = false, disabled = false }: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight, 190) + 'px';
  }, [value]);

  const submit = async () => {
    const content = value.trim();
    if (!content || disabled || isStreaming) return;
    setValue('');
    await onSend(content);
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
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
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
        <span className="composer-hint"><b>Enter</b> envia · <b>Shift + Enter</b> quebra linha</span>
        <div className="composer-actions">
          {value.length > 0 ? <span className="composer-count">{value.length.toLocaleString('pt-BR')}</span> : null}
          {isStreaming ? (
            <button type="button" className="btn btn-danger" onClick={onStop} aria-label="Parar geração">
              <Square size={13} fill="currentColor" />
              Parar
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={disabled || !value.trim()} aria-label="Enviar mensagem">
              Enviar
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
