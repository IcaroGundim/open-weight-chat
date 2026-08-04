import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../shared/types';
import { buildArtifactContext } from './context';

function artifact(slug: string, content: string, updatedAt: number): Artifact {
  return {
    id: slug,
    conversationId: 'conversation',
    slug,
    kind: 'code',
    language: 'ts',
    title: slug,
    currentVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    versions: [{ version: 1, content, operation: 'create', messageId: null, outputTokens: null, costUsd: null, truncated: false, createdAt: updatedAt }],
  };
}

describe('artifact context budget', () => {
  it('orders newest artifacts first and emits omitted metadata inside the 25% budget', () => {
    const result = buildArtifactContext([
      artifact('old', 'x'.repeat(400), 1),
      artifact('new', 'y'.repeat(20), 2),
    ], 400);
    expect(result.message?.content).toContain('new');
    expect(result.message?.content).toContain('omitted="true"');
    expect(result.estimatedTokens).toBeLessThanOrEqual(104);
  });

  it('does not persist a body-shaped message; it returns a transient user context message', () => {
    const result = buildArtifactContext([artifact('demo', 'const answer = 42;', 1)], 1_000);
    expect(result.message?.role).toBe('user');
    expect(result.message?.content).toContain('<artifact id="demo"');
  });
});

