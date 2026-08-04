import { describe, expect, it } from 'vitest';
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
    for await (const event of client.stream({
      providerId: 'ollama',
      modelId: 'llama3.2',
      messages: [{ role: 'user', content: 'oi' }],
      signal: new AbortController().signal,
      connectionTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
    })) {
      events.push(event);
    }
    expect(calls).toBe(2);
    expect(events).toContainEqual({ kind: 'text', text: 'ok' });
    expect(events).toContainEqual({ kind: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  });
});

