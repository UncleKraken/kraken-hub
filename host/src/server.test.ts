import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
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
});
