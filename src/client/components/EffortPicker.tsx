import { memo, useMemo } from 'react';
import { Select } from '@usefragments/ui';
import { Gauge } from 'lucide-react';
import { EFFORT_HINT, EFFORT_LABEL, EFFORT_LEVELS, isEffortLevel, type EffortLevel } from '../types';

type EffortPickerProps = {
  value: EffortLevel;
  onChange: (effort: EffortLevel) => void;
  disabled?: boolean;
};

/**
 * Seletor de nível de raciocínio da conversa aberta.
 *
 * Usa o `Select` da @usefragments/ui, e não o `Combobox` do seletor de
 * modelo: são cinco opções fixas, e um campo de busca aqui seria cerimônia
 * sem função.
 *
 * O ganho sobre o `<select>` nativo é a explicação de cada nível aparecer
 * na lista, no momento de escolher. Antes ela existia só como `title` do
 * controle inteiro — ou seja, descrevia o nível já escolhido, que é
 * exatamente quando não se precisa mais dela.
 */
export const EffortPicker = memo(function EffortPicker({
  value,
  onChange,
  disabled = false,
}: EffortPickerProps) {
  const opcoes = useMemo(
    () => EFFORT_LEVELS.map((level) => ({
      value: level,
      label: EFFORT_LABEL[level],
      hint: EFFORT_HINT[level],
    })),
    [],
  );

  return (
    <Select
      className="effort-picker"
      value={value}
      onValueChange={(escolhido) => {
        if (isEffortLevel(escolhido)) onChange(escolhido);
      }}
      disabled={disabled}
      size="sm"
      options={opcoes}
    >
      <Select.Trigger
        aria-label="Nível de raciocínio"
        icon={<Gauge size={14} strokeWidth={2} aria-hidden="true" />}
      />
      <Select.Content className="effort-picker-menu" />
    </Select>
  );
});
