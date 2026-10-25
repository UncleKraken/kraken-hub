import { z } from 'zod';
import { notFound, AppError } from '../errors.js';
import { defineCommand, type CommandContext } from './bus.js';

const both = ['operator', 'manager'] as const;

interface ProductStock {
  id: string;
  name: string;
  track_stock: number;
  stock_qty: number;
}

/**
 * Records a stock change for a product and updates its cached quantity, in the current
 * transaction. No-op for products that don't track stock. Call from sales, returns,
 * restocks, waste and counts so the movement log always explains the running total.
 */
export function adjustStock(ctx: CommandContext, productId: string, delta: number, reason: string, opts: { refId?: string; note?: string } = {}): void {
  const p = ctx.db.prepare('SELECT id, track_stock, stock_qty FROM products WHERE id = ?').get(productId) as ProductStock | undefined;
  if (!p || !p.track_stock || delta === 0) return;
  ctx.db
    .prepare('INSERT INTO stock_movements (id, product_id, delta, reason, ref_id, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.id(), productId, delta, reason, opts.refId ?? null, opts.note ?? null, ctx.actor.id, ctx.now);
  ctx.db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, productId);
}

/** Sets a product's stock to an exact counted number, logging the difference. */
export const countStock = defineCommand({
  type: 'inventory.count',
  roles: [...both],
  schema: z.object({ productId: z.string(), countedQty: z.number().int().min(0), note: z.string().trim().max(120).default('') }),
  handler(ctx, p) {
    const row = ctx.db.prepare('SELECT id, name, track_stock, stock_qty FROM products WHERE id = ?').get(p.productId) as ProductStock | undefined;
    if (!row) throw notFound('product');
    if (!row.track_stock) throw new AppError('error.not_tracked', 409);
    const delta = p.countedQty - row.stock_qty;
    if (delta !== 0) adjustStock(ctx, p.productId, delta, 'count', { note: p.note });
    ctx.audit({ action: 'inventory.count', entity: 'product', entityId: p.productId, before: { stockQty: row.stock_qty }, after: { stockQty: p.countedQty, delta } });
    return { stockQty: p.countedQty };
  },
});

/** Marks units as wasted (broken, expired), with a required reason. */
export const wasteStock = defineCommand({
  type: 'inventory.waste',
  roles: [...both],
  schema: z.object({ productId: z.string(), qty: z.number().int().min(1), reason: z.string().trim().min(1).max(120) }),
  handler(ctx, p) {
    const row = ctx.db.prepare('SELECT id, name, track_stock, stock_qty FROM products WHERE id = ?').get(p.productId) as ProductStock | undefined;
    if (!row) throw notFound('product');
    if (!row.track_stock) throw new AppError('error.not_tracked', 409);
    adjustStock(ctx, p.productId, -p.qty, 'waste', { note: p.reason });
    ctx.audit({ action: 'inventory.waste', entity: 'product', entityId: p.productId, after: { qty: p.qty, reason: p.reason } });
    return { stockQty: row.stock_qty - p.qty };
  },
});

/** Manager creates a restock order: which products and how many to order. */
export const createRestock = defineCommand({
  type: 'inventory.restock.create',
  roles: ['manager'],
  schema: z.object({
    items: z.array(z.object({ productId: z.string(), orderedQty: z.number().int().min(1) })).min(1).max(100),
    notes: z.string().trim().max(500).default(''),
  }),
  handler(ctx, p) {
    const id = ctx.id();
    ctx.db.prepare("INSERT INTO restock_orders (id, status, notes, created_at, created_by) VALUES (?, 'ordered', ?, ?, ?)").run(id, p.notes, ctx.now, ctx.actor.id);
    const ins = ctx.db.prepare('INSERT INTO restock_items (id, order_id, product_id, ordered_qty) VALUES (?, ?, ?, ?)');
    for (const it of p.items) {
      if (!ctx.db.prepare('SELECT 1 FROM products WHERE id = ?').get(it.productId)) throw notFound('product');
      ins.run(ctx.id(), id, it.productId, it.orderedQty);
    }
    ctx.audit({ action: 'inventory.restock.create', entity: 'restock_order', entityId: id, after: { items: p.items } });
    return { id };
  },
});

/** Operator records what actually arrived for each line of a restock order. */
export const receiveRestock = defineCommand({
  type: 'inventory.restock.receive',
  roles: [...both],
  schema: z.object({
    orderId: z.string(),
    received: z.array(z.object({ itemId: z.string(), receivedQty: z.number().int().min(0), condition: z.enum(['complete', 'short', 'damaged']) })).min(1),
  }),
  handler(ctx, p) {
    const order = ctx.db.prepare('SELECT * FROM restock_orders WHERE id = ?').get(p.orderId) as { status: string } | undefined;
    if (!order) throw notFound('restock_order');
    if (order.status !== 'ordered') throw new AppError('error.restock_closed', 409);
    const upd = ctx.db.prepare('UPDATE restock_items SET received_qty = ?, condition = ? WHERE id = ? AND order_id = ?');
    for (const r of p.received) upd.run(r.receivedQty, r.condition, r.itemId, p.orderId);
    ctx.audit({ action: 'inventory.restock.receive', entity: 'restock_order', entityId: p.orderId, after: { received: p.received } });
    return { ok: true };
  },
});

/** Manager confirms a received order; the received quantities are added to stock. */
export const confirmRestock = defineCommand({
  type: 'inventory.restock.confirm',
  roles: ['manager'],
  schema: z.object({ orderId: z.string() }),
  handler(ctx, p) {
    const order = ctx.db.prepare('SELECT * FROM restock_orders WHERE id = ?').get(p.orderId) as { status: string } | undefined;
    if (!order) throw notFound('restock_order');
    if (order.status !== 'ordered') throw new AppError('error.restock_closed', 409);
    const items = ctx.db.prepare('SELECT product_id, received_qty FROM restock_items WHERE order_id = ?').all(p.orderId) as { product_id: string; received_qty: number | null }[];
    for (const it of items) {
      if (it.received_qty && it.received_qty > 0) adjustStock(ctx, it.product_id, it.received_qty, 'restock', { refId: p.orderId });
    }
    ctx.db.prepare("UPDATE restock_orders SET status = 'confirmed', confirmed_at = ?, confirmed_by = ? WHERE id = ?").run(ctx.now, ctx.actor.id, p.orderId);
    ctx.audit({ action: 'inventory.restock.confirm', entity: 'restock_order', entityId: p.orderId });
    return { ok: true };
  },
});

export const cancelRestock = defineCommand({
  type: 'inventory.restock.cancel',
  roles: ['manager'],
  schema: z.object({ orderId: z.string() }),
  handler(ctx, p) {
    const order = ctx.db.prepare('SELECT status FROM restock_orders WHERE id = ?').get(p.orderId) as { status: string } | undefined;
    if (!order) throw notFound('restock_order');
    if (order.status !== 'ordered') throw new AppError('error.restock_closed', 409);
    ctx.db.prepare("UPDATE restock_orders SET status = 'cancelled' WHERE id = ?").run(p.orderId);
    ctx.audit({ action: 'inventory.restock.cancel', entity: 'restock_order', entityId: p.orderId });
    return { ok: true };
  },
});

export const inventoryCommands = [countStock, wasteStock, createRestock, receiveRestock, confirmRestock, cancelRestock];
