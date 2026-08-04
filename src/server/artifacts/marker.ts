export const ARTIFACT_MARKER_PATTERN = /^\[\[artefato:([a-z0-9][a-z0-9-]{0,63})@(\d+)\]\]$/u;

export function artifactMarker(slug: string, version: number): string {
  return `[[artefato:${slug}@${version}]]`;
}

export function parseArtifactMarker(value: string): { slug: string; version: number } | null {
  const match = ARTIFACT_MARKER_PATTERN.exec(value.trim());
  if (!match) return null;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) && version > 0 ? { slug: match[1], version } : null;
}

