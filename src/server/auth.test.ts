import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AppError } from './errors';
import { createAuthMiddleware, type AppVariables } from './auth';

/** Monta um mini-app com o middleware e um handler que registraria acesso a banco. */
function buildApp(verifyToken?: (token: string) => Promise<string | null>) {
  const app = new Hono<{ Variables: AppVariables }>();
  const dbCalls: string[] = [];
  app.use('*', createAuthMiddleware({ verifyToken }));
  app.get('/protegido', (c) => {
    dbCalls.push('SELECT 1');
    return c.json({ ok: true, userId: c.get('userId') });
  });
  return { app, dbCalls };
}

async function body(res: Response): Promise<{ error?: { code?: string; message?: string; retryable?: boolean } }> {
  return (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
}

describe('createAuthMiddleware', () => {
  it('rejeita 401 sem header Authorization, sem tocar no banco', async () => {
    const { app, dbCalls } = buildApp();
    const res = await app.request('/protegido');

    expect(res.status).toBe(401);
    const json = await body(res);
    expect(json.error?.code).toBe('UNAUTHORIZED');
    expect(json.error?.retryable).toBe(false);
    expect(json.error?.message).toContain('Authorization');
    expect(dbCalls).toHaveLength(0);
  });

  it('rejeita 401 com header sem o prefixo Bearer', async () => {
    const { app, dbCalls } = buildApp();
    const res = await app.request('/protegido', { headers: { Authorization: 'Token abc123' } });

    expect(res.status).toBe(401);
    const json = await body(res);
    expect(json.error?.code).toBe('UNAUTHORIZED');
    expect(dbCalls).toHaveLength(0);
  });

  it('rejeita 401 com Bearer vazio', async () => {
    const { app, dbCalls } = buildApp();
    const res = await app.request('/protegido', { headers: { Authorization: 'Bearer   ' } });

    expect(res.status).toBe(401);
    const json = await body(res);
    expect(json.error?.code).toBe('UNAUTHORIZED');
    expect(dbCalls).toHaveLength(0);
  });

  it('rejeita 401 quando o token é inválido (verifyToken retorna null)', async () => {
    const verifyToken = async () => null;
    const { app, dbCalls } = buildApp(verifyToken);
    const res = await app.request('/protegido', { headers: { Authorization: 'Bearer token-invalido' } });

    expect(res.status).toBe(401);
    const json = await body(res);
    expect(json.error?.code).toBe('UNAUTHORIZED');
    expect(dbCalls).toHaveLength(0);
  });

  it('aceita token válido, expõe o userId e segue para o handler', async () => {
    const verifyToken = async (token: string) => {
      expect(token).toBe('token-valido');
      return 'user_abc123';
    };
    const { app, dbCalls } = buildApp(verifyToken);
    const res = await app.request('/protegido', { headers: { Authorization: 'Bearer token-valido' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; userId: string };
    expect(json.ok).toBe(true);
    expect(json.userId).toBe('user_abc123');
    expect(dbCalls).toEqual(['SELECT 1']);
  });

  it('propaga AppError do verificador (ex.: 500 de configuração)', async () => {
    const verifyToken = async () => {
      throw new AppError('UNKNOWN', {
        status: 500,
        message: 'Configure CLERK_SECRET_KEY no servidor para habilitar a autenticação.',
      });
    };
    const { app, dbCalls } = buildApp(verifyToken);
    const res = await app.request('/protegido', { headers: { Authorization: 'Bearer token-qualquer' } });

    expect(res.status).toBe(500);
    const json = await body(res);
    expect(json.error?.code).toBe('UNKNOWN');
    expect(json.error?.message).toContain('CLERK_SECRET_KEY');
    expect(dbCalls).toHaveLength(0);
  });

  it('sem CLERK_SECRET_KEY e sem verifyToken injetado, responde 500 com mensagem de configuração', async () => {
    const previous = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      const { app, dbCalls } = buildApp();
      const res = await app.request('/protegido', { headers: { Authorization: 'Bearer token-qualquer' } });

      expect(res.status).toBe(500);
      const json = await body(res);
      expect(json.error?.code).toBe('UNKNOWN');
      expect(json.error?.message).toContain('CLERK_SECRET_KEY');
      expect(dbCalls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = previous;
    }
  });
});
