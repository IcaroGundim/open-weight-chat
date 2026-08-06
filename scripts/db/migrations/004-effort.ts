import type { Migration, Row, SqlRunner } from '../runner';

/**
 * Migração 004 — nível de esforço por conversa.
 *
 * Uma coluna `effort` em `conversations`, guardando o nível de raciocínio
 * escolhido para aquela conversa (`auto` | `off` | `low` | `medium` | `high`).
 *
 * NULL é deliberado como valor de conversas antigas: a leitura converte para
 * `auto`, que é o único nível que não envia parâmetro nenhum ao provedor.
 * Ou seja, toda conversa criada antes desta coluna continua se comportando
 * exatamente como antes — a funcionalidade só age em quem escolheu.
 *
 * Escrita como .ts, e não como par .sqlite.sql/.postgres.sql, porque o SQLite
 * não tem `ADD COLUMN IF NOT EXISTS`: o `ChatDatabase` já adiciona colunas
 * faltantes ao abrir o banco (`ensureColumn`), então um banco local pode
 * chegar aqui com a coluna já existindo e um ALTER cru falharia.
 */

async function hasColumn(run: SqlRunner, table: string, column: string): Promise<boolean> {
  const rows = await run.query<Row[]>('PRAGMA table_info(' + table + ')');
  return rows.some((row) => String(row.name) === column);
}

export const migration: Migration = {
  version: '004',
  name: 'effort',
  up: async (run, ctx) => {
    const { log } = ctx;
    if (ctx.driver === 'postgres') {
      await run.exec('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS effort TEXT');
    } else if (!(await hasColumn(run, 'conversations', 'effort'))) {
      await run.exec('ALTER TABLE conversations ADD COLUMN effort TEXT');
    }
    log('conversations.effort disponível (NULL = auto).');
  },
};
