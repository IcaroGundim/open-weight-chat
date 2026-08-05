import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import handler from './vercel-handler';
import { createApp } from './index';

const serverDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('entrada da função na Vercel', () => {
  it('exporta uma função, não um objeto com fetch', () => {
    // A versão anterior exportava `{ fetch }` — convenção de Workers/Bun/Deno.
    // A Vercel não a reconhece e devolvia FUNCTION_INVOCATION_FAILED em toda
    // requisição a /api/*, antes de qualquer roteamento.
    expect(typeof handler).toBe('function');
    expect((handler as { fetch?: unknown }).fetch).toBeUndefined();
  });

  it('não arrasta node:sqlite para o grafo de módulos da função', () => {
    // `node:sqlite` exige Node >= 22.5 e, antes do 23.4, a flag
    // --experimental-sqlite. Um import de valor em index.ts fazia a função
    // falhar no carregamento, antes de qualquer código nosso rodar. O SQLite
    // pertence a main.ts, que é a entrada local.
    const source = readFileSync(join(serverDir, 'index.ts'), 'utf8');
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+'\.\/db\/queries'/mu;
    expect(source).not.toMatch(valueImport);
    expect(readFileSync(join(serverDir, 'main.ts'), 'utf8')).toMatch(/from '\.\/db\/queries'/u);
  });

  it('explica a falta de DATABASE_URL em vez de cair no SQLite', () => {
    // Em serverless o disco é somente leitura e /tmp não persiste: cair no
    // SQLite perderia o histórico a cada cold start.
    expect(() => createApp()).toThrowError(/DATABASE_URL/);
  });
});
