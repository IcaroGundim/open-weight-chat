import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret, isV2Blob } from '../../src/server/secrets';
import {
  appliedVersions,
  createSqliteRunner,
  loadMigrations,
  migrateUp,
  splitStatements,
  tableCounts,
  toPostgresPlaceholders,
  type MigrationContext,
  type SqlRunner,
} from './runner';
import { migration as multiuserMigration } from './migrations/002-multiusuario';

/**
 * Testes do motor de migrações (SQLite em memória — sem rede, sem Neon).
 *
 * O cenário "legado" constrói manualmente o schema PRÉ-multiusuário
 * (conversations/provider_settings sem user_id, provider_settings com PK
 * simples em id) e chaves v1 — exatamente o que existe no deploy atual.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const SECRET = 'chave-mestra-de-teste-bem-longa';

let db: DatabaseSync;

/** Cifra como o formato v1 ANTIGO (AES-256-GCM sem AAD), como o deploy atual faz. */
function encryptLegacyV1(plain: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(SECRET, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', salt, iv, tag, ciphertext].map((part) => part.toString('base64')).join('.');
}

function legacyContext(ownerUserId: string | null): MigrationContext {
  return {
    driver: 'sqlite',
    ownerUserId,
    encrypt: encryptSecret,
    decrypt: decryptSecret,
    log: () => undefined,
  };
}

/** Cria um banco com o schema ANTIGO (pré-multiusuário) e dados legados. */
function seedLegacyDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      system_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', reasoning TEXT, provider_id TEXT, model_id TEXT,
      prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
      total_tokens INTEGER, cost_usd REAL, cost_estimated INTEGER NOT NULL DEFAULT 0, finish_reason TEXT,
      error_code TEXT, created_at INTEGER NOT NULL, latency_ms INTEGER
    );
    CREATE TABLE provider_settings (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, base_url TEXT NOT NULL, models_json TEXT NOT NULL,
      verified_at TEXT, api_key_cipher TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  process.env.PROVIDER_SECRET_KEY = SECRET;
});

afterEach(() => {
  db.close();
  delete process.env.PROVIDER_SECRET_KEY;
});

describe('motor de migração', () => {
  it('nao divide SQL em ponto-e-virgula dentro de comentarios ou literais', () => {
    const statements = splitStatements(
      "-- A descricao termina; mas o comentario continua\n" +
      "CREATE TABLE first_table (value text DEFAULT ';');\n" +
      '/* Outro comentario; ainda nao e um statement. */\n' +
      'CREATE TABLE second_table (id integer);',
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE first_table');
    expect(statements[1]).toContain('CREATE TABLE second_table');
  });

  it('adapta placeholders neutros para Postgres sem alterar literais', () => {
    expect(toPostgresPlaceholders("SELECT '?' AS literal, name FROM users WHERE id = ? AND note = 'it''s ?'"))
      .toBe("SELECT '?' AS literal, name FROM users WHERE id = $1 AND note = 'it''s ?'");
  });

  it('registra versões com BIGINT, compatível com Date.now() no Postgres', async () => {
    const executed: string[] = [];
    const runner: SqlRunner = {
      exec: async (sql) => { executed.push(sql); },
      query: async () => [],
      transaction: async (fn) => await fn(),
    };

    await appliedVersions(runner);
    expect(executed[0]).toContain('applied_at BIGINT NOT NULL');
  });

  it('cria timestamps BIGINT ao migrar um Neon legado', async () => {
    const executed: string[] = [];
    const runner: SqlRunner = {
      exec: async (sql) => { executed.push(sql); },
      query: async () => [],
      transaction: async (fn) => await fn(),
    };

    await multiuserMigration.up(runner, {
      driver: 'postgres',
      ownerUserId: null,
      encrypt: () => '',
      decrypt: () => null,
      log: () => undefined,
    });

    expect(executed[0]).toContain('created_at BIGINT NOT NULL');
    expect(executed[0]).toContain('updated_at BIGINT NOT NULL');
  });

  it('status em banco vazio: nenhuma migração aplicada', async () => {
    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    expect(migrations.map((m) => m.version)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
    expect(await appliedVersions(run)).toEqual(new Set());
  });

  it('up em banco vazio aplica 001 a 010 e cria o schema multiusuário', async () => {
    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    const result = await migrateUp(run, migrations, legacyContext(null));
    expect(result.applied.map((m) => m.version)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row: { name: string }) => row.name);
    expect(tables).toContain('users');
    expect(tables).toContain('schema_migrations');

    const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map((row: { name: string }) => row.name);
    expect(conversationColumns).toContain('user_id');
    // Migração 007: o CHECK de artifacts.kind passa a aceitar mindmap, e a
    // reconstrução da tabela não pode ter levado o índice junto.
    const artefatos = await run.query<Array<{ sql: string }>>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'",
    );
    expect(artefatos[0].sql).toContain('mindmap');
    // 008: gráfico entra no mesmo CHECK.
    expect(artefatos[0].sql).toContain('chart');
    const indice = await run.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_artifacts_conv'",
    );
    expect(indice).toHaveLength(1);

    // Tabela de anexos da migração 006.
    const anexos = await run.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'",
    );
    expect(anexos).toHaveLength(1);
    const attachmentSql = await run.query<Array<{ sql: string }>>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'",
    );
    expect(attachmentSql[0].sql).toContain('spreadsheet');
    const spreadsheetVersions = await run.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='spreadsheet_versions'",
    );
    expect(spreadsheetVersions).toHaveLength(1);

    // Tabela de configuração de busca da migração 005.
    const busca = await run.query<Array<Record<string, unknown>>>('PRAGMA table_info(search_settings)');
    expect(busca.map((row) => String(row.name))).toContain('backend');
    // Coluna de nível de esforço da migração 004.
    expect(conversationColumns).toContain('effort');

    // PK composta em provider_settings.
    const providerPk = db.prepare('PRAGMA table_info(provider_settings)').all().filter((row: { pk: number }) => row.pk > 0);
    expect(providerPk.map((row: { name: string }) => row.name).sort()).toEqual(['id', 'user_id']);

    // Índice de conversas por usuário.
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conversations_user'").get();
    expect(index).toBeTruthy();

    // Tabelas de rate limit da migração 003.
    const rateTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rate_limit_counters','rate_limit_streams')").all();
    expect(rateTables).toHaveLength(2);

    expect(await appliedVersions(run)).toEqual(new Set(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']));
  });

  it('up é idempotente: segunda execução não quebra nem duplica', async () => {
    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    await migrateUp(run, migrations, legacyContext(null));
    const before = await tableCounts(run);
    const second = await migrateUp(run, migrations, legacyContext(null));
    expect(second.applied).toEqual([]);
    expect(await tableCounts(run)).toEqual(before);
  });

  it('migração 010 preserva anexos existentes e suas chaves estrangeiras', async () => {
    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    await migrateUp(run, migrations.filter((migration) => migration.version !== '010'), legacyContext(null));
    const now = Date.now();
    db.prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)').run('user-sheet', now, now);
    db.prepare(`INSERT INTO conversations (id,user_id,title,provider_id,model_id,created_at,updated_at,archived)
      VALUES (?,?,?,?,?,?,?,0)`).run('conv-sheet', 'user-sheet', 'Planilha', 'ollama', 'llama3.2', now, now);
    db.prepare(`INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)`)
      .run('msg-sheet', 'conv-sheet', 'user', 'arquivo', now);
    db.prepare(`INSERT INTO attachments
      (id,user_id,conversation_id,message_id,kind,filename,mime,size_bytes,data_base64,extracted_text,truncated,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('attachment-old', 'user-sheet', 'conv-sheet', 'msg-sheet', 'document', 'notas.txt', 'text/plain', 5, null, 'texto', 0, now);

    await migrateUp(run, migrations, legacyContext(null));
    const attachment = db.prepare('SELECT * FROM attachments WHERE id=?').get('attachment-old') as Record<string, unknown>;
    expect(attachment.extracted_text).toBe('texto');
    expect(attachment.message_id).toBe('msg-sheet');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('migra dados legados: atribui ao LEGACY_OWNER e recifra v1 → v2', async () => {
    seedLegacyDatabase(db);
    const now = Date.now();
    const legacyKey = 'sk-chave-antiga-do-dono';
    db.prepare('INSERT INTO conversations (id, title, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('conv-1', 'Legado', 'deepseek', 'deepseek-v4-flash', now, now);
    db.prepare('INSERT INTO provider_settings (id, label, base_url, models_json, verified_at, api_key_cipher, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', '[]', null, encryptLegacyV1(legacyKey), now, now);

    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    await migrateUp(run, migrations, legacyContext('user_owner_123'));

    // Conversa atribuída ao dono.
    const conversation = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get('conv-1') as { user_id: string };
    expect(conversation.user_id).toBe('user_owner_123');

    // Provedor atribuído ao dono e chave recifrada como v2.
    const provider = db.prepare('SELECT user_id, api_key_cipher FROM provider_settings WHERE id = ?').get('openrouter') as {
      user_id: string;
      api_key_cipher: string;
    };
    expect(provider.user_id).toBe('user_owner_123');
    expect(isV2Blob(provider.api_key_cipher)).toBe(true);
    expect(decryptSecret(provider.api_key_cipher, { userId: 'user_owner_123', providerId: 'openrouter' })).toBe(legacyKey);

    // Registro do dono em users.
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get('user_owner_123');
    expect(user).toBeTruthy();
  });

  it('falha com mensagem clara quando há dados órfãos e não há LEGACY_OWNER', async () => {
    seedLegacyDatabase(db);
    const now = Date.now();
    db.prepare('INSERT INTO conversations (id, title, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('conv-1', 'Legado', 'deepseek', 'deepseek-v4-flash', now, now);

    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    await expect(migrateUp(run, migrations, legacyContext(null))).rejects.toThrow(/LEGACY_OWNER_CLERK_USER_ID/);

    // A 001 (schema idempotente) fica aplicada; a 002 falhou e reverteu.
    expect(await appliedVersions(run)).toEqual(new Set(['001']));
  });

  it('aborta com rollback quando uma chave v1 não pode ser decifrada', async () => {
    seedLegacyDatabase(db);
    const now = Date.now();
    db.prepare('INSERT INTO provider_settings (id, label, base_url, models_json, verified_at, api_key_cipher, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', '[]', null, 'v1.salt.invalido.tag.lixo', now, now);

    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    await expect(migrateUp(run, migrations, legacyContext('user_owner_123'))).rejects.toThrow(/ABORTADA|decifrar/);

    // A 001 (schema idempotente) fica aplicada; a 002 reverteu: chave intacta.
    expect(await appliedVersions(run)).toEqual(new Set(['001']));
    const provider = db.prepare('SELECT api_key_cipher FROM provider_settings WHERE id = ?').get('openrouter') as { api_key_cipher: string };
    expect(provider.api_key_cipher).toBe('v1.salt.invalido.tag.lixo');
  });

  it('conta linhas após migração completa', async () => {
    const run = createSqliteRunner(db);
    const migrations = await loadMigrations(MIGRATIONS_DIR, 'sqlite');
    await migrateUp(run, migrations, legacyContext(null));
    const counts = await tableCounts(run);
    expect(counts.users).toBe(0);
    expect(counts.conversations).toBe(0);
    expect(counts.provider_settings).toBe(0);
  });
});
