import { serve } from '@hono/node-server';
import { createApp } from './index';
import { ChatDatabase } from './db/queries';

/**
 * Entrada do servidor local.
 *
 * O SQLite (`node:sqlite`) é importado **aqui**, e não em `index.ts`, de
 * propósito: `api/[...route].ts` importa `index.ts` e, com o import estático,
 * o `node:sqlite` entrava no grafo de módulos da função serverless. Esse módulo
 * exige Node ≥ 22.5 e, antes do 23.4, a flag --experimental-sqlite — se o
 * runtime não o tiver, a importação falha e derruba a função inteira antes de
 * qualquer rota existir. A função da Vercel usa Neon e nunca precisou dele.
 */
export function startServer(): ReturnType<typeof serve> {
  const port = Number(process.env.PORT ?? 8787);
  const hostname = process.env.HOST ?? '0.0.0.0';
  const app = createApp({ db: process.env.DATABASE_URL ? undefined : new ChatDatabase() });
  return serve({ fetch: app.fetch, port, hostname });
}

startServer();
console.log(`Backend ouvindo em http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 8787}`);
