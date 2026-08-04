import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './queries';

describe('ChatDatabase', () => {
  it('initializes SQLite, persists messages, updates FTS and cascades deletes', () => {
    const database = new ChatDatabase(':memory:');
    try {
      const conversation = database.createConversation({
        title: 'Teste',
        providerId: 'ollama',
        modelId: 'llama3.2',
      });
      const message = database.insertMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'encontre esta palavra rara',
        providerId: 'ollama',
        modelId: 'llama3.2',
      });
      expect(database.searchConversations('palavra rara')).toHaveLength(1);
      database.updateMessage(message.id, { content: 'texto atualizado' });
      expect(database.searchConversations('palavra rara')).toHaveLength(0);
      expect(database.searchConversations('atualizado')).toHaveLength(1);
      database.insertMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'resposta',
        providerId: 'ollama',
        modelId: 'llama3.2',
        cost: { usd: 0.0012, estimated: false, pricingAvailable: true },
      });
      expect(database.getCostAnalytics(30).byModel[0]?.modelId).toBe('llama3.2');
      expect(database.getCostAnalytics(30).totalCostUsd).toBeCloseTo(0.0012);
      expect(database.deleteConversation(conversation.id)).toBe(true);
      expect(database.getConversation(conversation.id)).toBeNull();
      expect(database.getMessages(conversation.id)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
