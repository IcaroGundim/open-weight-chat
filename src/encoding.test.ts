import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_DIRS = ['src', 'scripts', 'docs'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.md', '.mjs', '.sql', '.html']);

/**
 * Assinatura de UTF-8 lido como Latin-1 e regravado como UTF-8: o "á" vira o
 * par "Ã" + "¡". Como o projeto é escrito em português, um arquivo corrompido
 * assim é indistinguível de texto válido para o compilador e para os testes —
 * ele só aparece para quem lê o código, e por isso sobrevive por muito tempo.
 * Quatro arquivos já tinham chegado a esse estado.
 */
const MOJIBAKE = /[Â-Å][-¿]/u;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (SCANNED_EXTENSIONS.has(extname(entry))) {
      yield path;
    }
  }
}

describe('codificação dos arquivos de origem', () => {
  it('não tem texto corrompido por dupla codificação', () => {
    const corrupted: string[] = [];
    for (const directory of SCANNED_DIRS) {
      for (const file of sourceFiles(join(repoRoot, directory))) {
        const content = readFileSync(file, 'utf8');
        if (MOJIBAKE.test(content)) {
          const line = content.split('\n').findIndex((text) => MOJIBAKE.test(text)) + 1;
          corrupted.push(`${file.slice(repoRoot.length + 1)}:${line}`);
        }
      }
    }

    expect(corrupted).toEqual([]);
  });
});
