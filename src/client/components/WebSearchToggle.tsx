import { Globe } from 'lucide-react';

/**
 * Interruptor da busca na web.
 *
 * Fica no compositor, junto do esforço e do Science, porque é a mesma classe
 * de decisão: o que este envio vai fazer, e quanto vai custar.
 *
 * Ele existe porque o plugin da OpenRouter **não decide**: uma vez ativado, ele
 * busca em toda requisição, mesmo em "resuma este texto" ou "corrija este
 * código". Não há modo condicional no plugin — o que a OpenRouter oferece para
 * isso é outra coisa, um server tool, com outro contrato. Enquanto não for
 * isso, quem decide é quem pergunta, e a decisão precisa estar à mão no
 * momento de perguntar, não enterrada em Configurações.
 *
 * Só aparece quando há busca configurada e ligada. Um interruptor que não liga
 * nada promete um recurso e não explica por que ele não acontece.
 */

type WebSearchToggleProps = {
  readonly value: boolean;
  readonly onChange: (on: boolean) => void;
  readonly disabled?: boolean;
};

export function WebSearchToggle({ value, onChange, disabled = false }: WebSearchToggleProps) {
  return (
    <button
      type="button"
      className="btn btn-quiet busca-toggle"
      data-ativo={value || undefined}
      aria-pressed={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      title={value
        ? 'Esta mensagem vai consultar a web. Cada consulta é cobrada.'
        : 'Responder só com o que o modelo já sabe, sem consultar a web.'}
    >
      <Globe size={15} aria-hidden="true" />
      Buscar
    </button>
  );
}
