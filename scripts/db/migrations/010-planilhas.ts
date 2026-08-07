import type { Migration, Row, SqlRunner } from '../runner';

const TIPOS = "'image', 'document', 'spreadsheet'";

async function sqliteJaTem(run: SqlRunner): Promise<boolean> {
  const rows = await run.query<Row[]>("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'");
  return rows.some((row) => String(row.sql ?? '').includes('spreadsheet'));
}

async function criarVersoes(run: SqlRunner): Promise<void> {
  await run.exec(`
    CREATE TABLE IF NOT EXISTS spreadsheet_versions (
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      workbook_json TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (attachment_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_attachment
      ON spreadsheet_versions(attachment_id, version DESC);
  `);
}

export const migration: Migration = {
  version: '010',
  name: 'planilhas',
  outsideTransaction: true,
  up: async (run, ctx) => {
    if (ctx.driver === 'postgres') {
      const restricoes = await run.query<Row[]>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'attachments'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%kind%'`,
      );
      for (const restricao of restricoes) {
        const nome = String(restricao.conname).replaceAll('"', '""');
        await run.exec(`ALTER TABLE attachments DROP CONSTRAINT "${nome}"`);
      }
      await run.exec(`ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN (${TIPOS}))`);
      await criarVersoes(run);
      ctx.log('attachments.kind aceita spreadsheet; histórico de planilhas disponível.');
      return;
    }

    if (!(await sqliteJaTem(run))) {
      await run.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN;
        CREATE TABLE attachments_novo (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN (${TIPOS})),
          filename TEXT NOT NULL,
          mime TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          data_base64 TEXT,
          extracted_text TEXT,
          truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
          created_at INTEGER NOT NULL
        );
        INSERT INTO attachments_novo
          (id, user_id, conversation_id, message_id, kind, filename, mime, size_bytes, data_base64, extracted_text, truncated, created_at)
          SELECT id, user_id, conversation_id, message_id, kind, filename, mime, size_bytes, data_base64, extracted_text, truncated, created_at
          FROM attachments;
        DROP TABLE attachments;
        ALTER TABLE attachments_novo RENAME TO attachments;
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at);
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
    }
    await criarVersoes(run);
    ctx.log('attachments.kind aceita spreadsheet; histórico de planilhas disponível.');
  },
};
