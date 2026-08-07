import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { SCIENCE_LEVELS, type ScienceFormat, type ScienceLevel } from '../types';

/**
 * Seletor do modo Science.
 *
 * É uma configuração à parte do esforço, e a interface mostra isso mantendo os
 * dois controles separados: esforço regula quanto o modelo pensa antes de
 * responder; ligar o Science faz o texto passar por duas mãos com papéis
 * diferentes — quem escreve e quem revisa e ilustra.
 *
 * **O número de agentes aparece na opção** porque cada um é uma chamada
 * cobrada: ligar o modo dobra o custo do turno, e isso precisa estar dito
 * antes da escolha, não depois da fatura.
 *
 * A pergunta do formato fica AQUI, junto da escolha do nível, e não numa
 * mensagem do chat. Perguntar por mensagem gastaria um turno inteiro do
 * modelo para coletar um dado que a interface já sabe pedir — e deixaria a
 * conversa começando por uma pergunta em vez de pela resposta.
 */

type SciencePickerProps = {
  readonly level: ScienceLevel;
  readonly format: ScienceFormat;
  readonly onChange: (level: ScienceLevel, format: ScienceFormat) => void;
  readonly disabled?: boolean;
};

export function SciencePicker({ level, format, onChange, disabled = false }: SciencePickerProps) {
  const [aberto, setAberto] = useState(false);
  const ativo = level !== 'off';
  const escolhido = SCIENCE_LEVELS.find((item) => item.id === level);

  return (
    <div className="science-picker">
      <button
        type="button"
        className="btn btn-quiet science-gatilho"
        data-ativo={ativo || undefined}
        onClick={() => setAberto((atual) => !atual)}
        disabled={disabled}
        aria-expanded={aberto}
        aria-haspopup="dialog"
        title="Modo Science: texto acadêmico por dois agentes"
      >
        <FlaskConical size={15} aria-hidden="true" />
        {ativo ? `Science · ${escolhido?.label}` : 'Science'}
      </button>

      {aberto ? (
        <div className="science-painel" role="dialog" aria-label="Modo Science">
          <p className="science-titulo">Modo Science</p>
          <p className="science-texto">
            Dois agentes para um texto acadêmico longo: o primeiro levanta o assunto e escreve
            um contexto detalhado; o segundo revisa coesão e semântica e acrescenta as figuras.
          </p>

          <div className="science-opcoes" role="radiogroup" aria-label="Modo">
            <button
              type="button"
              role="radio"
              aria-checked={level === 'off'}
              className="science-opcao"
              onClick={() => { onChange('off', format); setAberto(false); }}
            >
              <span className="science-opcao-topo"><strong>Desligado</strong></span>
              <small>Resposta normal, de um agente só.</small>
            </button>
            {SCIENCE_LEVELS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={level === item.id}
                className="science-opcao"
                onClick={() => onChange(item.id, format)}
              >
                <span className="science-opcao-topo">
                  <strong>{item.label}</strong>
                  {/* Mono só em valor medido: a contagem de agentes é uma. */}
                  <em><span className="num">{item.agentes}</span> agentes</em>
                </span>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>

          {ativo ? (
            <>
              <p className="science-titulo science-titulo-secundario">Formato do documento</p>
              <div className="science-formato" role="radiogroup" aria-label="Formato do documento">
                {([['markdown', 'Markdown'], ['latex', 'LaTeX']] as const).map(([id, rotulo]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={format === id}
                    className="science-formato-opcao"
                    data-escolhido={format === id || undefined}
                    onClick={() => onChange(level, id)}
                  >
                    {rotulo}
                  </button>
                ))}
              </div>
              <p className="science-aviso">
                Cada agente é uma chamada cobrada ao provedor:{' '}
                <span className="num">{escolhido?.agentes ?? 0}</span> por mensagem.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
