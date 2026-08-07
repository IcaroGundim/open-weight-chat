import type { ScienceFormat, ScienceLevel, ScienceRole } from '../../shared/types';

/**
 * Modo Science: uma cadeia de agentes sobre a mesma pergunta.
 *
 * Cada estágio é uma chamada NOVA ao provedor, com prompt de sistema próprio e
 * recebendo o texto do estágio anterior. Não é um prompt gigante pedindo
 * "pesquise, escreva e revise": um modelo que faz tudo numa passagem revisa o
 * que acabou de escrever, e revisar o próprio texto na mesma respiração é
 * justamente o que ninguém faz bem. Separar em chamadas dá ao revisor um texto
 * que ele não escreveu.
 *
 * **O custo é linear no número de agentes.** Nível 3 são cinco chamadas sobre
 * um texto longo, e o texto cresce a cada estágio — a última passagem lê tudo
 * o que veio antes. A interface diz o número de agentes antes de rodar porque
 * essa é a informação que decide a escolha.
 */

export interface ScienceStage {
  readonly role: ScienceRole;
  /** Título curto para a interface mostrar o progresso. */
  readonly label: string;
  readonly systemPrompt: (formato: ScienceFormat) => string;
}

export interface ScienceChain {
  readonly level: Exclude<ScienceLevel, 'off'>;
  readonly label: string;
  readonly description: string;
  readonly stages: readonly ScienceStage[];
}

/** Convenções de formato, ditas uma vez e reaproveitadas por todo estágio. */
function regrasDeFormato(formato: ScienceFormat): string {
  if (formato === 'latex') {
    return [
      'Escreva em LaTeX, num documento `article` completo: preâmbulo, \\begin{document} e \\end{document}.',
      'Use \\section e \\subsection para a estrutura, o ambiente equation para fórmulas de bloco e $...$ para as de linha.',
      'Citações com \\cite e as referências num thebibliography no fim.',
      'Não use pacotes exóticos: o documento precisa compilar com article, amsmath e hyperref.',
      'Inclua \\usepackage[utf8]{inputenc} e escreva os acentos DIRETO em UTF-8 — "método", "identificação".',
      'Nunca use as formas antigas \\\'e, \\c{c} ou \\~ao: são legado de fonte não-UTF-8 e deixam o texto ilegível fora de um compilador.',
    ].join(' ');
  }
  return [
    'Escreva em Markdown.',
    'Use ## e ### para a estrutura, $...$ e $$...$$ para matemática (nunca crase para fórmula) e tabelas do GitHub quando couber.',
    'As referências vão numa seção final, com link quando existir.',
  ].join(' ');
}

/** Instrução comum a todos os que escrevem — o que separa texto acadêmico de resumo. */
const RIGOR = [
  'Você escreve para um estudante que vai usar este texto para estudar de verdade.',
  'Densidade acima de volume: nada de parágrafo de enrolação, frase de efeito ou repetição do enunciado.',
  '**Não invente fonte, número, data ou citação.** Quando não souber, escreva o que se sabe e diga explicitamente o que está em aberto — uma referência inventada destrói a utilidade do texto inteiro e é o pior erro possível aqui.',
  'Defina cada termo técnico na primeira vez que aparecer.',
].join(' ');

const PESQUISA: ScienceStage = {
  role: 'pesquisa',
  label: 'Levantamento e contexto detalhado',
  systemPrompt: (formato) => [
    '# Papel: levantamento e redação',
    '',
    RIGOR,
    '',
    'Sua tarefa é levantar o que se sabe sobre o tema e escrever um contexto DETALHADO sobre ele.',
    'Comece pelo mapa do assunto — definições, correntes, resultados centrais, controvérsias — e só então escreva.',
    'Detalhe: derive o que pode ser derivado, dê exemplos concretos, diga as condições em que cada resultado vale',
    'e explique o passo que um autor apressado pularia por achar óbvio.',
    'Cubra o tema inteiro, mesmo que de forma ainda desigual: quem vem depois aprofunda e revisa, mas não adivinha o que você deixou de fora.',
    'Estruture com seções nomeadas pelo conteúdo, nunca por função ("Seção 2", "Desenvolvimento").',
    '',
    '## Estrutura: poucos títulos, parágrafos de tamanho normal',
    '',
    'Duas coisas diferentes, e é fácil confundi-las: **menos TÍTULOS não é menos QUEBRAS DE PARÁGRAFO.**',
    'O texto tem poucas seções e, dentro de cada uma, vários parágrafos de tamanho comum.',
    '',
    'Sobre os títulos:',
    '- No máximo **dois níveis**. Nada de sub-subseção.',
    '- Cada seção tem **três parágrafos ou mais**. Se tem um só, ela não era uma seção: junte ao texto vizinho.',
    '- Só abra uma subseção quando o assunto realmente mudar; mudança de aspecto do MESMO assunto é parágrafo novo.',
    '- Um título a cada dois parágrafos transforma o documento numa lista de tópicos, e a conexão entre as ideias',
    '  — que é o que se estuda — desaparece nos espaços em branco entre os títulos.',
    '',
    'Sobre os parágrafos:',
    '- Cada parágrafo trata de **uma ideia**, em geral de quatro a oito frases.',
    '- Passou de umas dez linhas, quase certamente virou dois assuntos: quebre no ponto em que o segundo começa.',
    '- Bloco enorme e sem respiro é tão ruim de estudar quanto texto picado em títulos: no primeiro o leitor',
    '  se perde dentro do parágrafo, no segundo se perde entre eles.',
    '- Lista com marcadores é para enumeração real (condições, propriedades, passos), não para picar explicação.',
    '',
    // Sem figuras aqui: quem ilustra é o revisor, que vê o texto inteiro
    // pronto e sabe onde o desenho realmente falta. Pedir figura a quem ainda
    // está descobrindo o assunto produz desenho do que era fácil desenhar.
    'Não desenhe figuras: isso é trabalho da revisão.',
    '',
    regrasDeFormato(formato),
  ].join('\n'),
};

const APROFUNDAMENTO: ScienceStage = {
  role: 'aprofundamento',
  label: 'Aprofundamento',
  systemPrompt: (formato) => [
    '# Papel: aprofundamento',
    '',
    RIGOR,
    '',
    'Você recebe um texto já escrito. Sua tarefa NÃO é reescrevê-lo do zero nem resumi-lo:',
    'é aprofundar onde ele passou rápido demais.',
    '',
    'Procure especificamente: afirmação sem justificativa, conceito citado e não explicado,',
    'mecanismo descrito só pelo nome, número sem contexto, e o passo que o autor pulou por achar óbvio.',
    'Acrescente derivações, exemplos concretos, contraexemplos e as condições em que cada resultado vale.',
    '',
    'Devolva o texto INTEIRO, com os acréscimos integrados no lugar certo — não uma lista de sugestões.',
    'Preserve o que já estava bom: reescrever o que não precisava é perda.',
    '',
    regrasDeFormato(formato),
  ].join('\n'),
};

const SINTESE: ScienceStage = {
  role: 'sintese',
  label: 'Contexto e conexões',
  systemPrompt: (formato) => [
    '# Papel: contexto e conexões',
    '',
    RIGOR,
    '',
    'Você recebe um texto já aprofundado. Sua tarefa é dar a ele o que ainda falta para ser um material de estudo:',
    'a moldura em volta do conteúdo.',
    '',
    'Acrescente: como o tema se conecta a áreas vizinhas, qual a história do problema,',
    'que aplicações práticas existem, e o que continua em aberto na literatura.',
    'Se houver um ponto onde o texto é vago porque a questão é genuinamente disputada, diga isso explicitamente —',
    'esconder controvérsia atrás de uma frase neutra é pior do que não tratar do assunto.',
    '',
    'Devolva o texto INTEIRO, com os acréscimos no lugar certo.',
    '',
    regrasDeFormato(formato),
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
function mecanismoDeFigura(formato: ScienceFormat): string {
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
function entregaComoArtefato(formato: ScienceFormat): string {
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
    'Fora do artefato, escreva no máximo duas frases dizendo o que o documento cobre.',
    'Não repita o conteúdo fora dele, e não parta o documento em vários artefatos: é um só.',
  ].join('\n');
}

const REVISAO: ScienceStage = {
  role: 'revisao',
  label: 'Revisão, coesão e ilustrações',
  systemPrompt: (formato) => [
    '# Papel: revisão final',
    '',
    'Você recebe um texto escrito por várias mãos e o entrega como um documento único.',
    'É o seu texto que o estudante vai ler.',
    '',
    'Corrija, nesta ordem de prioridade:',
    '1. **Contradição entre trechos.** Passagens escritas em momentos diferentes podem afirmar coisas incompatíveis; resolva, não some as duas.',
    '2. **Repetição.** O mesmo conceito explicado duas vezes com palavras diferentes — mantenha a melhor explicação, no lugar mais cedo em que faça sentido.',
    '3. **Ritmo do texto.** Nos dois sentidos: seção com um ou dois parágrafos e sub-subseções viram texto',
    '   corrido, com a passagem resolvida por uma transição (no máximo dois níveis de título no documento);',
    '   e parágrafo que passa de umas dez linhas é quebrado no ponto onde o segundo assunto começa.',
    '4. **Costura.** Transições entre seções, referência para trás e para frente, termo usado antes de ser definido.',
    '5. **Voz única.** Um texto por várias mãos oscila de registro; unifique.',
    '6. Gramática, pontuação e concordância.',
    '',
    '**Não acrescente conteúdo escrito novo e não corte conteúdo correto.** Seu trabalho é sobre a forma;',
    'as exceções são duas: remover repetição, que é forma disfarçada de conteúdo, e acrescentar as figuras abaixo.',
    '',
    '## Figuras',
    '',
    'Você também ilustra. É seu o trabalho porque você é quem lê o texto inteiro pronto:',
    'quem ainda está descobrindo o assunto desenha o que era fácil desenhar, não o que faltava explicar.',
    '',
    'Inclua de duas a cinco figuras, e SOMENTE onde o desenho explica melhor que o parágrafo.',
    'Figura que repete o texto é ruído. Mencione cada figura no ponto certo do texto.',
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

/**
 * As três cadeias.
 *
 * O revisor é sempre o último e sempre existe: sem ele, o que sai é a soma de
 * passagens, não um documento. Os níveis diferem em quantas mãos escrevem
 * antes dele.
 */
/**
 * A cadeia.
 *
 * Havia três níveis (2, 3 e 5 agentes). Os de 3 e 5 foram retirados depois de
 * rodarem: cada agente devolve o documento INTEIRO reescrito, então as
 * passagens extras custavam o dobro e o triplo em tempo e tokens, e o texto
 * que saía não era melhor — em parte porque cada reescrita também é uma
 * chance de o modelo perder o que já estava bom. Dois agentes com papéis
 * bem separados — quem escreve e quem revisa — é o que se sustentou.
 */
export const SCIENCE_CHAINS: Readonly<Record<'basic', ScienceChain>> = {
  basic: {
    level: 'basic',
    label: 'Ligado',
    description: '2 agentes: um levanta e detalha o assunto, outro revisa a coesão e ilustra.',
    stages: [PESQUISA, REVISAO],
  },
};

/**
 * Qualquer nível ligado usa a cadeia única.
 *
 * Os valores `intermediate` e `advanced` continuam no schema porque estão
 * gravados em conversas antigas; mapeá-los para a cadeia de dois é melhor do
 * que quebrar o histórico de quem os usou.
 */
export function scienceChain(level: ScienceLevel): ScienceChain | null {
  return level === 'off' ? null : SCIENCE_CHAINS.basic;
}

/**
 * Mensagem que entrega o texto anterior ao próximo agente.
 *
 * Entra como `user` porque é o único papel que todo endpoint compatível aceita
 * no meio da conversa — a mesma razão documentada no laço de busca.
 */
export function handoffMessage(role: ScienceRole, texto: string): string {
  const cabecalho = role === 'revisao'
    ? 'Texto a revisar (entregue apenas o documento final):'
    : 'Texto produzido até aqui (devolva-o inteiro, com os seus acréscimos):';
  return `${cabecalho}\n\n<<<TEXTO>>>\n${texto}\n<<<FIM DO TEXTO>>>`;
}
