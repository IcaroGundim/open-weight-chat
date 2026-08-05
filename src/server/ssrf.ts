/**
 * Proteção contra SSRF para URLs de provedores OpenAI-compatíveis.
 *
 * Regras (PLANO.md — endpoints próprios):
 * - Em produção (NODE_ENV=production ou VERCEL), somente HTTPS é aceito.
 * - Bloqueia credenciais embutidas na URL (user:password@).
 * - Bloqueia redirecionamentos e hosts/IPs em faixas privadas, loopback,
 *   link-local, multicast e metadata (169.254.169.254) — inclusive IPv4
 *   mapeado em IPv6 (::ffff:a.b.c.d).
 * - Em desenvolvimento, http://localhost e loopback (127.0.0.0/8, ::1) são
 *   permitidos; IPs privados NÃO-loopback permanecem bloqueados.
 * - O DNS é resolvido e revalidado antes do fetch e a cada redirecionamento
 *   (assertSafeHostResolved) para mitigar DNS rebinding.
 *
 * Não cobre formas ambíguas de IPv4 (ex.: "127.1", octal/hexadecimal) — o
 * WHATWG URL normaliza boa parte delas, e a revalidação pós-DNS é o
 * mecanismo de segurança final para o que escapar.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { AppError } from './errors';

/** Função de resolução DNS injetável (usada nos testes). */
export type LookupFn = (hostname: string) => Promise<string[]>;

export interface SsrfOptions {
  /** Permite http://localhost e loopback (127.0.0.0/8, ::1). Default: !production. */
  allowLocalhost?: boolean;
  /** Trata a validação como produção (exige HTTPS). Default: NODE_ENV=production ou VERCEL. */
  production?: boolean;
  /** Resolvedor DNS injetável. Default: dns.promises.lookup com all+verbatim. */
  lookup?: LookupFn;
  /** Limite de redirecionamentos seguidos (default: 5). */
  maxRedirects?: number;
  /** Implementação de fetch injetável (testes). Default: fetch global. */
  fetchImpl?: typeof fetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

/** Erro amigável com status 400 (configuração inválida do lado do servidor). */
function ssrfError(message: string): AppError {
  return new AppError('UNKNOWN', { status: 400, message });
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

/** Normaliza hostname para comparação: minúsculas, sem colchetes IPv6, sem ponto final. */
function normalizeHostname(hostname: string): string {
  let name = stripIpv6Brackets(hostname.trim()).toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  return name;
}

function parseIpv4(addr: string): number[] | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function parseIpv6(addr: string): Uint8Array | null {
  let rest = addr.toLowerCase();

  // Suporta o sufixo IPv4 embutido (ex.: ::ffff:192.168.0.1, ::10.0.0.1).
  const lastColon = rest.lastIndexOf(':');
  if (lastColon !== -1 && rest.slice(lastColon + 1).includes('.')) {
    const octets = rest.slice(lastColon + 1).split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const head = rest.slice(0, lastColon);
    const a = ((octets[0] << 8) | octets[1]).toString(16);
    const b = ((octets[2] << 8) | octets[3]).toString(16);
    rest = `${head}:${a}:${b}`;
  }

  const doubleColon = rest.indexOf('::');
  if (doubleColon === -1) {
    const parts = rest.split(':');
    if (parts.length !== 8) return null;
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    }
    return ipv6Bytes(parts.map((part) => parseInt(part, 16)));
  }

  const left = rest.slice(0, doubleColon).split(':').filter((part) => part !== '');
  const right = rest.slice(doubleColon + 2).split(':').filter((part) => part !== '');
  for (const part of [...left, ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null; // '::' precisa representar ao menos um grupo de zeros
  const expanded = [
    ...left.map((part) => parseInt(part, 16)),
    ...new Array<number>(missing).fill(0),
    ...right.map((part) => parseInt(part, 16)),
  ];
  return ipv6Bytes(expanded);
}

function ipv6Bytes(groups: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** ::ffff:a.b.c.d (IPv4 mapeado em IPv6). */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 &&
    bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0 &&
    bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0xff && bytes[11] === 0xff
  );
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — não especificado / "esta rede"
  if (a === 10) return true; // 10.0.0.0/8 — privado
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (inclui 169.254.169.254, metadata)
  if (a === 172 && (b & 0xf0) === 16) return true; // 172.16.0.0/12 — privado
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — privado
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 — multicast
  return false;
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  if (bytes.every((byte) => byte === 0)) return true; // :: — não especificado
  if (bytes.every((byte, i) => (i === 15 ? byte === 1 : byte === 0))) return true; // ::1 — loopback
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 — link-local
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 — único (ULA)
  if (bytes[0] === 0xff) return true; // ff00::/8 — multicast
  return false;
}

/**
 * Diz se um endereço IP (IPv4 ou IPv6) está em faixa bloqueada.
 * Normaliza IPv4 mapeado em IPv6 (::ffff:a.b.c.d) avaliando o IPv4 embutido.
 * Strings que não são IPs válidos retornam false (não são endereços).
 */
export function isBlockedIp(ip: string): boolean {
  const normalized = stripIpv6Brackets(ip.trim().toLowerCase());
  if (isIP(normalized) === 4) {
    const octets = parseIpv4(normalized);
    return octets !== null && isBlockedIpv4(octets);
  }
  if (isIP(normalized) === 6) {
    const bytes = parseIpv6(normalized);
    if (bytes === null) return false;
    if (isIpv4Mapped(bytes)) {
      return isBlockedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
    return isBlockedIpv6(bytes);
  }
  return false;
}

/** Loopback puro (127.0.0.0/8 ou ::1) — o único caso liberável com allowLocalhost. */
function isLoopbackLiteral(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (isIP(normalized) === 4) {
    const octets = parseIpv4(normalized);
    return octets !== null && octets[0] === 127;
  }
  if (isIP(normalized) === 6) {
    const bytes = parseIpv6(normalized);
    if (bytes === null) return false;
    if (isIpv4Mapped(bytes)) return bytes[12] === 127;
    return bytes.every((byte, i) => (i === 15 ? byte === 1 : byte === 0));
  }
  return false;
}

function resolveOptions(options: SsrfOptions = {}): { production: boolean; allowLocalhost: boolean } {
  const production = options.production ?? (process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL));
  const allowLocalhost = options.allowLocalhost ?? !production;
  return { production, allowLocalhost };
}

/**
 * Validação central de URL (usada pela URL inicial e por cada redirecionamento).
 * `prefix` aparece no início da mensagem de erro ('URL de provedor: ' ou
 * 'Redirecionamento bloqueado: ').
 */
function assertSafeUrl(rawUrl: string, options: SsrfOptions, prefix: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw ssrfError(`${prefix}'${rawUrl}' não é uma URL absoluta válida.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw ssrfError(`${prefix}O esquema precisa ser http ou https (recebido '${url.protocol}').`);
  }

  if (url.username || url.password) {
    throw ssrfError(`${prefix}Credenciais (user:password@) não são permitidas na URL.`);
  }

  const { production, allowLocalhost } = resolveOptions(options);
  if (production && url.protocol !== 'https:') {
    throw ssrfError(`${prefix}Em produção, somente HTTPS é permitido (recebido '${url.protocol}').`);
  }

  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      const liberavel = allowLocalhost && isLoopbackLiteral(hostname);
      if (!liberavel) {
        throw ssrfError(
          `${prefix}O endereço '${hostname}' está em faixa bloqueada (privado, loopback, link-local ou metadata).`,
        );
      }
    }
    return;
  }

  if (hostname === 'localhost' && !allowLocalhost) {
    throw ssrfError(`${prefix}'localhost' não é permitido em produção.`);
  }
}

/**
 * Valida a URL base de um provedor OpenAI-compatível, lançando AppError
 * (código 'UNKNOWN', status 400) quando a URL é insegura.
 */
export function assertSafeProviderUrl(baseURL: string, options: SsrfOptions = {}): void {
  assertSafeUrl(baseURL, options, 'URL de provedor: ');
}

/**
 * Revalida uma URL de redirecionamento com as mesmas regras da URL inicial
 * (credenciais, faixas de IP, HTTPS em produção). Chame antes de seguir
 * cada Location de resposta 3xx.
 */
export function assertSafeRedirect(url: string, options: SsrfOptions = {}): void {
  assertSafeUrl(url, options, 'Redirecionamento bloqueado: ');
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

/**
 * Resolve um hostname para uma lista de endereços (todos, com ordem
 * verbatim). Não bloqueia nada aqui — apenas resolve; use
 * `assertSafeHostResolved` para validar.
 */
export async function resolveSafeHost(hostname: string, options: { lookup?: LookupFn } = {}): Promise<string[]> {
  const lookup = options.lookup ?? defaultLookup;
  return lookup(hostname);
}

/**
 * Resolve o hostname e valida que NENHUM endereço resolvido está em faixa
 * bloqueada (mesmas regras de `assertSafeProviderUrl`). A única exceção:
 * com `allowLocalhost`, endereços de loopback são aceitos. Use antes do
 * fetch para mitigar DNS rebinding.
 */
export async function assertSafeHostResolved(hostname: string, options: SsrfOptions = {}): Promise<void> {
  const { allowLocalhost } = resolveOptions(options);
  const addresses = await resolveSafeHost(hostname, { lookup: options.lookup });

  for (const address of addresses) {
    if (!isBlockedIp(address)) continue;
    if (allowLocalhost && isLoopbackLiteral(address)) continue;
    throw ssrfError(
      `Host '${hostname}' resolveu para '${address}', que está em faixa bloqueada (possível SSRF ou DNS rebinding).`,
    );
  }
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Fetch com proteção SSRF e controle de redirecionamentos:
 * 1. valida a URL inicial (assertSafeProviderUrl);
 * 2. resolve/valida o DNS do host inicial (assertSafeHostResolved);
 * 3. faz fetch com `redirect: 'manual'` (sobrescreve init.redirect);
 * 4. a cada resposta 3xx, extrai Location, revalida a URL e o DNS, e segue
 *    até `maxRedirects` (default 5). Exceder o limite lança AppError.
 *
 * Observações:
 * - O método/body do init original é preservado nos redirecionamentos
 *   (provedores compatíveis devem usar 307/308 para POST).
 * - Respostas 3xx sem Location são devolvidas como estão.
 * - `production` é detectado do ambiente quando a opção não é passada.
 */
export async function safeFetchWithRedirects(
  input: string | URL,
  init: RequestInit = {},
  options: SsrfOptions = {},
): Promise<Response> {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, fetchImpl = fetch } = options;

  let current: URL;
  try {
    current = new URL(String(input));
  } catch {
    throw ssrfError(`URL de provedor: '${String(input)}' não é uma URL absoluta válida.`);
  }

  assertSafeProviderUrl(current.toString(), options);
  await assertSafeHostResolved(current.hostname, options);

  let followed = 0;
  for (;;) {
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });

    if (!isRedirectStatus(response.status)) return response;

    if (followed >= maxRedirects) {
      throw ssrfError(`Redirecionamento bloqueado: limite de ${maxRedirects} redirecionamentos excedido.`);
    }

    const location = response.headers.get('location');
    if (!location) return response;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw ssrfError(`Redirecionamento bloqueado: Location '${location}' inválida.`);
    }

    assertSafeRedirect(next.toString(), options);
    await assertSafeHostResolved(next.hostname, options);

    current = next;
    followed += 1;
  }
}
