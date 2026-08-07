import type { ArtifactKind } from '../../shared/types';

export type ArtifactParserEvent =
  | { kind: 'text'; text: string }
  | { kind: 'artifact_open'; slug: string; type: ArtifactKind | 'spreadsheet'; language: string | null; title: string }
  | { kind: 'artifact_body'; slug: string; text: string }
  | { kind: 'artifact_close'; slug: string; truncated: boolean }
  | { kind: 'artifact_patch'; slug: string; edits: Array<{ find: string; replace: string }> };

export type ParserEvent = ArtifactParserEvent;

const ARTIFACT_OPEN_PREFIX = '<artifact';
const UPDATE_OPEN_PREFIX = '<artifact-update';
const ARTIFACT_CLOSE = '</artifact>';
const ESCAPED_ARTIFACT_CLOSE = '<\\/artifact>';
const UPDATE_CLOSE = '</artifact-update>';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const KINDS = new Set<ArtifactKind | 'spreadsheet'>(['markdown', 'code', 'svg', 'mermaid', 'mindmap', 'chart', 'spreadsheet']);

type ParserState = 'prose' | 'artifact' | 'patch';

interface ArtifactMetadata {
  slug: string;
  type: ArtifactKind | 'spreadsheet';
  language: string | null;
  title: string;
}

function suffixThatCanStart(value: string, delimiters: readonly string[]): number {
  const max = Math.min(value.length, Math.max(...delimiters.map((delimiter) => delimiter.length)));
  for (let length = max; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (delimiters.some((delimiter) => delimiter.startsWith(suffix))) return length;
  }
  return 0;
}

function parseAttributes(tag: string, expectedName: string): Record<string, string> | null {
  if (!tag.startsWith(`<${expectedName}`) || !tag.endsWith('>')) return null;
  const body = tag.slice(expectedName.length + 1, -1);
  const attributes: Record<string, string> = {};
  let cursor = 0;
  const attributePattern = /\s+([a-z]+)="([^"]*)"/gu;
  while (cursor < body.length) {
    attributePattern.lastIndex = cursor;
    const match = attributePattern.exec(body);
    if (!match || match.index !== cursor) return null;
    if (attributes[match[1]]) return null;
    attributes[match[1]] = match[2];
    cursor = attributePattern.lastIndex;
  }
  return attributes;
}

function parseArtifactOpening(tag: string): ArtifactMetadata | null {
  const attributes = parseAttributes(tag, 'artifact');
  if (!attributes || !SLUG_PATTERN.test(attributes.id ?? '')) return null;
  const type = attributes.type as ArtifactKind | 'spreadsheet';
  if (!KINDS.has(type)) return null;
  const title = attributes.title ?? '';
  if (title.length < 1 || title.length > 120) return null;
  if (type === 'code' && (!attributes.language || attributes.language.length > 32)) return null;
  return {
    slug: attributes.id,
    type,
    language: type === 'code' ? attributes.language ?? null : null,
    title,
  };
}

function parsePatchOpening(tag: string): string | null {
  const attributes = parseAttributes(tag, 'artifact-update');
  const slug = attributes?.id ?? '';
  return SLUG_PATTERN.test(slug) ? slug : null;
}

function parsePatchBody(body: string): Array<{ find: string; replace: string }> | null {
  const edits: Array<{ find: string; replace: string }> = [];
  let cursor = 0;
  while (cursor < body.length) {
    while (/\s/u.test(body[cursor] ?? '')) cursor += 1;
    if (cursor >= body.length) break;
    if (!body.startsWith('<find>', cursor)) return null;
    const findEnd = body.indexOf('</find>', cursor + 6);
    if (findEnd < 0) return null;
    const find = body.slice(cursor + 6, findEnd);
    cursor = findEnd + '</find>'.length;
    while (/\s/u.test(body[cursor] ?? '')) cursor += 1;
    if (!body.startsWith('<replace>', cursor)) return null;
    const replaceEnd = body.indexOf('</replace>', cursor + 9);
    if (replaceEnd < 0) return null;
    const replace = body.slice(cursor + 9, replaceEnd);
    cursor = replaceEnd + '</replace>'.length;
    edits.push({ find, replace });
  }
  return edits.length > 0 ? edits : null;
}

function unescapeArtifactClose(text: string): string {
  return text.replaceAll('<\\/artifact>', '</artifact>');
}

export function createArtifactParser(): { push(chunk: string): ParserEvent[]; end(): ParserEvent[] } {
  let state: ParserState = 'prose';
  let buffer = '';
  let metadata: ArtifactMetadata | null = null;
  let patchSlug: string | null = null;
  let patchSource = '';

  const emitText = (events: ParserEvent[], text: string) => {
    if (text) events.push({ kind: 'text', text });
  };

  const processProse = (events: ParserEvent[]): boolean => {
    const artifactIndex = buffer.indexOf(ARTIFACT_OPEN_PREFIX);
    const updateIndex = buffer.indexOf(UPDATE_OPEN_PREFIX);
    const candidates = [artifactIndex, updateIndex].filter((index) => index >= 0);
    if (candidates.length === 0) {
      const keep = suffixThatCanStart(buffer, [ARTIFACT_OPEN_PREFIX, UPDATE_OPEN_PREFIX]);
      emitText(events, buffer.slice(0, buffer.length - keep));
      buffer = buffer.slice(buffer.length - keep);
      return false;
    }

    const index = Math.min(...candidates);
    emitText(events, buffer.slice(0, index));
    buffer = buffer.slice(index);
    if (buffer.startsWith(UPDATE_OPEN_PREFIX) && UPDATE_OPEN_PREFIX.startsWith(buffer) && !buffer.includes('>')) return false;
    if (buffer.startsWith(ARTIFACT_OPEN_PREFIX) && ARTIFACT_OPEN_PREFIX.startsWith(buffer) && !buffer.includes('>')) return false;
    const close = buffer.indexOf('>');
    if (close < 0) return false;
    const tag = buffer.slice(0, close + 1);
    if (tag.startsWith(UPDATE_OPEN_PREFIX)) {
      const slug = parsePatchOpening(tag);
      if (!slug) {
        emitText(events, buffer.slice(0, 1));
        buffer = buffer.slice(1);
        return true;
      }
      patchSlug = slug;
      patchSource = tag;
      buffer = buffer.slice(close + 1);
      state = 'patch';
      return true;
    }
    const nextMetadata = parseArtifactOpening(tag);
    if (!nextMetadata) {
      emitText(events, buffer.slice(0, 1));
      buffer = buffer.slice(1);
      return true;
    }
    metadata = nextMetadata;
    buffer = buffer.slice(close + 1);
    state = 'artifact';
    events.push({ kind: 'artifact_open', ...nextMetadata });
    return true;
  };

  const processArtifact = (events: ParserEvent[]): boolean => {
    if (!metadata) {
      state = 'prose';
      return true;
    }
    const close = buffer.indexOf(ARTIFACT_CLOSE);
    if (close < 0) {
      const keep = suffixThatCanStart(buffer, [ARTIFACT_CLOSE, ESCAPED_ARTIFACT_CLOSE]);
      const body = buffer.slice(0, buffer.length - keep);
      if (body) events.push({ kind: 'artifact_body', slug: metadata.slug, text: unescapeArtifactClose(body) });
      buffer = buffer.slice(buffer.length - keep);
      return false;
    }
    const body = buffer.slice(0, close);
    if (body) events.push({ kind: 'artifact_body', slug: metadata.slug, text: unescapeArtifactClose(body) });
    buffer = buffer.slice(close + ARTIFACT_CLOSE.length);
    events.push({ kind: 'artifact_close', slug: metadata.slug, truncated: false });
    metadata = null;
    state = 'prose';
    return true;
  };

  const processPatch = (events: ParserEvent[]): boolean => {
    if (!patchSlug) {
      state = 'prose';
      return true;
    }
    const close = buffer.indexOf(UPDATE_CLOSE);
    if (close < 0) {
      const keep = suffixThatCanStart(buffer, [UPDATE_CLOSE]);
      patchSource += buffer.slice(0, buffer.length - keep);
      buffer = buffer.slice(buffer.length - keep);
      return false;
    }
    patchSource += buffer.slice(0, close);
    buffer = buffer.slice(close + UPDATE_CLOSE.length);
    const edits = parsePatchBody(patchSource.slice(patchSource.indexOf('>') + 1));
    if (edits) events.push({ kind: 'artifact_patch', slug: patchSlug, edits });
    else emitText(events, `${patchSource}${UPDATE_CLOSE}`);
    patchSlug = null;
    patchSource = '';
    state = 'prose';
    return true;
  };

  return {
    push(chunk: string): ParserEvent[] {
      if (!chunk) return [];
      buffer += chunk;
      const events: ParserEvent[] = [];
      let progressed = true;
      while (progressed) {
        progressed = state === 'prose'
          ? processProse(events)
          : state === 'artifact'
            ? processArtifact(events)
            : processPatch(events);
      }
      return events;
    },
    end(): ParserEvent[] {
      const events: ParserEvent[] = [];
      if (state === 'artifact' && metadata) {
        const body = `${buffer}`;
        if (body) events.push({ kind: 'artifact_body', slug: metadata.slug, text: unescapeArtifactClose(body) });
        events.push({ kind: 'artifact_close', slug: metadata.slug, truncated: true });
      } else if (state === 'patch') {
        emitText(events, `${patchSource}${buffer}`);
      } else {
        emitText(events, buffer);
      }
      state = 'prose';
      buffer = '';
      metadata = null;
      patchSlug = null;
      patchSource = '';
      return events;
    },
  };
}
