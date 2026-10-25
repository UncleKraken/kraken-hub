import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth.js';
import { adminCommands } from './admin.js';
import { CommandBus } from './bus.js';
import { inventoryCommands } from './inventory.js';
import { sessionCommands } from './sessions.js';
import { shiftCommands } from './shifts.js';
import { tabCommands } from './tabs.js';
import { openDatabase, type DB } from '../db/index.js';
import { adminLists, floorState, lowStock, restockOrders } from '../queries.js';
import { seedDemo } from '../seed.js';

let db: DB;
let now: number;
let bus: CommandBus;
let manager: Actor;
let operator: Actor;

function actor(username: string): Actor {
  return db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE username = ?').get(username) as Actor;
}
function run<T = Record<string, unknown>>(who: Actor, type: string, payload: unknown): T {
  return bus.execute(who, { type, requestId: randomUUID(), payload }) as T;
}
const product = (name: string) => adminLists(db).products.find((p) => p.name === name)!;
const station = (name: string) => floorState(db, operator, now).stations.find((s) => s.name === name)!;
const expectError = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ code }));

beforeEach(() => {
  db = openDatabase(':memory:');
  now = Date.UTC(2026, 10, 1, 16, 0, 0);
  seedDemo(db, now);
  bus = new CommandBus(db, () => now).register(...sessionCommands, ...tabCommands, ...shiftCommands, ...adminCommands, ...inventoryCommands);
  manager = actor('admin');
  operator = actor('operator');
});

describe('inventory', () => {
  it('drops stock on a sale and returns it when the item is removed', () => {
    run(operator, 'shift.open', {});
    const coke = product('Coca-Cola');
    expect(coke.stockQty).toBe(48);
    const pc = station('PC-01');
    const { entryId } = run<{ entryId: string }>(operator, 'tab.addItem', { stationId: pc.id, productId: coke.id, qty: 3 });
    expect(product('Coca-Cola').stockQty).toBe(45);
    run(operator, 'tab.reverseEntry', { entryId, reason: 'wrong item' });
    expect(product('Coca-Cola').stockQty).toBe(48);
  });

  it('does not track made-to-order items', () => {
    run(operator, 'shift.open', {});
    const espresso = product('Espresso');
    expect(espresso.trackStock).toBe(false);
    run(operator, 'tab.addItem', { stationId: station('PC-02').id, productId: espresso.id });
    expect(product('Espresso').stockQty).toBe(0); // untouched
  });

  it('flags low stock at or below the minimum', () => {
    run(operator, 'shift.open', {});
    const rb = product('Red Bull'); // 20, min 12
    expect(lowStock(db).map((x) => x.name)).not.toContain('Red Bull');
    run(operator, 'tab.addItem', { stationId: station('PC-03').id, productId: rb.id, qty: 9 }); // → 11
    expect(lowStock(db).map((x) => x.name)).toContain('Red Bull');
    expect(floorState(db, manager, now).lowStock.find((x) => x.name === 'Red Bull')?.stockQty).toBe(11);
  });

  it('runs a restock: manager orders, operator receives short, manager confirms', () => {
    const coke = product('Coca-Cola'); // 48
    const { id } = run<{ id: string }>(manager, 'inventory.restock.create', { items: [{ productId: coke.id, orderedQty: 24 }] });
    const order = restockOrders(db).find((o) => o.id === id)!;
    expect(order.items[0]!.orderedQty).toBe(24);
    // Only 20 arrived.
    run(operator, 'inventory.restock.receive', { orderId: id, received: [{ itemId: order.items[0]!.id, receivedQty: 20, condition: 'short' }] });
    expect(product('Coca-Cola').stockQty).toBe(48); // not applied until confirmed
    run(manager, 'inventory.restock.confirm', { orderId: id });
    expect(product('Coca-Cola').stockQty).toBe(68);
    expect(restockOrders(db).find((o) => o.id === id)).toBeUndefined(); // no longer "ordered"
  });

  it('records waste and counts, each logged as a movement', () => {
    run(operator, 'shift.open', {});
    const chips = product('Chips'); // 30
    run(operator, 'inventory.waste', { productId: chips.id, qty: 2, reason: 'expired' });
    expect(product('Chips').stockQty).toBe(28);
    run(manager, 'inventory.count', { productId: chips.id, countedQty: 25, note: 'shelf count' });
    expect(product('Chips').stockQty).toBe(25);
    const moves = db.prepare('SELECT reason, delta FROM stock_movements WHERE product_id = ? ORDER BY created_at').all(chips.id) as { reason: string; delta: number }[];
    expect(moves).toEqual([
      { reason: 'initial', delta: 30 },
      { reason: 'waste', delta: -2 },
      { reason: 'count', delta: -3 },
    ]);
  });

  it('keeps restock orders and waste from being edited by non-managers where required', () => {
    const coke = product('Coca-Cola');
    expectError(() => run(operator, 'inventory.restock.create', { items: [{ productId: coke.id, orderedQty: 10 }] }), 'error.forbidden');
    expect(() => db.prepare('UPDATE stock_movements SET delta = 0').run()).toThrow(/append-only/);
  });
});
