import { describe, expect, it } from 'vitest';
import { applyEdits } from './patch';

describe('artifact patches', () => {
  it('applies one or more exact edits in sequence', () => {
    expect(applyEdits('timeout = 30;\nretries = 2;', [
      { find: 'timeout = 30;', replace: 'timeout = 60;' },
      { find: 'retries = 2;', replace: 'retries = 3;' },
    ])).toEqual({ ok: true, content: 'timeout = 60;\nretries = 3;' });
  });

  it('rejects missing and ambiguous matches', () => {
    expect(applyEdits('a', [{ find: 'b', replace: 'c' }])).toEqual({ ok: false, reason: 'not_found', find: 'b' });
    expect(applyEdits('a a', [{ find: 'a', replace: 'b' }])).toEqual({ ok: false, reason: 'ambiguous', find: 'a' });
  });
});

