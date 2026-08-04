import { describe, expect, it } from 'vitest';
import { estimateTokens, trimContext } from './context';

describe('context trimming', () => {
  it('keeps the system prompt and newest message while trimming old turns', () => {
    const result = trimContext(
      [
        { role: 'system', content: 'Você é útil.' },
        { role: 'user', content: 'a'.repeat(120) },
        { role: 'assistant', content: 'b'.repeat(120) },
        { role: 'user', content: 'c'.repeat(120) },
      ],
      100,
    );
    expect(result.truncated).toBe(true);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages.at(-1)?.content).toBe('c'.repeat(120));
  });

  it('uses the documented conservative approximation', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

