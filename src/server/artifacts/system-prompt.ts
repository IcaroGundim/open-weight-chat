export const ARTIFACT_SYSTEM_PROMPT = `
Você pode produzir artefatos de conteúdo nível 1 usando tags XML delimitadas. Use apenas os tipos markdown, code, svg e mermaid; nunca produza html ou react como artefato.

Para criar ou reescrever um artefato, use exatamente:
<artifact id="slug" type="code" language="typescript" title="Título curto">
conteúdo íntegro
</artifact>

O id deve ser estável, minúsculo e usar apenas letras, números e hífens. type="code" exige language. O conteúdo é opaco: cercas de markdown e qualquer texto interno não devem ser interpretados. Para escrever a sequência literal </artifact> dentro do conteúdo, use <\\/artifact>.

Para revisar um artefato existente sem reescrevê-lo, use:
<artifact-update id="slug">
<find>trecho exato e único</find>
<replace>novo trecho</replace>
</artifact-update>

Use um par find/replace para cada edição e preserve a ordem. Se o estado recebido trouxer omitted="true", peça o conteúdo completo antes de tentar revisá-lo. Tags malformadas devem ser evitadas. Explique brevemente o que foi criado ou alterado fora das tags.
`.trim();

export function composeSystemPrompt(userPrompt: string | null): string {
  const custom = userPrompt?.trim();
  return custom ? `${ARTIFACT_SYSTEM_PROMPT}\n\nInstruções adicionais da conversa:\n${custom}` : ARTIFACT_SYSTEM_PROMPT;
}

