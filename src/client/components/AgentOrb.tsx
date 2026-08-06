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
export type AgentActivity =
  | 'pensando'
  | 'construindo'
  | 'revisando'
  | 'buscando'
  | 'conectando'
  | 'carregando'
  | 'reconstruindo'
  | 'compilando';

const ACTIVITY_STATE: Record<AgentActivity, OrbState> = {
  // Meridiano de varredura percorrendo o globo — é o indicador mais visto do
  // app (aparece a cada resposta), então fica com o desenho de maior
  // destaque em vez de dividi-lo com um estado periférico.
  pensando: 'searching',
  // Contorno pontilhado que se remodela — a leitura de "tomando forma" é
  // literal, e casa com o artefato crescendo no painel. Já é distinto do
  // globo de `pensando`, então os dois nunca se confundem lado a lado.
  construindo: 'shaping',
  // Faixas que se embaralham e voltam a encaixar. Revisar um artefato é
  // exatamente isso: o texto existente se desmancha nos trechos trocados e
  // assenta de novo. Distinguir de `construindo` informa, antes do diff, que
  // nada está sendo escrito do zero.
  revisando: 'solving',
  // Anel de face inteira em morfologia lenta: presença calma, que não disputa
  // atenção com o resto da tela de configurações enquanto o catálogo carrega.
  buscando: 'breathing',
  // Constelação que se cabeia sozinha, com pacotes correndo pelas arestas —
  // a imagem de uma sessão sendo estabelecida.
  conectando: 'connecting',
  // Partículas em órbitas inclinadas: trabalho genérico, sem prometer uma
  // semântica que a espera não tem.
  carregando: 'working',
  // Três fios trançando ao redor da esfera. Reconstruir um artefato é juntar
  // versões numa só peça.
  reconstruindo: 'weaving',
  // Faixa ondulante de várias bandas, para o relatório de custos sendo
  // montado a partir das agregações por dia e por modelo.
  compilando: 'composing',
};

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  pensando: 'O assistente está pensando',
  construindo: 'O artefato está sendo construído',
  revisando: 'O artefato está sendo revisado',
  buscando: 'Buscando os modelos do provedor',
  conectando: 'Estabelecendo a sessão',
  carregando: 'Carregando',
  reconstruindo: 'Reconstruindo o artefato',
  compilando: 'Compilando o relatório de custos',
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
