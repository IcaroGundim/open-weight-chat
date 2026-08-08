import type { Migration, Row, SqlRunner } from '../runner';

async function hasColumn(run: SqlRunner, table: string, column: string): Promise<boolean> {
  const rows = await run.query<Row[]>(`PRAGMA table_info(${table})`);
  return rows.some((row) => String(row.name) === column);
}

/**
 * Migração 011 — seleção genérica de skills por conversa.
 *
 * `science_level` e `science_format` permanecem como legado de leitura, mas
 * toda gravação nova usa `skills_json`. A conversão torna as conversas já
 * existentes equivalentes à skill `science`, sem desligá-las ao atualizar.
 */
export const migration: Migration = {
  version: '011',
  name: 'skills',
  up: async (run, ctx) => {
    if (ctx.driver === 'postgres') {
      await run.exec("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS skills_json TEXT NOT NULL DEFAULT '[]'");
    } else if (!(await hasColumn(run, 'conversations', 'skills_json'))) {
      await run.exec("ALTER TABLE conversations ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'");
    }

    await run.exec(`
      UPDATE conversations
         SET skills_json = CASE
           WHEN science_level IS NOT NULL AND science_level <> 'off' THEN
             CASE WHEN science_format = 'latex'
               THEN '[{"id":"science","settings":{"format":"latex"}}]'
               ELSE '[{"id":"science","settings":{"format":"markdown"}}]'
             END
           ELSE '[]'
         END
       WHERE skills_json IS NULL OR skills_json = '' OR skills_json = '[]'
    `);
    ctx.log('conversations.skills_json disponível; configurações legadas de Science foram convertidas para a skill science.');
  },
};
