import { z } from 'zod';
import { bundleOrThrow, STATION_KINDS } from '../domain/venue.js';
import { defineCommand } from './bus.js';

const kindEnum = z.enum(STATION_KINDS as unknown as [string, ...string[]]);

/**
 * Create or update a bundle — a named prepaid package the operator starts with one tap
 * ("5 hours – 800 L"). Kept in its own command file so the whole feature is separable, in line
 * with the project rule that a paid tier is a config switch, not a rewrite.
 */
export const upsertBundle = defineCommand({
  type: 'bundle.upsert',
  roles: ['manager'],
  schema: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(60),
    minutes: z.number().int().min(1).max(24 * 60),
    priceMinor: z.number().int().min(0).max(100_000_00),
    kinds: z.array(kindEnum).max(5).default([]),
    active: z.boolean().default(true),
    sort: z.number().int().min(0).max(9999).optional(),
  }),
  handler(ctx, p) {
    const kinds = JSON.stringify([...new Set(p.kinds)]);
    if (p.id) {
      const before = bundleOrThrow(ctx.db, p.id);
      ctx.db
        .prepare('UPDATE bundles SET name = ?, minutes = ?, price_minor = ?, kinds = ?, active = ?, sort = ? WHERE id = ?')
        .run(p.name, p.minutes, p.priceMinor, kinds, p.active ? 1 : 0, p.sort ?? before.sort, p.id);
      ctx.audit({ action: 'bundle.upsert', entity: 'bundle', entityId: p.id, before: { name: before.name, priceMinor: before.priceMinor, active: before.active }, after: { name: p.name, priceMinor: p.priceMinor, active: p.active } });
      return { id: p.id };
    }
    const id = ctx.id();
    const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM bundles').get() as { n: number }).n;
    ctx.db
      .prepare('INSERT INTO bundles (id, name, minutes, price_minor, kinds, active, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.name, p.minutes, p.priceMinor, kinds, p.active ? 1 : 0, p.sort ?? count, ctx.now, ctx.actor.id);
    ctx.audit({ action: 'bundle.upsert', entity: 'bundle', entityId: id, after: { name: p.name, minutes: p.minutes, priceMinor: p.priceMinor, kinds: p.kinds } });
    return { id };
  },
});

/** Archive (or restore) a bundle. Bundles are never hard-deleted so past sessions keep their link. */
export const setBundleActive = defineCommand({
  type: 'bundle.setActive',
  roles: ['manager'],
  schema: z.object({ id: z.string(), active: z.boolean() }),
  handler(ctx, p) {
    const before = bundleOrThrow(ctx.db, p.id);
    ctx.db.prepare('UPDATE bundles SET active = ? WHERE id = ?').run(p.active ? 1 : 0, p.id);
    ctx.audit({ action: 'bundle.setActive', entity: 'bundle', entityId: p.id, before: { active: before.active }, after: { active: p.active } });
    return { id: p.id, active: p.active };
  },
});

export const bundleCommands = [upsertBundle, setBundleActive];
