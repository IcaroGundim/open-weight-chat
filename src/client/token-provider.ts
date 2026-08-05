/**
 * Provedor de token injetável para o cliente HTTP.
 *
 * O módulo `api.ts` não conhece o Clerk nem o React: ele pergunta o token de
 * sessão aqui. O componente <AuthenticatedApp /> (em auth.ts) registra o
 * provider real, que resolve o JWT via `useAuth().getToken()`. Testes podem
 * registrar um provider fake sem tocar no React.
 *
 * `ApiError` vive aqui (e é reexportado por api.ts) para que este módulo possa
 * lançar erros de autenticação sem criar um ciclo de importação com api.ts.
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: string;

  constructor(message: string, status = 0, code?: string, details?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type TokenProvider = () => Promise<string | null>;
export type UserIdProvider = () => string | null;

let tokenProvider: TokenProvider | null = null;
let userIdProvider: UserIdProvider | null = null;

/** Registra (ou remove, com `null`) a função que resolve o JWT da sessão. */
export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

/** Registra (ou remove, com `null`) a função que resolve o id do usuário. */
export function setUserIdProvider(provider: UserIdProvider | null): void {
  userIdProvider = provider;
}

/**
 * Token JWT da sessão atual, ou `null` quando deslogado ou ainda carregando.
 * Sem provider registrado (ex.: app sem Clerk), retorna `null`.
 */
export async function getToken(): Promise<string | null> {
  if (!tokenProvider) return null;
  try {
    return (await tokenProvider()) ?? null;
  } catch {
    // Sessão expirada ou provider indisponível: trata como deslogado.
    return null;
  }
}

/**
 * Id do usuário atual, ou `null` quando deslogado. Usado para particionar
 * preferências no localStorage por usuário.
 */
export function getUserId(): string | null {
  return userIdProvider ? userIdProvider() : null;
}

/** True quando há um usuário logado (síncrono, via id do usuário). */
export function isAuthenticated(): boolean {
  return getUserId() !== null;
}

/**
 * Headers de autorização para uma chamada /api/*.
 * Lança ApiError 401 quando não há token — o app deve redirecionar para a
 * tela de login (o que o <SignedOut /> já faz ao desmontar o chat).
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new ApiError('Sessão expirada. Faça login novamente.', 401, 'UNAUTHENTICATED');
  }
  return { Authorization: `Bearer ${token}` };
}
