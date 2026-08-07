import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getConversation, streamChat } from './api';
import { authHeaders, setTokenProvider } from './token-provider';

beforeEach(() => {
  // Sessão fake: api.ts não conhece o Clerk; o provider injetável resolve o token.
  setTokenProvider(async () => 'token-de-teste');
});

afterEach(() => {
  setTokenProvider(null);
  vi.unstubAllGlobals();
});

describe('cliente SSE do chat', () => {
  it('consome o envelope normalizado do servidor e agrupa deltas', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      'event: text\n' +
      'data: {"type":"text","text":"olá","conversationId":"c1","messageId":"m1"}\n\n' +
      'event: reasoning\n' +
      'data: {"type":"reasoning","reasoning":"pensei"}\n\n' +
      'event: usage\n' +
      'data: {"type":"usage","usage":{"promptTokens":2,"completionTokens":1,"totalTokens":3,"estimated":false},"cost":{"usd":0.0001,"estimated":false,"pricingAvailable":true}}\n\n' +
      'event: done\n' +
      'data: {"type":"done","done":true,"finishReason":"stop"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const text: string[] = [];
    const reasoning: string[] = [];
    const usage: number[] = [];
    const done: string[] = [];

    await streamChat(
      { conversationId: 'c1', content: 'oi', providerId: 'ollama', modelId: 'llama3.2' },
      {
        onText: (value) => text.push(value),
        onReasoning: (value) => reasoning.push(value),
        onUsage: (value) => usage.push(value.totalTokens ?? 0),
        onDone: (value) => done.push(String(value.finishReason)),
      },
      new AbortController().signal,
    );

    expect(text.join('')).toBe('olá');
    expect(reasoning.join('')).toBe('pensei');
    expect(usage).toEqual([3]);
    expect(done).toEqual(['stop']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-de-teste' }),
      }),
    );
  });

  it('expõe início, deltas agrupados e fim de artefato', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      'event: artifact_start\n' +
      'data: {"type":"artifact_start","slug":"cliente-sse","kind":"code","language":"typescript","title":"Cliente SSE","version":1,"operation":"create"}\n\n' +
      'event: artifact_delta\n' +
      'data: {"type":"artifact_delta","slug":"cliente-sse","text":"const "}\n\n' +
      'event: artifact_delta\n' +
      'data: {"type":"artifact_delta","slug":"cliente-sse","text":"answer = 42;"}\n\n' +
      'event: artifact_end\n' +
      'data: {"type":"artifact_end","slug":"cliente-sse","version":1,"truncated":false,"outputTokens":12,"costUsd":0.0012}\n\n' +
      'event: done\n' +
      'data: {"type":"done"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const events: string[] = [];
    await streamChat(
      { conversationId: 'c1', content: 'oi', providerId: 'ollama', modelId: 'llama3.2' },
      {
        onArtifactStart: (value) => events.push(`start:${value.slug}@${value.version}`),
        onArtifactDelta: (value) => events.push(`delta:${value.text}`),
        onArtifactEnd: (value) => events.push(`end:${value.slug}@${value.version}`),
      },
      new AbortController().signal,
    );
    expect(events).toEqual(['start:cliente-sse@1', 'delta:const answer = 42;', 'end:cliente-sse@1']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-de-teste' }),
      }),
    );
  });

  it('entrega a planilha nativa criada durante o stream', async () => {
    const attachment = { id: 'sheet-1', kind: 'spreadsheet', filename: 'pg.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 1200, textChars: null, truncated: false, spreadsheet: { sheetNames: ['PG'], version: 1 }, createdAt: 10 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `event: spreadsheet_ready\ndata: ${JSON.stringify({ type: 'spreadsheet_ready', attachment })}\n\nevent: done\ndata: {"type":"done"}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )));
    const received: string[] = [];
    await streamChat(
      { conversationId: 'c1', content: 'crie', providerId: 'ollama', modelId: 'llama3.2' },
      { onSpreadsheetReady: (event) => received.push(event.attachment.filename) },
      new AbortController().signal,
    );
    expect(received).toEqual(['pg.xlsx']);
  });
});

describe('autenticação do cliente HTTP', () => {
  it('monta o header Authorization com o token do provider', async () => {
    await expect(authHeaders()).resolves.toEqual({ Authorization: 'Bearer token-de-teste' });
  });

  it('lança ApiError 401 com mensagem clara quando não há sessão', async () => {
    setTokenProvider(null);
    const error = await authHeaders().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('Sessão expirada. Faça login novamente.');
  });

  it('não chama fetch quando a sessão expirou', async () => {
    setTokenProvider(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      streamChat(
        { conversationId: 'c1', content: 'oi', providerId: 'ollama', modelId: 'llama3.2' },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('carregamento da conversa', () => {
  it('preserva anexos de planilha ao normalizar mensagens reabertas', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [{
        id: 'm1', conversationId: 'c1', role: 'user', content: 'analise', createdAt: 1,
        attachments: [{ id: 'p1', kind: 'spreadsheet', filename: 'dados.csv', mime: 'text/csv', sizeBytes: 20, textChars: null, truncated: false, spreadsheet: { sheetNames: ['Dados'], version: 3 }, createdAt: 1 }],
      }] }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ conversation: { id: 'c1', title: 'Dados' } }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getConversation('c1');
    expect(result.messages[0].attachments?.[0]).toMatchObject({
      id: 'p1', kind: 'spreadsheet', spreadsheet: { sheetNames: ['Dados'], version: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
