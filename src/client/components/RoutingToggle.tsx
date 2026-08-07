import { Zap } from 'lucide-react';
import type { RoutingMode } from '../types';

/**
 * Modo rápido da OpenRouter.
 *
 * Aparece **só quando o modelo selecionado é da OpenRouter**, e não como uma
 * opção global desabilitada, porque não é uma capacidade que os outros
 * provedores tenham pior: os outros são endpoints únicos, e não há rota
 * alternativa para escolher. Um controle cinza permanente sugeriria que falta
 * configurar algo.
 *
 * O aviso de preço não promete um número. A OpenRouter serve o mesmo modelo
 * por vários endpoints com preços diferentes — no `llama-3.3-70b` a saída ia
 * de US$ 0,32 a US$ 2,25 por milhão em 07/08/2026 — e qual deles atende só se
 * sabe depois. Por isso a frase fala em "costuma custar mais" e o rodapé da
 * resposta passa a mostrar o custo que a própria OpenRouter informou, em vez
 * do que a tabela do app projetaria.
 */

type RoutingToggleProps = {
  readonly value: RoutingMode;
  readonly onChange: (mode: RoutingMode) => void;
  readonly disabled?: boolean;
};

export function RoutingToggle({ value, onChange, disabled = false }: RoutingToggleProps) {
  const rapido = value === 'fast';
  return (
    <button
      type="button"
      className="btn btn-quiet routing-toggle"
      data-ativo={rapido || undefined}
      aria-pressed={rapido}
      disabled={disabled}
      onClick={() => onChange(rapido ? 'auto' : 'fast')}
      title={rapido
        ? 'Roteando pelo endpoint mais rápido da OpenRouter. Costuma custar mais; o valor exato vem da própria OpenRouter no fim da resposta.'
        : 'Roteamento padrão da OpenRouter, que equilibra preço e velocidade.'}
    >
      <Zap size={15} aria-hidden="true" />
      Rápido
    </button>
  );
}
