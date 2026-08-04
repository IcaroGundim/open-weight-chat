// Verificação de contraste WCAG 2.1 dos pares realmente usados na interface.
// Rode após qualquer mudança de cor: `node scripts/contrast.mjs`
// Os valores aqui devem espelhar os tokens de src/client/styles.css.

const channels = (value) => {
  const clean = value.replace('#', '');
  return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16) / 255);
};
const linearize = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (value) => {
  const [r, g, b] = channels(value).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

const light = {
  paper: '#FCFAF7',
  surface: '#F3EEE6',
  surface2: '#E8E0D4',
  rule: '#DCD2C4',
  ruleStrong: '#94836F',
  ink: '#1B1512',
  ink2: '#544840',
  ink3: '#756860',
  wine: '#7A2338',
  wineDeep: '#5E1729',
  wineTint: '#F5E4E7',
  ochre: '#8A6118',
  danger: '#B3261E',
  dangerTint: '#FBE4E1',
  onInk: '#FCFAF7',
  sidebar: '#2A211C',
  sidebar2: '#382C26',
  sidebarHover: '#463830',
  sidebarInk: '#F6EFE7',
  sidebarInk2: '#C3B2A5',
  sidebarWine: '#E0899C',
  code: '#241C18',
  codeInk: '#E3D8CC',
};

const dark = {
  paper: '#17120F',
  surface: '#1F1815',
  surface2: '#2B221D',
  rule: '#392D27',
  ruleStrong: '#7C6A5E',
  ink: '#F4EDE5',
  ink2: '#C0B1A6',
  ink3: '#9C8C81',
  wine: '#E4879C',
  wineDeep: '#F2A9B9',
  wineTint: '#3A1A24',
  ochre: '#D5A45C',
  danger: '#F08579',
  dangerTint: '#3E1C18',
  onInk: '#17120F',
  // A barra lateral é a mesma nos dois temas — ver DESIGN.md.
  sidebar: '#2A211C',
  sidebar2: '#382C26',
  sidebarHover: '#463830',
  sidebarInk: '#F6EFE7',
  sidebarInk2: '#C3B2A5',
  sidebarWine: '#E0899C',
  code: '#0F0C0A',
  codeInk: '#DCD1C6',
};

const pairs = (p) => [
  [p.ink, p.paper, 7, 'texto principal / papel'],
  [p.ink, p.surface, 7, 'texto principal / superficie'],
  [p.ink2, p.paper, 4.5, 'texto secundario / papel'],
  [p.ink2, p.surface, 4.5, 'texto secundario / superficie'],
  [p.ink2, p.surface2, 4.5, 'texto secundario / superficie-2'],
  [p.ink3, p.paper, 4.5, 'texto terciario / papel'],
  [p.ink3, p.surface, 4.5, 'texto terciario / superficie'],
  [p.wine, p.paper, 4.5, 'vinho / papel (link, custo)'],
  [p.wine, p.surface, 4.5, 'vinho / superficie'],
  [p.wine, p.wineTint, 4.5, 'vinho / vinho-tint (codigo inline)'],
  [p.wineDeep, p.paper, 4.5, 'vinho-fundo / papel'],
  [p.ochre, p.paper, 4.5, 'ocre / papel (atencao)'],
  [p.ochre, p.surface, 4.5, 'ocre / superficie'],
  [p.danger, p.paper, 4.5, 'erro / papel'],
  [p.danger, p.dangerTint, 4.5, 'erro / erro-tint (banner)'],
  [p.paper, p.ink, 7, 'botao primario: papel / tinta'],
  [p.onInk, p.danger, 4.5, 'botao Parar: texto / erro'],
  [p.sidebar, p.sidebarWine, 4.5, 'botao Excluir: texto / acento da barra'],
  [p.sidebarInk, p.sidebar, 7, 'barra: texto / fundo'],
  [p.sidebarInk, p.sidebar2, 4.5, 'barra: texto / fundo-2'],
  [p.sidebarInk2, p.sidebar, 4.5, 'barra: secundario / fundo'],
  [p.sidebarInk2, p.sidebarHover, 4.5, 'barra: secundario / hover'],
  [p.sidebarWine, p.sidebar, 4.5, 'barra: acento / fundo'],
  [p.sidebar, p.paper, 1.1, 'barra / canvas (separacao perceptivel)'],
  [p.codeInk, p.code, 4.5, 'codigo sem destaque / fundo de codigo'],
  [p.ruleStrong, p.paper, 3, 'borda funcional / papel (WCAG 1.4.11)'],
];

let failures = 0;
for (const [palette, name] of [[light, 'CLARO'], [dark, 'ESCURO']]) {
  console.log('\n=== TEMA ' + name + ' ===');
  for (const [fg, bg, min, label] of pairs(palette)) {
    const value = contrast(fg, bg);
    const ok = value >= min;
    if (!ok) failures += 1;
    console.log(
      (ok ? '  ok  ' : '  XX  ') + value.toFixed(2).padStart(5) + '  (min ' + min + ')  ' + label,
    );
  }
}

console.log('\n' + (failures === 0 ? 'todos os pares passam' : failures + ' par(es) reprovado(s)'));
process.exit(failures === 0 ? 0 : 1);
