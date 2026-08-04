import { memo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ModelOption } from '../types';

type ModelPickerProps = {
  models: ModelOption[];
  selectedModelId: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
};

export const ModelPicker = memo(function ModelPicker({
  models,
  selectedModelId,
  onChange,
  disabled = false,
  loading = false,
}: ModelPickerProps) {
  const providers = Array.from(new Set(models.map((model) => model.providerId)));

  return (
    <label className="model-picker">
      <span className="sr-only">Modelo e provedor</span>
      <select
        value={selectedModelId ?? ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || loading || models.length === 0}
        aria-label="Selecionar modelo e provedor"
      >
        {models.length === 0 ? <option value="">{loading ? 'Carregando modelos…' : 'Nenhum modelo disponível'}</option> : null}
        {providers.map((providerId) => {
          const providerModels = models.filter((model) => model.providerId === providerId);
          return (
            <optgroup key={providerId} label={providerModels[0]?.providerLabel ?? providerId}>
              {providerModels.map((model) => (
                <option key={model.providerId + ':' + model.id} value={model.id} disabled={model.configured === false}>
                  {model.label}{model.reasoning ? ' · raciocínio' : ''}{model.configured === false ? ' · configure a chave' : ''}{model.stale ? ' · preço antigo' : ''}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <ChevronDown className="model-picker-chevron" size={14} aria-hidden="true" />
    </label>
  );
});
