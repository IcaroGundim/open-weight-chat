import type { Migration, Row, SqlRunner } from '../runner';

/**
 * Migração 009 — modo Science por conversa.
 *
 * Duas colunas em `conversations`: o nível da cadeia de agentes e o formato do
 * documento. NULL nas duas é o estado de toda conversa anterior, e a leitura
 * converte para `off` — ou seja, nada muda para quem não usa o modo.
 *
 * Como a 004, é .ts e não .sql: o SQLite não tem `ADD COLUMN IF NOT EXISTS`, e
 * o `ChatDatabase` já pode ter criado as colunas ao abrir o banco.
 */

async function hasColumn(run: SqlRunner, table: string, column: string): Promise<boolean> {
  const rows = await run.query<Row[]>(`PRAGMA table_info(${table})`);
  return rows.some((row) => String(row.name) === column);
}

export const migration: Migration = {
  version: '009',
  name: 'science',
  up: async (run, ctx) => {
    for (const coluna of ['science_level', 'science_format']) {
      if (ctx.driver === 'postgres') {
        await run.exec(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ${coluna} TEXT`);
      } else if (!(await hasColumn(run, 'conversations', coluna))) {
        await run.exec(`ALTER TABLE conversations ADD COLUMN ${coluna} TEXT`);
      }
    }
    ctx.log('conversations.science_level e science_format disponíveis (NULL = desligado).');
  },
};
