/**
 * Fills an empty database with a demo café so the app can be tried right away.
 * Usage: npm run seed   (refuses to run if the venue is already set up)
 */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from './auth.js';
import { adminCommands, needsSetup, runSetup } from './commands/admin.js';
import { CommandBus } from './commands/bus.js';
import { openDatabase, type DB } from './db/index.js';

export function seedDemo(db: DB, now = Date.now()): void {
  if (!needsSetup(db)) throw new Error('Venue already set up; seed only runs on an empty database.');
  const managerId = runSetup(
    db,
    {
      venueName: 'Kraken Demo Café',
      language: 'sq',
      baseCurrency: { code: 'ALL', symbol: 'L', decimals: 0 },
      manager: { username: 'admin', displayName: 'Manager', password: 'admin123' },
    },
    now,
  );
  const manager: Actor = { id: managerId, username: 'admin', displayName: 'Manager', role: 'manager' };
  const bus = new CommandBus(db, () => now).register(...adminCommands);
  const run = (type: string, payload: unknown) => bus.execute(manager, { type, requestId: randomUUID(), payload }) as { id: string };

  run('admin.settings.update', { cashRoundingMinor: 10, operatorFixWindowMinutes: 5, defaultLanguage: 'sq' });
  run('admin.currency.upsert', { code: 'EUR', symbol: '€', decimals: 2, rate: 100, cashDenominations: [500, 1000, 2000, 5000] });
  // Base currency quick-cash notes.
  db.prepare("UPDATE currencies SET cash_denominations = '[200,500,1000,2000,5000]' WHERE code = 'ALL'").run();

  const pc = run('admin.plan.upsert', { name: 'PC standard', config: { kind: 'hourly', rates: { '1': 200 }, billingUnitMinutes: 1, minimumMinutes: 15 } }).id;
  const ps = run('admin.plan.upsert', { name: 'PlayStation', config: { kind: 'hourly', rates: { '1': 300, '2': 400, '4': 600 }, billingUnitMinutes: 1, minimumMinutes: 15 } }).id;
  const sim = run('admin.plan.upsert', { name: 'Sim racing', config: { kind: 'hourly', rates: { '1': 600 }, billingUnitMinutes: 5, minimumMinutes: 15 } }).id;
  const pool = run('admin.plan.upsert', { name: 'Pool', config: { kind: 'hourly', rates: { '1': 400 }, billingUnitMinutes: 15, minimumMinutes: 30 } }).id;
  const pong = run('admin.plan.upsert', { name: 'Ping pong game', config: { kind: 'per_session', priceMinor: 200 } }).id;

  let sort = 0;
  for (let i = 1; i <= 10; i++) run('admin.station.upsert', { name: `PC-${String(i).padStart(2, '0')}`, kind: 'pc', zone: 'PC', pricePlanId: pc, sort: sort++ });
  run('admin.station.upsert', { name: 'PS5-1', kind: 'console', zone: 'Console', pricePlanId: ps, sort: sort++ });
  run('admin.station.upsert', { name: 'PS5-2', kind: 'console', zone: 'Console', pricePlanId: ps, sort: sort++ });
  run('admin.station.upsert', { name: 'SIM-1', kind: 'sim', zone: 'Sim racing', pricePlanId: sim, sort: sort++ });
  run('admin.station.upsert', { name: 'Pool 1', kind: 'table', zone: 'Tables', pricePlanId: pool, sort: sort++ });
  run('admin.station.upsert', { name: 'Ping Pong', kind: 'table', zone: 'Tables', pricePlanId: pong, sort: sort++ });

  // Bottled/packaged items track stock; made-to-order coffee and toast don't.
  const products: [string, string, number, number?, number?][] = [
    // name, category, price, [initialStock], [minQty]
    ['Coca-Cola', 'Drinks', 150, 48, 24],
    ['Fanta', 'Drinks', 150, 36, 24],
    ['Red Bull', 'Drinks', 300, 20, 12],
    ['Water', 'Drinks', 80, 60, 24],
    ['Espresso', 'Coffee', 100],
    ['Cappuccino', 'Coffee', 150],
    ['Chips', 'Snacks', 120, 30, 15],
    ['Chocolate bar', 'Snacks', 100, 25, 12],
    ['Toast', 'Food', 250],
  ];
  products.forEach(([name, category, priceMinor, initialStock, minQty], i) =>
    run('admin.product.upsert', {
      name,
      category,
      priceMinor,
      sort: i,
      ...(initialStock !== undefined ? { trackStock: true, initialStock, minQty } : {}),
    }),
  );

  run('admin.user.upsert', { username: 'operator', displayName: 'Operator', role: 'operator', password: '1234' });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const dataDir = resolve(process.env.KRAKEN_DATA_DIR ?? join(here, '..', 'data'));
  const db = openDatabase(join(dataDir, 'kraken-hub.db'));
  seedDemo(db);
  db.close();
  console.log('Demo café created. Logins: admin / admin123 (manager), operator / 1234 (operator).');
}
