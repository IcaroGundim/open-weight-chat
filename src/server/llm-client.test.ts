import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { OpenAICompatibleClient, parseProviderChunk } from './llm-client';

function sseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function streamOptions(overrides: Partial<Parameters<OpenAICompatibleClient['stream']>[0]> = {}) {
  return {
    providerId: 'ollama' as const,
    modelId: 'llama3.2',
    baseURL: 'http://localhost:11434/v1/',
    apiKey: null,
    requiresApiKey: false,
    messages: [{ role: 'user' as const, content: 'oi' }],
    signal: new AbortController().signal,
    connectionTimeoutMs: 1_000,
    inactivityTimeoutMs: 1_000,
    ...overrides,
  };
}

describe('OpenAI-compatible streaming', () => {
  it('normalizes text, reasoning and final usage chunks', () => {
    expect(parseProviderChunk({ choices: [{ delta: { content: 'oi', reasoning_content: 'pensei' } }] })).toEqual([
      { kind: 'text', text: 'oi' },
      { kind: 'reasoning', reasoning: 'pensei' },
    ]);
    expect(parseProviderChunk({ choices: [], usage: { prompt_tokens: 2 } })).toEqual([
      { kind: 'usage', usage: { prompt_tokens: 2 } },
    ]);
  });

  it('retries a 429 before the first token and yields SSE deltas', async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient(async () => {
      calls += 1;
      if (calls === 1) return new Response('{"error":"rate limit"}', { status: 429 });
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    const events = [];
    for await (const event of client.stream(streamOptions())) {
      events.push(event);
    }
    expect(calls).toBe(2);
    expect(events).toContainEqual({ kind: 'text', text: 'ok' });
    expect(events).toContainEqual({ kind: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  });

  it('envia o campo de esforço no corpo e omite quando o nível é auto', async () => {
    const bodies: string[] = [];
    const client = new OpenAICompatibleClient(async (_input, init) => {
      bodies.push(String(init?.body));
      return sseResponse(['data: [DONE]\n\n']);
    });
    for await (const _ of client.stream(streamOptions({ effort: 'high' }))) {
      // apenas consome o stream
    }
    for await (const _ of client.stream(streamOptions({ effort: 'auto' }))) {
      // apenas consome o stream
    }
    expect(JSON.parse(bodies[0]).reasoning_effort).toBe('high');
    expect(JSON.parse(bodies[1])).not.toHaveProperty('reasoning_effort');
  });

  it('repete sem o campo de esforço quando o provedor devolve 400 reclamando dele', async () => {
    const bodies: string[] = [];
    const client = new OpenAICompatibleClient(async (_input, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        return new Response('{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}', { status: 400 });
      }
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const events = [];
    for await (const event of client.stream(streamOptions({ effort: 'high' }))) {
      events.push(event);
    }
    // A mensagem chega: a preferência do usuário não derruba o envio.
    expect(events).toContainEqual({ kind: 'text', text: 'ok' });
    expect(JSON.parse(bodies[0]).reasoning_effort).toBe('high');
    expect(JSON.parse(bodies[1])).not.toHaveProperty('reasoning_effort');
  });

  it('não repete um 400 que nada tem a ver com o esforço', async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient(async () => {
      calls += 1;
      return new Response('{"error":{"message":"maximum context length is 65536 tokens"}}', { status: 400 });
    });
    await expect(client.stream(streamOptions({ effort: 'high' })).next()).rejects.toThrow();
    // Repetir aqui só faria o usuário esperar duas vezes pelo mesmo erro.
    expect(calls).toBe(1);
  });

  it('normalizes a trailing slash in the base URL', async () => {
    const requested: string[] = [];
    const client = new OpenAICompatibleClient(async (input) => {
      requested.push(String(input));
      return sseResponse(['data: [DONE]\n\n']);
    });
    for await (const _ of client.stream(streamOptions({ baseURL: 'http://localhost:11434/v1///' }))) {
      // apenas consome o stream
    }
    expect(requested[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('blocks a private endpoint before opening a chat stream', async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient(async () => {
      calls += 1;
      return sseResponse(['data: [DONE]\n\n']);
    });

    await expect(client.stream(streamOptions({ baseURL: 'http://169.254.169.254/v1' })).next())
      .rejects.toThrow(/faixa bloqueada/);
    expect(calls).toBe(0);
  });

  it('blocks a chat redirect to metadata', async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient(async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    });

    await expect(client.stream(streamOptions()).next()).rejects.toThrow(/Redirecionamento bloqueado/);
    expect(calls).toBe(1);
  });

  it('rejects a missing key when the provider requires one', async () => {
    const client = new OpenAICompatibleClient(async () => {
      throw new Error('não deve chamar o upstream');
    });
    await expect(
      (async () => {
        for await (const _ of client.stream(streamOptions({ requiresApiKey: true, apiKey: null }))) {
          // nunca chega aqui
        }
      })(),
    ).rejects.toMatchObject({
      code: 'INVALID_API_KEY',
      message: 'Configure a chave deste provedor em Configurações → Provedores.',
    });
  });

  it('sends the resolved apiKey as a Bearer token', async () => {
    const headers: Array<Record<string, string>> = [];
    const client = new OpenAICompatibleClient(async (_input, init) => {
      headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return sseResponse(['data: [DONE]\n\n']);
    });
    for await (const _ of client.stream(streamOptions({ requiresApiKey: true, apiKey: 'sk-do-usuario' }))) {
      // apenas consome o stream
    }
    expect(headers[0].authorization).toBe('Bearer sk-do-usuario');
  });
});

describe('validação de opções', () => {
  it('falha com MODEL_NOT_FOUND quando a baseURL está vazia', async () => {
    const client = new OpenAICompatibleClient();
    const error = await client
      .stream(streamOptions({ baseURL: '' }))
      .next()
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('MODEL_NOT_FOUND');
  });
});
