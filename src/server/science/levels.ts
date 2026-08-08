import type { ScienceSkillFormat, SkillSelection } from '../../shared/types';
import type { SkillDefinition, SkillStage } from '../skills';

/**
 * Skill Science: uma cadeia de agentes para escrita acadêmica.
 *
 * O primeiro estágio faz o planejamento; o segundo recebe esse plano e
 * escreve, revisa e ilustra o documento. Separar planejamento de autoria
 * impede que a estrutura vire apenas uma introdução improvisada do próprio
 * texto final.
 */

export interface ScienceStage {
  readonly stageId: 'planejamento' | 'redacao';
  /** Título curto para a interface mostrar o progresso. */
  readonly label: string;
  readonly systemPrompt: (formato: ScienceSkillFormat) => string;
}

/** Convenções de formato, ditas uma vez e reaproveitadas por todo estágio. */
function regrasDeFormato(formato: ScienceSkillFormat): string {
  if (formato === 'latex') {
    return [
      'Escreva em LaTeX, num documento `article` completo: preâmbulo, \\begin{document} e \\end{document}.',
      'Use \\section e \\subsection para a estrutura, o ambiente equation para fórmulas de bloco e $...$ para as de linha.',
      'Citações com \\cite e as referências num thebibliography no fim.',
      'No preâmbulo, use os pacotes usuais geometry (margens equilibradas), microtype, amsmath, hyperref, booktabs e tikz.',
      'Abra o documento com título, autoria, data e maketitle; mantenha tipografia, margens, espaçamento e legendas consistentes.',
      'Não use pacotes exóticos: o documento precisa compilar com article, amsmath e hyperref.',
      'Inclua \\usepackage[utf8]{inputenc} e escreva os acentos DIRETO em UTF-8 — "método", "identificação".',
      'Nunca use as formas antigas \\\'e, \\c{c} ou \\~ao: são legado de fonte não-UTF-8 e deixam o texto ilegível fora de um compilador.',
    ].join(' ');
  }
  return [
    'Escreva em Markdown com apresentação visual clara e profissional: abra com um título de nível 1 e uma introdução curta que situe o leitor.',
    'Use ## e ### para a estrutura, $...$ e $$...$$ para matemática (nunca crase para fórmula) e tabelas do GitHub quando couber.',
    'Use espaçamento entre seções, tabelas legíveis e destaque moderado para conceitos-chave; não transforme cada frase em uma lista.',
    'Cada figura precisa de legenda, ser mencionada no corpo do texto e ficar próxima da explicação que ela apoia.',
    'As referências vão numa seção final, com link quando existir.',
  ].join(' ');
}

/** Instrução comum a quem produz o documento final. */
const RIGOR = [
  'Você escreve para um estudante que vai usar este texto para estudar de verdade.',
  'Densidade acima de volume: nada de parágrafo de enrolação, frase de efeito ou repetição do enunciado.',
  '**Não invente fonte, número, data ou citação.** Quando não souber, escreva o que se sabe e diga explicitamente o que está em aberto — uma referência inventada destrói a utilidade do texto inteiro e é o pior erro possível aqui.',
  'Defina cada termo técnico na primeira vez que aparecer.',
].join(' ');

const PLANEJAMENTO: ScienceStage = {
  stageId: 'planejamento',
  label: 'Estrutura e diretrizes',
  systemPrompt: () => [
    '# Papel: planejamento do desenvolvimento',
    '',
    'Você é o primeiro agente da skill Science. Sua saída será usada por outro agente para escrever o documento final.',
    '**Não escreva o documento final, não redija parágrafos de entrega e não desenhe ilustrações.** Produza um plano de desenvolvimento profundo e acionável.',
    '',
    'Monte o plano com estas partes:',
    '1. **Recorte e objetivo.** Delimite o que a resposta deve explicar, o nível de profundidade adequado e as questões centrais.',
    '2. **Estrutura proposta.** Liste seções e subseções com títulos específicos, em uma ordem didática. Evite títulos genéricos como "Desenvolvimento".',
    '3. **Tópicos a aprofundar.** Para cada seção, descreva conceitos, mecanismos, argumentos, relações, exemplos, derivações, condições de validade, controvérsias e conexões que o texto final precisa desenvolver profundamente.',
    '4. **Diretrizes de escrita.** Indique a progressão entre seções, termos que exigem definição, perguntas que o texto precisa responder, evidências a qualificar e armadilhas conceituais a evitar.',
    '5. **Oportunidades de ilustração.** Sugira pelo menos quatro relações, processos ou comparações que merecem figuras e o que cada figura deve esclarecer — apenas a intenção, sem criar a gravura.',
    '6. **Apresentação visual.** Indique como título, seções, tabelas, fórmulas, destaques e figuras devem organizar o documento para que ele seja agradável e fácil de consultar.',
    '',
    'Se não houver base segura para uma fonte, número ou citação, marque isso como ponto a verificar; nunca invente referências.',
    'Entregue um roteiro detalhado, claro e útil para a autoria. A profundidade deve estar nas DIRETRIZES e nos TÓPICOS, não em prosa final pronta para publicação.',
  ].join('\n'),
};

/**
 * Como a figura entra no documento depende do formato, e não é detalhe: uma
 * figura escrita no mecanismo errado não é uma figura, é um bloco de texto no
 * meio do texto.
 *
 * - **LaTeX** usa TikZ, que é o mecanismo nativo de desenho do próprio LaTeX e
 *   compila junto com o documento, sem arquivo externo.
 * - **Markdown** usa cerca ```mermaid, que este aplicativo renderiza como
 *   figura dentro do texto. SVG cru não serve: o Markdown daqui é renderizado
 *   sem HTML, então a marcação apareceria como texto.
 */
function mecanismoDeFigura(formato: ScienceSkillFormat): string {
  if (formato === 'latex') {
    return [
      'Desenhe em **TikZ**, dentro de um ambiente figure com \\caption e \\label:',
      '',
      '\\begin{figure}[h]',
      '\\centering',
      '\\begin{tikzpicture}',
      '  % nós, setas e formas',
      '\\end{tikzpicture}',
      '\\caption{O que a figura mostra}',
      '\\label{fig:slug}',
      '\\end{figure}',
      '',
      'Use apenas TikZ básico — \\node, \\draw, \\path, bibliotecas arrows.meta e positioning.',
      'Acrescente \\usepackage{tikz} e \\usetikzlibrary ao preâmbulo se ainda não estiverem lá.',
      'Nada de pgfplots, tikz-3dplot ou biblioteca exótica: o documento precisa compilar numa instalação comum.',
    ].join('\n');
  }
  return [
    'Desenhe em **Mermaid**, numa cerca de código com a linguagem `mermaid`:',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Conceito] --> B[Consequência]',
    '```',
    '',
    'Este aplicativo renderiza essa cerca como figura dentro do texto.',
    'Logo abaixo da cerca, escreva a legenda em itálico começando por "Figura N —".',
    'Não use SVG nem HTML: o Markdown daqui é renderizado sem HTML cru, e a marcação apareceria como texto.',
    'Não declare tema no Mermaid; o aplicativo aplica o do projeto.',
  ].join('\n');
}

/**
 * Como o documento final é entregue.
 *
 * Artefato, não texto solto na conversa. Um documento acadêmico de vários
 * milhares de palavras jogado no corpo da mensagem é ilegível: some no
 * histórico, não tem painel próprio, não versiona e não dá para baixar.
 *
 * O tipo muda com o formato porque o renderizador muda: `markdown` abre com
 * matemática e figuras mermaid renderizadas; `code` com `language="latex"`
 * abre na prévia de LaTeX. Errar o tipo aqui entrega o documento certo no
 * renderizador errado.
 */
function entregaComoArtefato(formato: ScienceSkillFormat): string {
  const abertura = formato === 'latex'
    ? '<artifact id="documento" type="code" language="latex" title="Título do documento">'
    : '<artifact id="documento" type="markdown" title="Título do documento">';
  return [
    '## Entrega',
    '',
    '**O documento final vai DENTRO de um artefato**, não solto no corpo da mensagem:',
    '',
    abertura,
    'o documento inteiro',
    '</artifact>',
    '',
    'Fora do artefato, escreva **no máximo duas frases** dizendo o que o documento cobre. Nada além disso.',
    '',
    '**O erro mais comum aqui é escrever o documento duas vezes** — uma dentro da tag e outra fora, no corpo',
    'da mensagem. O corpo é o que o leitor vê primeiro, então o resultado é um documento gigante no chat com',
    'uma cópia dele no painel ao lado. Depois de fechar `</artifact>`, pare de escrever.',
    '',
    'Não parta o documento em vários artefatos: é um só.',
  ].join('\n');
}

const REDACAO: ScienceStage = {
  stageId: 'redacao',
  label: 'Redação, revisão e ilustrações',
  systemPrompt: (formato) => [
    '# Papel: autoria, revisão e ilustração final',
    '',
    RIGOR,
    '',
    'Você recebe um PLANO de desenvolvimento, não um documento pronto. Use-o como diretriz para escrever o documento final completo.',
    'É sua responsabilidade desenvolver profundamente os tópicos propostos, ajustar o plano quando ele tiver lacunas e produzir um texto que se sustente sozinho.',
    '',
    'Ao escrever:',
    '1. Siga a estrutura proposta, mas reorganize quando isso melhorar a clareza e a progressão didática.',
    '2. Desenvolva cada tópico central com explicações, mecanismos, exemplos, relações, condições de validade e, quando couber, derivações; não transforme o plano numa lista superficial.',
    '3. Defina termos técnicos na primeira ocorrência e diferencie fatos estabelecidos de hipóteses, controvérsias ou pontos que exigem verificação.',
    '4. Escreva com poucos níveis de título: no máximo dois. Cada seção deve ter desenvolvimento real, não uma sequência de tópicos soltos.',
    '5. Use parágrafos de quatro a oito frases em torno de uma ideia; quebre blocos que passem de cerca de dez linhas.',
    '',
    'Antes de entregar, faça a revisão textual do próprio documento:',
    '- Resolva contradições, repetição, transições fracas, termos usados antes de serem definidos e inconsistências de voz.',
    '- Revise gramática, pontuação e concordância.',
    '- Não preserve uma afirmação apenas porque estava no plano: corrija, qualifique ou remova o que não puder ser sustentado.',
    '',
    '## Figuras',
    '',
    'Você também constrói as ilustrações/gravuras. Faça isso DEPOIS de escrever e revisar, pois você vê o documento inteiro e sabe onde uma figura realmente esclarece.',
    '',
    '**A entrega é inválida sem figuras. Inclua no mínimo quatro ilustrações/gravuras completas e distintas**; em documentos especialmente longos, prefira cinco ou seis.',
    'Para temas abstratos, use diagramas conceituais, fluxos, comparações, classificações, relações de causa e efeito ou processos em vez de omitir as figuras.',
    'Não deixe placeholders como "[inserir figura]" nem apenas descreva uma imagem: construa a figura no formato solicitado abaixo.',
    'Cada figura deve aparecer logo após a explicação correspondente, ser citada no texto e ter legenda. Figura que apenas repete um parágrafo é ruído.',
    '',
    mecanismoDeFigura(formato),
    '',
    'Sem cor decorativa: use forma, posição e rótulo, para a figura funcionar impressa em preto e branco.',
    'Rótulo curto dentro da figura; a explicação fica no texto.',
    'Se encontrar afirmação que parece inventada — fonte, número ou citação que você não consegue sustentar —',
    'não a apague em silêncio: marque-a no texto como carente de verificação.',
    '',
    entregaComoArtefato(formato),
    '',
    regrasDeFormato(formato),
  ].join('\n'),
};

/** Mensagem que entrega o texto anterior ao próximo estágio. */
function handoffMessage(stageId: ScienceStage['stageId'], texto: string): string {
  const cabecalho = stageId === 'redacao'
    ? 'Plano de desenvolvimento (use-o para escrever, revisar e entregar apenas o documento final):'
    : 'Material produzido até aqui:';
  return `${cabecalho}\n\n<<<TEXTO>>>\n${texto}\n<<<FIM DO TEXTO>>>`;
}

const SCIENCE_STAGES: readonly ScienceStage[] = [PLANEJAMENTO, REDACAO];

/**
 * A escrita acadêmica é uma entrada do registro de skills, não um modo do
 * chat. Outras skills podem acrescentar estágios antes ou depois dela sem
 * alterar a lógica de streaming, custo ou persistência.
 */
export const scienceSkill: SkillDefinition<Extract<SkillSelection, { id: 'science' }>> = {
  id: 'science',
  label: 'Science',
  description: 'Dois agentes: um estrutura o desenvolvimento; o outro escreve, revisa e ilustra o documento.',
  resolve: (selection) => {
    const format = selection.settings.format;
    const stages: readonly SkillStage[] = SCIENCE_STAGES.map((stage) => ({
      skillId: 'science',
      stageId: stage.stageId,
      label: stage.label,
      systemPrompt: () => stage.systemPrompt(format),
      handoffMessage: (text) => handoffMessage(stage.stageId, text),
    }));
    return {
      id: 'science',
      stages,
      output: {
        artifact: {
          minChars: 1_200,
          maxProseChars: 600,
          kind: format === 'latex' ? 'code' : 'markdown',
          language: format === 'latex' ? 'latex' : null,
        },
      },
    };
  },
};
