import type { ApiError, ErrorCode } from '../shared/types';

const ACTIONABLE_MESSAGES: Record<ErrorCode, string> = {
  RATE_LIMIT: 'O provedor limitou esta requisição. Aguarde alguns segundos e tente novamente.',
  INSUFFICIENT_BALANCE:
    'O saldo ou limite da chave do provedor é insuficiente. Verifique a cobrança e os limites da conta.',
  CONTEXT_LENGTH_EXCEEDED:
    'O histórico excede a janela de contexto deste modelo. Inicie uma nova conversa ou reduza o contexto.',
  INVALID_API_KEY:
    'A chave de API não foi aceita. Configure a chave correta no servidor e tente novamente.',
  MODEL_NOT_FOUND:
    'O modelo selecionado não foi encontrado pelo provedor. Atualize o modelo configurado e tente novamente.',
  UPSTREAM_TIMEOUT:
    'O provedor demorou demais para responder. Tente novamente ou escolha outro provedor.',
  UNAUTHORIZED:
    'Sua sessão expirou ou o token é inválido. Faça login novamente.',
  UNKNOWN:
    'O provedor retornou um erro inesperado. Confira a configuração e tente novamente.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly providerStatus?: number;

  constructor(
    code: ErrorCode,
    options: { status?: number; retryable?: boolean; providerStatus?: number; message?: string } = {},
  ) {
    super(options.message ?? ACTIONABLE_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.retryable = options.retryable ?? (code === 'RATE_LIMIT' || code === 'UPSTREAM_TIMEOUT');
    this.providerStatus = options.providerStatus;
  }
}

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.body = body;
  }
}

export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case 'RATE_LIMIT':
      return 429;
    case 'INVALID_API_KEY':
      return 401;
    case 'UNAUTHORIZED':
      return 401;
    case 'MODEL_NOT_FOUND':
      return 404;
    case 'CONTEXT_LENGTH_EXCEEDED':
      return 400;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    case 'INSUFFICIENT_BALANCE':
      return 402;
    default:
      return 502;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError' ||
    error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'))
  );
}

function bodyText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    return JSON.stringify(parsed).toLowerCase();
  } catch {
    return body.toLowerCase();
  }
}

export function codeForUpstreamStatus(status: number, body = ''): ErrorCode {
  const text = bodyText(body);
  if (status === 402 || /insufficient|balance|credit|quota|billing|saldo|cr[eé]dito/.test(text)) {
    return 'INSUFFICIENT_BALANCE';
  }
  if (status === 401 || status === 403 || /invalid.*(api)?[_ -]?key|unauthorized|authentication/.test(text)) {
    return 'INVALID_API_KEY';
  }
  if (status === 404 || /model.*(not found|不存在|unknown)|model_not_found/.test(text)) {
    return 'MODEL_NOT_FOUND';
  }
  if (status === 400 || status === 422 || /context.{0,20}(length|window)|too many tokens|maximum context/.test(text)) {
    return 'CONTEXT_LENGTH_EXCEEDED';
  }
  if (status === 429) return 'RATE_LIMIT';
  return 'UNKNOWN';
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof UpstreamHttpError) {
    const code = codeForUpstreamStatus(error.status, error.body);
    return new AppError(code, {
      providerStatus: error.status,
      retryable: error.status === 429 || error.status >= 500,
    });
  }
  if (isAbortError(error)) {
    return new AppError('UPSTREAM_TIMEOUT');
  }
  return new AppError('UNKNOWN');
}

export function errorPayload(error: unknown): ApiError {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
}
