import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { dateTime } from './format';
import { t } from './i18n';
import type { Actor, InventoryData, RestockOrder } from './types';
import { Dialog, useRun } from './ui';

/**
 * The inventory page, for both roles. Operators receive deliveries, waste and count;
 * managers also create and confirm restock orders. Stock moves only through these actions
 * and sales, so the numbers always trace back to the movement log.
 */
export function Inventory({ me, version, onClose }: { me: Actor; version: number; onClose: () => void }) {
  const { run } = useRun();
  const isManager = me.role === 'manager';
  const [data, setData] = useState<InventoryData | null>(null);
  const load = useCallback(() => api.get<InventoryData>('/api/inventory').then(setData).catch(() => undefined), []);
  useEffect(() => {
    void load();
  }, [load, version]);

  const [newOrder, setNewOrder] = useState(false);
  const [receiving, setReceiving] = useState<RestockOrder | null>(null);
  const [acting, setActing] = useState<{ kind: 'waste' | 'count'; product: InventoryData['products'][number] } | null>(null);

  const act = async (type: string, payload: unknown) => {
    const res = await run(type, payload);
    if (res) await load();
  };

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('inv.title')}>
        <button onClick={onClose}>← {t('settings.backToFloor')}</button>
      </nav>
      <main className="settings-main">
        <header className="settings-head">
          <div>
            <h1>{t('inv.title')}</h1>
            <p>{t('inv.intro')}</p>
          </div>
          {isManager && (
            <button className="btn btn-primary" onClick={() => setNewOrder(true)}>
              {t('inv.newOrder')}
            </button>
          )}
        </header>
        {!data ? (
          <p className="empty-note">{t('common.loading')}</p>
        ) : (
          <div className="settings-body">
            <section>
              <h2 className="list-group">{t('inv.lowStock')}</h2>
              {data.lowStock.length === 0 ? (
                <p className="empty-note">{t('inv.lowNone')}</p>
              ) : (
                <>
                  <div className="list">
                    {data.lowStock.map((p) => (
                      <div key={p.id} className="list-row">
                        <div className="list-main">
                          <b>{p.name}</b>
                          <small>
                            {t('products.inStock', { n: p.stockQty })} · min {p.minQty}
                          </small>
                        </div>
                        <span className="list-meta" style={{ color: 'var(--ending)' }}>
                          {t('products.low')}
                        </span>
                      </div>
                    ))}
                  </div>
                  {isManager && (
                    <button className="btn" style={{ marginTop: 10, justifySelf: 'start' }} onClick={() => setNewOrder(true)}>
                      {t('inv.orderLow')}
                    </button>
                  )}
                </>
              )}
            </section>

            <section>
              <h2 className="list-group">{t('inv.openOrders')}</h2>
              {data.orders.length === 0 ? (
                <p className="empty-note">{t('inv.ordersNone')}</p>
              ) : (
                <div className="list">
                  {data.orders.map((o) => {
                    const received = o.items.every((it) => it.receivedQty !== null);
                    return (
                      <div key={o.id} className="list-row">
                        <div className="list-main">
                          <b>{o.items.map((it) => `${it.orderedQty}× ${it.name}`).join(', ')}</b>
                          <small>
                            {dateTime(o.createdAt)} · {t('inv.by', { name: o.createdBy })}
                            {received ? ` · ${t('inv.received')}` : ''}
                          </small>
                        </div>
                        <div className="req-actions">
                          <button className="btn" onClick={() => setReceiving(o)}>
                            {t('inv.receive')}
                          </button>
                          {isManager && received && (
                            <button className="btn btn-primary" onClick={() => void act('inventory.restock.confirm', { orderId: o.id })}>
                              {t('inv.confirmShort')}
                            </button>
                          )}
                          {isManager && (
                            <button className="btn btn-quiet" onClick={() => void act('inventory.restock.cancel', { orderId: o.id })}>
                              {t('inv.cancelOrder')}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <h2 className="list-group">{t('settings.products')}</h2>
              <div className="list">
                {data.products.map((p) => (
                  <div key={p.id} className="list-row">
                    <div className="list-main">
                      <b>{p.name}</b>
                      <small>{p.category}</small>
                    </div>
                    <span className="list-meta" style={{ color: p.stockQty <= p.minQty ? 'var(--ending)' : undefined }}>
                      {t('products.inStock', { n: p.stockQty })}
                    </span>
                    <div className="req-actions">
                      <button className="btn btn-quiet" onClick={() => setActing({ kind: 'count', product: p })}>
                        {t('inv.count')}
                      </button>
                      <button className="btn btn-quiet" onClick={() => setActing({ kind: 'waste', product: p })}>
                        {t('inv.waste')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
      {newOrder && data && <NewOrderDialog products={data.products} prefill={data.lowStock.map((l) => l.id)} onClose={() => setNewOrder(false)} onDone={load} />}
      {receiving && <ReceiveDialog order={receiving} onClose={() => setReceiving(null)} onDone={load} />}
      {acting && <AdjustDialog kind={acting.kind} product={acting.product} onClose={() => setActing(null)} onDone={load} />}
    </div>
  );
}

function NewOrderDialog({
  products,
  prefill,
  onClose,
  onDone,
}: {
  products: InventoryData['products'];
  prefill: string[];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { run, toast } = useRun();
  // Default: low-stock items at roughly twice their minimum, a sensible restock amount.
  const [qty, setQty] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const p of products) if (prefill.includes(p.id)) init[p.id] = Math.max(p.minQty * 2 - p.stockQty, p.minQty, 1);
    return init;
  });
  const [error, setError] = useState('');

  const set = (id: string, n: number) => setQty((x) => ({ ...x, [id]: n }));
  const submit = async () => {
    const items = Object.entries(qty)
      .filter(([, n]) => n > 0)
      .map(([productId, orderedQty]) => ({ productId, orderedQty }));
    if (items.length === 0) {
      setError(t('inv.pickProducts'));
      return;
    }
    const res = await run('inventory.restock.create', { items });
    if (res) {
      toast(t('settings.saved'), 'success');
      await onDone();
      onClose();
    }
  };

  return (
    <Dialog title={t('inv.newOrder')} onClose={onClose} wide>
      <div className="form-grid">
        {products.map((p) => (
          <div className="rate-row" key={p.id}>
            <span>
              {p.name}
              <small className="hint" style={{ display: 'block' }}>
                {t('products.inStock', { n: p.stockQty })}
              </small>
            </span>
            <input
              className="input input-money"
              type="number"
              min={0}
              value={qty[p.id] ?? 0}
              onChange={(e) => set(p.id, Math.max(0, Number(e.target.value)))}
              aria-label={`${t('inv.qty')} ${p.name}`}
            />
            <span />
          </div>
        ))}
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ReceiveDialog({ order, onClose, onDone }: { order: RestockOrder; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { run, toast } = useRun();
  const [rows, setRows] = useState(() =>
    order.items.map((it) => ({ itemId: it.id, name: it.name, orderedQty: it.orderedQty, receivedQty: it.receivedQty ?? it.orderedQty })),
  );

  const conditionOf = (ordered: number, received: number): 'complete' | 'short' | 'damaged' => (received >= ordered ? 'complete' : 'short');

  const submit = async () => {
    const received = rows.map((r) => ({ itemId: r.itemId, receivedQty: r.receivedQty, condition: conditionOf(r.orderedQty, r.receivedQty) }));
    const res = await run('inventory.restock.receive', { orderId: order.id, received });
    if (res) {
      toast(t('settings.saved'), 'success');
      await onDone();
      onClose();
    }
  };

  return (
    <Dialog title={t('inv.receiveTitle')} onClose={onClose} wide>
      <div className="form-grid">
        {rows.map((r, i) => (
          <div className="rate-row" key={r.itemId}>
            <span>
              {r.name}
              <small className="hint" style={{ display: 'block' }}>
                {t('inv.ordered', { n: r.orderedQty })}
              </small>
            </span>
            <input
              className="input input-money"
              type="number"
              min={0}
              value={r.receivedQty}
              onChange={(e) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, receivedQty: Math.max(0, Number(e.target.value)) } : x)))}
              aria-label={`${t('inv.received')} ${r.name}`}
            />
            <span className="hint">{r.receivedQty < r.orderedQty ? t('inv.short') : t('inv.complete')}</span>
          </div>
        ))}
        <div className="dialog-actions">
          <button className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()}>
            {t('inv.saveReceived')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function AdjustDialog({
  kind,
  product,
  onClose,
  onDone,
}: {
  kind: 'waste' | 'count';
  product: InventoryData['products'][number];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { run, toast } = useRun();
  const [qty, setQty] = useState(kind === 'count' ? product.stockQty : 1);
  const [reason, setReason] = useState('');

  const submit = async () => {
    const res =
      kind === 'waste'
        ? await run('inventory.waste', { productId: product.id, qty, reason: reason.trim() || '—' })
        : await run('inventory.count', { productId: product.id, countedQty: qty });
    if (res) {
      toast(t('settings.saved'), 'success');
      await onDone();
      onClose();
    }
  };

  return (
    <Dialog title={t(kind === 'waste' ? 'inv.wasteTitle' : 'inv.countTitle', { name: product.name })} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{kind === 'waste' ? t('inv.wasteQty') : t('inv.countedQty')}</span>
          <input className="input input-money" type="number" min={kind === 'waste' ? 1 : 0} value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value)))} autoFocus />
        </label>
        {kind === 'waste' && (
          <label className="field">
            <span>{t('inv.wasteReason')}</span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} required />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}
