const allowedElements = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'use', 'title', 'desc',
]);

const allowedAttributes = new Set([
  'xmlns', 'xmlns:xlink', 'viewbox', 'width', 'height', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray',
  'stroke-dashoffset', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'transform', 'id', 'offset', 'stop-color', 'stop-opacity', 'font-size', 'font-family',
  'font-weight', 'text-anchor', 'dominant-baseline', 'href', 'xlink:href',
]);

function safeAttribute(name: string, value: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized.startsWith('on') || !allowedAttributes.has(normalized)) return false;
  if ((normalized === 'href' || normalized === 'xlink:href') && !value.trim().startsWith('#')) return false;
  return true;
}

function sanitizeWithDom(source: string): string | null {
  const parser = new DOMParser();
  const document = parser.parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || document.querySelector('parsererror')) return null;

  const visit = (element: Element): void => {
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (!allowedElements.has(tag)) {
        child.remove();
        continue;
      }
      visit(child);
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!safeAttribute(attribute.name, attribute.value)) element.removeAttribute(attribute.name);
    }
  };

  if (!allowedElements.has(root.tagName.toLowerCase())) return null;
  visit(root);
  return new XMLSerializer().serializeToString(root);
}

function sanitizeWithoutDom(source: string): string | null {
  const rootMatch = source.match(/<svg\b[^>]*>[\s\S]*<\/svg>/i);
  if (!rootMatch) return null;
  const sanitized = rootMatch[0]
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<\/?([a-z][\w:-]*)\b[^>]*>/gi, (tag, name: string) => {
      const normalizedName = name.toLowerCase();
      if (!allowedElements.has(normalizedName)) return '';
      if (tag.startsWith('</')) return `</${name}>`;
      const attributes = [...tag.matchAll(/([:\w-]+)\s*=\s*("[^"]*"|'[^']*')/g)]
        .filter((match) => safeAttribute(match[1], match[2].slice(1, -1)))
        .map((match) => ` ${match[1]}="${match[2].slice(1, -1).replaceAll('"', '&quot;')}"`)
        .join('');
      return `<${name}${attributes}${tag.endsWith('/>') ? '/>' : '>'}`;
    });
  return sanitized.includes('<svg') ? sanitized : null;
}

export function sanitizeSvg(source: string): string | null {
  if (!source.trim()) return null;
  return typeof DOMParser === 'function' ? sanitizeWithDom(source) : sanitizeWithoutDom(source);
}

export function svgToDataUrl(source: string): string | null {
  const sanitized = sanitizeSvg(source);
  if (!sanitized) return null;
  const bytes = new TextEncoder().encode(sanitized);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
