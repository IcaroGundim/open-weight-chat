import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getModels: vi.fn(),
  getConversations: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getModels: api.getModels,
  getConversations: api.getConversations,
}));

import { useChatStore } from './chat';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('isolamento de sessão do chat', () => {
  beforeEach(() => {
    api.getModels.mockReset();
    api.getConversations.mockReset();
    useChatStore.getState().resetState();
  });

  it('descarta modelos e conversas de uma conta cuja sessão já foi resetada', async () => {
    const previousModels = deferred<{
      models: Array<{ id: string; providerId: string; providerLabel: string; label: string }>;
      configErrors: string[];
    }>();
    const previousConversations = deferred<Array<{ id: string; title: string }>>();
    api.getModels.mockReturnValue(previousModels.promise);
    api.getConversations.mockReturnValue(previousConversations.promise);

    const pendingModels = useChatStore.getState().loadModels();
    const pendingConversations = useChatStore.getState().loadConversations();
    useChatStore.getState().resetState();

    previousModels.resolve({
      models: [{ id: 'modelo-da-conta-anterior', providerId: 'provider-a', providerLabel: 'Provider A', label: 'Modelo A' }],
      configErrors: [],
    });
    previousConversations.resolve([{ id: 'conversa-da-conta-anterior', title: 'Conta anterior' }]);
    await Promise.all([pendingModels, pendingConversations]);

    const state = useChatStore.getState();
    expect(state.models).toEqual([]);
    expect(state.conversations).toEqual([]);
    expect(state.isLoadingModels).toBe(false);
    expect(state.isLoadingConversations).toBe(false);
  });
});
