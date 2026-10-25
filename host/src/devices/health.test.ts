import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { openDatabase, type DB } from '../db/index.js';
import { deviceHealthDetail, floorState } from '../queries.js';
import { seedDemo } from '../seed.js';
import { buildServer } from '../server.js';

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

async function pairApproved(stationName: string, machineId = 'MACHINE-HEALTH-0001') {
  const secret = randomBytes(24).toString('hex');
  const res = await fetch(`http://${base}/api/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineId, hostname: 'GAMING-PC', mac: 'AA:BB:CC:DD:EE:0F', secret, version: '0.1.0' }),
  });
  const { deviceId } = (await res.json()) as { deviceId: string };
  run('device.approve', { deviceId, stationId: station(stationName).id });
  return { deviceId, secret, machineId };
}

function report(machineId: string, secret: string, body: Record<string, unknown>) {
  return fetch(`http://${base}/api/agent/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineId, secret, version: '0.2.0', ...body }),
  });
}

describe('PC health telemetry', () => {
  it('stores a snapshot and surfaces it on the floor', async () => {
    const pc = await pairApproved('PC-01');
    const res = await report(pc.machineId, pc.secret, {
      metrics: { uptimeMs: 3_600_000, cpuPct: 22, memUsedMb: 8000, memTotalMb: 16000, diskFreeMb: 200_000, diskTotalMb: 500_000, cpuTempC: 55 },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { accepted: boolean }).toMatchObject({ accepted: true, newEvents: 0 });

    const dev = station('PC-01').device!;
    expect(dev.alerts).toEqual([]);
    expect(dev.health).toMatchObject({ diskFreePct: 40, memPct: 50, cpuPct: 22, tempC: 55 });
    // Reporting a newer version updates the device record.
    expect(dev.version).toBe('0.2.0');
  });

  it('raises a low-disk alert, debounces it, and clears on acknowledge', async () => {
    const pc = await pairApproved('PC-02');
    // 5% free is at/under the default 10% threshold, and under half of it -> crit.
    const first = await report(pc.machineId, pc.secret, { metrics: { diskFreeMb: 25_000, diskTotalMb: 500_000 } });
    expect((await first.json()) as { newEvents: number }).toMatchObject({ newEvents: 1 });
    expect(station('PC-02').device!.alerts).toEqual(['low_disk']);
    expect(floor().pcAlerts).toBe(1);

    // Still low on the next report: no second alert while the first is unacknowledged.
    const second = await report(pc.machineId, pc.secret, { metrics: { diskFreeMb: 24_000, diskTotalMb: 500_000 } });
    expect((await second.json()) as { newEvents: number }).toMatchObject({ newEvents: 0 });

    const detail = deviceHealthDetail(db, pc.deviceId, built.hub.onlineIds());
    expect(detail.events[0]).toMatchObject({ kind: 'low_disk', severity: 'crit' });

    run('device.ackHealth', { deviceId: pc.deviceId });
    expect(station('PC-02').device!.alerts).toEqual([]);
    expect(floor().pcAlerts).toBe(0);

    // A fresh breach after acknowledging opens a new alert.
    const third = await report(pc.machineId, pc.secret, { metrics: { diskFreeMb: 20_000, diskTotalMb: 500_000 } });
    expect((await third.json()) as { newEvents: number }).toMatchObject({ newEvents: 1 });
    expect(station('PC-02').device!.alerts).toEqual(['low_disk']);
  });

  it('raises a hot-PC alert from the hottest of CPU/GPU', async () => {
    const pc = await pairApproved('PC-03');
    const res = await report(pc.machineId, pc.secret, { metrics: { cpuTempC: 70, gpuTempC: 92 } });
    expect((await res.json()) as { newEvents: number }).toMatchObject({ newEvents: 1 });
    const dev = station('PC-03').device!;
    expect(dev.alerts).toEqual(['high_temp']);
    expect(dev.health).toMatchObject({ tempC: 92 });
    const detail = deviceHealthDetail(db, pc.deviceId, built.hub.onlineIds());
    expect(detail.events[0]).toMatchObject({ kind: 'high_temp', severity: 'crit', detail: { tempC: 92 } });
  });

  it('records discrete events the PC reports (unclean shutdown, client crash)', async () => {
    const pc = await pairApproved('PC-04');
    const res = await report(pc.machineId, pc.secret, {
      metrics: { uptimeMs: 30_000 },
      events: [{ kind: 'unclean_shutdown', detail: { downMs: 12_000 } }, { kind: 'client_crash' }],
    });
    expect((await res.json()) as { newEvents: number }).toMatchObject({ newEvents: 2 });
    expect(station('PC-04').device!.alerts.sort()).toEqual(['client_crash', 'unclean_shutdown']);
    const detail = deviceHealthDetail(db, pc.deviceId, built.hub.onlineIds());
    expect(detail.events.map((e) => e.kind).sort()).toEqual(['client_crash', 'unclean_shutdown']);
  });

  it('ignores reports with the wrong secret or no approved PC', async () => {
    const pc = await pairApproved('PC-05');
    const bad = await report(pc.machineId, 'x'.repeat(48), { metrics: { cpuTempC: 99 } });
    expect(bad.status).toBe(202);
    expect((await bad.json()) as { accepted: boolean }).toMatchObject({ accepted: false });

    const unknown = await report('NO-SUCH-MACHINE', pc.secret, { metrics: { cpuTempC: 99 } });
    expect((await unknown.json()) as { accepted: boolean }).toMatchObject({ accepted: false });
    expect(floor().pcAlerts).toBe(0);
  });

  it('device events are append-only and immutable except acknowledgement', () => {
    const pc = db.prepare("SELECT id FROM devices LIMIT 1").get() as { id: string } | undefined;
    const deviceId = pc?.id ?? 'x';
    db.prepare("INSERT INTO devices (id, machine_id, hostname, secret_hash, status, created_at) VALUES ('d-ev', 'M', 'H', 's', 'approved', ?)").run(now);
    db.prepare("INSERT INTO device_events (id, device_id, at, severity, kind, detail) VALUES ('e1', 'd-ev', ?, 'warn', 'low_disk', '{}')").run(now);
    expect(() => db.prepare("DELETE FROM device_events WHERE id = 'e1'").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE device_events SET kind = 'high_temp' WHERE id = 'e1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE device_events SET acknowledged_at = ? WHERE id = 'e1'").run(now)).not.toThrow();
    void deviceId;
  });
});
