import type { Artifact } from '../../shared/types';
import { estimateMessageTokens, estimateTokens, type ContextMessage } from '../context';

export interface ArtifactContextResult {
  message: ContextMessage | null;
  estimatedTokens: number;
  includedSlugs: string[];
  omittedSlugs: string[];
}

function currentVersion(artifact: Artifact): Artifact['versions'][number] | undefined {
  return artifact.versions.find((version) => version.version === artifact.currentVersion)
    ?? artifact.versions.at(-1);
}

function lines(content: string): number {
  return content ? content.split('\n').length : 0;
}

function artifactBlock(artifact: Artifact, version: Artifact['versions'][number], omitted = false): string {
  const language = artifact.kind === 'code' && artifact.language ? ` language="${artifact.language}"` : '';
  if (omitted) {
    return `<artifact id="${artifact.slug}" title="${artifact.title}" version="${version.version}" omitted="true" lines="${lines(version.content)}"/>`;
  }
  return `<artifact id="${artifact.slug}" type="${artifact.kind}"${language} title="${artifact.title}" version="${version.version}">\n${version.content}\n</artifact>`;
}

export function buildArtifactContext(artifacts: readonly Artifact[], contextWindow: number): ArtifactContextResult {
  const budgetTokens = Math.max(1, Math.floor(contextWindow * 0.25));
  const ordered = [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
  if (ordered.length === 0) return { message: null, estimatedTokens: 0, includedSlugs: [], omittedSlugs: [] };

  const selected: string[] = [];
  const omitted: string[] = [];
  let body = 'Estado atual dos artefatos desta conversa:\n\n';
  for (const artifact of ordered) {
    const version = currentVersion(artifact);
    if (!version) continue;
    const candidate = `${body}${artifactBlock(artifact, version)}\n\n`;
    if (estimateMessageTokens({ role: 'user', content: candidate }) <= budgetTokens) {
      body = candidate;
      selected.push(artifact.slug);
    } else {
      const omittedBlock = `${body}${artifactBlock(artifact, version, true)}\n\n`;
      if (estimateMessageTokens({ role: 'user', content: omittedBlock }) <= budgetTokens) {
        body = omittedBlock;
      }
      omitted.push(artifact.slug);
    }
  }
  if (selected.length === 0 && omitted.length === 0) return { message: null, estimatedTokens: 0, includedSlugs: [], omittedSlugs: [] };
  const content = body.trimEnd();
  return {
    message: { role: 'user', content },
    estimatedTokens: estimateTokens(content) + 4,
    includedSlugs: selected,
    omittedSlugs: omitted,
  };
}

