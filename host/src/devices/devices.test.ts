import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { openDatabase, type DB } from '../db/index.js';
import { floorState } from '../queries.js';
import { seedDemo } from '../seed.js';
import { buildServer } from '../server.js';
import type { Actor } from '../auth.js';
import type { DeviceState } from './hub.js';

const T0 = Date.UTC(2026, 10, 1, 16, 0, 0);

let db: DB;
let now: number;
let built: Awaited<ReturnType<typeof buildServer>>;
let base: string;
let operator: Actor;

beforeEach(async () => {
  db = openDatabase(':memory:');
  now = T0;
  seedDemo(db, now);
  built = await buildServer({ db, clock: () => now, tickMs: 0 });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
  operator = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE username = 'operator'").get() as Actor;
});

afterEach(async () => {
  await built.app.close();
});

const run = (type: string, payload: unknown) => built.bus.execute(operator, { type, requestId: randomUUID(), payload }) as Record<string, unknown>;
const floor = () => floorState(db, operator, now, built.hub.onlineIds());
const station = (name: string) => floor().stations.find((s) => s.name === name)!;

async function pair(machineId = 'MACHINE-0001-ABCD') {
  const secret = randomBytes(24).toString('hex');
  const res = await fetch(`http://${base}/api/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineId, hostname: 'GAMING-PC-03', mac: 'AA:BB:CC:DD:EE:03', secret, version: '0.1.0' }),
  });
  return { secret, ...((await res.json()) as { deviceId: string; status: string }) };
}

/** A fake customer PC: connects, records every message, and can send requests. */
class FakePC {
  messages: Record<string, unknown>[] = [];
  private ws: WebSocket;
  private waiters: ((m: Record<string, unknown>) => boolean)[] = [];
  constructor(deviceId: string, secret: string) {
    this.ws = new WebSocket(`ws://${base}/api/agent/ws?deviceId=${deviceId}&secret=${secret}&version=0.1.0`);
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  closedWith(): Promise<number> {
    return new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }
  next(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        resolve(m);
        return true;
      });
    });
  }
  state(pred: (s: DeviceState) => boolean = () => true): Promise<DeviceState> {
    const last = [...this.messages].reverse().find((m) => m.type === 'state') as DeviceState | undefined;
    if (last && pred(last)) return Promise.resolve(last);
    return this.next((m) => m.type === 'state' && pred(m as unknown as DeviceState)) as unknown as Promise<DeviceState>;
  }
  request(kind: string, payload: unknown = {}) {
    const requestId = randomUUID();
    this.ws.send(JSON.stringify({ type: 'request', requestId, kind, payload }));
    return this.next((m) => m.type === 'result' && m.requestId === requestId);
  }
  endSession() {
    const requestId = randomUUID();
    this.ws.send(JSON.stringify({ type: 'endSession', requestId }));
    return this.next((m) => m.type === 'result' && m.requestId === requestId);
  }
  close() {
    this.ws.close();
  }
}

describe('customer PC link', () => {
  it('pairs, waits for approval, then runs a guest session end to end', async () => {
    const p = await pair();
    expect(p.status).toBe('pending');
    expect(floor().pendingDevices.map((d) => d.hostname)).toEqual(['GAMING-PC-03']);

    // Not approved yet: the live link is refused.
    const early = new FakePC(p.deviceId, p.secret);
    expect(await early.closedWith()).toBe(4401);

    run('device.approve', { deviceId: p.deviceId, stationId: station('PC-03').id });
    expect(floor().pendingDevices).toHaveLength(0);
    expect((await pair()).status).toBe('pending'); // a different secret is a new request
    const again = await fetch(`http://${base}/api/agent/status?deviceId=${p.deviceId}&secret=${p.secret}`);
    expect(((await again.json()) as { status: string }).status).toBe('approved');

    const pc = new FakePC(p.deviceId, p.secret);
    await pc.opened();
    const idle = await pc.state();
    expect(idle).toMatchObject({ paired: true, locked: true, reason: 'idle', station: { name: 'PC-03' } });
    expect(station('PC-03').device?.online).toBe(true);

    // Customer taps "Continue as guest"; the operator sees it and approves open time.
    const guest = await pc.request('guest');
    expect(guest.ok).toBe(true);
    const req = floor().requests.find((r) => r.kind === 'guest')!;
    expect(req.stationName).toBe('PC-03');
    run('request.resolveGuest', { requestId: req.id, decision: 'approve', mode: 'postpaid' });
    const unlocked = await pc.state((s) => !s.locked);
    expect(unlocked.session?.mode).toBe('postpaid');

    // Customer orders a Coke; it reaches the tab only when the operator marks it delivered.
    const coke = floor().products.find((x) => x.name === 'Coca-Cola')!;
    expect((await pc.request('order', { items: [{ productId: coke.id, qty: 2 }] })).ok).toBe(true);
    expect(station('PC-03').tab?.balanceMinor).toBe(0);
    const order = floor().requests.find((r) => r.kind === 'order')!;
    run('request.resolve', { requestId: order.id, decision: 'done' });
    expect(station('PC-03').tab?.balanceMinor).toBe(300);

    // 40 minutes later the customer ends the session from the PC.
    now += 40 * 60_000;
    expect((await pc.endSession()).ok).toBe(true);
    const locked = await pc.state((s) => s.locked && s.reason === 'idle');
    expect(locked.tab?.balanceMinor).toBe(300 + 133);
    const audit = db.prepare("SELECT actor_id FROM audit_log WHERE action = 'session.end'").get() as { actor_id: string };
    expect(audit.actor_id).toBe('system-client');

    // Remote restart reaches the PC.
    run('station.remote', { stationId: station('PC-03').id, action: 'restart' });
    const cmd = await pc.next((m) => m.type === 'command');
    expect(cmd.action).toBe('restart');
    pc.close();
  });

  it('refuses wrong secrets and keeps PC-only commands off the HTTP API', async () => {
    const p = await pair();
    run('device.approve', { deviceId: p.deviceId, stationId: station('PC-01').id });
    const bad = new FakePC(p.deviceId, 'x'.repeat(48));
    expect(await bad.closedWith()).toBe(4401);
    expect(() => run('client.request', { deviceId: p.deviceId, kind: 'guest' })).toThrow(expect.objectContaining({ code: 'error.unknown_command' }));
  });

  it('pauses open time when a PC goes offline for 90 seconds', async () => {
    const p = await pair();
    run('device.approve', { deviceId: p.deviceId, stationId: station('PC-02').id });
    const pc = new FakePC(p.deviceId, p.secret);
    await pc.opened();
    await pc.state();
    run('session.start', { stationId: station('PC-02').id });
    pc.close();
    await new Promise((r) => setTimeout(r, 50));
    now += 60_000;
    built.hub.tick();
    expect(station('PC-02').session?.status).toBe('active');
    now += 40_000;
    built.hub.tick();
    expect(station('PC-02').session?.status).toBe('paused');
    expect(station('PC-02').device?.online).toBe(false);
  });

  it('expires unanswered guest requests after two minutes', async () => {
    const { expireGuestRequests } = await import('./commands.js');
    const p = await pair();
    run('device.approve', { deviceId: p.deviceId, stationId: station('PC-04').id });
    const pc = new FakePC(p.deviceId, p.secret);
    await pc.opened();
    await pc.state();
    await pc.request('guest');
    now += 121_000;
    expect(expireGuestRequests(db, now)).toBe(1);
    built.hub.pushAll();
    const s = await pc.state((x) => x.guestRequest?.status === 'expired');
    expect(s.locked).toBe(true);
    pc.close();
  });
});
