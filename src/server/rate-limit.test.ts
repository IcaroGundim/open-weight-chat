import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { neon } from '@neondatabase/serverless';
import { DatabaseSync } from 'node:sqlite';
import {
  CHAT_START_LIMIT_PER_MINUTE,
  MAX_ACTIVE_STREAMS,
  MODEL_DISCOVERY_LIMIT_PER_MINUTE,
  NeonRateLimitStore,
  SqliteRateLimitStore,
} from './rate-limit';

/**
 * Limites por usuário (plano multiusuário): 20 inícios de chat/minuto,
 * 5 descobertas de modelos/minuto e no máximo 2 streams ativos. Os contadores
 * devem ser por usuário — A nunca afeta B.
 */
describe('rate limits por usuário', () => {
  let db: DatabaseSync;
  let store: SqliteRateLimitStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new SqliteRateLimitStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('permite até 20 inícios de chat por minuto e rejeita o 21º', async () => {
    for (let index = 0; index < CHAT_START_LIMIT_PER_MINUTE; index += 1) {
      await store.checkChatStart('user_a');
    }
    await expect(store.checkChatStart('user_a')).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });

  it('permite até 5 descobertas de modelos por minuto e rejeita a 6ª', async () => {
    for (let index = 0; index < MODEL_DISCOVERY_LIMIT_PER_MINUTE; index += 1) {
      await store.checkModelDiscovery('user_a');
    }
    await expect(store.checkModelDiscovery('user_a')).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });

  it('limita a 2 streams ativos por usuário e libera slot ao finalizar', async () => {
    const firstSlot = await store.acquireStreamSlot('user_a');
    await store.acquireStreamSlot('user_a');
    await expect(store.acquireStreamSlot('user_a')).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });

    await store.releaseStreamSlot('user_a', firstSlot);
    await store.acquireStreamSlot('user_a'); // slot liberado: volta a caber
  });

  it('liberar o mesmo slot duas vezes não quebra (idempotente)', async () => {
    const slotId = await store.acquireStreamSlot('user_a');
    await store.releaseStreamSlot('user_a', slotId);
    await store.releaseStreamSlot('user_a', slotId);
    await store.acquireStreamSlot('user_a');
  });

  it('libera e renova somente o slot do stream que chamou', async () => {
    const firstSlot = await store.acquireStreamSlot('user_a');
    const secondSlot = await store.acquireStreamSlot('user_a');
    db.prepare('UPDATE rate_limit_streams SET last_active = 0 WHERE user_id = ?').run('user_a');

    await store.touchStream('user_a', firstSlot);
    const touched = db.prepare('SELECT id, last_active FROM rate_limit_streams WHERE user_id = ?').all('user_a') as Array<{
      id: string;
      last_active: number;
    }>;
    expect(touched.find((slot) => slot.id === firstSlot)?.last_active).toBeGreaterThan(0);
    expect(touched.find((slot) => slot.id === secondSlot)?.last_active).toBe(0);

    await store.releaseStreamSlot('user_a', secondSlot);
    const remaining = db.prepare('SELECT id FROM rate_limit_streams WHERE user_id = ?').all('user_a') as Array<{ id: string }>;
    expect(remaining).toEqual([{ id: firstSlot }]);
  });

  it('expira slots de stream inativos (10 min) na próxima aquisição', async () => {
    await store.acquireStreamSlot('user_a');
    await store.acquireStreamSlot('user_a');
    // Envelhece os slots diretamente: a próxima aquisição os limpa.
    db.prepare('UPDATE rate_limit_streams SET last_active = ? WHERE user_id = ?').run(
      Date.now() - 11 * 60 * 1000,
      'user_a',
    );
    await store.acquireStreamSlot('user_a'); // slots expirados viram livres
  });

  it('mantém limites independentes entre usuários (A nunca afeta B)', async () => {
    for (let index = 0; index < CHAT_START_LIMIT_PER_MINUTE; index += 1) {
      await store.checkChatStart('user_a');
    }
    // B não sente o limite de A.
    for (let index = 0; index < CHAT_START_LIMIT_PER_MINUTE; index += 1) {
      await store.checkChatStart('user_b');
    }
    await store.acquireStreamSlot('user_a');
    await store.acquireStreamSlot('user_a');
    // B ainda tem os próprios 2 slots.
    await store.acquireStreamSlot('user_b');
    await store.acquireStreamSlot('user_b');
    await expect(store.acquireStreamSlot('user_b')).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('reseta o contador quando a janela de 60s muda', async () => {
    for (let index = 0; index < CHAT_START_LIMIT_PER_MINUTE; index += 1) {
      await store.checkChatStart('user_a');
    }
    await expect(store.checkChatStart('user_a')).rejects.toMatchObject({ code: 'RATE_LIMIT' });

    // Move o contador para uma janela antiga: a janela atual fica livre.
    db.prepare('UPDATE rate_limit_counters SET window_start = ? WHERE user_id = ?').run(
      Date.now() - 61 * 1000,
      'user_a',
    );
    await store.checkChatStart('user_a');
  });

  it('MAX_ACTIVE_STREAMS é 2', () => {
    expect(MAX_ACTIVE_STREAMS).toBe(2);
  });

  it('Neon só confirma a aquisição quando o INSERT reservou o slot', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    let insertedSlots = 0;
    const fakeSql = {
      query: (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('RETURNING id')) {
          insertedSlots += 1;
          return Promise.resolve(insertedSlots <= MAX_ACTIVE_STREAMS ? [{ id: String(params[0]) }] : []);
        }
        return Promise.resolve([]);
      },
      transaction: async (jobs: Array<Promise<unknown>>) => await Promise.all(jobs),
    };
    const store = new NeonRateLimitStore('postgres://unused', fakeSql as unknown as ReturnType<typeof neon>);

    const firstSlot = await store.acquireStreamSlot('user_a');
    const secondSlot = await store.acquireStreamSlot('user_a');
    await expect(store.acquireStreamSlot('user_a')).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });

    await store.releaseStreamSlot('user_a', secondSlot);
    await store.touchStream('user_a', firstSlot);

    const inserts = queries.filter((query) => query.sql.includes('INSERT INTO rate_limit_streams'));
    expect(inserts).toHaveLength(3);
    expect(inserts[0].sql).toContain('WHERE (SELECT COUNT(*) FROM rate_limit_streams WHERE user_id = $2) < $4');
    expect(inserts[0].sql).toContain('RETURNING id');
    expect(queries.at(-2)).toMatchObject({
      sql: 'DELETE FROM rate_limit_streams WHERE user_id = $1 AND id = $2',
      params: ['user_a', secondSlot],
    });
    expect(queries.at(-1)).toMatchObject({
      sql: 'UPDATE rate_limit_streams SET last_active = $3 WHERE user_id = $1 AND id = $2',
      params: ['user_a', firstSlot, expect.any(Number)],
    });
  });

  it('Neon não executa DDL antes de limitar a descoberta de modelos', async () => {
    const queries: string[] = [];
    const fakeSql = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve([{ count: 1 }]);
      },
      transaction: () => {
        throw new Error('DDL não deve rodar em uma requisição');
      },
    };
    const store = new NeonRateLimitStore('postgres://unused', fakeSql as unknown as ReturnType<typeof neon>);

    await store.checkModelDiscovery('user_a');

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('INSERT INTO rate_limit_counters');
    expect(queries[0]).not.toContain('CREATE TABLE');
  });
});
