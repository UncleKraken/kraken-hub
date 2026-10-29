import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { parseLayout, readFloorPlan } from '../domain/venue.js';
import { floorState } from '../queries.js';
import { CommandBus } from './bus.js';
import { adminCommands, runSetup } from './admin.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
let db: DB;
let bus: CommandBus;
let manager: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  runSetup(db, { venueName: 'Kraken', language: 'en', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'boss', displayName: 'Boss', password: 'secret1' } }, T0);
  bus = new CommandBus(db, () => T0).register(...adminCommands);
  manager = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'boss'").get() as Actor;
  run('admin.quickSetup', { hourlyRateMinor: 200, pcCount: 3, consoleCount: 1 });
});

const run = (type: string, payload: unknown) => bus.execute(manager, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;
const ids = () => (db.prepare('SELECT id, kind FROM stations ORDER BY sort').all() as { id: string; kind: string }[]);

describe('admin.floor.layout', () => {
  it('stores station positions/shapes and décor areas, and reads them back on the floor', () => {
    const [a, b] = ids();
    const res = run('admin.floor.layout', {
      canvas: { w: 1000, h: 680 },
      stations: [
        { id: a!.id, x: 40, y: 60, shape: 'desk' },
        { id: b!.id, x: 200, y: 60, shape: 'round', w: 100, h: 100 },
      ],
      areas: [{ id: 'area1', x: 10, y: 10, w: 300, h: 200, label: 'VIP Room', color: 'violet' }],
    });
    expect(res).toMatchObject({ placed: 2, areas: 1 });

    const plan = readFloorPlan(db);
    expect(plan.areas).toEqual([{ id: 'area1', x: 10, y: 10, w: 300, h: 200, label: 'VIP Room', color: 'violet' }]);

    const st = floorState(db, manager, T0);
    const sa = st.stations.find((s) => s.id === a!.id)!;
    const sb = st.stations.find((s) => s.id === b!.id)!;
    expect(sa.layout).toEqual({ x: 40, y: 60, shape: 'desk' });
    expect(sb.layout).toEqual({ x: 200, y: 60, shape: 'round', w: 100, h: 100 });
    expect(st.floorPlan.areas).toHaveLength(1);
  });

  it('is authoritative: a station left out of a later save is taken off the map', () => {
    const [a, b] = ids();
    run('admin.floor.layout', {
      stations: [
        { id: a!.id, x: 40, y: 60, shape: 'desk' },
        { id: b!.id, x: 200, y: 60, shape: 'sofa' },
      ],
      areas: [],
    });
    // Re-save with only the first station: the second should lose its placement.
    run('admin.floor.layout', { stations: [{ id: a!.id, x: 50, y: 70, shape: 'seat' }], areas: [] });

    const st = floorState(db, manager, T0);
    expect(st.stations.find((s) => s.id === a!.id)!.layout).toEqual({ x: 50, y: 70, shape: 'seat' });
    expect(st.stations.find((s) => s.id === b!.id)!.layout).toBeNull();
  });

  it('coordinates are rounded and an unknown shape falls back to plain on read', () => {
    const [a] = ids();
    run('admin.floor.layout', { stations: [{ id: a!.id, x: 40.7, y: 59.2, shape: 'rect' }], areas: [] });
    const raw = (db.prepare('SELECT layout FROM stations WHERE id = ?').get(a!.id) as { layout: string }).layout;
    expect(JSON.parse(raw)).toEqual({ x: 41, y: 59, shape: 'rect' });
    // Defensive read of a hand-corrupted layout.
    expect(parseLayout('{"x":1,"y":2,"shape":"bogus"}')).toEqual({ x: 1, y: 2, shape: 'plain' });
    expect(parseLayout('not json')).toBeNull();
    expect(parseLayout(null)).toBeNull();
  });

  it('skips unknown / archived station ids without failing the whole save', () => {
    const [a] = ids();
    const res = run('admin.floor.layout', {
      stations: [
        { id: a!.id, x: 10, y: 10, shape: 'desk' },
        { id: 'does-not-exist', x: 20, y: 20, shape: 'desk' },
      ],
      areas: [],
    });
    expect(res).toMatchObject({ placed: 1 });
  });
});
