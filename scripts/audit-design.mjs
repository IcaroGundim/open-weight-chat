// Auditoria das proibições da direção visual — ver DESIGN.md §3.1 e §10.2.
// Rode junto com scripts/contrast.mjs antes de commitar mudanças de interface.
//   node scripts/audit-design.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, não url.pathname: o caminho do projeto tem espaço e viraria %20.
const root = fileURLToPath(new URL('..', import.meta.url));
const cssPath = join(root, 'src/client/styles.css');

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const css = readFileSync(cssPath, 'utf8');
// Comentários viram espaço em branco (preservando quebras de linha) para que a
// prosa que *documenta* uma exceção não seja lida como a exceção em si.
const cssLines = css
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))
  .split('\n');
const componentFiles = collect(join(root, 'src/client'));

const findings = [];
const report = (rule, file, line, detail) =>
  findings.push({ rule, file: relative(root, file).replaceAll('\\', '/'), line, detail });

// Faixas de linha onde hexadecimais literais são a própria definição dos tokens.
const tokenRanges = [];
{
  let depth = 0;
  let start = -1;
  cssLines.forEach((text, index) => {
    if (start === -1 && /^(:root|\[data-theme="dark"\])\s*\{/.test(text.trim())) {
      start = index;
      depth = 0;
    }
    if (start !== -1) {
      depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
      if (depth <= 0 && index > start) {
        tokenRanges.push([start, index]);
        start = -1;
      }
    }
  });
}
const isTokenDefinition = (index) => tokenRanges.some(([from, to]) => index >= from && index <= to);

cssLines.forEach((text, index) => {
  const line = index + 1;

  if (/\b(linear|radial|conic)-gradient\s*\(/.test(text)) {
    report('gradiente', cssPath, line, text.trim());
  }

  if (/font-family[^;]*\bInter\b/.test(text)) {
    report('fonte Inter', cssPath, line, text.trim());
  }

  const size = /font-size:\s*(\d+)px/.exec(text);
  if (size && Number(size[1]) < 12) {
    report('fonte abaixo de 12px', cssPath, line, text.trim());
  }

  const weight = /font-weight:\s*(\d{3})/.exec(text);
  if (weight && !['500', '600', '700'].includes(weight[1])) {
    report('peso fora da escala', cssPath, line, text.trim());
  }

  if (/letter-spacing:\s*0\.\d+em/.test(text)) {
    report('letter-spacing positivo', cssPath, line, text.trim());
  }

  if (/text-transform:\s*uppercase/.test(text)) {
    report('caixa alta', cssPath, line, text.trim());
  }

  // Hex literal fora da definição de tokens. As miniaturas de tema em
  // Configurações são exceção documentada (DESIGN.md §9.3): precisam mostrar as
  // cores do tema oposto, que não estão nas variáveis ativas.
  if (/#[0-9a-fA-F]{3,8}\b/.test(text) && !isTokenDefinition(index)) {
    const context = cssLines.slice(Math.max(0, index - 4), index + 1).join('\n');
    if (!/settings-theme-preview/.test(context)) {
      report('hex fora dos tokens', cssPath, line, text.trim());
    }
  }
});

for (const file of componentFiles) {
  readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
    const line = index + 1;

    if (/window\.(prompt|confirm|alert)\s*\(/.test(text)) {
      report('diálogo nativo', file, line, text.trim());
    }

    // Texto de interface escrito inteiramente em caixa alta dentro do JSX.
    const shouting = />\s*([A-ZÀ-Ý][A-ZÀ-Ý\s]{3,})\s*</.exec(text);
    if (shouting && /[A-ZÀ-Ý]{4,}/.test(shouting[1])) {
      report('caixa alta no JSX', file, line, shouting[1].trim());
    }
  });
}

const groups = new Map();
for (const finding of findings) {
  if (!groups.has(finding.rule)) groups.set(finding.rule, []);
  groups.get(finding.rule).push(finding);
}

if (groups.size === 0) {
  console.log('nenhuma violação: a interface está de acordo com DESIGN.md');
  process.exit(0);
}

console.log('Violações de DESIGN.md §3.1\n');
for (const [rule, items] of groups) {
  console.log(rule + '  (' + items.length + ')');
  for (const item of items) {
    console.log('  ' + item.file + ':' + item.line + '  ' + item.detail.slice(0, 90));
  }
  console.log('');
}
console.log(findings.length + ' violação(ões). Divergências já conhecidas estão listadas em DESIGN.md §11.');
process.exit(1);
