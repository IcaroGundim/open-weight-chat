import { afterEach, describe, expect, it } from 'vitest';
import handler from '../../api/[...route]';
import { createApp } from './index';

const originalDbPath = process.env.CHAT_DB_PATH;

afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.DATABASE_URL;
  if (originalDbPath === undefined) delete process.env.CHAT_DB_PATH;
  else process.env.CHAT_DB_PATH = originalDbPath;
});

describe('entrada da função na Vercel', () => {
  it('exporta uma função, não um objeto com fetch', () => {
    // A versão anterior exportava `{ fetch }` — convenção de Workers/Bun/Deno.
    // A Vercel não a reconhece e devolvia FUNCTION_INVOCATION_FAILED em toda
    // requisição a /api/*, antes de qualquer roteamento.
    expect(typeof handler).toBe('function');
    expect((handler as { fetch?: unknown }).fetch).toBeUndefined();
  });

  it('explica a falta de DATABASE_URL em vez de estourar na importação', () => {
    process.env.VERCEL = '1';
    // Sem banco remoto, cair no SQLite significaria escrever num disco somente
    // leitura e perder tudo a cada cold start.
    expect(() => createApp()).toThrowError(/DATABASE_URL/);
  });

  it('não interfere no modo local, onde o SQLite é legítimo', () => {
    // Em memória: o teste não pode tocar no chat.db de verdade.
    process.env.CHAT_DB_PATH = ':memory:';
    expect(() => createApp()).not.toThrowError(/DATABASE_URL/);
  });
});
