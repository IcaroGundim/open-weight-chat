export type ArtifactEdit = { find: string; replace: string };

export type ApplyEditsResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; find: string };

export function applyEdits(source: string, edits: ArtifactEdit[]): ApplyEditsResult {
  let content = source;
  for (const edit of edits) {
    const first = content.indexOf(edit.find);
    if (first < 0) return { ok: false, reason: 'not_found', find: edit.find };
    if (content.indexOf(edit.find, first + edit.find.length) >= 0) {
      return { ok: false, reason: 'ambiguous', find: edit.find };
    }
    content = `${content.slice(0, first)}${edit.replace}${content.slice(first + edit.find.length)}`;
  }
  return { ok: true, content };
}

