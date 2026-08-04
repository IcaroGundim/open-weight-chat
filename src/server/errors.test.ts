import { describe, expect, it } from 'vitest';
import { AppError, UpstreamHttpError, normalizeError } from './errors';

describe('upstream errors', () => {
  it('maps actionable provider failures to pt-BR errors', () => {
    const error = normalizeError(new UpstreamHttpError(429, '{"error":"rate limit"}'));
    expect(error.code).toBe('RATE_LIMIT');
    expect(error.status).toBe(429);
    expect(error.message).toContain('Aguarde');
  });

  it('keeps explicit application errors intact', () => {
    const error = new AppError('MODEL_NOT_FOUND', { status: 404 });
    expect(normalizeError(error)).toBe(error);
  });
});

