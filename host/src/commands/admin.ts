import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from '../auth.js';
import type { DB } from '../db/index.js';
import { setSetting } from '../db/index.js';
import { PricePlanConfig } from '../domain/pricing.js';
import { readSettings, stationOrThrow } from '../domain/venue.js';
import { AppError, notFound } from '../errors.js';
import { defineCommand, type CommandContext } from './bus.js';
import { adjustStock } from './inventory.js';

const managers = ['manager'] as const;

function upsert<T extends Record<string, unknown>>(
  ctx: CommandContext,
  table: string,
  entity: string,
  id: string | undefined,
  values: T,
): string {
  const cols = Object.keys(values);
  if (id) {
    const before = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!before) throw notFound(entity);
    ctx.db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...values, id });
    ctx.audit({ action: `${entity}.update`, entity, entityId: id, before, after: values });
    return id;
  }
  const newId = ctx.id();
  ctx.db
    .prepare(`INSERT INTO ${table} (id, ${cols.join(', ')}, created_at) VALUES (@id, ${cols.map((c) => `@${c}`).join(', ')}, @created_at)`)
    .run({ ...values, id: newId, created_at: ctx.now });
  ctx.audit({ action: `${entity}.create`, entity, entityId: newId, after: values });
  return newId;
}

export const upsertPlan = defineCommand({
  type: 'admin.plan.upsert',
  roles: [...managers],
  schema: z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(60), config: PricePlanConfig, active: z.boolean().default(true) }),
  handler(ctx, p) {
    const id = upsert(ctx, 'price_plans', 'price_plan', p.id, { name: p.name, config: JSON.stringify(p.config), active: p.active ? 1 : 0 });
    return { id };
  },
});

export const upsertStation = defineCommand({
  type: 'admin.station.upsert',
  roles: [...managers],
  schema: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(40),
    kind: z.enum(['pc', 'sim', 'console', 'table', 'other']),
    zone: z.string().trim().max(40).default(''),
    control: z.enum(['agent', 'manual']).optional(),
    pricePlanId: z.string(),
    sort: z.number().int().default(0),
    active: z.boolean().default(true),
  }),
  handler(ctx, p) {
    if (!ctx.db.prepare('SELECT 1 FROM price_plans WHERE id = ?').get(p.pricePlanId)) throw notFound('price_plan');
    const control = p.control ?? (p.kind === 'pc' || p.kind === 'sim' ? 'agent' : 'manual');
    if (!p.active && p.id && ctx.db.prepare("SELECT 1 FROM sessions WHERE station_id = ? AND status <> 'ended'").get(p.id)) {
      throw new AppError('error.station_busy', 409);
    }
    const id = upsert(ctx, 'stations', 'station', p.id, {
      name: p.name,
      kind: p.kind,
      zone: p.zone,
      control,
      price_plan_id: p.pricePlanId,
      sort: p.sort,
      active: p.active ? 1 : 0,
    });
    return { id };
  },
});

export const setOutOfOrder = defineCommand({
  type: 'station.setOutOfOrder',
  roles: ['operator', 'manager'],
  schema: z.object({ stationId: z.string(), outOfOrder: z.boolean() }),
  handler(ctx, p) {
    const s = stationOrThrow(ctx.db, p.stationId);
    ctx.db.prepare('UPDATE stations SET out_of_order = ? WHERE id = ?').run(p.outOfOrder ? 1 : 0, s.id);
    ctx.audit({ action: 'station.setOutOfOrder', entity: 'station', entityId: s.id, before: { outOfOrder: !!s.out_of_order }, after: { outOfOrder: p.outOfOrder } });
    return { ok: true };
  },
});

export const upsertProduct = defineCommand({
  type: 'admin.product.upsert',
  roles: [...managers],
  schema: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(60),
    category: z.string().trim().max(40).default(''),
    priceMinor: z.number().int().min(0),
    sort: z.number().int().default(0),
    active: z.boolean().default(true),
    trackStock: z.boolean().default(false),
    minQty: z.number().int().min(0).default(0),
    /** Starting stock for a new tracked product; ignored on edit (use count/restock). */
    initialStock: z.number().int().min(0).optional(),
  }),
  handler(ctx, p) {
    // stock_qty is never set here; it only changes through stock movements.
    const id = upsert(ctx, 'products', 'product', p.id, {
      name: p.name,
      category: p.category,
      price_minor: p.priceMinor,
      sort: p.sort,
      active: p.active ? 1 : 0,
      track_stock: p.trackStock ? 1 : 0,
      min_qty: p.minQty,
    });
    if (!p.id && p.trackStock && p.initialStock && p.initialStock > 0) {
      adjustStock(ctx, id, p.initialStock, 'initial');
    }
    return { id };
  },
});

export const upsertCurrency = defineCommand({
  type: 'admin.currency.upsert',
  roles: [...managers],
  schema: z.object({
    code: z.string().length(3).toUpperCase(),
    symbol: z.string().trim().min(1).max(4),
    decimals: z.number().int().min(0).max(3),
    rate: z.number().positive(),
    enabled: z.boolean().default(true),
    cashDenominations: z.array(z.number().int().positive()).max(12).default([]),
    sort: z.number().int().default(0),
  }),
  handler(ctx, p) {
    const before = ctx.db.prepare('SELECT * FROM currencies WHERE code = ?').get(p.code) as { is_base: number } | undefined;
    if (before?.is_base && !p.enabled) throw new AppError('error.base_currency_required', 409);
    ctx.db
      .prepare(
        `INSERT INTO currencies (code, symbol, decimals, rate, is_base, enabled, cash_denominations, sort)
         VALUES (@code, @symbol, @decimals, @rate, 0, @enabled, @denoms, @sort)
         ON CONFLICT(code) DO UPDATE SET symbol = @symbol, decimals = @decimals, rate = @rate, enabled = @enabled, cash_denominations = @denoms, sort = @sort`,
      )
      .run({ code: p.code, symbol: p.symbol, decimals: p.decimals, rate: before?.is_base ? 1 : p.rate, enabled: p.enabled ? 1 : 0, denoms: JSON.stringify(p.cashDenominations), sort: p.sort });
    ctx.audit({ action: 'currency.upsert', entity: 'currency', entityId: p.code, before, after: p });
    return { code: p.code };
  },
});

export const upsertUser = defineCommand({
  type: 'admin.user.upsert',
  roles: [...managers],
  schema: z.object({
    id: z.string().optional(),
    username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(60),
    role: z.enum(['operator', 'manager']),
    password: z.string().min(4).max(128).optional(),
    active: z.boolean().default(true),
  }),
  handler(ctx, p) {
    if (p.id === ctx.actor.id && (!p.active || p.role !== 'manager')) throw new AppError('error.cannot_demote_self', 409);
    if (p.id) {
      const before = ctx.db.prepare('SELECT id, username, display_name, role, active FROM users WHERE id = ?').get(p.id);
      if (!before) throw notFound('user');
      ctx.db.prepare('UPDATE users SET username = ?, display_name = ?, role = ?, active = ? WHERE id = ?').run(p.username, p.displayName, p.role, p.active ? 1 : 0, p.id);
      if (p.password) ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(p.password), p.id);
      if (!p.active || p.password) ctx.db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(p.id);
      ctx.audit({ action: 'user.update', entity: 'user', entityId: p.id, before, after: { username: p.username, displayName: p.displayName, role: p.role, active: p.active, passwordChanged: !!p.password } });
      return { id: p.id };
    }
    if (!p.password) throw new AppError('error.password_required', 400);
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(p.username)) throw new AppError('error.username_taken', 409);
    const id = ctx.id();
    ctx.db
      .prepare('INSERT INTO users (id, username, display_name, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.username, p.displayName, p.role, hashPassword(p.password), p.active ? 1 : 0, ctx.now);
    ctx.audit({ action: 'user.create', entity: 'user', entityId: id, after: { username: p.username, displayName: p.displayName, role: p.role } });
    return { id };
  },
});

export const updateSettings = defineCommand({
  type: 'admin.settings.update',
  roles: [...managers],
  schema: z.object({
    venueName: z.string().trim().min(1).max(60).optional(),
    cashRoundingMinor: z.number().int().min(1).optional(),
    operatorFixWindowMinutes: z.number().int().min(0).max(120).optional(),
    defaultLanguage: z.enum(['en', 'sq']).optional(),
    tipSplitRule: z.enum(['collector', 'equal', 'hours']).optional(),
    blindCount: z.boolean().optional(),
    reservedHoldMinutes: z.number().int().min(0).max(120).optional(),
    noShowGraceMinutes: z.number().int().min(0).max(120).optional(),
    pointsPer100: z.number().int().min(0).max(1000).optional(),
    redeemValueMinor: z.number().int().min(0).max(100000).optional(),
    diskWarnPct: z.number().int().min(0).max(90).optional(),
    tempWarnC: z.number().int().min(40).max(110).optional(),
  }),
  handler(ctx, p) {
    const before = readSettings(ctx.db);
    const map: Record<string, string | undefined> = {
      venue_name: p.venueName,
      cash_rounding_minor: p.cashRoundingMinor?.toString(),
      operator_fix_window_minutes: p.operatorFixWindowMinutes?.toString(),
      default_language: p.defaultLanguage,
      tip_split_rule: p.tipSplitRule,
      blind_count: p.blindCount === undefined ? undefined : p.blindCount ? '1' : '0',
      reserved_hold_minutes: p.reservedHoldMinutes?.toString(),
      no_show_grace_minutes: p.noShowGraceMinutes?.toString(),
      points_per_100: p.pointsPer100?.toString(),
      redeem_value_minor: p.redeemValueMinor?.toString(),
      disk_warn_pct: p.diskWarnPct?.toString(),
      temp_warn_c: p.tempWarnC?.toString(),
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) setSetting(ctx.db, k, v);
    ctx.audit({ action: 'settings.update', entity: 'settings', before, after: readSettings(ctx.db) });
    return { ok: true };
  },
});

export const adminCommands = [upsertPlan, upsertStation, setOutOfOrder, upsertProduct, upsertCurrency, upsertUser, updateSettings];

/** True until the first manager account exists. */
export function needsSetup(db: DB): boolean {
  return !db.prepare("SELECT 1 FROM users WHERE id <> 'system-client' LIMIT 1").get();
}

export const SetupInput = z.object({
  venueName: z.string().trim().min(1).max(60),
  language: z.enum(['en', 'sq']).default('en'),
  baseCurrency: z.object({
    code: z.string().length(3).toUpperCase(),
    symbol: z.string().trim().min(1).max(4),
    decimals: z.number().int().min(0).max(3),
  }),
  manager: z.object({
    username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(60),
    password: z.string().min(6).max(128),
  }),
});

/** First-run setup: venue name, base currency and the first manager. Only works once. */
export function runSetup(db: DB, input: z.infer<typeof SetupInput>, now: number): string {
  return db.transaction(() => {
    if (!needsSetup(db)) throw new AppError('error.already_set_up', 409);
    const userId = randomUUID();
    db.prepare("INSERT INTO users (id, username, display_name, role, password_hash, active, created_at) VALUES (?, ?, ?, 'manager', ?, 1, ?)").run(
      userId,
      input.manager.username,
      input.manager.displayName,
      hashPassword(input.manager.password),
      now,
    );
    db.prepare("INSERT INTO currencies (code, symbol, decimals, rate, is_base, enabled, cash_denominations, sort) VALUES (?, ?, ?, 1, 1, 1, '[]', 0)").run(
      input.baseCurrency.code,
      input.baseCurrency.symbol,
      input.baseCurrency.decimals,
    );
    setSetting(db, 'venue_name', input.venueName);
    setSetting(db, 'default_language', input.language);
    db.prepare("INSERT INTO audit_log (at, actor_id, action, entity, entity_id, after) VALUES (?, ?, 'system.setup', 'settings', NULL, ?)").run(
      now,
      userId,
      JSON.stringify({ venueName: input.venueName, baseCurrency: input.baseCurrency.code, manager: input.manager.username }),
    );
    return userId;
  })();
}
