import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/index.js';
import { startDiscovery } from './discovery.js';
import { readSettings } from './domain/venue.js';
import { buildServer } from './server.js';
import { readSyncConfig, SyncAgent } from './sync/agent.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.KRAKEN_DATA_DIR ?? join(here, '..', 'data'));
const port = Number(process.env.PORT ?? 7300);
const host = process.env.HOST ?? '0.0.0.0';
const webDir = resolve(process.env.KRAKEN_WEB_DIR ?? join(here, '..', '..', 'web', 'dist'));

const db = openDatabase(join(dataDir, 'kraken-hub.db'));
const { app } = await buildServer({ db, webDir, logger: true });

await app.listen({ port, host });
app.log.info(`Kraken Hub host ready on http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (data: ${dataDir})`);

// Let customer PCs find this host on the local network.
const discovery = startDiscovery({
  httpPort: port,
  name: () => readSettings(db).venueName,
  onError: (err) => app.log.warn({ err }, 'PC discovery unavailable; PCs can still be pointed at the host address'),
});

// Multi-branch: if a hub is configured, push this branch's daily rollup to it. Optional —
// with no hub env set, nothing starts and the branch runs standalone.
const syncConfig = readSyncConfig();
const syncAgent = syncConfig ? new SyncAgent(db, syncConfig, Date.now, (msg, err) => app.log.warn({ err }, msg)) : null;
if (syncAgent && syncConfig) {
  syncAgent.start();
  app.log.info(`Multi-branch sync on: reporting to hub at ${syncConfig.hubUrl} as "${syncConfig.branchName}"`);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  discovery.close();
  syncAgent?.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
