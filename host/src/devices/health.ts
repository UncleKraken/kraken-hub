import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import type { VenueSettings } from '../domain/venue.js';

/**
 * PC health telemetry. Customer PCs report a snapshot every so often; the host keeps the
 * latest per PC and turns threshold breaches (low disk, hot CPU/GPU) into alert events.
 * Discrete events the PC detects itself — an unclean shutdown, a client crash — come in the
 * same payload. See migration 6 for the tables.
 */

export const TelemetryMetrics = z.object({
  uptimeMs: z.number().int().min(0).optional(),
  cpuPct: z.number().int().min(0).max(100).optional(),
  memUsedMb: z.number().int().min(0).optional(),
  memTotalMb: z.number().int().min(0).optional(),
  diskFreeMb: z.number().int().min(0).optional(),
  diskTotalMb: z.number().int().min(0).optional(),
  diskGameFreeMb: z.number().int().min(0).optional(),
  diskGameTotalMb: z.number().int().min(0).optional(),
  cpuTempC: z.number().int().min(0).max(150).optional(),
  gpuTempC: z.number().int().min(0).max(150).optional(),
});

/** Events the PC detects for itself; derived alerts (low disk, hot PC) are made by the host. */
export const TelemetryEvent = z.object({
  kind: z.enum(['unclean_shutdown', 'client_crash']),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const TelemetryInput = z.object({
  machineId: z.string().min(8).max(128),
  secret: z.string().min(32).max(256),
  version: z.string().max(32).default(''),
  metrics: TelemetryMetrics.default({}),
  events: z.array(TelemetryEvent).max(20).default([]),
});

export type Telemetry = z.infer<typeof TelemetryInput>;

export interface DeviceHealthRow {
  device_id: string;
  at: number;
  uptime_ms: number | null;
  cpu_pct: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  disk_free_mb: number | null;
  disk_total_mb: number | null;
  disk_game_free_mb: number | null;
  disk_game_total_mb: number | null;
  cpu_temp_c: number | null;
  gpu_temp_c: number | null;
  raw: string;
}

export interface DeviceEventRow {
  id: string;
  device_id: string;
  at: number;
  severity: 'info' | 'warn' | 'crit';
  kind: string;
  detail: string;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
}

/** Free-disk percent from a free/total pair, or null when either is missing. */
export function freePct(freeMb: number | null | undefined, totalMb: number | null | undefined): number | null {
  if (freeMb == null || totalMb == null || totalMb <= 0) return null;
  return Math.round((freeMb / totalMb) * 100);
}

/** The highest temperature the PC reported (CPU or GPU), or null if it reported neither. */
export function maxTemp(cpu: number | null | undefined, gpu: number | null | undefined): number | null {
  const vals = [cpu, gpu].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.max(...vals) : null;
}

const n = (v: number | undefined): number | null => (v === undefined ? null : v);

/** Compact, display-ready view of a snapshot, shared by the floor and the station panel. */
export interface HealthSummary {
  at: number;
  diskFreePct: number | null; // worst of system / game drive
  diskFreeMb: number | null;
  diskTotalMb: number | null;
  diskGameFreePct: number | null;
  memPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  uptimeMs: number | null;
  cpuPct: number | null;
  tempC: number | null; // max of CPU / GPU
  cpuTempC: number | null;
  gpuTempC: number | null;
}

export function summarize(h: DeviceHealthRow): HealthSummary {
  const sysPct = freePct(h.disk_free_mb, h.disk_total_mb);
  const gamePct = freePct(h.disk_game_free_mb, h.disk_game_total_mb);
  const diskFreePct = [sysPct, gamePct].filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;
  const memPct = h.mem_used_mb != null && h.mem_total_mb != null && h.mem_total_mb > 0 ? Math.round((h.mem_used_mb / h.mem_total_mb) * 100) : null;
  return {
    at: h.at,
    diskFreePct,
    diskFreeMb: h.disk_free_mb,
    diskTotalMb: h.disk_total_mb,
    diskGameFreePct: gamePct,
    memPct,
    memUsedMb: h.mem_used_mb,
    memTotalMb: h.mem_total_mb,
    uptimeMs: h.uptime_ms,
    cpuPct: h.cpu_pct,
    tempC: maxTemp(h.cpu_temp_c, h.gpu_temp_c),
    cpuTempC: h.cpu_temp_c,
    gpuTempC: h.gpu_temp_c,
  };
}

/**
 * Stores a telemetry snapshot and appends any new alert/notable events.
 * Derived alerts (low_disk, high_temp) are debounced: a new one is only opened when there
 * is no still-unacknowledged event of that kind for the PC, so a persistent problem doesn't
 * spam the floor until the operator clears it. Returns how many new events were written.
 * Must run inside a transaction (the caller wraps it).
 */
export function recordTelemetry(db: DB, deviceId: string, t: Telemetry, settings: VenueSettings, now: number): number {
  const m = t.metrics;
  db.prepare(
    `INSERT INTO device_health
       (device_id, at, uptime_ms, cpu_pct, mem_used_mb, mem_total_mb, disk_free_mb, disk_total_mb,
        disk_game_free_mb, disk_game_total_mb, cpu_temp_c, gpu_temp_c, raw)
     VALUES (@device_id, @at, @uptime_ms, @cpu_pct, @mem_used_mb, @mem_total_mb, @disk_free_mb, @disk_total_mb,
             @disk_game_free_mb, @disk_game_total_mb, @cpu_temp_c, @gpu_temp_c, @raw)
     ON CONFLICT(device_id) DO UPDATE SET
       at = excluded.at, uptime_ms = excluded.uptime_ms, cpu_pct = excluded.cpu_pct,
       mem_used_mb = excluded.mem_used_mb, mem_total_mb = excluded.mem_total_mb,
       disk_free_mb = excluded.disk_free_mb, disk_total_mb = excluded.disk_total_mb,
       disk_game_free_mb = excluded.disk_game_free_mb, disk_game_total_mb = excluded.disk_game_total_mb,
       cpu_temp_c = excluded.cpu_temp_c, gpu_temp_c = excluded.gpu_temp_c, raw = excluded.raw`,
  ).run({
    device_id: deviceId,
    at: now,
    uptime_ms: n(m.uptimeMs),
    cpu_pct: n(m.cpuPct),
    mem_used_mb: n(m.memUsedMb),
    mem_total_mb: n(m.memTotalMb),
    disk_free_mb: n(m.diskFreeMb),
    disk_total_mb: n(m.diskTotalMb),
    disk_game_free_mb: n(m.diskGameFreeMb),
    disk_game_total_mb: n(m.diskGameTotalMb),
    cpu_temp_c: n(m.cpuTempC),
    gpu_temp_c: n(m.gpuTempC),
    raw: JSON.stringify(m),
  });

  let written = 0;
  const openOfKind = db.prepare("SELECT 1 FROM device_events WHERE device_id = ? AND kind = ? AND acknowledged_at IS NULL LIMIT 1");
  const insert = db.prepare(
    "INSERT INTO device_events (id, device_id, at, severity, kind, detail) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const add = (severity: DeviceEventRow['severity'], kind: string, detail: object, debounce: boolean) => {
    if (debounce && openOfKind.get(deviceId, kind)) return;
    insert.run(randomUUID(), deviceId, now, severity, kind, JSON.stringify(detail));
    written++;
  };

  // Derived alerts from the snapshot.
  const sysPct = freePct(m.diskFreeMb, m.diskTotalMb);
  const gamePct = freePct(m.diskGameFreeMb, m.diskGameTotalMb);
  const worstDisk = [sysPct, gamePct].filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;
  if (worstDisk !== null && worstDisk <= settings.diskWarnPct) {
    add(worstDisk <= Math.ceil(settings.diskWarnPct / 2) ? 'crit' : 'warn', 'low_disk', { freePct: worstDisk, sysPct, gamePct }, true);
  }
  const temp = maxTemp(m.cpuTempC, m.gpuTempC);
  if (temp !== null && temp >= settings.tempWarnC) {
    add(temp >= settings.tempWarnC + 5 ? 'crit' : 'warn', 'high_temp', { tempC: temp, cpuTempC: m.cpuTempC ?? null, gpuTempC: m.gpuTempC ?? null }, true);
  }

  // Discrete events the PC reported (already deduped client-side).
  for (const e of t.events) add('warn', e.kind, e.detail, false);

  return written;
}
