import { describe, expect, it } from 'vitest';
import { createArtifactParser, type ParserEvent } from './parser';

function parseInChunks(input: string, chunkSize = input.length): ParserEvent[] {
  const parser = createArtifactParser();
  const events: ParserEvent[] = [];
  for (let index = 0; index < input.length; index += chunkSize) events.push(...parser.push(input.slice(index, index + chunkSize)));
  events.push(...parser.end());
  return events;
}

describe('artifact parser', () => {
  it('keeps the body out of text even when every delimiter is split', () => {
    const input = 'antes <artifact id="demo" type="code" language="ts" title="Demo">```ts\nconst x = 1;\n```</artifact> depois';
    for (let split = 1; split <= input.length; split += 1) {
      const events = parseInChunks(input, split);
      expect(events.flatMap((event) => event.kind === 'text' ? [event.text] : []).join('')).toBe('antes  depois');
      expect(events.flatMap((event) => event.kind === 'artifact_body' ? [event.text] : []).join('')).toContain('const x = 1;');
    }
  });

  it('treats malformed openings as prose', () => {
    const events = parseInChunks('<artifact id="bad" type="html" title="Bad">x</artifact>');
    expect(events.every((event) => event.kind === 'text')).toBe(true);
    expect(events.flatMap((event) => event.kind === 'text' ? [event.text] : []).join('')).toContain('<artifact id="bad"');
  });

  it('closes an interrupted artifact as truncated and unescapes its literal close', () => {
    const events = parseInChunks('<artifact id="demo" type="markdown" title="Demo">literal <\\/artifact> fim');
    expect(events.flatMap((event) => event.kind === 'artifact_body' ? [event.text] : []).join('')).toContain('</artifact>');
    expect(events.find((event) => event.kind === 'artifact_close' && event.truncated)).toBeTruthy();
  });

  it('emits ordered patch edits without interpreting fenced content', () => {
    const events = parseInChunks('<artifact-update id="demo"><find>a</find><replace>b</replace><find>c</find><replace>d</replace></artifact-update>');
    expect(events).toEqual([{ kind: 'artifact_patch', slug: 'demo', edits: [{ find: 'a', replace: 'b' }, { find: 'c', replace: 'd' }] }]);
  });

  it('accepts a native spreadsheet artifact across chunk boundaries', () => {
    const input = '<artifact id="pg" type="spreadsheet" title="PG">{"filename":"pg.xlsx","sheets":[{"name":"PG","rows":[[1,2]]}]}</artifact>';
    const events = parseInChunks(input, 1);
    expect(events.find((event) => event.kind === 'artifact_open')).toMatchObject({ type: 'spreadsheet', slug: 'pg' });
    expect(events.flatMap((event) => event.kind === 'artifact_body' ? [event.text] : []).join('')).toContain('pg.xlsx');
  });
});
