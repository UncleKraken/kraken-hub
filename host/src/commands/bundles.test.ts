import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { floorState } from '../queries.js';
import { adminCommands, runSetup } from './admin.js';
import { bundleCommands } from './bundles.js';
import { CommandBus } from './bus.js';
import { sessionCommands } from './sessions.js';

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
let db: DB;
let bus: CommandBus;
let manager: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  runSetup(db, { venueName: 'Kraken', language: 'en', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'boss', displayName: 'Boss', password: 'secret1' } }, T0);
  bus = new CommandBus(db, () => T0).register(...adminCommands, ...bundleCommands, ...sessionCommands);
  manager = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'boss'").get() as Actor;
  // 200 L/h PCs, plus a console.
  run('admin.quickSetup', { hourlyRateMinor: 200, pcCount: 2, consoleCount: 1 });
});

const run = (type: string, payload: unknown) => bus.execute(manager, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;
const pcs = () => db.prepare("SELECT id, name, kind FROM stations WHERE kind = 'pc' ORDER BY sort").all() as { id: string; name: string }[];
const consoleStation = () => db.prepare("SELECT id FROM stations WHERE kind = 'console' LIMIT 1").get() as { id: string };
const tabBalance = (tabId: string) => (db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS s FROM ledger WHERE tab_id = ?').get(tabId) as { s: number }).s;

describe('bundles', () => {
  it('a new bundle shows up as active and lands in the floor state', () => {
    const { id } = run('bundle.upsert', { name: '5 hours', minutes: 300, priceMinor: 800, kinds: ['pc'] });
    const st = floorState(db, manager, T0);
    expect(st.bundles).toHaveLength(1);
    expect(st.bundles[0]).toMatchObject({ id, name: '5 hours', minutes: 300, priceMinor: 800, kinds: ['pc'], active: true });
  });

  it('starting a session from a bundle charges the flat price, not minutes × rate', () => {
    // 300 min at 200 L/h would be 1000 L; the bundle sells it for 800.
    run('bundle.upsert', { name: '5 hours', minutes: 300, priceMinor: 800, kinds: ['pc'] });
    const bundle = floorState(db, manager, T0).bundles[0]!;
    const pc = pcs()[0]!;
    const res = run('session.start', { stationId: pc.id, bundleId: bundle.id });

    const session = db.prepare('SELECT mode, prepaid_minutes AS m, bundle_id AS b FROM sessions WHERE id = ?').get(res.sessionId as string) as { mode: string; m: number; b: string };
    expect(session).toMatchObject({ mode: 'prepaid', m: 300, b: bundle.id });
    expect(tabBalance(res.tabId as string)).toBe(800);
  });

  it('refuses a bundle on a station kind it does not apply to', () => {
    run('bundle.upsert', { name: 'Console night', minutes: 120, priceMinor: 500, kinds: ['console'] });
    const bundle = floorState(db, manager, T0).bundles[0]!;
    const pc = pcs()[0]!;
    expect(() => run('session.start', { stationId: pc.id, bundleId: bundle.id })).toThrow(/bundle_wrong_kind/);
    // But it works on the console.
    const res = run('session.start', { stationId: consoleStation().id, bundleId: bundle.id });
    expect(tabBalance(res.tabId as string)).toBe(500);
  });

  it('a bundle with no kinds applies to every station', () => {
    run('bundle.upsert', { name: 'Any 1h', minutes: 60, priceMinor: 150, kinds: [] });
    const bundle = floorState(db, manager, T0).bundles[0]!;
    expect(() => run('session.start', { stationId: pcs()[0]!.id, bundleId: bundle.id })).not.toThrow();
    expect(() => run('session.start', { stationId: consoleStation().id, bundleId: bundle.id })).not.toThrow();
  });

  it('an archived bundle leaves the floor state and cannot start a session', () => {
    const { id } = run('bundle.upsert', { name: 'Old deal', minutes: 60, priceMinor: 100, kinds: ['pc'] });
    run('bundle.setActive', { id, active: false });
    expect(floorState(db, manager, T0).bundles).toHaveLength(0);
    expect(() => run('session.start', { stationId: pcs()[0]!.id, bundleId: id as string })).toThrow(/bundle_inactive/);
  });

  it('editing a bundle updates it in place and keeps one row', () => {
    const { id } = run('bundle.upsert', { name: '5 hours', minutes: 300, priceMinor: 800, kinds: ['pc'] });
    run('bundle.upsert', { id, name: '5 hours (promo)', minutes: 300, priceMinor: 700, kinds: ['pc', 'sim'] });
    const st = floorState(db, manager, T0);
    expect(st.bundles).toHaveLength(1);
    expect(st.bundles[0]).toMatchObject({ name: '5 hours (promo)', priceMinor: 700, kinds: ['pc', 'sim'] });
  });
});
