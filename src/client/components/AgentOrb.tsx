import { ThinkingOrb, type OrbSize, type OrbState } from 'thinking-orbs';
import { useSettingsStore } from '../store/settings';

/**
 * Indicador de atividade do agente.
 *
 * Três momentos do trabalho, três animações distintas — a forma informa o que
 * está acontecendo antes de qualquer texto:
 *
 * - `pensando`     o modelo raciocina ou ainda não emitiu o primeiro token;
 * - `construindo`  um artefato está sendo escrito no painel;
 * - `buscando`     o servidor consulta o catálogo /models do provedor.
 *
 * O mapeamento para os estados da biblioteca fica aqui, num lugar só, para que
 * os três momentos nunca divirjam entre telas: o mesmo tipo de espera precisa
 * ter sempre a mesma aparência, senão o indicador vira ruído em vez de sinal.
 */
export type AgentActivity = 'pensando' | 'construindo' | 'buscando';

const ACTIVITY_STATE: Record<AgentActivity, OrbState> = {
  // Anel de face inteira em morfologia lenta: presença calma, que não disputa
  // atenção com o texto que está sendo transmitido ao lado.
  pensando: 'breathing',
  // Contorno pontilhado que se remodela — a leitura de "tomando forma" é
  // literal, e casa com o artefato crescendo no painel.
  construindo: 'shaping',
  // Meridiano de varredura percorrendo o globo: a metáfora de busca já é a do
  // próprio desenho.
  buscando: 'searching',
};

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  pensando: 'O assistente está pensando',
  construindo: 'O artefato está sendo construído',
  buscando: 'Buscando os modelos do provedor',
};

interface AgentOrbProps {
  activity: AgentActivity;
  /** 20 acompanha texto corrido; 64 é escala de avatar. Presets distintos, não escala. */
  size?: OrbSize;
  /** Sobrescreve o rótulo de acessibilidade quando o contexto pede algo mais específico. */
  label?: string;
}

export function AgentOrb({ activity, size = 20, label }: AgentOrbProps) {
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);

  return (
    <ThinkingOrb
      state={ACTIVITY_STATE[activity]}
      size={size}
      // `auto` resolve sozinho: o ChatView já escreve data-theme no
      // documentElement, que é precisamente o que a biblioteca observa.
      theme="auto"
      // "Reduzir movimento" das Configurações congela o quadro em vez de
      // esconder o indicador — a informação de que algo está em curso
      // permanece, o movimento é que sai.
      paused={reduceMotion}
      className="agent-orb"
      role="status"
      aria-label={label ?? ACTIVITY_LABEL[activity]}
    />
  );
}
