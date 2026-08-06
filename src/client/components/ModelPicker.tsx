import { memo, useMemo } from 'react';
import { Combobox } from '@usefragments/ui';
import { Brain, KeyRound, TriangleAlert } from 'lucide-react';
import type { ModelOption } from '../types';

type ModelPickerProps = {
  models: ModelOption[];
  selectedModelId: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
};

const compacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Segunda linha do item: capacidade, janela e preço.
 *
 * Recebe o modelo por **prop**, e não por `children`, de propósito. A
 * biblioteca deriva o rótulo exibido no campo fechado com um `getNodeText`
 * que desce recursivamente por `props.children` — então qualquer texto
 * passado assim seria concatenado ao nome do modelo, e o campo mostrava
 * "DeepSeek V4 Flashraciocínio1 mi ct". Sem `children`, o walker devolve
 * string vazia e o rótulo fica sendo só o nome.
 */
function OpcaoMeta({ model }: { model: ModelOption }) {
  const valores = preco(model.inputPriceUsdPerMillion, model.outputPriceUsdPerMillion);
  return (
    <span className="model-option-sub">
      {model.reasoning ? (
        <span className="model-option-tag">
          <Brain size={12} strokeWidth={2.2} aria-hidden="true" />
          raciocínio
        </span>
      ) : null}
      {model.configured === false ? (
        <span className="model-option-tag model-option-tag-warn">
          <KeyRound size={12} strokeWidth={2.2} aria-hidden="true" />
          configure a chave
        </span>
      ) : null}
      {model.stale ? (
        <span className="model-option-tag model-option-tag-warn">
          <TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
          preço antigo
        </span>
      ) : null}
      {model.contextWindow ? <span className="mono">janela {compacto.format(model.contextWindow)}</span> : null}
      {valores ? <span className="mono">{valores}</span> : null}
    </span>
  );
}

const dinheiro = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

/** Preço por milhão de tokens, no formato que a bancada usa para medir. */
function preco(entrada?: number, saida?: number): string | null {
  if (entrada === undefined && saida === undefined) return null;
  if (entrada === 0 && saida === 0) return 'grátis';
  const formata = (valor?: number) => (valor === undefined ? '—' : dinheiro.format(valor));
  return `US$ ${formata(entrada)} / ${formata(saida)} por 1M`;
}

/**
 * Seletor de modelo e provedor.
 *
 * É um Combobox com busca, e não um `<select>`, por uma razão medida: um
 * OpenRouter real devolve ~400 modelos, e rolar essa lista num menu nativo é
 * inviável. Digitar filtra pelo nome do modelo: a biblioteca deriva tanto o
 * termo de busca quanto o rótulo do campo fechado do mesmo texto, e por isso
 * a segunda linha entra por prop (ver OpcaoMeta) em vez de children.
 *
 * Cada linha carrega o que decide a escolha neste app: se o modelo raciocina
 * e quanto ele custa. Preço e janela em mono tabular, porque são valores
 * medidos (DESIGN.md §5.3).
 */
export const ModelPicker = memo(function ModelPicker({
  models,
  selectedModelId,
  onChange,
  disabled = false,
  loading = false,
}: ModelPickerProps) {
  const porProvedor = useMemo(() => {
    const grupos = new Map<string, { label: string; models: ModelOption[] }>();
    for (const model of models) {
      const grupo = grupos.get(model.providerId)
        ?? { label: model.providerLabel || model.providerId, models: [] };
      grupo.models.push(model);
      grupos.set(model.providerId, grupo);
    }
    return [...grupos.entries()];
  }, [models]);

  const vazio = models.length === 0;

  return (
    <div className="model-picker">
      <Combobox
        value={selectedModelId ?? ''}
        onValueChange={(value) => { if (value) onChange(value); }}
        disabled={disabled || loading || vazio}
        size="sm"
        placeholder={loading ? 'Carregando modelos…' : vazio ? 'Nenhum modelo disponível' : 'Buscar modelo…'}
      >
        <Combobox.Input showTrigger aria-label="Selecionar modelo e provedor" />
        <Combobox.Content className="model-picker-menu" maxVisibleItems={7}>
          <Combobox.Empty>Nenhum modelo corresponde à busca.</Combobox.Empty>
          {porProvedor.map(([providerId, grupo]) => (
            <Combobox.Group key={providerId}>
              <Combobox.GroupLabel>{grupo.label}</Combobox.GroupLabel>
              {grupo.models.map((model) => (
                <Combobox.Item
                  key={providerId + ':' + model.id}
                  value={model.id}
                  disabled={model.configured === false}
                  className="model-option"
                >
                  <span className="model-option-name">{model.label}</span>
                  <OpcaoMeta model={model} />
                </Combobox.Item>
              ))}
            </Combobox.Group>
          ))}
        </Combobox.Content>
      </Combobox>
    </div>
  );
});
