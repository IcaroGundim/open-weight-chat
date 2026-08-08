import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SKILLS, type SkillSelection } from '../types';

type SkillsPickerProps = {
  readonly skills: SkillSelection[];
  readonly onChange: (skills: SkillSelection[]) => void;
  readonly disabled?: boolean;
};

function isSelected(skills: SkillSelection[], id: SkillSelection['id']): boolean {
  return skills.some((skill) => skill.id === id);
}

/**
 * Seletor genérico de Skills. A lista vem do registro do cliente e a seleção
 * é um conjunto ordenado, por isso novas skills não exigem outro botão no
 * compositor nem novos campos no estado da conversa.
 */
export function SkillsPicker({ skills, onChange, disabled = false }: SkillsPickerProps) {
  const [aberto, setAberto] = useState(false);
  const selected = SKILLS.filter((skill) => isSelected(skills, skill.id));
  const science = skills.find((skill) => skill.id === 'science');

  const toggle = (id: SkillSelection['id']) => {
    if (isSelected(skills, id)) {
      onChange(skills.filter((skill) => skill.id !== id));
      return;
    }
    // O discriminated union garante que cada id novo define os próprios
    // settings padrão neste ponto, sem vazar detalhes para o resto da UI.
    if (id === 'science') onChange([...skills, { id: 'science', settings: { format: 'markdown' } }]);
  };

  const setScienceFormat = (format: 'markdown' | 'latex') => {
    onChange(skills.map((skill) => skill.id === 'science' ? { ...skill, settings: { ...skill.settings, format } } : skill));
  };

  return (
    <div className="science-picker">
      <button
        type="button"
        className="btn btn-quiet science-gatilho"
        data-ativo={selected.length > 0 || undefined}
        onClick={() => setAberto((atual) => !atual)}
        disabled={disabled}
        aria-expanded={aberto}
        aria-haspopup="dialog"
        title="Skills: aplique fluxos especializados à resposta"
      >
        <Sparkles size={15} aria-hidden="true" />
        {selected.length > 0 ? `Skills · ${selected.map((skill) => skill.label).join(', ')}` : 'Skills'}
      </button>

      {aberto ? (
        <div className="science-painel" role="dialog" aria-label="Skills">
          <p className="science-titulo">Skills</p>
          <p className="science-texto">
            Ative fluxos especializados para esta conversa. Cada skill pode executar um ou mais estágios e aumentar o custo do turno.
          </p>

          <div className="science-opcoes" role="group" aria-label="Skills disponíveis">
            {SKILLS.map((skill) => {
              const ativo = isSelected(skills, skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  role="checkbox"
                  aria-checked={ativo}
                  className="science-opcao"
                  onClick={() => toggle(skill.id)}
                >
                  <span className="science-opcao-topo">
                    <strong>{skill.label}</strong>
                    <em><span className="num">{skill.agentes}</span> estágios</em>
                  </span>
                  <small>{skill.hint}</small>
                </button>
              );
            })}
          </div>

          {science ? (
            <>
              <p className="science-titulo science-titulo-secundario">Formato do documento</p>
              <div className="science-formato" role="radiogroup" aria-label="Formato do documento acadêmico">
                {SKILLS.find((skill) => skill.id === 'science')?.formats?.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={science.settings.format === id}
                    className="science-formato-opcao"
                    data-escolhido={science.settings.format === id || undefined}
                    onClick={() => setScienceFormat(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="science-aviso">
                A skill Science usa <span className="num">2</span> chamadas ao provedor por mensagem.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
