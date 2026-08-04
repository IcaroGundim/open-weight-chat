import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './db/queries';
import { createApp } from './index';

describe('Hono API', () => {
  it('serves models and conversation CRUD without external dependencies', async () => {
    const database = new ChatDatabase(':memory:');
    try {
      const app = createApp({ db: database });
      const models = await app.request('/api/models');
      expect(models.status).toBe(200);
      expect((await models.json()).providers).toHaveLength(5);

      const created = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'ollama', modelId: 'llama3.2', title: 'CRUD' }),
      });
      expect(created.status).toBe(201);
      const conversation = (await created.json()).conversation;
      expect(conversation.title).toBe('CRUD');

      const updated = await app.request(`/api/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Atualizada', archived: true }),
      });
      expect(updated.status).toBe(200);
      expect((await updated.json()).conversation.title).toBe('Atualizada');

      const deleted = await app.request(`/api/conversations/${conversation.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
    } finally {
      database.close();
    }
  });

  it('proxies a compatible SSE stream and persists the assistant response', async () => {
    const database = new ChatDatabase(':memory:');
    try {
      const app = createApp({
        db: database,
        fetchImpl: async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"olá"}}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const response = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'diga olá',
          providerId: 'ollama',
          modelId: 'llama3.2',
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"type":"text"');
      expect(body).toContain('"type":"done"');
      const conversations = database.listConversations();
      expect(conversations).toHaveLength(1);
      const messages = database.getMessages(conversations[0].id);
      expect(messages.at(-1)?.content).toBe('olá');
      expect(messages.at(-1)?.finishReason).toBe('stop');
    } finally {
      database.close();
    }
  });

  it('parses artifact streams into versioned storage and applies a later patch', async () => {
    const database = new ChatDatabase(':memory:');
    let call = 0;
    try {
      const app = createApp({
        db: database,
        fetchImpl: async () => {
          call += 1;
          const content = call === 1
            ? '<artifact id="demo" type="code" language="ts" title="Demo">const value = 1;</artifact>'
            : '<artifact-update id="demo"><find>const value = 1;</find><replace>const value = 2;</replace></artifact-update>';
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
              'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":8,"total_tokens":11}}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });

      const first = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'crie um artefato', providerId: 'ollama', modelId: 'llama3.2' }),
      });
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(firstBody).toContain('artifact_start');
      expect(firstBody).toContain('artifact_delta');
      expect(firstBody).toContain('artifact_end');
      const conversation = database.listConversations()[0];
      const firstArtifacts = database.getArtifacts(conversation.id);
      expect(firstArtifacts[0]?.versions[0]?.content).toBe('const value = 1;');
      expect(database.getMessages(conversation.id).at(-1)?.content).toContain('[[artefato:demo@1]]');
      expect(database.getMessages(conversation.id).at(-1)?.content).not.toContain('const value = 1;');

      const second = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.id, content: 'mude para 2', providerId: 'ollama', modelId: 'llama3.2' }),
      });
      expect(second.status).toBe(200);
      await second.text();
      const versions = database.getArtifacts(conversation.id)[0]?.versions ?? [];
      expect(versions).toHaveLength(2);
      expect(versions[1]?.operation).toBe('update');
      expect(versions[1]?.content).toBe('const value = 2;');
      expect(database.getMessages(conversation.id).at(-1)?.content).toContain('[[artefato:demo@2]]');
    } finally {
      database.close();
    }
  });
});
