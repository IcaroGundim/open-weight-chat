import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret } from '../../src/server/secrets';
import {
  appliedVersions,
  createPostgresRunner,
  createSqliteRunner,
  describePending,
  loadMigrations,
  migrateUp,
  tableCounts,
  type Driver,
  type MigrationContext,
} from './runner';

/**
 * CLI de migração versionada.
 *
 *   pnpm db:migrate status              — versão atual, pendentes, contagens
 *   pnpm db:migrate up                  — aplica as migrações pendentes
 *   pnpm db:migrate up --dry-run        — mostra o que seria aplicado (sem tocar no banco)
 *   pnpm db:migrate down                — não suportado (veja scripts/db/README.md)
 *
 * Driver: DATABASE_URL (Neon/Postgres) tem prioridade; sem ela, usa SQLite em
 * CHAT_DB_PATH (padrão ./chat.db). Carrega o .env local, como o servidor.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

interface CliOptions {
  command: 'status' | 'up' | 'down';
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const command = (argv[0] === 'status' || argv[0] === 'up' || argv[0] === 'down') ? argv[0] : 'status';
  const dryRun = command === 'up' && argv.includes('--dry-run');
  return { command, dryRun };
}

function resolveDriver(): { driver: Driver; connectionString: string | null; sqlitePath: string | null } {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return { driver: 'postgres', connectionString: databaseUrl, sqlitePath: null };
  }
  const sqlitePath = process.env.CHAT_DB_PATH?.trim() || join(process.cwd(), 'chat.db');
  return { driver: 'sqlite', connectionString: null, sqlitePath };
}

function printCounts(label: string, counts: Awaited<ReturnType<typeof tableCounts>>): void {
  console.log(`  ${label}:`);
  console.log(
    `    users=${counts.users} conversations=${counts.conversations} providers=${counts.provider_settings} ` +
      `messages=${counts.messages} artifacts=${counts.artifacts}`,
  );
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function run(): Promise<void> {
  try {
    process.loadEnvFile(process.env.ENV_FILE ?? '.env');
  } catch {
    // .env é opcional; produção injeta as variáveis pelo processo.
  }

  const options = parseArgs(process.argv.slice(2));
  const { driver, connectionString, sqlitePath } = resolveDriver();
  if (driver === 'postgres' && !connectionString) {
    throw new Error('DATABASE_URL não configurada.');
  }
  if (driver === 'sqlite' && !existsSync(sqlitePath!)) {
    console.log(`Banco SQLite não encontrado em ${sqlitePath} — será criado ao aplicar a primeira migração.`);
  }

  const sqliteDb = driver === 'sqlite' ? new DatabaseSync(sqlitePath!, { enableForeignKeyConstraints: true }) : null;
  const run = driver === 'postgres'
    ? createPostgresRunner(connectionString!)
    : createSqliteRunner(sqliteDb!);
  try {
  const migrations = await loadMigrations(MIGRATIONS_DIR, driver);
  const applied = await appliedVersions(run);
  const counts = await tableCounts(run);

  const ctx: MigrationContext = {
    driver,
    ownerUserId: process.env.LEGACY_OWNER_CLERK_USER_ID?.trim() || null,
    encrypt: encryptSecret,
    decrypt: decryptSecret,
    log: (message) => console.log(message),
  };

  console.log(`Driver: ${driver === 'postgres' ? 'Postgres (Neon)' : 'SQLite'}`);
  printCounts('antes', counts);
  console.log(`Migrações: ${migrations.length} (${migrations.map((m) => m.version).join(', ')})`);

  if (options.command === 'status') {
    const pending = describePending(migrations, applied);
    console.log(`Aplicadas: ${applied.size}`);
    if (pending.length === 0) {
      console.log('Pendentes: nenhuma — banco atualizado.');
    } else {
      console.log(`Pendentes: ${pending.map((m) => `${m.version} ${m.name}`).join(', ')}`);
    }
    if (ctx.ownerUserId) {
      console.log(`LEGACY_OWNER_CLERK_USER_ID definido: ${ctx.ownerUserId}`);
    }
    return;
  }

  if (options.command === 'down') {
    console.log('Não há rollback automático. Restaure o backup do Neon (painel Neon → Branches/Backups ou pg_dump).');
    return;
  }

  // up
  const pending = describePending(migrations, applied);
  if (pending.length === 0) {
    console.log('Nada pendente — banco atualizado.');
    return;
  }
  console.log(`Pendentes: ${pending.map((m) => `${m.version} ${m.name}`).join(', ')}`);
  if (options.dryRun) {
    console.log('--- DRY-RUN: nada foi executado. ---');
    console.log('O que seria feito:');
    for (const migration of pending) {
      console.log(`  • ${migration.version} ${migration.name}`);
    }
    if (driver === 'sqlite' && (process.env.LEGACY_OWNER_CLERK_USER_ID?.trim() || (await tableCounts(run)).conversations > 0)) {
      console.log('  • atribuição de conversas/provedores sem dono ao LEGACY_OWNER_CLERK_USER_ID');
      console.log('  • recifragem das chaves v1 → v2 (aborta se alguma não puder ser lida)');
    }
    return;
  }

  const result = await migrateUp(run, migrations, ctx);
  const after = await tableCounts(run);
  printCounts('depois', after);
  console.log(`Aplicadas agora: ${result.applied.length}`);
  if (result.applied.length === 0) console.log('Nada pendente — banco atualizado.');
  } finally {
    await run.close?.();
    if (sqliteDb?.isOpen) sqliteDb.close();
  }
}

void main();
