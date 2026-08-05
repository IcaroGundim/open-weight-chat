import { verifyToken as verifyClerkToken } from '@clerk/backend';
import type { MiddlewareHandler } from 'hono';
import { AppError, errorPayload } from './errors';

/**
 * Variáveis de contexto Hono disponíveis após o middleware de autenticação.
 *
 * Para consumir com type-safety na Onda 4, declare o app como
 * `new Hono<{ Variables: AppVariables }>()` e leia com `c.get('userId')`.
 * Sem o generic, use `c.get('userId' as never)`.
 */
export type AppVariables = {
  userId: string;
};

export interface AuthMiddlewareOptions {
  /**
   * Função de verificação de token injetável (usada nos testes).
   * Recebe o token bruto e devolve o userId (claim `sub`) ou `null` se inválido.
   * Quando ausente, o middleware usa o Clerk (`verifyToken` de @clerk/backend).
   */
  verifyToken?: (token: string) => Promise<string | null>;
  /**
   * Tolerância de dessincronização de relógio na verificação do JWT, em
   * milissegundos. Repassada ao Clerk como `clockSkewInMs`. Padrão: 5s.
   */
  clockSkewMs?: number;
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/iu;

function unauthorized(message: string): AppError {
  return new AppError('UNAUTHORIZED', { status: 401, message });
}

/**
 * Verificador padrão: delega ao Clerk. A leitura de CLERK_SECRET_KEY acontece
 * em runtime (a cada chamada) e não na criação do middleware, para que testes
 * possam controlar a variável de ambiente sem depender do momento da factory.
 */
function defaultVerifyToken(clockSkewMs: number): (token: string) => Promise<string | null> {
  return async (token) => {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new AppError('UNKNOWN', {
        status: 500,
        message: 'Configure CLERK_SECRET_KEY no servidor para habilitar a autenticação.',
      });
    }
    try {
      const payload = await verifyClerkToken(token, { secretKey, clockSkewInMs: clockSkewMs });
      return payload?.sub ?? null;
    } catch {
      // Token inválido/expirado ou falha ao obter as chaves de assinatura (JWKS).
      return null;
    }
  };
}

/**
 * Cria o middleware de autenticação do Hono.
 *
 * - Lê o header `Authorization` no formato `Bearer <token>`.
 * - Sem header ou com formato inválido → 401 `{ error: { code: 'UNAUTHORIZED', ... } }`.
 * - Token válido → `c.set('userId', ...)` e segue para o handler.
 * - Token inválido → 401, sempre ANTES de qualquer acesso a banco.
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler<{ Variables: AppVariables }> {
  const clockSkewMs = options.clockSkewMs ?? 5_000;
  const verifyToken = options.verifyToken ?? defaultVerifyToken(clockSkewMs);

  return async (c, next) => {
    const header = c.req.header('Authorization');

    if (!header) {
      return c.json(
        { error: errorPayload(unauthorized('Autenticação necessária: envie o token de sessão no header Authorization.')) },
        401,
      );
    }

    const match = BEARER_PATTERN.exec(header);
    if (!match || !match[1].trim()) {
      return c.json(
        { error: errorPayload(unauthorized('Header Authorization inválido: use o formato "Bearer <token>".')) },
        401,
      );
    }

    let userId: string | null;
    try {
      userId = await verifyToken(match[1].trim());
    } catch (error) {
      if (error instanceof AppError) {
        // Ex.: CLERK_SECRET_KEY ausente → 500 com a mensagem de configuração.
        return c.json({ error: errorPayload(error) }, error.status as 401 | 500);
      }
      // Erro inesperado do verificador: falha fechada (fail-closed).
      return c.json(
        { error: errorPayload(unauthorized('Não foi possível verificar o token de sessão.')) },
        401,
      );
    }

    if (!userId) {
      return c.json({ error: errorPayload(new AppError('UNAUTHORIZED', { status: 401 })) }, 401);
    }

    c.set('userId', userId);
    await next();
  };
}
