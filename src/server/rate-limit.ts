import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors';
import type { ChatDatabaseAdapter } from './db/database';

/**
 * Limites de uso POR USUÁRIO, atômicos e compartilhados entre instâncias.
 *
 * O plano (PLANO-MULTIUSUARIO.md) exige: 20 inícios de chat/minuto,
 * 5 descobertas de modelos/minuto e no máximo 2 streams ativos por usuário.
 * Os contadores vivem no Postgres (Neon) para serem compartilhados entre as
 * instâncias da Vercel; as implementações SQLite e InMemory existem para
 * desenvolvimento local e testes.
 *
 * Tabelas (criadas com CREATE TABLE IF NOT EXISTS no construtor de cada store
 * — idempotente; serão incluídas nas migrações versionadas depois):
 *
 *   CREATE TABLE IF NOT EXISTS rate_limit_counters (
 *     bucket text NOT NULL,
 *     user_id text NOT NULL,
 *     count integer NOT NULL,
 *     window_start bigint NOT NULL,
 *     PRIMARY KEY (bucket, user_id, window_start)
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS rate_limit_streams (
 *     user_id text NOT NULL,
 *     started_at bigint NOT NULL,
 *     last_active bigint NOT NULL,
 *     PRIMARY KEY (user_id, started_at)
 *   );
 *
 * Janela fixa de 60s: `window_start = Math.floor(now/60000) * 60000` e o bucket
 * é 'chat' ou 'discovery'. A janela anterior expira naturalmente — a chave
 * primária muda a cada minuto, então não há rotina de limpeza (o volume é
 * trivial). O incremento é atômico via INSERT ... ON CONFLICT ... DO UPDATE
 * com `WHERE count < limite RETURNING count`: 0 linhas devolvidas = limite
 * estourado. Uma pequena corrida é aceita (duas requisições simultâneas podem
 * passar de 19 para 21) — o teto é proteção de abuso, não contabilidade.
 *
 * Slots de stream: UMA LINHA POR STREAM ATIVO (identificada por UUID), e não
 * apenas user_id, justamente para permitir contar até 2 streams do mesmo
 * usuário). A aquisição no Postgres serializa requisições concorrentes do mesmo
 * usuário com `pg_advisory_xact_lock(hashtext(user_id))` dentro de uma
 * transação: remove expirados + conta + insere condicionalmente. Slots expiram
 * após 10 minutos sem atividade (last_active) — cobre streams que morrem sem
 * liberar o slot. A aquisição retorna o identificador do slot; touch e release
 * usam esse identificador, então um stream nunca toca ou remove o outro.
 */

export const CHAT_START_LIMIT_PER_MINUTE = 20;
export const MODEL_DISCOVERY_LIMIT_PER_MINUTE = 5;
export const MAX_ACTIVE_STREAMS = 2;
export const STREAM_SLOT_EXPIRY_MS = 10 * 60_000;
const WINDOW_MS = 60_000;

export const CHAT_START_LIMIT_MESSAGE = 'Muitos inícios de chat por minuto. Aguarde um instante.';
export const MODEL_DISCOVERY_LIMIT_MESSAGE = 'Muitas descobertas de modelos por minuto. Aguarde um instante.';
export const STREAM_LIMIT_MESSAGE = 'Você já tem 2 conversas em andamento. Aguarde uma terminar.';

/** Identifica exclusivamente uma execução de stream ativa. */
export type StreamSlotId = string;

export function rateLimitError(message: string): AppError {
  return new AppError('RATE_LIMIT', { status: 429, message });
}

export interface RateLimitStore {
  /** Conta um início de chat na janela de 60s; lança 429 acima de 20/min. */
  checkChatStart(userId: string): Promise<void>;
  /** Conta uma descoberta de modelos na janela de 60s; lança 429 acima de 5/min. */
  checkModelDiscovery(userId: string): Promise<void>;
  /** Reserva um slot de stream ativo e devolve seu id; lança 429 quando o usuário já tem 2. */
  acquireStreamSlot(userId: string): Promise<StreamSlotId>;
  /** Libera exclusivamente o slot informado; repetir a chamada é inofensivo. */
  releaseStreamSlot(userId: string, slotId: StreamSlotId): Promise<void>;
  /** Renova somente o slot informado (stream ativo continuou vivo). */
  touchStream(userId: string, slotId: StreamSlotId): Promise<void>;
}

/** Contador de janela fixa de 60s (lógica comum às três implementações). */
function currentWindowStart(): number {
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}

/** Um stream que morreu sem liberar o slot não conta depois da expiração. */
function expiryThreshold(now: number): number {
  return now - STREAM_SLOT_EXPIRY_MS;
}

/**
 * Implementação em memória — apenas testes/desenvolvimento sem banco.
 * Não é compartilhada entre instâncias nem processos.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  /** Chave: `bucket:windowStart:userId`. */
  private readonly counters = new Map<string, number>();
  private readonly slots = new Map<string, Array<{ id: StreamSlotId; startedAt: number; lastActive: number }>>();

  private increment(bucket: string, userId: string, limit: number, message: string): void {
    const windowStart = currentWindowStart();
    const key = `${bucket}:${windowStart}:${userId}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    if (next > limit) throw rateLimitError(message);
    this.counters.set(key, next);
    // Higiene simples: janelas antigas saem do mapa quando ele cresce.
    if (this.counters.size > 1_024) {
      for (const [candidate] of this.counters) {
        if (!candidate.startsWith(`${bucket}:${windowStart}:`)) this.counters.delete(candidate);
      }
    }
  }

  async checkChatStart(userId: string): Promise<void> {
    this.increment('chat', userId, CHAT_START_LIMIT_PER_MINUTE, CHAT_START_LIMIT_MESSAGE);
  }

  async checkModelDiscovery(userId: string): Promise<void> {
    this.increment('discovery', userId, MODEL_DISCOVERY_LIMIT_PER_MINUTE, MODEL_DISCOVERY_LIMIT_MESSAGE);
  }

  async acquireStreamSlot(userId: string): Promise<StreamSlotId> {
    const now = Date.now();
    const fresh = (this.slots.get(userId) ?? []).filter((slot) => now - slot.lastActive <= STREAM_SLOT_EXPIRY_MS);
    if (fresh.length >= MAX_ACTIVE_STREAMS) throw rateLimitError(STREAM_LIMIT_MESSAGE);
    const slotId = randomUUID();
    fresh.push({ id: slotId, startedAt: now, lastActive: now });
    this.slots.set(userId, fresh);
    return slotId;
  }

  async releaseStreamSlot(userId: string, slotId: StreamSlotId): Promise<void> {
    const slots = this.slots.get(userId);
    if (!slots || slots.length === 0) return;
    const index = slots.findIndex((slot) => slot.id === slotId);
    if (index === -1) return;
    slots.splice(index, 1);
    if (slots.length === 0) this.slots.delete(userId);
  }

  async touchStream(userId: string, slotId: StreamSlotId): Promise<void> {
    const slots = this.slots.get(userId);
    if (!slots) return;
    const slot = slots.find((candidate) => candidate.id === slotId);
    if (slot) slot.lastActive = Date.now();
  }
}

/**
 * Implementação Postgres (Neon): contadores atômicos e compartilhados entre
 * as instâncias da Vercel. O construtor cria as tabelas (idempotente) e as
 * migrações versionadas futuras usarão o mesmo SQL.
 */
export class NeonRateLimitStore implements RateLimitStore {
  private readonly sql: ReturnType<typeof neon>;
  private readonly ready: Promise<void>;

  constructor(connectionString: string, sql: ReturnType<typeof neon> = neon(connectionString)) {
    this.sql = sql;
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS rate_limit_counters (
        bucket text NOT NULL,
        user_id text NOT NULL,
        count integer NOT NULL,
        window_start bigint NOT NULL,
        PRIMARY KEY (bucket, user_id, window_start)
      )`,
      `CREATE TABLE IF NOT EXISTS rate_limit_streams (
        id text NOT NULL,
        user_id text NOT NULL,
        started_at bigint NOT NULL,
        last_active bigint NOT NULL,
        PRIMARY KEY (id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rate_limit_streams_user ON rate_limit_streams(user_id, started_at)`,
    ];
    await this.sql.transaction(statements.map((statement) => this.sql.query(statement)));
  }

  private async rows(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    await this.ready;
    return await this.sql.query(query, params) as Record<string, unknown>[];
  }

  private async increment(bucket: string, userId: string, limit: number, message: string): Promise<void> {
    const windowStart = currentWindowStart();
    // Atômico: a linha só é incrementada enquanto count < limite; 0 linhas
    // devolvidas (RETURNING) significa que o limite foi estourado.
    const rows = await this.rows(
      `INSERT INTO rate_limit_counters (bucket, user_id, count, window_start)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (bucket, user_id, window_start) DO UPDATE
         SET count = rate_limit_counters.count + 1
         WHERE rate_limit_counters.count < $4
       RETURNING count`,
      [bucket, userId, windowStart, limit],
    );
    if (rows.length === 0) throw rateLimitError(message);
  }

  async checkChatStart(userId: string): Promise<void> {
    await this.increment('chat', userId, CHAT_START_LIMIT_PER_MINUTE, CHAT_START_LIMIT_MESSAGE);
  }

  async checkModelDiscovery(userId: string): Promise<void> {
    await this.increment('discovery', userId, MODEL_DISCOVERY_LIMIT_PER_MINUTE, MODEL_DISCOVERY_LIMIT_MESSAGE);
  }

  async acquireStreamSlot(userId: string): Promise<StreamSlotId> {
    await this.ready;
    const now = Date.now();
    const slotId = randomUUID();
    const results = await this.sql.transaction([
      // Serializa as aquisições concorrentes do mesmo usuário entre instâncias.
      this.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]),
      // Slots expirados (stream morto sem release) não contam.
      this.sql.query('DELETE FROM rate_limit_streams WHERE user_id = $1 AND last_active <= $2', [userId, expiryThreshold(now)]),
      // Insere apenas se o usuário ainda não tem 2 slots ativos. O lock acima
      // torna count + insert atômicos entre todas as instâncias.
      this.sql.query(
        `INSERT INTO rate_limit_streams (id, user_id, started_at, last_active)
         SELECT $1, $2, $3, $3
          WHERE (SELECT COUNT(*) FROM rate_limit_streams WHERE user_id = $2) < $4
         RETURNING id`,
        [slotId, userId, now, MAX_ACTIVE_STREAMS],
      ),
    ]);
    const inserted = results[2] as Record<string, unknown>[];
    if (inserted.length === 0) throw rateLimitError(STREAM_LIMIT_MESSAGE);
    return String(inserted[0].id);
  }

  async releaseStreamSlot(userId: string, slotId: StreamSlotId): Promise<void> {
    await this.rows(
      'DELETE FROM rate_limit_streams WHERE user_id = $1 AND id = $2',
      [userId, slotId],
    );
  }

  async touchStream(userId: string, slotId: StreamSlotId): Promise<void> {
    await this.rows('UPDATE rate_limit_streams SET last_active = $3 WHERE user_id = $1 AND id = $2', [userId, slotId, Date.now()]);
  }
}

/**
 * Implementação SQLite (desenvolvimento local e testes).
 *
 * Recebe um `DatabaseSync` já aberto (ex.: o campo público `db` do
 * ChatDatabase) para que os testes compartilhem o mesmo arquivo/:memory:.
 * O `node:sqlite` é síncrono e toda operação passa pela MESMA conexão, então
 * contagem + inserção não sofrem corrida dentro do processo; ainda assim a
 * aquisição roda dentro de BEGIN IMMEDIATE para espelhar a atomicidade do
 * Postgres (e bloquear escritores concorrentes de outras conexões no futuro).
 */
export class SqliteRateLimitStore implements RateLimitStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (bucket, user_id, window_start)
);
CREATE TABLE IF NOT EXISTS rate_limit_streams (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_streams_user ON rate_limit_streams(user_id, started_at);
`);
  }

  private increment(bucket: string, userId: string, limit: number, message: string): void {
    const windowStart = currentWindowStart();
    const row = this.db
      .prepare(
        `INSERT INTO rate_limit_counters (bucket, user_id, count, window_start)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket, user_id, window_start) DO UPDATE
           SET count = rate_limit_counters.count + 1
           WHERE rate_limit_counters.count < ?
         RETURNING count`,
      )
      .get(bucket, userId, windowStart, limit);
    if (!row) throw rateLimitError(message);
  }

  async checkChatStart(userId: string): Promise<void> {
    this.increment('chat', userId, CHAT_START_LIMIT_PER_MINUTE, CHAT_START_LIMIT_MESSAGE);
  }

  async checkModelDiscovery(userId: string): Promise<void> {
    this.increment('discovery', userId, MODEL_DISCOVERY_LIMIT_PER_MINUTE, MODEL_DISCOVERY_LIMIT_MESSAGE);
  }

  async acquireStreamSlot(userId: string): Promise<StreamSlotId> {
    const now = Date.now();
    const slotId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    let exceeded = false;
    try {
      this.db.prepare('DELETE FROM rate_limit_streams WHERE user_id = ? AND last_active <= ?').run(userId, expiryThreshold(now));
      const row = this.db.prepare('SELECT COUNT(*) AS active FROM rate_limit_streams WHERE user_id = ?').get(userId) as { active: number } | undefined;
      exceeded = Number(row?.active ?? 0) >= MAX_ACTIVE_STREAMS;
      if (!exceeded) {
        this.db
          .prepare(
            `INSERT INTO rate_limit_streams (id, user_id, started_at, last_active)
             VALUES (?, ?, ?, ?)`,
          )
          .run(slotId, userId, now, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (exceeded) throw rateLimitError(STREAM_LIMIT_MESSAGE);
    return slotId;
  }

  async releaseStreamSlot(userId: string, slotId: StreamSlotId): Promise<void> {
    this.db
      .prepare('DELETE FROM rate_limit_streams WHERE user_id = ? AND id = ?')
      .run(userId, slotId);
  }

  async touchStream(userId: string, slotId: StreamSlotId): Promise<void> {
    this.db.prepare('UPDATE rate_limit_streams SET last_active = ? WHERE user_id = ? AND id = ?').run(Date.now(), userId, slotId);
  }
}

/**
 * Escolha padrão do store dentro do createApp:
 * - banco SQLite local (ChatDatabase expõe o DatabaseSync público `db`) → SQLite;
 * - DATABASE_URL presente (Neon) → Neon;
 * - nenhum dos dois (mocks de teste) → InMemory.
 */
export function pickDefaultRateLimitStore(db?: ChatDatabaseAdapter): RateLimitStore {
  const sqlite = (db as { db?: unknown } | undefined)?.db;
  if (sqlite && typeof (sqlite as { prepare?: unknown }).prepare === 'function') {
    return new SqliteRateLimitStore(sqlite as DatabaseSync);
  }
  if (process.env.DATABASE_URL) return new NeonRateLimitStore(process.env.DATABASE_URL);
  return new InMemoryRateLimitStore();
}
