import { memo } from 'react';
import { ChevronDown, Gauge } from 'lucide-react';
import { EFFORT_HINT, EFFORT_LABEL, EFFORT_LEVELS, isEffortLevel, type EffortLevel } from '../types';

type EffortPickerProps = {
  value: EffortLevel;
  onChange: (effort: EffortLevel) => void;
  disabled?: boolean;
};

/**
 * Seletor de nível de raciocínio da conversa aberta.
 *
 * Fica ao lado do seletor de modelo porque é a mesma decisão sob dois
 * ângulos: qual modelo pensa e quanto ele pensa. As duas escolhas movem o
 * custo da mensagem, e este app existe para deixar isso visível.
 */
export const EffortPicker = memo(function EffortPicker({
  value,
  onChange,
  disabled = false,
}: EffortPickerProps) {
  return (
    <label className="effort-picker" title={EFFORT_HINT[value]}>
      <span className="sr-only">Nível de raciocínio</span>
      <Gauge className="effort-picker-icon" size={14} aria-hidden="true" />
      <select
        value={value}
        onChange={(event) => {
          if (isEffortLevel(event.target.value)) onChange(event.target.value);
        }}
        disabled={disabled}
        aria-label="Nível de raciocínio"
      >
        {EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {EFFORT_LABEL[level]}
          </option>
        ))}
      </select>
      <ChevronDown className="effort-picker-chevron" size={14} aria-hidden="true" />
    </label>
  );
});
