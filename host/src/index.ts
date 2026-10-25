import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/index.js';
import { startDiscovery } from './discovery.js';
import { readSettings } from './domain/venue.js';
import { buildServer } from './server.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.KRAKEN_DATA_DIR ?? join(here, '..', 'data'));
const port = Number(process.env.PORT ?? 7300);
const host = process.env.HOST ?? '0.0.0.0';
const webDir = resolve(process.env.KRAKEN_WEB_DIR ?? join(here, '..', '..', 'web', 'dist'));

const db = openDatabase(join(dataDir, 'kraken-hub.db'));
const { app } = await buildServer({ db, webDir, logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port, host });
app.log.info(`Kraken Hub host ready on http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (data: ${dataDir})`);

// Let customer PCs find this host on the local network.
const discovery = startDiscovery({
  httpPort: port,
  name: () => readSettings(db).venueName,
  onError: (err) => app.log.warn({ err }, 'PC discovery unavailable; PCs can still be pointed at the host address'),
});
app.addHook('onClose', async () => {
  discovery.close();
});
