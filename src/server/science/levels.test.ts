import { describe, expect, it } from 'vitest';
import { resolveSkillChain } from '../skills';
import { scienceSkill } from './levels';

const selection = (format: 'markdown' | 'latex' = 'markdown') => ({ id: 'science' as const, settings: { format } });
const stages = (format: 'markdown' | 'latex' = 'markdown') => scienceSkill.resolve(selection(format)).stages;

describe('skill Science', () => {
  it('registra planejamento antes da redação final', () => {
    const chain = resolveSkillChain([selection()]);
    expect(chain?.stages).toHaveLength(2);
    expect(chain?.stages[0]).toMatchObject({ skillId: 'science', stageId: 'planejamento' });
    expect(chain?.stages[1]).toMatchObject({ skillId: 'science', stageId: 'redacao' });
  });

  it('a cadeia vazia mantém a resposta normal', () => {
    expect(resolveSkillChain([])).toBeNull();
  });

  it('expõe configuração de artefato no contrato genérico da skill', () => {
    expect(resolveSkillChain([selection('markdown')])?.output.artifact).toMatchObject({ kind: 'markdown', language: null, minChars: 1200 });
    expect(resolveSkillChain([selection('latex')])?.output.artifact).toMatchObject({ kind: 'code', language: 'latex' });
  });
});

describe('mecanismo de figura por formato', () => {
  it('em LaTeX manda desenhar em TikZ, que é o mecanismo nativo', () => {
    const prompt = stages('latex')[1].systemPrompt();
    expect(prompt).toContain('tikzpicture');
    expect(prompt).toContain('\\caption');
    expect(prompt).not.toContain('mermaid');
  });

  it('em Markdown manda a cerca mermaid, que o app renderiza como figura', () => {
    const prompt = stages()[1].systemPrompt();
    expect(prompt).toContain('mermaid');
    expect(prompt).not.toContain('tikzpicture');
    expect(prompt).toContain('sem HTML cru');
  });

  it('a etapa de redação recebe as regras do formato escolhido', () => {
    expect(stages('latex')[1].systemPrompt()).toMatch(/LaTeX|TikZ/u);
    expect(stages('markdown')[1].systemPrompt()).toMatch(/Markdown|Mermaid/u);
    expect(stages('latex')[1].systemPrompt()).toContain('geometry');
    expect(stages('latex')[1].systemPrompt()).toContain('maketitle');
  });
});

describe('divisão de trabalho', () => {
  const [planejador, redator] = stages();

  it('o primeiro agente entrega um plano, não o documento', () => {
    const prompt = planejador.systemPrompt();
    expect(prompt).toContain('Não escreva o documento final');
    expect(prompt).toContain('Tópicos a aprofundar');
    expect(prompt).toContain('Diretrizes de escrita');
    expect(prompt).toContain('Oportunidades de ilustração');
    expect(prompt).toContain('Apresentação visual');
    expect(prompt).not.toContain('mermaid');
  });

  it('o segundo agente escreve, revisa e constrói as figuras', () => {
    const prompt = redator.systemPrompt();
    expect(prompt).toContain('escrever o documento final completo');
    expect(prompt).toContain('revisão textual');
    expect(prompt).toContain('mermaid');
    expect(prompt).toContain('constrói as ilustrações/gravuras');
    expect(prompt).toContain('A entrega é inválida sem figuras');
    expect(prompt).toContain('no mínimo quatro');
  });

  it('passa o plano ao estágio de autoria sem acoplar o chat ao Science', () => {
    const paraRedator = redator.handoffMessage('plano');
    expect(paraRedator).toContain('Plano de desenvolvimento');
    expect(paraRedator).toContain('revisar');
    expect(paraRedator).toContain('<<<TEXTO>>>');
  });
});

describe('estrutura e entrega', () => {
  const [, redator] = stages();

  it('instrui a redação a ter títulos e parágrafos legíveis', () => {
    const prompt = redator.systemPrompt();
    expect(prompt).toContain('no máximo dois');
    expect(prompt).toContain('quatro a oito frases');
    expect(prompt).toContain('título de nível 1');
    expect(prompt).toContain('Cada figura precisa de legenda');
  });

  it('pede ao redator para evitar duplicar o documento fora do artefato', () => {
    const prompt = redator.systemPrompt();
    expect(prompt).toContain('escrever o documento duas vezes');
    expect(prompt).toContain('pare de escrever');
  });
});
