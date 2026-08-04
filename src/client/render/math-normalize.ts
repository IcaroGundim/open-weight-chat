interface MarkdownSegment {
  code: boolean;
  value: string;
}

function isFenceAt(source: string, index: number): { marker: string; start: number } | null {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  if (index !== lineStart && !/^ {0,3}$/.test(source.slice(lineStart, index))) return null;
  const match = source.slice(index).match(/^(`{3,}|~{3,})/);
  return match ? { marker: match[1], start: index } : null;
}

function findFenceClose(source: string, from: number, marker: string): number {
  const linePattern = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`, 'm');
  const match = linePattern.exec(source.slice(from));
  return match ? from + match.index : -1;
}

export function splitMarkdownSegments(source: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  const pushText = (end: number) => {
    if (end > textStart) segments.push({ code: false, value: source.slice(textStart, end) });
  };

  while (cursor < source.length) {
    const fence = isFenceAt(source, cursor);
    if (fence) {
      pushText(cursor);
      const close = findFenceClose(source, cursor + fence.marker.length, fence.marker);
      const end = close >= 0 ? source.indexOf('\n', close) + 1 || source.length : source.length;
      segments.push({ code: true, value: source.slice(cursor, end) });
      cursor = end;
      textStart = cursor;
      continue;
    }

    if (source[cursor] === '`') {
      const run = source.slice(cursor).match(/^`+/)?.[0] ?? '`';
      const close = source.indexOf(run, cursor + run.length);
      if (close >= 0) {
        pushText(cursor);
        const end = close + run.length;
        segments.push({ code: true, value: source.slice(cursor, end) });
        cursor = end;
        textStart = cursor;
        continue;
      }
    }
    cursor += 1;
  }

  pushText(source.length);
  return segments;
}

function normalizeTextSegment(source: string, streaming: boolean): string {
  let value = source;

  value = value.replace(/\\\[([\s\S]*?)\\\]/g, (_, content: string) => `$$\n${content}\n$$`);
  value = value.replace(/\\\(([\s\S]*?)\\\)/g, (_, content: string) => `$${content}$`);

  value = value.replace(/\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/g, (_, environment: string, content: string) =>
    `$$\n\\begin{${environment}}${content}\\end{${environment}}\n$$`,
  );

  if (streaming) {
    const openBlock = value.lastIndexOf('\\[');
    const closeBlock = value.lastIndexOf('\\]');
    if (openBlock > closeBlock) {
      value = `${value.slice(0, openBlock)}$$\n${value.slice(openBlock + 2)}\n$$`;
    }

    const openInline = value.lastIndexOf('\\(');
    const closeInline = value.lastIndexOf('\\)');
    if (openInline > closeInline) {
      value = `${value.slice(0, openInline)}$${value.slice(openInline + 2)}$`;
    }

    let inlineOpen = false;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== '$' || value[index - 1] === '\\') continue;
      if (value[index + 1] === '$') {
        index += 1;
        continue;
      }
      if (!inlineOpen) {
        const next = value[index + 1] ?? '';
        if (next && !/\s|\d/.test(next)) inlineOpen = true;
      } else {
        inlineOpen = false;
      }
    }
    if (inlineOpen) value += '$';
  }

  return value;
}

export function normalizeMathDelimiters(source: string, streaming = false): string {
  return splitMarkdownSegments(source)
    .map((segment) => segment.code ? segment.value : normalizeTextSegment(segment.value, streaming))
    .join('');
}

function closeOpenFence(source: string): string {
  const lines = source.split('\n');
  let openMarker: string | null = null;
  for (const line of lines) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    if (!openMarker) {
      openMarker = match[1];
    } else if (match[1][0] === openMarker[0] && match[1].length >= openMarker.length) {
      openMarker = null;
    }
  }
  return openMarker ? `${source}\n${openMarker}\n` : source;
}

function closeOpenInlineCode(source: string): string {
  const segments = splitMarkdownSegments(source);
  const last = segments.at(-1);
  if (!last?.code || /^(`{3,}|~{3,})/.test(last.value.trimStart())) return source;
  const marker = last.value.match(/^`+/)?.[0];
  return marker && !last.value.trimEnd().endsWith(marker) ? `${source}${marker}` : source;
}

export function prepareMarkdownForRender(source: string, streaming = false): string {
  if (!streaming) return normalizeMathDelimiters(source, false);
  return normalizeMathDelimiters(closeOpenInlineCode(closeOpenFence(source)), true);
}

export function hasMathSyntax(source: string): boolean {
  return splitMarkdownSegments(source)
    .filter((segment) => !segment.code)
    .some((segment) =>
      /\\(?:\(|\[|begin\{)/.test(segment.value) ||
      /\$\$/.test(segment.value) ||
      /(^|[^\\])\$(?!\s|\d)(?:[^$\n]+\$|[^$\n]*$)/.test(segment.value),
    );
}
