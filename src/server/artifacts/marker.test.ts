import { describe, expect, it } from 'vitest';
import { artifactMarker, parseArtifactMarker } from './marker';

describe('versioned artifact markers', () => {
  it('distinguishes versions and rejects prose that merely resembles a marker', () => {
    expect(artifactMarker('cliente-sse', 2)).toBe('[[artefato:cliente-sse@2]]');
    expect(parseArtifactMarker('[[artefato:cliente-sse@1]]')).toEqual({ slug: 'cliente-sse', version: 1 });
    expect(parseArtifactMarker('texto [[artefato:cliente-sse@1]] texto')).toBeNull();
    expect(parseArtifactMarker('[[artefato:Cliente@1]]')).toBeNull();
  });
});

