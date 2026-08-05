import { useState } from 'react';
import { AgentOrb } from './AgentOrb';

type ReasoningBlockProps = {
  reasoning?: string;
  tokens?: number;
  streaming?: boolean;
};

export function ReasoningBlock({ reasoning, tokens, streaming = false }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false);
  if (!reasoning?.trim()) return null;

  return (
    <details className="reasoning-block" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {streaming ? <AgentOrb activity="pensando" label="Raciocínio em andamento" /> : null}
        <span>{streaming ? 'Raciocínio em andamento' : 'Raciocínio do modelo'}</span>
        {tokens ? <span className="reasoning-count">{tokens.toLocaleString('pt-BR')} tokens</span> : null}
      </summary>
      <div className="reasoning-content">{reasoning}</div>
    </details>
  );
}
