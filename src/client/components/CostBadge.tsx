import { memo } from 'react';
import type { Usage } from '../types';

type CostBadgeProps = {
  costUsd?: number | null;
  usage?: Usage;
  compact?: boolean;
  label?: string;
};

function formatCost(value: number): string {
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.0001) return '<$0.0001';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 6 : 4,
  }).format(value);
}

export const CostBadge = memo(function CostBadge({ costUsd, usage, compact = false, label }: CostBadgeProps) {
  const value = costUsd ?? usage?.costUsd;
  if (value === undefined || value === null || !Number.isFinite(value)) return null;

  const estimated = usage?.costEstimated ?? false;
  const title = usage
    ? (usage.promptTokens ?? 0) + ' tokens de entrada · ' + (usage.completionTokens ?? 0) + ' tokens de saída'
      + (estimated ? ' · valor estimado' : '')
    : estimated
      ? 'Custo estimado'
      : 'Custo desta resposta';

  return (
    <span
      className={'cost-badge' + (compact ? ' cost-badge-compact' : '') + (estimated ? ' cost-estimated' : '')}
      title={title}
    >
      <span>{label ?? 'Custo'}</span>
      <span className="cost-value">{(estimated ? '≈ ' : '') + formatCost(value)}</span>
    </span>
  );
});

export { formatCost };
