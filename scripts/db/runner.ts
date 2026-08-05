import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from '@neondatabase/serverless';
import type { SecretContext } from '../../src/server/secrets';

/**
 * Motor de migrações versionadas (SQLite local + Postgres/Neon).
 *
 * Cada migração é um arquivo em scripts/db/migrations/:
 *   - `NNN-nome.sqlite.sql`  — SQL puro, executado no SQLite (multi-statement);
 *   - `NNN-nome.postgres.sql` — SQL puro, executado no Postgres;
 *   - `NNN-nome.ts`           — migração com lógica (recifragem etc.), exportando
 *                               `export const migration: Migration`.
 *
 * A tabela `schema_migrations` registra as versões aplicadas. Cada migração
 * roda dentro de uma transação: falhou, reverteu. O dry-run apenas imprime o
 * que seria feito — nunca executa.
 */

export type Driver = 'sqlite' | 'postgres';

export interface Row {
  [column: string]: unknown;
}

export interface SqlRunner {
  /** SQL multi-statement, sem parâmetros (DDL). */
  exec(sql: string): Promise<void>;
  /** Consulta com parâmetros posicionais `?` (o runner adapta para cada banco). */
  query<T = Row[]>(sql: string, params?: unknown[]): Promise<T>;
  /** Executa `fn` dentro de BEGIN/COMMIT, com ROLLBACK em erro. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Fecha recursos de rede quando existirem (usado pelo CLI). */
  close?(): Promise<void>;
}

export interface MigrationContext {
  driver: Driver;
  /** LEGACY_OWNER_CLERK_USER_ID — dono dos dados pré-multiusuário. */
  ownerUserId: string | null;
  encrypt: (plain: string, context?: SecretContext) => string;
  decrypt: (blob: string | null | undefined, context?: SecretContext) => string | null;
  log: (message: string) => void;
}

export interface Migration {
  version: string;
  name: string;
  up: (run: SqlRunner, ctx: MigrationContext) => Promise<void>;
}

const SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
)`;

export function createSqliteRunner(db: DatabaseSync): SqlRunner {
  return {
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    async query<T = Row[]>(sql: string, params: unknown[] = []): Promise<T> {
      return db.prepare(sql).all(...params) as T;
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/** Divide SQL por `;` respeitando aspas simples — para statements isolados. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'" && sql[index - 1] !== '\\') inString = !inString;
    if (char === ';' && !inString) {
      statements.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/**
 * O SQLite aceita `?`, enquanto o protocolo Postgres usa `$1`, `$2` etc.
 * As migrações usam uma única sintaxe neutra. Não substituímos pontos de
 * interrogação que estejam dentro de strings ou identificadores quoted.
 */
export function toPostgresPlaceholders(sql: string): string {
  let result = '';
  let parameter = 0;
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (singleQuoted) {
      result += character;
      if (character === "'" && next === "'") {
        result += next;
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      result += character;
      if (character === '"' && next === '"') {
        result += next;
        index += 1;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (character === "'") {
      singleQuoted = true;
      result += character;
    } else if (character === '"') {
      doubleQuoted = true;
      result += character;
    } else if (character === '?') {
      parameter += 1;
      result += `$${parameter}`;
    } else {
      result += character;
    }
  }

  return result;
}

export function createPostgresRunner(connectionString: string): SqlRunner {
  // Migrações têm passos dependentes (ler schema, recifrar chaves, escrever
  // e registrar a versão), portanto exigem uma sessão interativa. O helper
  // HTTP `neon()` não mantém BEGIN/COMMIT entre requests; Pool/Client sim.
  const pool = new Pool({ connectionString });
  let transactionClient: PoolClient | null = null;

  const query = async <T = Row[]>(queryText: string, params: unknown[] = []): Promise<T> => {
    const client = transactionClient ?? pool;
    const result = await client.query(toPostgresPlaceholders(queryText), params);
    return result.rows as T;
  };

  return {
    async exec(sqlText: string): Promise<void> {
      for (const statement of splitStatements(sqlText)) {
        if (statement.trim()) await query(statement);
      }
    },
    query,
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // As migrações atuais não aninham transações. Caso uma venha a fazê-lo,
      // ela participa da transação externa, em vez de abrir outra sessão.
      if (transactionClient) return await fn();

      const client = await pool.connect();
      transactionClient = client;
      try {
        await client.query('BEGIN');
        const result = await fn();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserva o erro da migração; uma conexão quebrada será descartada.
        }
        throw error;
      } finally {
        transactionClient = null;
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export async function loadMigrations(directory: string, driver: Driver): Promise<Migration[]> {
  const files = readdirSync(directory).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const sqlMatch = file.match(/^(\d{3})-(.+)\.(sqlite|postgres)\.sql$/u);
    if (sqlMatch && sqlMatch[3] === driver) {
      const version = sqlMatch[1];
      const name = sqlMatch[2];
      const sql = readFileSync(join(directory, file), 'utf8');
      migrations.push({
        version,
        name,
        up: async (run) => { await run.exec(sql); },
      });
      continue;
    }
    const tsMatch = file.match(/^(\d{3})-(.+)\.ts$/u);
    if (tsMatch) {
      const module = await import(pathToFileURL(join(directory, file)).href);
      const migration = module.migration ?? module.default;
      if (migration && typeof migration.up === 'function') {
        migrations.push(migration as Migration);
      }
    }
  }
  migrations.sort((left, right) => left.version.localeCompare(right.version));
  return migrations;
}

export async function appliedVersions(run: SqlRunner): Promise<Set<string>> {
  await run.exec(SCHEMA_MIGRATIONS);
  const rows = await run.query<Row[]>('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => String(row.version)));
}

export interface MigrateUpResult {
  applied: Array<{ version: string; name: string }>;
}

/** Aplica as migrações pendentes em ordem. Falha → transação reverte a migração atual. */
export async function migrateUp(
  run: SqlRunner,
  migrations: Migration[],
  ctx: MigrationContext,
): Promise<MigrateUpResult> {
  const applied = await appliedVersions(run);
  const result: MigrateUpResult = { applied: [] };
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await run.transaction(async () => {
      await migration.up(run, ctx);
      await run.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        Date.now(),
      ]);
    });
    applied.add(migration.version);
    result.applied.push({ version: migration.version, name: migration.name });
    ctx.log(`✔ ${migration.version} ${migration.name}`);
  }
  return result;
}

export interface TableCounts {
  users: number;
  conversations: number;
  provider_settings: number;
  messages: number;
  artifacts: number;
}

export async function tableCounts(run: SqlRunner): Promise<TableCounts> {
  const count = async (table: string): Promise<number> => {
    try {
      const rows = await run.query<Row[]>(`SELECT COUNT(*) AS total FROM ${table}`);
      return Number(rows[0]?.total ?? 0);
    } catch {
      return -1; // tabela ainda não existe
    }
  };
  return {
    users: await count('users'),
    conversations: await count('conversations'),
    provider_settings: await count('provider_settings'),
    messages: await count('messages'),
    artifacts: await count('artifacts'),
  };
}

export function describePending(
  migrations: Migration[],
  applied: Set<string>,
): Array<{ version: string; name: string }> {
  return migrations.filter((migration) => !applied.has(migration.version)).map((migration) => ({
    version: migration.version,
    name: migration.name,
  }));
}
