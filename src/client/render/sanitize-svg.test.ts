import { describe, expect, it } from 'vitest';
import { sanitizeSvg, svgToDataUrl } from './sanitize-svg';

describe('sanitização de SVG de artefatos', () => {
  it('remove script, handlers e foreignObject', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><img onerror="alert(2)" /></foreignObject><rect width="10" height="10" /></svg>';
    const sanitized = sanitizeSvg(source);
    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toMatch(/script|onload|onerror|foreignObject|img/i);
    expect(sanitized).toContain('<rect');
  });

  it('remove referências externas e preserva href local por fragmento', () => {
    const source = '<svg><defs><linearGradient id="paint" /></defs><use href="#paint" /><use href="https://externo.invalid/payload.svg" /><use xlink:href="//externo.invalid/payload.svg" /></svg>';
    const sanitized = sanitizeSvg(source);
    expect(sanitized).not.toBeNull();
    expect(sanitized).toContain('href="#paint"');
    expect(sanitized).not.toContain('externo.invalid');
  });

  it('produz uma segunda camada de isolamento em data URL', () => {
    const dataUrl = svgToDataUrl('<svg><script>alert(1)</script><circle cx="4" cy="4" r="4" /></svg>');
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const encoded = dataUrl?.split(',')[1] ?? '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    expect(decoded).not.toMatch(/script/i);
    expect(decoded).toContain('<circle');
  });
});

