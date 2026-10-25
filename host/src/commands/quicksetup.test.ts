import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { verifyPassword } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { migrations } from '../db/migrations.js';
import { CommandBus } from './bus.js';
import { adminCommands, runSetup } from './admin.js';
import { AppError } from '../errors.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
let db: DB;
let bus: CommandBus;
let manager: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  void migrations;
  runSetup(db, { venueName: 'Kraken', language: 'en', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'boss', displayName: 'Boss', password: 'secret1' } }, T0);
  bus = new CommandBus(db, () => T0).register(...adminCommands);
  manager = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'boss'").get() as Actor;
});

const run = (type: string, payload: unknown) => bus.execute(manager, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;

describe('admin.quickSetup', () => {
  it('creates a plan, stations and an operator in one go', () => {
    const res = run('admin.quickSetup', {
      hourlyRateMinor: 200,
      pcCount: 10,
      consoleCount: 2,
      tableCount: 1,
      operator: { username: 'staff', displayName: 'Floor', password: 'floor1' },
    });
    expect(res).toMatchObject({ pcCount: 10, consoleCount: 2, tableCount: 1, operatorCreated: true });

    const plans = db.prepare('SELECT name, config FROM price_plans').all() as { name: string; config: string }[];
    expect(plans).toHaveLength(1);
    expect(JSON.parse(plans[0]!.config)).toMatchObject({ kind: 'hourly', rates: { '1': 200 } });

    const stations = db.prepare('SELECT kind, name, control FROM stations ORDER BY sort').all() as { kind: string; name: string; control: string }[];
    expect(stations).toHaveLength(13);
    expect(stations.filter((s) => s.kind === 'pc')).toHaveLength(10);
    expect(stations[0]).toMatchObject({ name: 'PC-01', kind: 'pc', control: 'agent' });
    expect(stations.find((s) => s.kind === 'console')).toMatchObject({ control: 'manual' });
    // Every station points at the one plan.
    const planId = (db.prepare('SELECT id FROM price_plans').get() as { id: string }).id;
    expect((db.prepare('SELECT COUNT(*) AS n FROM stations WHERE price_plan_id = ?').get(planId) as { n: number }).n).toBe(13);

    const op = db.prepare("SELECT role, password_hash FROM users WHERE username = 'staff'").get() as { role: string; password_hash: string };
    expect(op.role).toBe('operator');
    expect(verifyPassword('floor1', op.password_hash)).toBe(true);
  });

  it('works without an operator and with only PCs', () => {
    const res = run('admin.quickSetup', { hourlyRateMinor: 150, pcCount: 5 });
    expect(res).toMatchObject({ pcCount: 5, consoleCount: 0, tableCount: 0, operatorCreated: false });
    expect((db.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number }).n).toBe(5);
  });

  it('refuses to run once stations exist', () => {
    run('admin.quickSetup', { hourlyRateMinor: 200, pcCount: 3 });
    expect(() => run('admin.quickSetup', { hourlyRateMinor: 200, pcCount: 3 })).toThrow(expect.objectContaining({ code: 'error.already_set_up' }));
    // Nothing was added by the refused second run.
    expect((db.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number }).n).toBe(3);
  });

  it('rejects a setup that would create no stations', () => {
    expect(() => run('admin.quickSetup', { hourlyRateMinor: 200, pcCount: 0 })).toThrow(AppError);
    expect((db.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number }).n).toBe(0);
  });

  it('rolls back everything if the operator username is taken', () => {
    // 'boss' already exists; reusing it must abort the whole setup atomically.
    expect(() =>
      run('admin.quickSetup', { hourlyRateMinor: 200, pcCount: 4, operator: { username: 'boss', displayName: 'x', password: 'pass12' } }),
    ).toThrow(expect.objectContaining({ code: 'error.username_taken' }));
    expect((db.prepare('SELECT COUNT(*) AS n FROM stations').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM price_plans').get() as { n: number }).n).toBe(0);
  });
});
