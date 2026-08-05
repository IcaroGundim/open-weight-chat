import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './queries';

const USER_A = 'user_test_a';
const USER_B = 'user_test_b';

describe('artifact persistence', () => {
  it('stores versions, retrieves them, searches current content and cascades with a conversation', () => {
    const database = new ChatDatabase(':memory:');
    try {
      const conversation = database.createConversation(USER_A, { providerId: 'ollama', modelId: 'llama3.2' });
      database.insertArtifactVersion(USER_A, {
        conversationId: conversation.id,
        slug: 'demo',
        kind: 'code',
        language: 'ts',
        title: 'Demo',
        content: 'const oldMarker = true;',
        operation: 'create',
      });
      database.insertArtifactVersion(USER_A, {
        conversationId: conversation.id,
        slug: 'demo',
        kind: 'code',
        language: 'ts',
        title: 'Demo',
        content: 'const currentMarker = true;',
        operation: 'update',
      });
      expect(database.getArtifacts(USER_A, conversation.id)[0]?.currentVersion).toBe(2);
      expect(database.getArtifactVersion(USER_A, conversation.id, 'demo', 1)?.content).toContain('oldMarker');
      expect(database.searchConversations(USER_A, 'currentMarker')).toHaveLength(1);
      expect(database.searchConversations(USER_A, 'oldMarker')).toHaveLength(0);
      expect(database.deleteConversation(USER_A, conversation.id)).toBe(true);
      expect(database.getArtifacts(USER_A, conversation.id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('isola artefatos entre usuários: B não vê nem altera artefatos de A', () => {
    const database = new ChatDatabase(':memory:');
    try {
      const conversationA = database.createConversation(USER_A, { providerId: 'ollama', modelId: 'llama3.2' });
      database.insertArtifactVersion(USER_A, {
        conversationId: conversationA.id,
        slug: 'demo',
        kind: 'code',
        language: 'ts',
        title: 'Demo',
        content: 'const segredoDeA = true;',
        operation: 'create',
      });

      // Leitura de B não enxerga nada da conversa de A.
      expect(database.getArtifacts(USER_B, conversationA.id)).toEqual([]);
      expect(database.getArtifactVersion(USER_B, conversationA.id, 'demo', 1)).toBeNull();
      expect(database.searchConversations(USER_B, 'segredoDeA')).toEqual([]);
      expect(database.searchConversations(USER_A, 'segredoDeA')).toHaveLength(1);

      // Atualização de custo de B não afeta a versão de A.
      expect(database.updateArtifactVersionCost(USER_B, conversationA.id, 'demo', 1, 10, 0.5)).toBe(false);
      expect(database.getArtifactVersion(USER_A, conversationA.id, 'demo', 1)?.outputTokens).toBeNull();
      expect(database.getArtifactVersion(USER_A, conversationA.id, 'demo', 1)?.costUsd).toBeNull();

      // A continua vendo os próprios artefatos intactos.
      expect(database.getArtifacts(USER_A, conversationA.id)).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
