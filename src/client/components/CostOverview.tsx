import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { getCostAnalytics } from '../api';
import type { CostAnalytics } from '../types';
import { AgentOrb } from './AgentOrb';
import { formatCost } from './CostBadge';

type CostOverviewProps = {
  onClose: () => void;
};

function dayLabel(day: string): string {
  const date = new Date(day + 'T12:00:00');
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(date);
}

export function CostOverview({ onClose }: CostOverviewProps) {
  const [analytics, setAnalytics] = useState<CostAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getCostAnalytics(30)
      .then((value) => {
        if (active) setAnalytics(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os custos.');
      });
    return () => {
      active = false;
    };
  }, []);

  const maxDailyCost = useMemo(
    () => Math.max(0, ...(analytics?.daily.map((item) => item.costUsd) ?? [])),
    [analytics],
  );

  return (
    <div className="cost-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="cost-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cost-overview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cost-modal-header">
          <div>
            <h2 id="cost-overview-title">Custo observado</h2>
            <p>Últimos 30 dias, a partir do que foi registrado localmente.</p>
          </div>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Fechar custos"><X size={17} /></button>
        </header>

        {error ? <p className="cost-modal-error" role="alert">{error}</p> : null}
        {!analytics && !error ? (
          <div className="cost-modal-loading"><AgentOrb activity="compilando" label="Lendo o registro de custos" /> Lendo o registro…</div>
        ) : null}

        {analytics ? (
          <>
            <div className="cost-total-card">
              <div>
                <p>Total com preço conhecido</p>
                <small>Modelos sem preço configurado, como Ollama local, não entram neste total.</small>
              </div>
              <strong>{formatCost(analytics.totalCostUsd)}</strong>
            </div>

            <div className="cost-overview-grid">
              <div>
                <h3>Por dia</h3>
                {analytics.daily.length === 0 ? (
                  <p className="cost-empty">Ainda não há custos registrados.</p>
                ) : (
                  <div className="cost-daily-list">
                    {analytics.daily.slice(0, 14).map((item) => (
                      <div className="cost-daily-row" key={item.day}>
                        <span>{dayLabel(item.day)}</span>
                        <div className="cost-bar-track" aria-hidden="true">
                          <span style={{ width: maxDailyCost ? Math.max(4, (item.costUsd / maxDailyCost) * 100) + '%' : '0%' }} />
                        </div>
                        <strong>{formatCost(item.costUsd)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3>Por modelo</h3>
                {analytics.byModel.length === 0 ? (
                  <p className="cost-empty">Nenhum modelo com preço conhecido.</p>
                ) : (
                  <div className="cost-model-list">
                    {analytics.byModel.map((item) => (
                      <div className="cost-model-row" key={item.providerId + ':' + item.modelId}>
                        <div>
                          <strong>{item.modelId}</strong>
                          <small>{item.providerId} · {item.messageCount} mensagens</small>
                        </div>
                        <span>{formatCost(item.costUsd)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
