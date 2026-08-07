import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { composeSystemPrompt, FORMATTING_SYSTEM_PROMPT } from './system-prompt';

describe('prompt de sistema', () => {
  it('sempre ensina a notação de fórmula, mesmo sem capacidades extras', () => {
    // Sem esta regra o modelo envolve fórmula em crase e usa expoente Unicode
    // (`e⁻ˣ`), que a interface exibe como caixa de código.
    const prompt = composeSystemPrompt(null);
    expect(prompt).toContain('Nunca use crase para fórmula');
    expect(prompt).toContain('$$');
    expect(prompt).toContain('type="spreadsheet"');
    expect(prompt).toContain('Não entregue Python, openpyxl');
  });

  it('mantém a ordem: protocolo do produto, capacidades, instruções da conversa', () => {
    const prompt = composeSystemPrompt('Responda em tom formal.', ['## Busca na web']);
    expect(prompt.indexOf('artifact')).toBeLessThan(prompt.indexOf('## Fórmulas'));
    expect(prompt.indexOf('## Fórmulas')).toBeLessThan(prompt.indexOf('## Busca na web'));
    // As instruções do usuário ficam por último: são as que devem prevalecer.
    expect(prompt.indexOf('## Busca na web')).toBeLessThan(prompt.indexOf('tom formal'));
  });

  it('os exemplos que o prompt manda seguir realmente renderizam', () => {
    // Um exemplo com erro de LaTeX ensinaria o modelo a errar junto.
    const exemplos = [...FORMATTING_SYSTEM_PROMPT.matchAll(/\$\$?([^$]+)\$\$?/gu)]
      .map((encontrado) => encontrado[1].trim())
      .filter((expressao) => expressao.includes('\\'));
    expect(exemplos.length).toBeGreaterThan(0);
    for (const expressao of exemplos) {
      expect(() => katex.renderToString(expressao, { throwOnError: true, strict: 'ignore' })).not.toThrow();
    }
  });
});
