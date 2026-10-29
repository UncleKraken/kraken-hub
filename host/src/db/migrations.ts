/**
 * Schema migrations. Append new migrations to the end; never edit a shipped one.
 *
 * Conventions:
 * - Money is stored as INTEGER minor units (ISO 4217 decimals of the currency).
 * - Timestamps are INTEGER milliseconds since the Unix epoch (UTC).
 * - Money tables (ledger, payments, payment_tenders, cash_movements, tips) are
 *   append-only: triggers block UPDATE and DELETE. Corrections are new rows.
 */
export const migrations: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE currencies (
    code TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 3),
    rate REAL NOT NULL CHECK (rate > 0),           -- base major units per 1 major unit
    is_base INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    cash_denominations TEXT NOT NULL DEFAULT '[]', -- JSON array of minor-unit notes for quick-cash buttons
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('operator', 'manager')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE price_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,                          -- JSON PricePlanConfig
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE stations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pc', 'sim', 'console', 'table', 'other')),
    zone TEXT NOT NULL DEFAULT '',
    control TEXT NOT NULL DEFAULT 'manual' CHECK (control IN ('agent', 'manual')),
    price_plan_id TEXT NOT NULL REFERENCES price_plans(id),
    sort INTEGER NOT NULL DEFAULT 0,
    out_of_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE shifts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    opening_float TEXT NOT NULL,                   -- JSON {currency: minor}
    counted TEXT,                                  -- JSON {currency: minor}
    float_left TEXT,                               -- JSON {currency: minor}
    tips_marked_minor INTEGER NOT NULL DEFAULT 0,  -- base currency
    notes TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX one_open_shift_per_user ON shifts(user_id) WHERE status = 'open';

  CREATE TABLE tabs (
    id TEXT PRIMARY KEY,
    station_id TEXT REFERENCES stations(id),
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at INTEGER NOT NULL,
    opened_by TEXT NOT NULL REFERENCES users(id),
    closed_at INTEGER,
    closed_by TEXT REFERENCES users(id)
  );
  CREATE UNIQUE INDEX one_open_tab_per_station ON tabs(station_id) WHERE status = 'open' AND station_id IS NOT NULL;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    station_id TEXT NOT NULL REFERENCES stations(id),
    mode TEXT NOT NULL CHECK (mode IN ('prepaid', 'postpaid')),
    plan TEXT NOT NULL,                            -- JSON snapshot of the price plan at start
    prepaid_minutes INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
    started_at INTEGER NOT NULL,
    started_by TEXT NOT NULL REFERENCES users(id),
    ended_at INTEGER,
    ended_by TEXT REFERENCES users(id),
    end_reason TEXT
  );
  CREATE UNIQUE INDEX one_live_session_per_station ON sessions(station_id) WHERE status <> 'ended';

  CREATE TABLE session_segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    players INTEGER NOT NULL CHECK (players >= 1),
    rate_minor_per_hour INTEGER NOT NULL CHECK (rate_minor_per_hour >= 0),
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX segments_by_session ON session_segments(session_id);

  CREATE TABLE ledger (
    id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    kind TEXT NOT NULL CHECK (kind IN ('time', 'item', 'adjustment', 'rounding', 'transfer')),
    description TEXT NOT NULL,
    product_id TEXT REFERENCES products(id),
    session_id TEXT REFERENCES sessions(id),
    qty INTEGER NOT NULL DEFAULT 1,
    unit_minor INTEGER NOT NULL,
    amount_minor INTEGER NOT NULL,                 -- base currency, signed
    reverses_id TEXT UNIQUE REFERENCES ledger(id),
    reason TEXT,
    actor_id TEXT NOT NULL REFERENCES users(id),
    shift_id TEXT REFERENCES shifts(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ledger_by_tab ON ledger(tab_id);
  CREATE INDEX ledger_by_shift ON ledger(shift_id);

  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    shift_id TEXT NOT NULL REFERENCES shifts(id),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card')),
    applied_minor INTEGER NOT NULL,                -- base currency applied to the tab (negative = refund)
    tip_minor INTEGER NOT NULL DEFAULT 0,          -- base currency kept as tip
    change_minor INTEGER NOT NULL DEFAULT 0,       -- base currency handed back
    actor_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX payments_by_tab ON payments(tab_id);
  CREATE INDEX payments_by_shift ON payments(shift_id);

  CREATE TABLE payment_tenders (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL REFERENCES payments(id),
    currency TEXT NOT NULL REFERENCES currencies(code),
    amount_minor INTEGER NOT NULL,                 -- in the tender currency
    rate REAL NOT NULL,                            -- snapshot
    base_minor INTEGER NOT NULL                    -- converted to base currency
  );

  CREATE TABLE cash_movements (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES shifts(id),
    currency TEXT NOT NULL REFERENCES currencies(code),
    amount_minor INTEGER NOT NULL,                 -- signed, in that currency
    kind TEXT NOT NULL CHECK (kind IN ('float_open', 'tender_in', 'change_out', 'refund_out', 'tip_payout', 'drop', 'float_left', 'adjustment')),
    ref_id TEXT,
    actor_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX cash_by_shift ON cash_movements(shift_id);

  CREATE TABLE tips (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES shifts(id),
    source TEXT NOT NULL CHECK (source IN ('checkout', 'card', 'marked')),
    base_minor INTEGER NOT NULL,
    payment_id TEXT REFERENCES payments(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_id TEXT REFERENCES users(id),
    approved_by TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    before TEXT,
    after TEXT,
    request_id TEXT
  );

  CREATE TABLE idempotency (
    request_id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    actor_id TEXT,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Append-only guarantees for money and audit tables.
  CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'payments are append-only'); END;
  CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments are append-only'); END;
  CREATE TRIGGER tenders_no_update BEFORE UPDATE ON payment_tenders BEGIN SELECT RAISE(ABORT, 'tenders are append-only'); END;
  CREATE TRIGGER tenders_no_delete BEFORE DELETE ON payment_tenders BEGIN SELECT RAISE(ABORT, 'tenders are append-only'); END;
  CREATE TRIGGER cash_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;
  CREATE TRIGGER cash_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;
  CREATE TRIGGER tips_no_update BEFORE UPDATE ON tips BEGIN SELECT RAISE(ABORT, 'tips are append-only'); END;
  CREATE TRIGGER tips_no_delete BEFORE DELETE ON tips BEGIN SELECT RAISE(ABORT, 'tips are append-only'); END;
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  `,

  // 2 — Customer PCs (devices) and the requests they send to the operator.
  `
  -- Built-in account used to sign actions that come from a customer PC (e.g. a customer
  -- ending their own session). It can never sign in: inactive, unusable password.
  INSERT INTO users (id, username, display_name, role, password_hash, active, created_at)
  VALUES ('system-client', 'system-client', 'Customer PC', 'operator', '!', 0, 0);

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,                     -- stable id reported by the PC (Windows MachineGuid)
    hostname TEXT NOT NULL,
    mac TEXT NOT NULL DEFAULT '',
    secret_hash TEXT NOT NULL,                    -- sha256 of a secret the PC generated when pairing
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
    station_id TEXT REFERENCES stations(id),
    client_version TEXT NOT NULL DEFAULT '',
    last_ip TEXT NOT NULL DEFAULT '',
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    approved_by TEXT REFERENCES users(id)
  );
  CREATE UNIQUE INDEX one_live_device_per_station ON devices(station_id) WHERE status = 'approved' AND station_id IS NOT NULL;
  CREATE INDEX devices_by_machine ON devices(machine_id);

  CREATE TABLE client_requests (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    station_id TEXT REFERENCES stations(id),
    kind TEXT NOT NULL CHECK (kind IN ('guest', 'help', 'order', 'extend')),
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'declined', 'expired')),
    result TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT REFERENCES users(id)
  );
  CREATE INDEX requests_pending ON client_requests(status, created_at);
  `,

  // 3 — Bookings. The manager owns them; the operator checks customers in on arrival.
  `
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    starts_at INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'phone' CHECK (source IN ('phone', 'message', 'instagram', 'walk_in', 'other')),
    deposit_minor INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('booked', 'checked_in', 'cancelled', 'no_show', 'done')),
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    checked_in_at INTEGER,
    checked_in_by TEXT REFERENCES users(id)
  );
  CREATE INDEX bookings_by_start ON bookings(starts_at);
  CREATE INDEX bookings_active ON bookings(status, starts_at);

  -- Which stations a booking holds. A booking can span several (a group / party).
  CREATE TABLE booking_stations (
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    station_id TEXT NOT NULL REFERENCES stations(id),
    PRIMARY KEY (booking_id, station_id)
  );
  CREATE INDEX booking_stations_by_station ON booking_stations(station_id);
  `,

  // 4 — Inventory. Optional per product; stock drops with sales and is topped up by deliveries.
  `
  ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE products ADD COLUMN stock_qty INTEGER NOT NULL DEFAULT 0;      -- cached running total
  ALTER TABLE products ADD COLUMN min_qty INTEGER NOT NULL DEFAULT 0;        -- low-stock threshold

  -- Append-only log of every stock change, so the running total can always be reconstructed.
  CREATE TABLE stock_movements (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    delta INTEGER NOT NULL,                       -- signed units
    reason TEXT NOT NULL CHECK (reason IN ('sale', 'return', 'restock', 'waste', 'count', 'correction', 'initial')),
    ref_id TEXT,                                  -- ledger id, restock order id, etc.
    note TEXT,
    actor_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX stock_by_product ON stock_movements(product_id, created_at);
  CREATE TRIGGER stock_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;
  CREATE TRIGGER stock_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;

  CREATE TABLE restock_orders (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('ordered', 'confirmed', 'cancelled')),
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    confirmed_at INTEGER,
    confirmed_by TEXT REFERENCES users(id)
  );
  CREATE INDEX restock_by_status ON restock_orders(status, created_at);

  CREATE TABLE restock_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES restock_orders(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    ordered_qty INTEGER NOT NULL CHECK (ordered_qty > 0),
    received_qty INTEGER,                          -- filled in by the operator on delivery
    condition TEXT NOT NULL DEFAULT 'pending' CHECK (condition IN ('pending', 'complete', 'short', 'damaged'))
  );
  CREATE INDEX restock_items_by_order ON restock_items(order_id);
  `,

  // 5 — Members and loyalty points. Guest stays the default; a member is attached to a tab.
  `
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    code TEXT UNIQUE COLLATE NOCASE,              -- short membership/card code, optional
    points INTEGER NOT NULL DEFAULT 0,            -- cached running total
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id)
  );
  CREATE INDEX members_by_name ON members(name);

  -- Append-only log of every points change.
  CREATE TABLE point_movements (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('earn', 'redeem', 'adjust')),
    ref_id TEXT,
    note TEXT,
    actor_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX points_by_member ON point_movements(member_id, created_at);
  CREATE TRIGGER points_no_update BEFORE UPDATE ON point_movements BEGIN SELECT RAISE(ABORT, 'point movements are append-only'); END;
  CREATE TRIGGER points_no_delete BEFORE DELETE ON point_movements BEGIN SELECT RAISE(ABORT, 'point movements are append-only'); END;

  ALTER TABLE tabs ADD COLUMN member_id TEXT REFERENCES members(id);
  `,

  // 6 — PC health. Customer PCs report telemetry; the host keeps the latest snapshot and
  // an append-only log of notable events (unclean shutdown, client crash, low disk, hot CPU).
  `
  -- Latest health snapshot per PC. A cache of what the PC last reported, so it is overwritten
  -- in place (nothing here is money or audit); the durable record is device_events below.
  CREATE TABLE device_health (
    device_id TEXT PRIMARY KEY REFERENCES devices(id),
    at INTEGER NOT NULL,                  -- when the PC reported it
    uptime_ms INTEGER,                    -- how long the PC has been up
    cpu_pct INTEGER,                      -- 0..100, nullable (not every PC samples it)
    mem_used_mb INTEGER,
    mem_total_mb INTEGER,
    disk_free_mb INTEGER,                 -- system drive
    disk_total_mb INTEGER,
    disk_game_free_mb INTEGER,            -- optional game/second drive
    disk_game_total_mb INTEGER,
    cpu_temp_c INTEGER,                   -- nullable; many PCs can't report temperature
    gpu_temp_c INTEGER,                   -- nullable
    raw TEXT NOT NULL DEFAULT '{}'        -- full payload as reported, for fields added later
  );

  -- Append-only log of notable health events. Immutable once written; only the
  -- acknowledgement columns may change (an operator clearing the alert).
  CREATE TABLE device_events (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    at INTEGER NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'crit')),
    kind TEXT NOT NULL,                   -- unclean_shutdown | client_crash | low_disk | high_temp | ...
    detail TEXT NOT NULL DEFAULT '{}',
    acknowledged_at INTEGER,
    acknowledged_by TEXT REFERENCES users(id)
  );
  CREATE INDEX device_events_recent ON device_events(device_id, at);
  CREATE INDEX device_events_open ON device_events(acknowledged_at) WHERE acknowledged_at IS NULL;
  CREATE TRIGGER device_events_no_delete BEFORE DELETE ON device_events
    BEGIN SELECT RAISE(ABORT, 'device events are append-only'); END;
  CREATE TRIGGER device_events_immutable BEFORE UPDATE ON device_events
  BEGIN
    SELECT CASE
      WHEN NEW.id <> OLD.id OR NEW.device_id <> OLD.device_id OR NEW.at <> OLD.at
        OR NEW.severity <> OLD.severity OR NEW.kind <> OLD.kind OR NEW.detail <> OLD.detail
      THEN RAISE(ABORT, 'device events are immutable except acknowledgement') END;
  END;
  `,

  // 7 — Group sessions. Several stations started together share one tab (station_id NULL, so an
  // unpaid group tab shows in the counter-tabs strip). Each station's session carries the group id.
  `
  ALTER TABLE tabs ADD COLUMN group_id TEXT;
  ALTER TABLE sessions ADD COLUMN group_id TEXT;
  CREATE INDEX sessions_by_group ON sessions(group_id) WHERE group_id IS NOT NULL;
  `,

  // 8 — Floor plan. A station can carry an optional layout {x,y,shape,w,h} so it is drawn as a
  // recognisable shape at its real place on a 2-D map of the room, instead of a numbered card.
  // Décor areas (labelled rooms/zones/bar) live in the 'floor_plan' setting, not here, because
  // they reference no station and are purely cosmetic. NULL layout = station not placed yet.
  `
  ALTER TABLE stations ADD COLUMN layout TEXT;
  `,
];
