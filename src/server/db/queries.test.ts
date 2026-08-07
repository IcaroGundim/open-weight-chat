import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './queries';

const USER_A = 'user_test_a';
const USER_B = 'user_test_b';

describe('ChatDatabase', () => {
  it('initializes SQLite, persists messages, updates FTS and cascades deletes', () => {
    const database = new ChatDatabase(':memory:');
    try {
      const conversation = database.createConversation(USER_A, {
        title: 'Teste',
        providerId: 'ollama',
        modelId: 'llama3.2',
      });
      const message = database.insertMessage(USER_A, {
        conversationId: conversation.id,
        role: 'user',
        content: 'encontre esta palavra rara',
        providerId: 'ollama',
        modelId: 'llama3.2',
      });
      expect(database.searchConversations(USER_A, 'palavra rara')).toHaveLength(1);
      database.updateMessage(USER_A, message.id, { content: 'texto atualizado' });
      expect(database.searchConversations(USER_A, 'palavra rara')).toHaveLength(0);
      expect(database.searchConversations(USER_A, 'atualizado')).toHaveLength(1);
      database.insertMessage(USER_A, {
        conversationId: conversation.id,
        role: 'assistant',
        content: 'resposta',
        providerId: 'ollama',
        modelId: 'llama3.2',
        cost: { usd: 0.0012, estimated: false, pricingAvailable: true, reported: false },
      });
      expect(database.getCostAnalytics(USER_A, 30).byModel[0]?.modelId).toBe('llama3.2');
      expect(database.getCostAnalytics(USER_A, 30).totalCostUsd).toBeCloseTo(0.0012);
      expect(database.deleteConversation(USER_A, conversation.id)).toBe(true);
      expect(database.getConversation(USER_A, conversation.id)).toBeNull();
      expect(database.getMessages(USER_A, conversation.id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('ensureUser cria o usuário e é idempotente', () => {
    const database = new ChatDatabase(':memory:');
    try {
      database.ensureUser(USER_A);
      database.ensureUser(USER_A); // segunda chamada não pode quebrar
      // O usuário segue operacional depois do upsert repetido.
      const conversation = database.createConversation(USER_A, { providerId: 'ollama', modelId: 'llama3.2' });
      expect(database.getConversation(USER_A, conversation.id)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it('isola conversas, mensagens, custos e provedores entre usuários no mesmo banco', () => {
    const database = new ChatDatabase(':memory:');
    try {
      // Usuário A cria conversa com mensagem paga e provedor.
      const conversationA = database.createConversation(USER_A, {
        title: 'Segredo de A',
        providerId: 'ollama',
        modelId: 'llama3.2',
      });
      database.insertMessage(USER_A, {
        conversationId: conversationA.id,
        role: 'assistant',
        content: 'termo-secreto-de-a',
        providerId: 'ollama',
        modelId: 'llama3.2',
        cost: { usd: 5, estimated: false, pricingAvailable: true, reported: false },
      });
      database.upsertProviderSettings(USER_A, {
        id: 'openrouter',
        label: 'OpenRouter de A',
        baseURL: 'https://a.example',
        models: [],
      });

      // B não vê nada de A.
      expect(database.listConversations(USER_B)).toEqual([]);
      expect(database.getConversation(USER_B, conversationA.id)).toBeNull();
      expect(database.getMessages(USER_B, conversationA.id)).toEqual([]);
      expect(database.searchConversations(USER_B, 'Segredo')).toEqual([]);
      expect(database.searchConversations(USER_B, 'termo-secreto-de-a')).toEqual([]);
      expect(database.listProviderSettings(USER_B)).toEqual([]);
      expect(database.deleteProviderSettings(USER_B, 'openrouter')).toBe(false);
      expect(database.getCostAnalytics(USER_B, 30).totalCostUsd).toBe(0);
      expect(database.getCostAnalytics(USER_B, 30).byModel).toEqual([]);

      // A continua vendo os próprios recursos.
      expect(database.listConversations(USER_A)).toHaveLength(1);
      expect(database.getCostAnalytics(USER_A, 30).totalCostUsd).toBeCloseTo(5);

      // B não consegue alterar nem apagar a conversa de A.
      expect(database.updateConversation(USER_B, conversationA.id, { title: 'invadido' })).toBeNull();
      expect(database.deleteConversation(USER_B, conversationA.id)).toBe(false);
      expect(database.getConversation(USER_A, conversationA.id)?.title).toBe('Segredo de A');
    } finally {
      database.close();
    }
  });

  it('permite que dois usuários tenham provider_settings com o mesmo id e valores diferentes', () => {
    const database = new ChatDatabase(':memory:');
    try {
      database.upsertProviderSettings(USER_A, {
        id: 'openrouter',
        label: 'OpenRouter de A',
        baseURL: 'https://a.example',
        models: [],
      });
      database.upsertProviderSettings(USER_B, {
        id: 'openrouter',
        label: 'OpenRouter de B',
        baseURL: 'https://b.example',
        models: [],
      });

      const [settingsA] = database.listProviderSettings(USER_A);
      const [settingsB] = database.listProviderSettings(USER_B);
      expect(settingsA.id).toBe('openrouter');
      expect(settingsA.label).toBe('OpenRouter de A');
      expect(settingsB.id).toBe('openrouter');
      expect(settingsB.label).toBe('OpenRouter de B');

      // Upsert de B não altera o registro de A.
      database.upsertProviderSettings(USER_B, {
        id: 'openrouter',
        label: 'Renomeado por B',
        baseURL: 'https://b.example',
        models: [],
      });
      expect(database.listProviderSettings(USER_A)[0]?.label).toBe('OpenRouter de A');
      expect(database.listProviderSettings(USER_B)[0]?.label).toBe('Renomeado por B');

      // Exclusão é escopada pelo usuário.
      expect(database.deleteProviderSettings(USER_B, 'openrouter')).toBe(true);
      expect(database.listProviderSettings(USER_A)).toHaveLength(1);
      expect(database.listProviderSettings(USER_B)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
