import { describe, expect, it } from 'vitest';

import {
  assertSafeHostResolved,
  assertSafeProviderUrl,
  assertSafeRedirect,
  isBlockedIp,
  resolveSafeHost,
  safeFetchWithRedirects,
} from './ssrf';

/** Lookup fake que resolve para um IP público seguro. */
const safeLookup = async (): Promise<string[]> => ['93.184.216.34'];

/** Cria um fetchImpl fake que delega a um handler por URL. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(String(input), init));
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // metadata
    '::1',
    'fc00::1',
    'fe80::1',
    '0.0.0.0',
    '::ffff:10.0.0.1', // IPv4-mapped
  ])('bloqueia %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1'])('permite %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('não trata hostnames como IPs', () => {
    expect(isBlockedIp('api.openai.com')).toBe(false);
  });
});

describe('assertSafeProviderUrl', () => {
  it('aceita URL https pública em produção', () => {
    expect(() => assertSafeProviderUrl('https://api.openai.com/v1', { production: true })).not.toThrow();
  });

  it('exige HTTPS em produção', () => {
    expect(() => assertSafeProviderUrl('http://api.x.com/v1', { production: true })).toThrow(/HTTPS/);
  });

  it('bloqueia credenciais embutidas na URL', () => {
    expect(() => assertSafeProviderUrl('https://user:pass@host/v1', { production: true })).toThrow(/credenciais/i);
  });

  it('bloqueia IP privado mesmo em desenvolvimento', () => {
    expect(() =>
      assertSafeProviderUrl('http://192.168.1.1:8080/v1', { production: false, allowLocalhost: true }),
    ).toThrow(/faixa bloqueada/);
  });

  it('bloqueia IP privado não-loopback em produção', () => {
    expect(() => assertSafeProviderUrl('https://10.0.0.5/v1', { production: true })).toThrow(/faixa bloqueada/);
  });

  it('permite http://localhost em desenvolvimento', () => {
    expect(() => assertSafeProviderUrl('http://localhost:11434/v1', { allowLocalhost: true })).not.toThrow();
  });

  it('bloqueia localhost em produção', () => {
    expect(() => assertSafeProviderUrl('https://localhost:11434/v1', { production: true })).toThrow(/não é permitido/);
    expect(() => assertSafeProviderUrl('http://localhost:11434/v1', { production: true })).toThrow();
  });

  it('permite loopback em desenvolvimento', () => {
    expect(() => assertSafeProviderUrl('http://127.0.0.1:11434/v1', { allowLocalhost: true })).not.toThrow();
  });

  it('bloqueia loopback em produção', () => {
    expect(() => assertSafeProviderUrl('https://127.0.0.1:11434/v1', { production: true })).toThrow(/faixa bloqueada/);
  });

  it('recusa URL sem protocolo', () => {
    expect(() => assertSafeProviderUrl('api.openai.com/v1')).toThrow(/URL de provedor/);
  });

  it('recusa esquema não-http(s)', () => {
    expect(() => assertSafeProviderUrl('ftp://api.openai.com/v1')).toThrow(/http ou https/);
  });

  it('detecta produção pelo ambiente quando a opção não é passada', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => assertSafeProviderUrl('http://api.x.com/v1')).toThrow(/HTTPS/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('assertSafeRedirect', () => {
  it('aceita redirecionamento seguro', () => {
    expect(() => assertSafeRedirect('https://api.openai.com/v2', { production: true })).not.toThrow();
  });

  it('bloqueia redirecionamento para metadata', () => {
    expect(() => assertSafeRedirect('http://169.254.169.254/latest/meta-data', { production: false })).toThrow(
      /Redirecionamento bloqueado/,
    );
  });

  it('bloqueia redirecionamento com credenciais', () => {
    expect(() => assertSafeRedirect('https://user:pass@api.openai.com/v2', { production: true })).toThrow(
      /Redirecionamento bloqueado/,
    );
  });

  it('exige HTTPS em redirecionamento em produção', () => {
    expect(() => assertSafeRedirect('http://api.openai.com/v2', { production: true })).toThrow(/HTTPS/);
  });
});

describe('resolveSafeHost', () => {
  it('resolve com lookup injetado', async () => {
    const addresses = await resolveSafeHost('api.exemplo.com', {
      lookup: async () => ['1.1.1.1', '2606:4700::1111'],
    });
    expect(addresses).toEqual(['1.1.1.1', '2606:4700::1111']);
  });

  it.skip('integração com DNS real (requer rede)', async () => {
    const addresses = await resolveSafeHost('example.com');
    expect(addresses.length).toBeGreaterThan(0);
  });
});

describe('assertSafeHostResolved', () => {
  it('aceita hostname que resolve para IP público', async () => {
    await expect(assertSafeHostResolved('api.openai.com', { lookup: safeLookup })).resolves.toBeUndefined();
  });

  it('bloqueia hostname que resolve para IP privado (DNS rebinding)', async () => {
    await expect(
      assertSafeHostResolved('api.exemplo.com', { lookup: async () => ['10.0.0.1'] }),
    ).rejects.toThrow(/faixa bloqueada/);
  });

  it('bloqueia resolução para loopback sem allowLocalhost', async () => {
    await expect(
      assertSafeHostResolved('api.exemplo.com', { allowLocalhost: false, lookup: async () => ['127.0.0.1'] }),
    ).rejects.toThrow(/faixa bloqueada/);
  });

  it('aceita localhost resolvendo para loopback com allowLocalhost', async () => {
    await expect(
      assertSafeHostResolved('localhost', { allowLocalhost: true, lookup: async () => ['127.0.0.1'] }),
    ).resolves.toBeUndefined();
  });

  it('bloqueia quando QUALQUER endereço resolvido é bloqueado', async () => {
    await expect(
      assertSafeHostResolved('api.exemplo.com', { lookup: async () => ['93.184.216.34', '192.168.0.10'] }),
    ).rejects.toThrow(/faixa bloqueada/);
  });
});

describe('safeFetchWithRedirects', () => {
  it('retorna resposta direta sem redirecionamento', async () => {
    const fetchImpl = fakeFetch(() => new Response('ok', { status: 200 }));
    const response = await safeFetchWithRedirects('https://api.openai.com/v1', {}, { production: true, lookup: safeLookup, fetchImpl });
    expect(response.status).toBe(200);
  });

  it('segue redirecionamento para URL segura', async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      urls.push(url);
      if (url.includes('/v1')) return redirectResponse('https://api.openai.com/v2');
      return new Response('ok', { status: 200 });
    });

    const response = await safeFetchWithRedirects(
      'https://api.openai.com/v1',
      {},
      { production: true, lookup: safeLookup, fetchImpl },
    );

    expect(response.status).toBe(200);
    expect(urls).toEqual(['https://api.openai.com/v1', 'https://api.openai.com/v2']);
  });

  it('segue redirecionamento relativo', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/v1')) return redirectResponse('/v2');
      return new Response('ok', { status: 200 });
    });

    const response = await safeFetchWithRedirects(
      'https://api.openai.com/v1',
      {},
      { production: true, lookup: safeLookup, fetchImpl },
    );
    expect(response.status).toBe(200);
  });

  it('bloqueia redirecionamento para metadata (SSRF)', async () => {
    const fetchImpl = fakeFetch(() => redirectResponse('http://169.254.169.254/latest/meta-data'));
    await expect(
      safeFetchWithRedirects('https://api.openai.com/v1', {}, { production: false, lookup: safeLookup, fetchImpl }),
    ).rejects.toThrow(/Redirecionamento bloqueado/);
  });

  it('bloqueia redirecionamento com credenciais', async () => {
    const fetchImpl = fakeFetch(() => redirectResponse('https://user:pass@api.openai.com/v2'));
    await expect(
      safeFetchWithRedirects('https://api.openai.com/v1', {}, { production: true, lookup: safeLookup, fetchImpl }),
    ).rejects.toThrow(/credenciais/i);
  });

  it('para ao exceder maxRedirects em loop de redirecionamentos', async () => {
    const fetchImpl = fakeFetch(() => redirectResponse('https://api.openai.com/loop'));
    await expect(
      safeFetchWithRedirects('https://api.openai.com/loop', {}, { production: true, lookup: safeLookup, maxRedirects: 3, fetchImpl }),
    ).rejects.toThrow(/limite de 3/);
  });

  it('valida a URL inicial antes de qualquer fetch', async () => {
    const fetchImpl = fakeFetch(() => new Response('ok', { status: 200 }));
    await expect(
      safeFetchWithRedirects('https://10.0.0.5/v1', {}, { production: true, lookup: safeLookup, fetchImpl }),
    ).rejects.toThrow(/faixa bloqueada/);
  });
});
