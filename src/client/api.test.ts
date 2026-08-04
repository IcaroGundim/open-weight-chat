import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cliente SSE do chat', () => {
  it('consome o envelope normalizado do servidor e agrupa deltas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'event: text\n' +
      'data: {"type":"text","text":"olá","conversationId":"c1","messageId":"m1"}\n\n' +
      'event: reasoning\n' +
      'data: {"type":"reasoning","reasoning":"pensei"}\n\n' +
      'event: usage\n' +
      'data: {"type":"usage","usage":{"promptTokens":2,"completionTokens":1,"totalTokens":3,"estimated":false},"cost":{"usd":0.0001,"estimated":false,"pricingAvailable":true}}\n\n' +
      'event: done\n' +
      'data: {"type":"done","done":true,"finishReason":"stop"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )));
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
  });

  it('expõe início, deltas agrupados e fim de artefato', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
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
    )));
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
  });
});
