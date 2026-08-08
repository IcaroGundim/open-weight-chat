import type { ArtifactKind, SkillId, SkillSelection, SkillSelections } from '../../shared/types';
import { scienceSkill } from '../science/levels';

/** Um estágio é a unidade comum de execução de qualquer skill. */
export interface SkillStage {
  readonly skillId: SkillId;
  readonly stageId: string;
  readonly label: string;
  readonly systemPrompt: () => string;
  /** Entrega o material produzido à próxima passagem da cadeia. */
  readonly handoffMessage: (text: string) => string;
}

/** Como a resposta final de uma skill deve ser armazenada, se necessário. */
export interface SkillOutput {
  readonly artifact?: {
    readonly minChars: number;
    readonly maxProseChars: number;
    readonly kind: ArtifactKind;
    readonly language: string | null;
  };
}

export interface ResolvedSkill {
  readonly id: SkillId;
  readonly stages: readonly SkillStage[];
  readonly output: SkillOutput;
}

/**
 * Contrato para registrar uma skill nova.
 *
 * A implementação recebe apenas sua seleção e devolve estágios genéricos. O
 * servidor não conhece "modo" algum: ele concatena os estágios registrados e
 * passa a saída de um para o seguinte na ordem escolhida pelo usuário.
 */
export interface SkillDefinition<TSelection extends SkillSelection = SkillSelection> {
  readonly id: TSelection['id'];
  readonly label: string;
  readonly description: string;
  readonly resolve: (selection: TSelection) => ResolvedSkill;
}

export const SKILL_REGISTRY: Readonly<Record<SkillId, SkillDefinition>> = {
  science: scienceSkill,
};

export interface SkillChain {
  readonly selections: SkillSelections;
  readonly stages: readonly SkillStage[];
  readonly output: SkillOutput;
}

/**
 * Resolve as skills selecionadas para uma cadeia única e ordenada.
 *
 * Uma skill futura só precisa entrar no registro com estágios compatíveis; a
 * seleção, o streaming, o custo e a persistência já usam esta abstração.
 */
export function resolveSkillChain(selections: SkillSelections): SkillChain | null {
  if (selections.length === 0) return null;
  const resolved = selections.map((selection) => SKILL_REGISTRY[selection.id].resolve(selection));
  const stages = resolved.flatMap((skill) => skill.stages);
  if (stages.length === 0) {
    throw new Error(`As skills selecionadas (${selections.map((skill) => skill.id).join(', ')}) não registraram nenhum estágio.`);
  }
  return {
    selections,
    stages,
    // A última skill é dona da forma da resposta final. Isso permite, por
    // exemplo, uma skill futura de revisão depois da escrita acadêmica.
    output: resolved.at(-1)?.output ?? {},
  };
}
