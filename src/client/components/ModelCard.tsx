import { memo } from 'react';
import type { ModelOption } from '../types';

type ModelCardProps = {
  model?: ModelOption;
  loading?: boolean;
};

function formatPrice(value?: number): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return 'grátis';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.1 ? 3 : 2,
  }).format(value);
}

function formatContext(value?: number): string {
  if (!value || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return (Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)) + 'M';
  }
  if (value >= 1000) return Math.round(value / 1000) + 'k';
  return value.toString();
}

function verificationNote(verifiedAt?: string, stale?: boolean): string {
  if (!verifiedAt) return 'Preços sem data de verificação — confirme antes de usar como projeção de custo.';
  const date = new Date(verifiedAt);
  const label = Number.isNaN(date.getTime())
    ? verifiedAt
    : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  return stale
    ? 'Preços verificados em ' + label + ' — já passaram de 90 dias. Revalide antes de confiar no custo.'
    : 'Preços verificados em ' + label + '.';
}

/**
 * A tese do produto é custo. O estado inicial mostra o medidor antes da
 * primeira mensagem, em vez de uma capa decorativa.
 */
export const ModelCard = memo(function ModelCard({ model, loading = false }: ModelCardProps) {
  if (loading) {
    return (
      <div className="model-card">
        <div className="model-card-head"><strong>Carregando modelos…</strong></div>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="model-card">
        <div className="model-card-head"><strong>Nenhum modelo disponível</strong></div>
        <div className="model-card-foot foot-warn">
          Configure ao menos uma chave no <code>.env</code> do servidor (DeepSeek, Z.ai, Kimi ou OpenRouter),
          ou aponte um endpoint local do Ollama.
        </div>
      </div>
    );
  }

  const unconfigured = model.configured === false;

  return (
    <div className="model-card">
      <div className="model-card-head">
        <strong>{model.label}</strong>
        <span>{model.providerLabel}</span>
      </div>
      <dl className="model-specs">
        <div className="model-spec">
          <dt>Entrada / 1M</dt>
          <dd>{formatPrice(model.inputPriceUsdPerMillion)}</dd>
        </div>
        <div className="model-spec">
          <dt>Saída / 1M</dt>
          <dd>{formatPrice(model.outputPriceUsdPerMillion)}</dd>
        </div>
        <div className="model-spec">
          <dt>Janela</dt>
          <dd className={model.contextWindow ? undefined : 'spec-warn'}>
            {formatContext(model.contextWindow)}
          </dd>
        </div>
        <div className="model-spec">
          <dt>Raciocínio</dt>
          <dd className="spec-plain">{model.reasoning ? 'sim' : 'não'}</dd>
        </div>
      </dl>
      <div className={'model-card-foot' + (unconfigured || model.stale ? ' foot-warn' : '')}>
        {unconfigured
          ? 'Chave não configurada para este provedor — as mensagens vão falhar.'
          : verificationNote(model.verifiedAt, model.stale)}
      </div>
    </div>
  );
});
