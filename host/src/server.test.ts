import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from './auth.js';
import { openDatabase } from './db/index.js';
import { seedDemo } from './seed.js';
import { buildServer } from './server.js';

describe('HTTP API', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('runs first-time setup once, then logs in and executes commands', async () => {
    const db = openDatabase(':memory:');
    const { app } = await buildServer({ db, tickMs: 0 });
    close = () => app.close();

    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needsSetup: true });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { venueName: 'Test', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'boss', displayName: 'Boss', password: 'secret1' } },
    });
    expect(setup.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { venueName: 'X', baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 }, manager: { username: 'x', displayName: 'X', password: 'secret1' } },
    });
    expect(again.statusCode).toBe(409);

    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'wrong' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'secret1' } });
    const { token } = login.json() as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    expect((await app.inject({ url: '/api/state' })).statusCode).toBe(401);
    const state = await app.inject({ url: '/api/state', headers: auth });
    expect(state.json().me.username).toBe('boss');

    const cmd = await app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: auth,
      payload: { type: 'admin.product.upsert', requestId: randomUUID(), payload: { name: 'Cola', priceMinor: 150 } },
    });
    expect(cmd.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/state', headers: auth })).json().products).toHaveLength(1);

    const bad = await app.inject({ method: 'POST', url: '/api/commands', headers: auth, payload: { type: 'tab.addItem', requestId: randomUUID(), payload: {} } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('error.invalid_input');
  });

  it('recovers interrupted sessions after a power cut and resumes them', async () => {
    const db = openDatabase(':memory:');
    const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
    seedDemo(db, T0);

    // First run: an open-time session is live, then the host goes down.
    const first = await buildServer({ db, clock: () => T0, tickMs: 0 });
    const op = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'operator'").get() as Actor;
    first.bus.execute(op, { type: 'shift.open', requestId: randomUUID(), payload: {} });
    const pc = db.prepare("SELECT id FROM stations WHERE name = 'PC-01'").get() as { id: string };
    first.bus.execute(op, { type: 'session.start', requestId: randomUUID(), payload: { stationId: pc.id, mode: 'postpaid' } });
    await first.app.close();

    // Restart 10 minutes later: recovery pauses the session and raises the banner.
    const { app } = await buildServer({ db, clock: () => T0 + 10 * 60_000, tickMs: 0 });
    close = () => app.close();
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin123' } });
    const auth = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

    const state = (await app.inject({ url: '/api/state', headers: auth })).json();
    expect(state.powerEvent).toMatchObject({ interrupted: 1 });
    expect(state.stations.find((s: { name: string }) => s.name === 'PC-01').session.status).toBe('paused');

    const resume = await app.inject({ method: 'POST', url: '/api/commands', headers: auth, payload: { type: 'recovery.resumeAll', requestId: randomUUID(), payload: {} } });
    expect(resume.statusCode).toBe(200);
    const after = (await app.inject({ url: '/api/state', headers: auth })).json();
    expect(after.powerEvent).toBeNull();
    expect(after.stations.find((s: { name: string }) => s.name === 'PC-01').session.status).toBe('active');
  });
});
