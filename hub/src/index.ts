import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { buildHub } from './server.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.KRAKEN_HUB_DATA_DIR ?? join(here, '..', 'data'));
const port = Number(process.env.PORT ?? 7400);
const host = process.env.HOST ?? '0.0.0.0';
const publicDir = resolve(process.env.KRAKEN_HUB_PUBLIC_DIR ?? join(here, '..', 'public'));

const db = openDatabase(join(dataDir, 'kraken-hub-central.db'));
const { app } = await buildHub({ db, logger: true, publicDir });

await app.listen({ port, host });
app.log.info(`Kraken Hub (central) ready on http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (data: ${dataDir})`);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
