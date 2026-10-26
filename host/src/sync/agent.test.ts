import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { floorState } from '../queries.js';
import { seedDemo } from '../seed.js';
import { CommandBus } from '../commands/bus.js';
import { sessionCommands } from '../commands/sessions.js';
import { tabCommands } from '../commands/tabs.js';
import { shiftCommands } from '../commands/shifts.js';
import { readSyncConfig, SyncAgent } from './agent.js';

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
let db: DB;
let bus: CommandBus;
let op: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  seedDemo(db, T0);
  bus = new CommandBus(db, () => T0).register(...sessionCommands, ...tabCommands, ...shiftCommands);
  op = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'operator'").get() as Actor;
  bus.execute(op, { type: 'shift.open', requestId: randomUUID(), payload: {} });
});

const run = (type: string, payload: unknown) => bus.execute(op, { type, requestId: randomUUID(), payload });
const state = () => floorState(db, op, T0);
const prod = (n: string) => state().products.find((p) => p.name === n)!;

function sale() {
  const sid = state().stations.find((s) => s.name === 'PC-01')!.id;
  run('session.start', { stationId: sid, mode: 'postpaid', players: 1 });
  run('tab.addItem', { stationId: sid, productId: prod('Red Bull').id, qty: 2 });
  const live = state().stations.find((s) => s.id === sid)!.session!;
  const ended = run('session.end', { sessionId: live.id }) as { tabId: string };
  const due = (db.prepare('SELECT COALESCE(SUM(amount_minor),0) c FROM ledger WHERE tab_id=?').get(ended.tabId) as { c: number }).c;
  run('tab.checkout', { tabId: ended.tabId, method: 'cash', tenders: [{ currency: 'ALL', amountMinor: due }], tipMinor: 0 });
}

describe('SyncAgent', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('keeps running when the hub is unreachable (offline-safe)', async () => {
    sale();
    // Port 9 (discard) refuses connections; the push must resolve, not throw.
    const agent = new SyncAgent(db, { hubUrl: 'http://127.0.0.1:9', branchId: 'b1', branchName: 'B1', secret: 'x'.repeat(16), tzOffsetMin: 0 }, () => T0);
    await expect(agent.push(0)).resolves.toBe(0);
  });

  it('pushes the recomputed rollup to the hub', async () => {
    sale();
    let received: { branchId?: string; days?: { summary: { revenueMinor: number } }[] } | null = null;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"days":1}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const agent = new SyncAgent(db, { hubUrl: `http://127.0.0.1:${port}`, branchId: 'tirana', branchName: 'Tirana', secret: 'secret-abcdefghij', tzOffsetMin: 60 }, () => T0);
    const sent = await agent.push(0);
    expect(sent).toBe(1);
    expect(received!.branchId).toBe('tirana');
    expect(received!.days![0]!.summary.revenueMinor).toBeGreaterThan(0);
  });

  it('is disabled when no hub is configured', () => {
    expect(readSyncConfig({})).toBeNull();
    expect(readSyncConfig({ KRAKEN_HUB_URL: 'http://h', KRAKEN_BRANCH_ID: 'b' })).toBeNull(); // missing secret
    const cfg = readSyncConfig({ KRAKEN_HUB_URL: 'http://h/', KRAKEN_BRANCH_ID: 'b', KRAKEN_BRANCH_SECRET: 's', KRAKEN_BRANCH_NAME: 'Name' });
    expect(cfg).toMatchObject({ hubUrl: 'http://h', branchId: 'b', branchName: 'Name' });
  });
});
