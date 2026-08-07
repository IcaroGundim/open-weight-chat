import type { Migration, Row, SqlRunner } from '../runner';

/**
 * Migração 008 — tipo de artefato `chart`.
 *
 * `artifacts.kind` tem um CHECK que lista os tipos aceitos, e gráfico é o
 * sexto. Escrita como .ts, e não como par de .sql, porque os dois bancos
 * relaxam um CHECK de formas incomparáveis:
 *
 * - **Postgres** troca a restrição no lugar (DROP/ADD CONSTRAINT). O nome dela
 *   não é fixo — depende de como a tabela foi criada —, então é lido do
 *   catálogo em vez de adivinhado.
 * - **SQLite** não sabe alterar CHECK. A única saída é reconstruir a tabela:
 *   criar a nova, copiar as linhas, derrubar a antiga e renomear. As chaves
 *   estrangeiras ficam desligadas durante a troca porque `artifact_versions`
 *   aponta para `artifacts`; como os ids são preservados, as referências
 *   continuam válidas do outro lado — mas o DROP intermediário as veria
 *   quebradas e abortaria.
 *
 * Idempotente nos dois: se o CHECK já cita `mindmap`, não há o que fazer.
 */

const TIPOS = "'markdown', 'code', 'svg', 'mermaid', 'mindmap', 'chart'";

async function sqliteJaTem(run: SqlRunner): Promise<boolean> {
  const rows = await run.query<Row[]>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'",
  );
  return rows.some((row) => String(row.sql ?? '').includes('chart'));
}

export const migration: Migration = {
  version: '008',
  name: 'grafico',
  // Ver o comentário de `outsideTransaction` no runner: o PRAGMA que protege
  // os dados durante a reconstrução não vale dentro de uma transação.
  outsideTransaction: true,
  up: async (run, ctx) => {
    const { log } = ctx;

    if (ctx.driver === 'postgres') {
      const restricoes = await run.query<Row[]>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'artifacts'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%kind%'`,
      );
      for (const restricao of restricoes) {
        await run.exec(`ALTER TABLE artifacts DROP CONSTRAINT ${String(restricao.conname)}`);
      }
      await run.exec(`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN (${TIPOS}))`);
      log('artifacts.kind aceita chart.');
      return;
    }

    if (await sqliteJaTem(run)) {
      log('artifacts.kind já aceitava chart; nada a fazer.');
      return;
    }

    // Multi-statement num exec só: PRAGMA de chave estrangeira não vale dentro
    // de transação, então ele fica por fora do BEGIN.
    await run.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE artifacts_novo (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${TIPOS})),
        language TEXT,
        title TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (conversation_id, slug)
      );
      INSERT INTO artifacts_novo (id, conversation_id, slug, kind, language, title, current_version, created_at, updated_at)
        SELECT id, conversation_id, slug, kind, language, title, current_version, created_at, updated_at FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_novo RENAME TO artifacts;
      CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id, updated_at DESC);
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);

    // A reconstrução é a parte que pode perder dado em silêncio; conferir o
    // total é barato e é a única prova de que a cópia saiu inteira.
    const [{ total }] = await run.query<Array<{ total: number }>>('SELECT COUNT(*) AS total FROM artifacts');
    log(`artifacts reconstruída com ${Number(total)} registro(s); kind aceita chart.`);
  },
};
