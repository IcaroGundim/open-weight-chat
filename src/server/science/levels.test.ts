import { describe, expect, it } from 'vitest';
import { SCIENCE_CHAINS, handoffMessage, scienceChain } from './levels';

describe('a cadeia', () => {
  it('tem dois agentes: quem escreve e quem revisa', () => {
    // Os níveis de 3 e 5 foram retirados: cada agente reescreve o documento
    // inteiro, então as passagens extras custavam o dobro e o triplo sem
    // melhorar o texto.
    expect(SCIENCE_CHAINS.basic.stages).toHaveLength(2);
    expect(SCIENCE_CHAINS.basic.stages[0].role).toBe('pesquisa');
    expect(SCIENCE_CHAINS.basic.stages[1].role).toBe('revisao');
  });

  it('níveis antigos gravados em conversas continuam funcionando', () => {
    // Quebrar o histórico de quem usou o nível avançado seria pior do que
    // atendê-lo com a cadeia que sobrou.
    expect(scienceChain('intermediate')?.stages).toHaveLength(2);
    expect(scienceChain('advanced')?.stages).toHaveLength(2);
    expect(scienceChain('off')).toBeNull();
  });
});

describe('mecanismo de figura por formato', () => {
  // Quem ilustra é o REVISOR: ele é quem lê o texto inteiro pronto e sabe
  // onde o desenho falta. O redator desenharia o que era fácil desenhar.
  const ilustrador = SCIENCE_CHAINS.basic.stages[1];

  it('em LaTeX manda desenhar em TikZ, que é o mecanismo nativo', () => {
    const prompt = ilustrador.systemPrompt('latex');
    expect(prompt).toContain('tikzpicture');
    expect(prompt).toContain('\\caption');
    // Mermaid não existe em LaTeX: pedir isso produziria um bloco de texto.
    expect(prompt).not.toContain('mermaid');
  });

  it('em Markdown manda a cerca mermaid, que o app renderiza como figura', () => {
    const prompt = ilustrador.systemPrompt('markdown');
    expect(prompt).toContain('mermaid');
    expect(prompt).not.toContain('tikzpicture');
    // SVG cru apareceria como marcação: o Markdown daqui não aceita HTML.
    expect(prompt).toContain('sem HTML cru');
  });

  it('todo estágio que escreve recebe as regras do formato escolhido', () => {
    for (const cadeia of Object.values(SCIENCE_CHAINS)) {
      for (const estagio of cadeia.stages) {
        expect(estagio.systemPrompt('latex'), estagio.role).toMatch(/LaTeX|TikZ/u);
        expect(estagio.systemPrompt('markdown'), estagio.role).toMatch(/Markdown|Mermaid/u);
      }
    }
  });

  it('a instrução contra inventar fonte está em quem escreve', () => {
    // Num material de estudo, referência fabricada destrói o texto inteiro.
    for (const estagio of SCIENCE_CHAINS.basic.stages) {
      if (estagio.role === 'revisao') continue;
      expect(estagio.systemPrompt('markdown'), estagio.role).toContain('Não invente');
    }
  });
});

describe('divisão de trabalho', () => {
  const [redator, revisor] = SCIENCE_CHAINS.basic.stages;

  it('o redator escreve e é proibido de ilustrar', () => {
    const prompt = redator.systemPrompt('markdown');
    expect(prompt).toContain('contexto DETALHADO');
    expect(prompt).toContain('Não desenhe figuras');
    expect(prompt).not.toContain('mermaid');
  });

  it('o revisor cuida da forma E das figuras', () => {
    const prompt = revisor.systemPrompt('markdown');
    expect(prompt).toContain('Contradição entre trechos');
    expect(prompt).toContain('mermaid');
    // A proibição de conteúdo novo não pode contradizer o pedido de figura.
    expect(prompt).toContain('acrescentar as figuras');
  });

  it('em LaTeX é o revisor que recebe o TikZ', () => {
    expect(revisor.systemPrompt('latex')).toContain('tikzpicture');
    expect(redator.systemPrompt('latex')).not.toContain('tikzpicture');
  });
});

describe('passagem de bastão', () => {
  it('cerca o texto e diz ao próximo o que fazer com ele', () => {
    const paraRevisor = handoffMessage('revisao', 'texto');
    expect(paraRevisor).toContain('revisar');
    expect(paraRevisor).toContain('<<<TEXTO>>>');
    const paraAutor = handoffMessage('aprofundamento', 'texto');
    expect(paraAutor).toContain('devolva-o inteiro');
  });
});

describe('estrutura do texto', () => {
  const [redator, revisor] = SCIENCE_CHAINS.basic.stages;

  it('o redator é instruído a usar poucos títulos', () => {
    // Um título a cada dois parágrafos vira lista de tópicos, e a conexão
    // entre as ideias — que é o que se estuda — some entre os títulos.
    const prompt = redator.systemPrompt('markdown');
    expect(prompt).toContain('dois níveis');
    expect(prompt).toContain('três parágrafos ou mais');
  });

  it('poucos títulos não pode virar parágrafo gigante', () => {
    // A primeira versão desta instrução dizia "parágrafos longos" e mandava
    // escrever em prosa contínua; o modelo obedeceu e entregou blocos sem
    // respiro. São duas coisas diferentes, e o prompt precisa dizer isso.
    const prompt = redator.systemPrompt('markdown');
    expect(prompt).toContain('menos TÍTULOS não é menos QUEBRAS DE PARÁGRAFO');
    expect(prompt).toContain('quatro a oito frases');
    expect(prompt).not.toContain('parágrafos longos');
  });

  it('o revisor junta o que ficou fragmentado', () => {
    // É ele quem conserta forma; deixar a regra só no redator dependeria de o
    // primeiro agente acertar de primeira.
    expect(revisor.systemPrompt('markdown')).toContain('Ritmo do texto');
  });

  it('a regra vale nos dois formatos', () => {
    for (const formato of ['markdown', 'latex'] as const) {
      expect(redator.systemPrompt(formato)).toContain('sub-subseção');
    }
  });
});
