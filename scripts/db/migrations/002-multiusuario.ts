import type { Migration, Row, SqlRunner } from '../runner';

/**
 * Migração 002 — multiusuário.
 *
 * Transforma o schema pré-multiusuário no novo:
 *   1. Cria a tabela `users` (id = user_... do Clerk).
 *   2. Adiciona `user_id` em `conversations` e `provider_settings`.
 *   3. Troca a PK de `provider_settings` para (user_id, id).
 *   4. Atribui `LEGACY_OWNER_CLERK_USER_ID` a todas as linhas órfãs
 *      (user_id = '') — falha se houver órfãos sem dono definido.
 *   5. Recifra as chaves v1 → v2 (AAD userId:providerId). Se QUALQUER chave
 *      v1 não puder ser decifrada com a chave-mestra vigente, a transação é
 *      abortada sem nenhuma alteração.
 *   6. Cria o índice de conversas por usuário.
 *
 * É idempotente: em bancos novos (001 já aplicada com o schema novo) apenas
 * confirma o que já existe.
 */

const OWNER_ENV = 'LEGACY_OWNER_CLERK_USER_ID';

async function hasColumn(run: SqlRunner, table: string, column: string): Promise<boolean> {
  const rows = await run.query<Row[]>('PRAGMA table_info(' + table + ')');
  return rows.some((row) => String(row.name) === column);
}

async function hasCompositeProviderPk(run: SqlRunner): Promise<boolean> {
  const rows = await run.query<Row[]>('PRAGMA table_info(provider_settings)');
  const pkColumns = rows.filter((row) => Number(row.pk) > 0);
  return pkColumns.length === 2;
}

async function orphanCount(run: SqlRunner, table: string): Promise<number> {
  const rows = await run.query<Row[]>(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ''`);
  return Number(rows[0]?.total ?? 0);
}

export const migration: Migration = {
  version: '002',
  name: 'multiusuario',
  up: async (run, ctx) => {
    const { log } = ctx;
    const isPostgres = ctx.driver === 'postgres';

    // 1. Tabela users (idempotente — a 001 já cria em bancos novos).
    await run.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`);

    // 2. Coluna user_id nas conversas (idempotente).
    if (isPostgres) {
      await run.exec("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''");
    } else if (!(await hasColumn(run, 'conversations', 'user_id'))) {
      await run.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    }
    if (isPostgres) {
      await run.exec("ALTER TABLE provider_settings ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''");
    } else if (!(await hasColumn(run, 'provider_settings', 'user_id'))) {
      await run.exec("ALTER TABLE provider_settings ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    }

    // 3. PK composta em provider_settings (idempotente).
    if (isPostgres) {
      const constraints = await run.query<Row[]>(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'provider_settings'::regclass AND contype = 'p'`,
      );
      const composite = constraints.some((row) => String(row.def).includes('user_id'));
      if (!composite) {
        for (const constraint of constraints) {
          await run.exec(`ALTER TABLE provider_settings DROP CONSTRAINT ${String(constraint.conname)}`);
        }
        await run.exec('ALTER TABLE provider_settings ADD PRIMARY KEY (user_id, id)');
      }
    } else if (!(await hasCompositeProviderPk(run))) {
      // SQLite não altera PK: recria a tabela no padrão 12-passos (dentro da
      // transação da migração, então um erro aqui reverte tudo).
      await run.exec(`
CREATE TABLE provider_settings_new (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL,
  verified_at TEXT,
  api_key_cipher TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
)`);
      await run.exec(`
INSERT INTO provider_settings_new (id, user_id, label, base_url, models_json, verified_at, api_key_cipher, created_at, updated_at)
SELECT id, user_id, label, base_url, models_json, verified_at, api_key_cipher, created_at, updated_at
  FROM provider_settings`);
      await run.exec('DROP TABLE provider_settings');
      await run.exec('ALTER TABLE provider_settings_new RENAME TO provider_settings');
    }

    // 4. Atribuição do dono legado.
    const conversationsOrphans = await orphanCount(run, 'conversations');
    const providerOrphans = await orphanCount(run, 'provider_settings');
    const owner = ctx.ownerUserId?.trim() || null;
    if (conversationsOrphans + providerOrphans > 0 && !owner) {
      throw new Error(
        `Há dados sem dono (${conversationsOrphans} conversas, ${providerOrphans} provedores) e ` +
          `${OWNER_ENV} não está definida. Defina ${OWNER_ENV}=user_... com o ID da conta do ` +
          'proprietário no Clerk (painel → Users) antes de migrar. Nenhuma alteração foi feita.',
      );
    }
    if (owner) {
      if (conversationsOrphans > 0) {
        await run.query("UPDATE conversations SET user_id = ? WHERE user_id = ''", [owner]);
        log(`  → ${conversationsOrphans} conversa(s) atribuída(s) ao proprietário`);
      }
      if (providerOrphans > 0) {
        await run.query("UPDATE provider_settings SET user_id = ? WHERE user_id = ''", [owner]);
        log(`  → ${providerOrphans} provedor(es) atribuído(s) ao proprietário`);
      }
      // Garante o registro do proprietário na tabela users.
      const existing = await run.query<Row[]>('SELECT id FROM users WHERE id = ?', [owner]);
      if (existing.length === 0) {
        const now = Date.now();
        await run.query('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)', [owner, now, now]);
        log('  → registro do proprietário criado em users');
      }
    }

    // 5. Recifragem v1 → v2 (somente linhas com chave v1).
    const v1Rows = await run.query<Row[]>(
      "SELECT id, user_id, api_key_cipher FROM provider_settings WHERE api_key_cipher LIKE 'v1.%'",
    );
    if (v1Rows.length > 0) {
      log(`  → recifrando ${v1Rows.length} chave(s) v1 → v2`);
      const failures: string[] = [];
      for (const row of v1Rows) {
        const providerId = String(row.id);
        const rowOwner = String(row.user_id || owner || '');
        const cipher = row.api_key_cipher == null ? null : String(row.api_key_cipher);
        const plain = ctx.decrypt(cipher, rowOwner ? { userId: rowOwner, providerId } : undefined);
        if (plain === null || plain === undefined) {
          failures.push(providerId);
          continue;
        }
        const reencrypted = ctx.encrypt(plain, { userId: rowOwner, providerId });
        await run.query('UPDATE provider_settings SET api_key_cipher = ? WHERE user_id = ? AND id = ?', [
          reencrypted,
          rowOwner,
          providerId,
        ]);
      }
      if (failures.length > 0) {
        throw new Error(
          `Não foi possível decifrar ${failures.length} chave(s) v1 com a PROVIDER_SECRET_KEY vigente ` +
            `(provedores: ${failures.join(', ')}). A migração foi ABORTADA sem nenhuma alteração. ` +
            'Confirme que PROVIDER_SECRET_KEY é exatamente a mesma usada quando as chaves foram gravadas.',
        );
      }
    }

    // 6. Índice de conversas por usuário.
    if (isPostgres) {
      await run.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)');
    } else {
      await run.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)');
    }
  },
};
