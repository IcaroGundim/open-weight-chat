import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './queries';

describe('artifact persistence', () => {
  it('stores versions, retrieves them, searches current content and cascades with a conversation', () => {
    const database = new ChatDatabase(':memory:');
    try {
      const conversation = database.createConversation({ providerId: 'ollama', modelId: 'llama3.2' });
      database.insertArtifactVersion({
        conversationId: conversation.id,
        slug: 'demo',
        kind: 'code',
        language: 'ts',
        title: 'Demo',
        content: 'const oldMarker = true;',
        operation: 'create',
      });
      database.insertArtifactVersion({
        conversationId: conversation.id,
        slug: 'demo',
        kind: 'code',
        language: 'ts',
        title: 'Demo',
        content: 'const currentMarker = true;',
        operation: 'update',
      });
      expect(database.getArtifacts(conversation.id)[0]?.currentVersion).toBe(2);
      expect(database.getArtifactVersion(conversation.id, 'demo', 1)?.content).toContain('oldMarker');
      expect(database.searchConversations('currentMarker')).toHaveLength(1);
      expect(database.searchConversations('oldMarker')).toHaveLength(0);
      expect(database.deleteConversation(conversation.id)).toBe(true);
      expect(database.getArtifacts(conversation.id)).toEqual([]);
    } finally {
      database.close();
    }
  });
});

