import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { clock, dateTime, money } from './format';
import { setLang, t, useLang, type Lang } from './i18n';
import { ShiftKV } from './Shift';
import type { AdminLists, AuditEntry, Currency, PricePlanConfig, ShiftListItem, ShiftSummary, StationKind } from './types';
import { Dialog, MoneyInput, useRun } from './ui';

type Section = 'stations' | 'plans' | 'products' | 'staff' | 'currencies' | 'venue' | 'shifts' | 'activity';
const SETUP: Section[] = ['stations', 'plans', 'products', 'staff', 'currencies', 'venue'];
const RECORDS: Section[] = ['shifts', 'activity'];
const KINDS: StationKind[] = ['pc', 'console', 'sim', 'table', 'other'];

/** Manager settings. Every save goes through the same command bus as the floor, so it is audited. */
export function Settings({ version, meId, onBack }: { version: number; meId: string; onBack: () => void }) {
  useLang();
  const [section, setSection] = useState<Section>('stations');
  const [data, setData] = useState<AdminLists | null>(null);
  const load = useCallback(() => api.get<AdminLists>('/api/admin').then(setData).catch(() => undefined), []);
  useEffect(() => {
    void load();
  }, [load, version]);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('settings.open')}>
        <button onClick={onBack}>← {t('settings.backToFloor')}</button>
        <hr />
        {SETUP.map((s) => (
          <button key={s} aria-current={section === s ? 'page' : undefined} onClick={() => setSection(s)}>
            {t(`settings.${s}`)}
          </button>
        ))}
        <hr />
        {RECORDS.map((s) => (
          <button key={s} aria-current={section === s ? 'page' : undefined} onClick={() => setSection(s)}>
            {t(`settings.${s}`)}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        {!data ? (
          <p className="empty-note">{t('common.loading')}</p>
        ) : section === 'stations' ? (
          <Stations data={data} reload={load} />
        ) : section === 'plans' ? (
          <Plans data={data} reload={load} />
        ) : section === 'products' ? (
          <Products data={data} reload={load} />
        ) : section === 'staff' ? (
          <Staff data={data} reload={load} meId={meId} />
        ) : section === 'currencies' ? (
          <Currencies data={data} reload={load} />
        ) : section === 'venue' ? (
          <Venue data={data} reload={load} />
        ) : section === 'shifts' ? (
          <Shifts currencies={data.currencies} />
        ) : (
          <Activity />
        )}
      </main>
    </div>
  );
}

/* ---- Shared bits ----------------------------------------------------------------------- */

function Head({ title, intro, action }: { title: string; intro: string; action?: ReactNode }) {
  return (
    <header className="settings-head">
      <div>
        <h1>{title}</h1>
        <p>{intro}</p>
      </div>
      {action}
    </header>
  );
}

function useSave(reload: () => Promise<unknown>) {
  const { run, toast } = useRun();
  return async (type: string, payload: unknown, quiet = false) => {
    const res = await run(type, payload);
    if (res) {
      await reload();
      if (!quiet) toast(t('settings.saved'), 'success');
    }
    return res;
  };
}

function ArchivedToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {t('settings.showArchived')}
    </label>
  );
}

const baseOf = (data: AdminLists) => data.currencies.find((c) => c.isBase)!;

/* ---- Stations --------------------------------------------------------------------------- */

type StationRow = AdminLists['stations'][number];

function Stations({ data, reload }: { data: AdminLists; reload: () => Promise<unknown> }) {
  const save = useSave(reload);
  const [editing, setEditing] = useState<StationRow | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const plans = data.plans.filter((p) => p.active);
  const rows = data.stations.filter((s) => showArchived || s.active);
  const zones = [...new Set(data.stations.map((s) => s.zone).filter(Boolean))];
  const planName = (id: string) => data.plans.find((p) => p.id === id)?.name ?? '—';

  return (
    <>
      <Head
        title={t('settings.stations')}
        intro={t('stations.intro')}
        action={
          plans.length > 0 && (
            <div className="row" style={{ flex: 'none' }}>
              <button className="btn" onClick={() => setBulk(true)}>
                {t('stations.addMany')}
              </button>
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                {t('stations.add')}
              </button>
            </div>
          )
        }
      />
      <div className="settings-body">
        {plans.length === 0 && <p className="empty-note">{t('stations.noPlans')}</p>}
        {rows.length > 0 && (
          <div className="list">
            {rows.map((s) => (
              <div key={s.id} className={`list-row${s.active ? '' : ' is-archived'}`}>
                <div className="list-main">
                  <b>
                    {s.name}
                    {!s.active && <span className="badge">{t('settings.archived')}</span>}
                  </b>
                  <small>
                    {t(`kind.${s.kind}`)}
                    {s.zone && s.zone !== t(`kind.${s.kind}`) ? ` · ${s.zone}` : ''}
                  </small>
                </div>
                <span className="list-meta">{planName(s.pricePlanId)}</span>
                <button className="btn btn-quiet" onClick={() => setEditing(s)}>
                  {t('settings.edit')}
                </button>
              </div>
            ))}
          </div>
        )}
        <ArchivedToggle value={showArchived} onChange={setShowArchived} />
      </div>
      {editing && (
        <StationDialog
          station={editing === 'new' ? null : editing}
          plans={plans}
          zones={zones}
          nextSort={data.stations.length}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (await save('admin.station.upsert', payload)) setEditing(null);
          }}
        />
      )}
      {bulk && (
        <BulkStations
          plans={plans}
          zones={zones}
          nextSort={data.stations.length}
          onClose={() => setBulk(false)}
          onCreate={async (items) => {
            for (const item of items) {
              const ok = await save('admin.station.upsert', item, true);
              if (!ok) return;
            }
            setBulk(false);
          }}
        />
      )}
    </>
  );
}

function StationDialog({
  station,
  plans,
  zones,
  nextSort,
  onClose,
  onSave,
}: {
  station: StationRow | null;
  plans: AdminLists['plans'];
  zones: string[];
  nextSort: number;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(station?.name ?? '');
  const [kind, setKind] = useState<StationKind>(station?.kind ?? 'pc');
  const [zone, setZone] = useState(station?.zone ?? '');
  const [planId, setPlanId] = useState(station?.pricePlanId ?? plans[0]?.id ?? '');
  const [sort, setSort] = useState(station?.sort ?? nextSort);
  const payload = (active: boolean) => ({ id: station?.id, name, kind, zone, pricePlanId: planId, sort, active });

  return (
    <Dialog title={station ? `${t('settings.edit')}: ${station.name}` : t('stations.add')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(payload(station?.active ?? true));
        }}
      >
        <label className="field">
          <span>{t('settings.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="PC-11" />
        </label>
        <label className="field">
          <span>{t('stations.kind')}</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as StationKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('stations.plan')}</span>
          <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)} required>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('stations.zone')}</span>
          <input className="input" list="zones" value={zone} onChange={(e) => setZone(e.target.value)} maxLength={40} />
          <datalist id="zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <small className="hint">{t('stations.zoneHint')}</small>
        </label>
        <label className="field">
          <span>{t('settings.order')}</span>
          <input className="input" type="number" value={sort} onChange={(e) => setSort(Number(e.target.value))} />
        </label>
        <div className="dialog-actions">
          {station && (
            <button type="button" className="btn btn-quiet" onClick={() => void onSave(payload(!station.active))}>
              {station.active ? t('settings.archive') : t('settings.restore')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function BulkStations({
  plans,
  zones,
  nextSort,
  onClose,
  onCreate,
}: {
  plans: AdminLists['plans'];
  zones: string[];
  nextSort: number;
  onClose: () => void;
  onCreate: (items: Record<string, unknown>[]) => Promise<void>;
}) {
  const [prefix, setPrefix] = useState('PC-');
  const [from, setFrom] = useState(1);
  const [count, setCount] = useState(10);
  const [kind, setKind] = useState<StationKind>('pc');
  const [zone, setZone] = useState('PC');
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const pad = String(from + count - 1).length < 2 ? 2 : String(from + count - 1).length;
  const nameAt = (i: number) => `${prefix}${String(from + i).padStart(pad, '0')}`;

  return (
    <Dialog title={t('stations.addMany')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onCreate(Array.from({ length: count }, (_, i) => ({ name: nameAt(i), kind, zone, pricePlanId: planId, sort: nextSort + i })));
          setBusy(false);
        }}
      >
        <div className="row">
          <label className="field">
            <span>{t('stations.prefix')}</span>
            <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={30} />
          </label>
          <label className="field">
            <span>{t('stations.from')}</span>
            <input className="input" type="number" min={0} value={from} onChange={(e) => setFrom(Math.max(0, Number(e.target.value)))} />
          </label>
          <label className="field">
            <span>{t('stations.count')}</span>
            <input className="input" type="number" min={1} max={60} value={count} onChange={(e) => setCount(Math.min(60, Math.max(1, Number(e.target.value))))} />
          </label>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          {t('stations.preview', { first: nameAt(0), last: nameAt(count - 1) })}
        </p>
        <div className="row">
          <label className="field">
            <span>{t('stations.kind')}</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as StationKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('stations.plan')}</span>
            <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>{t('stations.zone')}</span>
          <input className="input" list="zones-bulk" value={zone} onChange={(e) => setZone(e.target.value)} maxLength={40} />
          <datalist id="zones-bulk">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {t('settings.add')} {count}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---- Prices ---------------------------------------------------------------------------- */

type PlanRow = AdminLists['plans'][number];

function planSummary(cfg: PricePlanConfig, base: Currency): string {
  if (cfg.kind === 'per_session') return `${money(cfg.priceMinor, base)} ${t('plans.perGame')}`;
  const entries = Object.entries(cfg.rates).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (entries.length === 1) return `${money(entries[0]![1], base)}${t('plans.perHour')}`;
  return entries.map(([n, r]) => `${n}P ${money(r, base)}`).join(' · ') + t('plans.perHour');
}

function Plans({ data, reload }: { data: AdminLists; reload: () => Promise<unknown> }) {
  const save = useSave(reload);
  const base = baseOf(data);
  const [editing, setEditing] = useState<PlanRow | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const rows = data.plans.filter((p) => showArchived || p.active);
  const usage = (id: string) => data.stations.filter((s) => s.active && s.pricePlanId === id).length;

  return (
    <>
      <Head
        title={t('settings.plans')}
        intro={t('plans.intro')}
        action={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            {t('plans.add')}
          </button>
        }
      />
      <div className="settings-body">
        {rows.length === 0 ? (
          <p className="empty-note">{t('settings.none')}</p>
        ) : (
          <div className="list">
            {rows.map((p) => (
              <div key={p.id} className={`list-row${p.active ? '' : ' is-archived'}`}>
                <div className="list-main">
                  <b>
                    {p.name}
                    {!p.active && <span className="badge">{t('settings.archived')}</span>}
                  </b>
                  <small>{t('plans.usedBy', { n: usage(p.id) })}</small>
                </div>
                <span className="list-meta">{planSummary(p.config, base)}</span>
                <button className="btn btn-quiet" onClick={() => setEditing(p)}>
                  {t('settings.edit')}
                </button>
              </div>
            ))}
          </div>
        )}
        <ArchivedToggle value={showArchived} onChange={setShowArchived} />
      </div>
      {editing && (
        <PlanDialog
          plan={editing === 'new' ? null : editing}
          base={base}
          inUse={editing !== 'new' && usage(editing.id) > 0}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (await save('admin.plan.upsert', payload)) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function PlanDialog({
  plan,
  base,
  inUse,
  onClose,
  onSave,
}: {
  plan: PlanRow | null;
  base: Currency;
  inUse: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const cfg = plan?.config;
  const [name, setName] = useState(plan?.name ?? '');
  const [kind, setKind] = useState<PricePlanConfig['kind']>(cfg?.kind ?? 'hourly');
  const hourly = cfg?.kind === 'hourly' ? cfg : null;
  const [rates, setRates] = useState<[number, number][]>(
    hourly ? Object.entries(hourly.rates).map(([n, r]) => [Number(n), r] as [number, number]).sort((a, b) => a[0] - b[0]) : [[1, 0]],
  );
  const [byPlayers, setByPlayers] = useState(rates.length > 1);
  const [unit, setUnit] = useState(hourly?.billingUnitMinutes ?? 1);
  const [minimum, setMinimum] = useState(hourly?.minimumMinutes ?? 0);
  const [price, setPrice] = useState(cfg?.kind === 'per_session' ? cfg.priceMinor : 0);

  const build = (active: boolean) => {
    const config =
      kind === 'per_session'
        ? { kind, priceMinor: price }
        : {
            kind,
            rates: Object.fromEntries((byPlayers ? rates : rates.slice(0, 1)).map(([n, r]) => [String(n), r])),
            billingUnitMinutes: unit,
            minimumMinutes: minimum,
          };
    return { id: plan?.id, name, config, active };
  };
  const setRate = (i: number, patch: Partial<{ n: number; r: number }>) =>
    setRates((rs) => rs.map((x, j) => (j === i ? [patch.n ?? x[0], patch.r ?? x[1]] : x)));

  return (
    <Dialog title={plan ? `${t('settings.edit')}: ${plan.name}` : t('plans.add')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(build(plan?.active ?? true));
        }}
      >
        <label className="field">
          <span>{t('settings.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="PC standard" />
        </label>
        <div className="field">
          <span>{t('plans.kind')}</span>
          <div className="seg" role="group" style={{ justifySelf: 'start' }}>
            <button type="button" aria-pressed={kind === 'hourly'} onClick={() => setKind('hourly')}>
              {t('plans.hourly')}
            </button>
            <button type="button" aria-pressed={kind === 'per_session'} onClick={() => setKind('per_session')}>
              {t('plans.perSession')}
            </button>
          </div>
        </div>

        {kind === 'hourly' ? (
          <>
            <div className="field">
              <span>{byPlayers ? `${t('plans.rate1')} · 1P` : t('plans.rate1')}</span>
              <MoneyInput currency={base} label={t('plans.rate1')} value={rates[0]![1]} onChange={(v) => setRate(0, { r: v })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={byPlayers} onChange={(e) => setByPlayers(e.target.checked)} />
              {t('plans.ratesByPlayers')}
            </label>
            {byPlayers && (
              <div className="form-grid">
                {rates.slice(1).map(([n, r], k) => {
                  const i = k + 1;
                  return (
                    <div className="rate-row" key={i}>
                      <input
                        className="input"
                        type="number"
                        min={2}
                        max={16}
                        aria-label={t('station.players')}
                        value={n}
                        onChange={(e) => setRate(i, { n: Math.max(2, Number(e.target.value)) })}
                      />
                      <MoneyInput currency={base} label={t('plans.players', { n })} value={r} onChange={(v) => setRate(i, { r: v })} />
                      <button type="button" className="btn btn-quiet" onClick={() => setRates((rs) => rs.filter((_, j) => j !== i))} aria-label={t('settings.archive')}>
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="btn btn-quiet"
                  style={{ justifySelf: 'start' }}
                  onClick={() => setRates((rs) => [...rs, [Math.max(...rs.map((x) => x[0])) + (rs.length === 1 ? 1 : 2), rs[rs.length - 1]![1]]])}
                >
                  + {t('plans.addPlayers')}
                </button>
              </div>
            )}
            <div className="row">
              <label className="field">
                <span>{t('plans.billingUnit')}</span>
                <select className="input" value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
                  {[1, 5, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m} {t('station.minutes')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('plans.minimum')}</span>
                <select className="input" value={minimum} onChange={(e) => setMinimum(Number(e.target.value))}>
                  {[0, 5, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m} {t('station.minutes')}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <small className="hint">{t('plans.billingUnitHint')}</small>
          </>
        ) : (
          <label className="field">
            <span>{t('plans.price')}</span>
            <MoneyInput currency={base} label={t('plans.price')} value={price} onChange={setPrice} />
          </label>
        )}

        <div className="dialog-actions">
          {plan && !inUse && (
            <button type="button" className="btn btn-quiet" onClick={() => void onSave(build(!plan.active))}>
              {plan.active ? t('settings.archive') : t('settings.restore')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---- Products ------------------------------------------------------------------------------ */

type ProductRow = AdminLists['products'][number];

function Products({ data, reload }: { data: AdminLists; reload: () => Promise<unknown> }) {
  const save = useSave(reload);
  const base = baseOf(data);
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const rows = data.products.filter((p) => showArchived || p.active);
  const categories = [...new Set(data.products.map((p) => p.category))];
  const grouped = useMemo(() => {
    const m = new Map<string, ProductRow[]>();
    for (const p of rows) m.set(p.category, [...(m.get(p.category) ?? []), p]);
    return [...m.entries()];
  }, [rows]);

  return (
    <>
      <Head
        title={t('settings.products')}
        intro={t('products.intro')}
        action={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            {t('products.add')}
          </button>
        }
      />
      <div className="settings-body">
        {rows.length === 0 && <p className="empty-note">{t('settings.none')}</p>}
        {grouped.map(([cat, items]) => (
          <div key={cat}>
            {cat && <h2 className="list-group">{cat}</h2>}
            <div className="list">
              {items.map((p) => (
                <div key={p.id} className={`list-row${p.active ? '' : ' is-archived'}`}>
                  <div className="list-main">
                    <b>
                      {p.name}
                      {!p.active && <span className="badge">{t('settings.archived')}</span>}
                      {p.trackStock && p.stockQty <= p.minQty && <span className="badge badge-warn">{t('products.low')}</span>}
                    </b>
                    {p.trackStock && <small>{t('products.inStock', { n: p.stockQty })}</small>}
                  </div>
                  <span className="list-meta">{money(p.priceMinor, base)}</span>
                  <button className="btn btn-quiet" onClick={() => setEditing(p)}>
                    {t('settings.edit')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
        <ArchivedToggle value={showArchived} onChange={setShowArchived} />
      </div>
      {editing && (
        <ProductDialog
          product={editing === 'new' ? null : editing}
          base={base}
          categories={categories}
          nextSort={data.products.length}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (await save('admin.product.upsert', payload)) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function ProductDialog({
  product,
  base,
  categories,
  nextSort,
  onClose,
  onSave,
}: {
  product: ProductRow | null;
  base: Currency;
  categories: string[];
  nextSort: number;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category ?? categories[0] ?? '');
  const [price, setPrice] = useState(product?.priceMinor ?? 0);
  const [sort, setSort] = useState(product?.sort ?? nextSort);
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? false);
  const [minQty, setMinQty] = useState(product?.minQty ?? 0);
  const [initialStock, setInitialStock] = useState(0);
  const payload = (active: boolean) => ({
    id: product?.id,
    name,
    category,
    priceMinor: price,
    sort,
    active,
    trackStock,
    minQty,
    ...(!product && trackStock ? { initialStock } : {}),
  });
  return (
    <Dialog title={product ? `${t('settings.edit')}: ${product.name}` : t('products.add')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(payload(product?.active ?? true));
        }}
      >
        <label className="field">
          <span>{t('settings.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        <label className="field">
          <span>{t('products.price')}</span>
          <MoneyInput currency={base} label={t('products.price')} value={price} onChange={setPrice} />
        </label>
        <label className="field">
          <span>{t('products.category')}</span>
          <input className="input" list="categories" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} />
          <datalist id="categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <small className="hint">{t('products.categoryHint')}</small>
        </label>
        <label className="field">
          <span>{t('settings.order')}</span>
          <input className="input" type="number" value={sort} onChange={(e) => setSort(Number(e.target.value))} />
        </label>
        <div>
          <label className="check">
            <input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
            {t('products.track')}
          </label>
          <small className="hint">{t('products.trackHint')}</small>
        </div>
        {trackStock && (
          <div className="row">
            {!product && (
              <label className="field">
                <span>{t('products.initial')}</span>
                <input className="input" type="number" min={0} value={initialStock} onChange={(e) => setInitialStock(Math.max(0, Number(e.target.value)))} />
              </label>
            )}
            <label className="field">
              <span>{t('products.minQty')}</span>
              <input className="input" type="number" min={0} value={minQty} onChange={(e) => setMinQty(Math.max(0, Number(e.target.value)))} />
            </label>
          </div>
        )}
        <div className="dialog-actions">
          {product && (
            <button type="button" className="btn btn-quiet" onClick={() => void onSave(payload(!product.active))}>
              {product.active ? t('settings.archive') : t('settings.restore')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---- Staff ------------------------------------------------------------------------------------ */

type UserRow = AdminLists['users'][number];

function Staff({ data, reload, meId }: { data: AdminLists; reload: () => Promise<unknown>; meId: string }) {
  const save = useSave(reload);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  return (
    <>
      <Head
        title={t('settings.staff')}
        intro={t('staff.intro')}
        action={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            {t('staff.add')}
          </button>
        }
      />
      <div className="settings-body">
        <div className="list">
          {data.users.map((u) => (
            <div key={u.id} className={`list-row${u.active ? '' : ' is-archived'}`}>
              <div className="list-main">
                <b>
                  {u.displayName}
                  {u.id === meId && <span className="badge">{t('staff.you')}</span>}
                  {!u.active && <span className="badge">{t('settings.archived')}</span>}
                </b>
                <small>{u.username}</small>
              </div>
              <span className="list-meta">{t(`role.${u.role}`)}</span>
              <button className="btn btn-quiet" onClick={() => setEditing(u)}>
                {t('settings.edit')}
              </button>
            </div>
          ))}
        </div>
      </div>
      {editing && (
        <UserDialog
          user={editing === 'new' ? null : editing}
          isMe={editing !== 'new' && editing.id === meId}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (await save('admin.user.upsert', payload)) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function UserDialog({ user, isMe, onClose, onSave }: { user: UserRow | null; isMe: boolean; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [role, setRole] = useState<UserRow['role']>(user?.role ?? 'operator');
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(user?.active ?? true);
  return (
    <Dialog title={user ? `${t('settings.edit')}: ${user.displayName}` : t('staff.add')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ id: user?.id, displayName, username, role, active, ...(password ? { password } : {}) });
        }}
      >
        <label className="field">
          <span>{t('staff.displayName')}</span>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={60} />
        </label>
        <label className="field">
          <span>{t('staff.username')}</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[a-zA-Z0-9._\-]{2,32}" autoComplete="off" />
        </label>
        <div className="field">
          <span>{t('staff.role')}</span>
          <div className="seg" role="group" style={{ justifySelf: 'start' }}>
            {(['operator', 'manager'] as const).map((r) => (
              <button key={r} type="button" aria-pressed={role === r} disabled={isMe} onClick={() => setRole(r)}>
                {t(`role.${r}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>{user ? t('staff.newPassword') : t('staff.password')}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} required={!user} autoComplete="new-password" />
          <small className="hint">{t('staff.passwordHint')}</small>
        </label>
        {user && !isMe && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('staff.active')}
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

/* ---- Currencies ----------------------------------------------------------------------------- */

function Currencies({ data, reload }: { data: AdminLists; reload: () => Promise<unknown> }) {
  const save = useSave(reload);
  const base = baseOf(data);
  const [editing, setEditing] = useState<Currency | 'new' | null>(null);
  return (
    <>
      <Head
        title={t('settings.currencies')}
        intro={t('currencies.intro')}
        action={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            {t('currencies.add')}
          </button>
        }
      />
      <div className="settings-body">
        <div className="list">
          {data.currencies.map((c) => (
            <div key={c.code} className={`list-row${c.enabled ? '' : ' is-archived'}`}>
              <div className="list-main">
                <b>
                  {c.code} · {c.symbol}
                  {c.isBase && <span className="badge">{t('currencies.main')}</span>}
                  {!c.enabled && <span className="badge">{t('settings.archived')}</span>}
                </b>
                <small>{c.cashDenominations.map((d) => money(d, c)).join(' · ') || '—'}</small>
              </div>
              <span className="list-meta">{c.isBase ? '' : `1 ${c.code} = ${money(Math.round(c.rate * 10 ** base.decimals), base)}`}</span>
              <button className="btn btn-quiet" onClick={() => setEditing(c)}>
                {t('settings.edit')}
              </button>
            </div>
          ))}
        </div>
      </div>
      {editing && (
        <CurrencyDialog
          currency={editing === 'new' ? null : editing}
          base={base}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (await save('admin.currency.upsert', payload)) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function CurrencyDialog({ currency, base, onClose, onSave }: { currency: Currency | null; base: Currency; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [code, setCode] = useState(currency?.code ?? '');
  const [symbol, setSymbol] = useState(currency?.symbol ?? '');
  const [decimals, setDecimals] = useState(currency?.decimals ?? 2);
  const [rate, setRate] = useState(currency ? String(currency.rate) : '');
  const [enabled, setEnabled] = useState(currency?.enabled ?? true);
  const [notes, setNotes] = useState((currency?.cashDenominations ?? []).map((d) => d / 10 ** (currency?.decimals ?? 0)).join(', '));
  const isBase = !!currency?.isBase;
  const parsedNotes = notes
    .split(/[,;\s]+/)
    .map((s) => Number(s.replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round(n * 10 ** decimals));
  const rateNum = isBase ? 1 : Number(rate.replace(',', '.'));

  return (
    <Dialog title={currency ? `${t('settings.edit')}: ${currency.code}` : t('currencies.add')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ code: code.toUpperCase(), symbol, decimals, rate: rateNum, enabled: isBase ? true : enabled, cashDenominations: parsedNotes });
        }}
      >
        <div className="row">
          <label className="field">
            <span>{t('currencies.code')}</span>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required minLength={3} maxLength={3} disabled={!!currency} />
          </label>
          <label className="field">
            <span>{t('currencies.symbol')}</span>
            <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} required maxLength={4} disabled={isBase} />
          </label>
          <label className="field">
            <span>{t('currencies.decimals')}</span>
            <select className="input" value={decimals} onChange={(e) => setDecimals(Number(e.target.value))} disabled={isBase}>
              <option value={0}>0</option>
              <option value={2}>2</option>
            </select>
          </label>
        </div>
        {!isBase && (
          <label className="field">
            <span>{t('currencies.rate', { code: code || '…', base: base.code })}</span>
            <input className="input input-money" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required placeholder="100" />
          </label>
        )}
        <label className="field">
          <span>{t('currencies.notes')}</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={decimals ? '5, 10, 20, 50' : '200, 500, 1000, 2000, 5000'} />
          <small className="hint">{t('currencies.notesHint')}</small>
        </label>
        {!isBase && currency && (
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('currencies.accepted')}
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!isBase && !(rateNum > 0)}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---- Venue -------------------------------------------------------------------------------------- */

function Venue({ data, reload }: { data: AdminLists; reload: () => Promise<unknown> }) {
  const save = useSave(reload);
  const base = baseOf(data);
  const s = data.settings;
  const [venueName, setVenueName] = useState(s.venueName);
  const [rounding, setRounding] = useState(s.cashRoundingMinor);
  const [fixWindow, setFixWindow] = useState(s.operatorFixWindowMinutes);
  const [language, setLanguage] = useState<Lang>(s.defaultLanguage);
  const [blind, setBlind] = useState(s.blindCount);
  const [tipRule, setTipRule] = useState(s.tipSplitRule);
  const [reservedHold, setReservedHold] = useState(s.reservedHoldMinutes);
  const [noShowGrace, setNoShowGrace] = useState(s.noShowGraceMinutes);
  const [pointsPer100, setPointsPer100] = useState(s.pointsPer100);
  const [redeemValue, setRedeemValue] = useState(s.redeemValueMinor);

  return (
    <>
      <Head title={t('settings.venue')} intro={t('venue.intro')} />
      <form
        className="settings-body form-grid"
        style={{ maxWidth: 560 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await save('admin.settings.update', {
            venueName,
            cashRoundingMinor: Math.max(1, rounding),
            operatorFixWindowMinutes: fixWindow,
            defaultLanguage: language,
            blindCount: blind,
            tipSplitRule: tipRule,
            reservedHoldMinutes: reservedHold,
            noShowGraceMinutes: noShowGrace,
            pointsPer100,
            redeemValueMinor: redeemValue,
          });
          if (ok && language !== s.defaultLanguage) setLang(language);
        }}
      >
        <label className="field">
          <span>{t('venue.name')}</span>
          <input className="input" value={venueName} onChange={(e) => setVenueName(e.target.value)} required maxLength={60} />
        </label>
        <label className="field">
          <span>{t('venue.rounding')}</span>
          <MoneyInput currency={base} label={t('venue.rounding')} value={rounding} onChange={setRounding} />
          <small className="hint">{t('venue.roundingHint')}</small>
        </label>
        <label className="field">
          <span>{t('venue.fixWindow')}</span>
          <select className="input" value={fixWindow} onChange={(e) => setFixWindow(Number(e.target.value))}>
            {[0, 2, 5, 10, 15, 30].map((m) => (
              <option key={m} value={m}>
                {m} {t('station.minutes')}
              </option>
            ))}
          </select>
          <small className="hint">{t('venue.fixWindowHint')}</small>
        </label>
        <div className="field">
          <span>{t('venue.language')}</span>
          <div className="seg" role="group" style={{ justifySelf: 'start' }}>
            {(['sq', 'en'] as Lang[]).map((l) => (
              <button key={l} type="button" aria-pressed={language === l} onClick={() => setLanguage(l)}>
                {t(`lang.${l}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>{t('venue.tipRule')}</span>
          <select className="input" value={tipRule} onChange={(e) => setTipRule(e.target.value as typeof tipRule)}>
            <option value="collector">{t('venue.tipCollector')}</option>
            <option value="equal">{t('venue.tipEqual')}</option>
            <option value="hours">{t('venue.tipHours')}</option>
          </select>
        </label>
        <div>
          <label className="check">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            {t('venue.blind')}
          </label>
          <small className="hint">{t('venue.blindHint')}</small>
        </div>
        <label className="field">
          <span>{t('venue.reservedHold')}</span>
          <select className="input" value={reservedHold} onChange={(e) => setReservedHold(Number(e.target.value))}>
            {[5, 10, 15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} {t('station.minutes')}
              </option>
            ))}
          </select>
          <small className="hint">{t('venue.reservedHoldHint')}</small>
        </label>
        <label className="field">
          <span>{t('venue.noShowGrace')}</span>
          <select className="input" value={noShowGrace} onChange={(e) => setNoShowGrace(Number(e.target.value))}>
            {[5, 10, 15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} {t('station.minutes')}
              </option>
            ))}
          </select>
          <small className="hint">{t('venue.noShowGraceHint')}</small>
        </label>
        <label className="field">
          <span>{t('venue.pointsPer100')}</span>
          <input className="input" type="number" min={0} value={pointsPer100} onChange={(e) => setPointsPer100(Math.max(0, Number(e.target.value)))} />
          <small className="hint">{t('venue.pointsPer100Hint')}</small>
        </label>
        <label className="field">
          <span>{t('venue.redeemValue')}</span>
          <MoneyInput currency={base} label={t('venue.redeemValue')} value={redeemValue} onChange={setRedeemValue} />
          <small className="hint">{t('venue.redeemValueHint')}</small>
        </label>
        <div>
          <button className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </>
  );
}

/* ---- Shift history ---------------------------------------------------------------------------- */

function Shifts({ currencies }: { currencies: Currency[] }) {
  const [list, setList] = useState<ShiftListItem[] | null>(null);
  const [open, setOpen] = useState<{ item: ShiftListItem; summary: ShiftSummary } | null>(null);
  useEffect(() => {
    api.get<ShiftListItem[]>('/api/shifts').then(setList).catch(() => setList([]));
  }, []);
  return (
    <>
      <Head title={t('settings.shifts')} intro={t('shifts.intro')} />
      <div className="settings-body">
        {list && list.length === 0 && <p className="empty-note">{t('settings.none')}</p>}
        {list && list.length > 0 && (
          <div className="list">
            {list.map((s) => (
              <div key={s.id} className="list-row">
                <div className="list-main">
                  <b>{s.userName}</b>
                  <small>
                    {dateTime(s.openedAt)} – {s.closedAt ? clock(s.closedAt) : t('shifts.running')}
                  </small>
                </div>
                <span className="list-meta">{s.status === 'open' ? t('shifts.running') : t('shifts.closed')}</span>
                <button
                  className="btn btn-quiet"
                  onClick={() =>
                    api
                      .get<ShiftSummary>(`/api/shifts/${s.id}`)
                      .then((summary) => setOpen({ item: s, summary }))
                      .catch(() => undefined)
                  }
                >
                  {t('shifts.open')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {open && (
        <Dialog title={`${t('shift.report')} · ${open.item.userName}`} onClose={() => setOpen(null)}>
          <p style={{ margin: 0, color: 'var(--ink-2)' }}>
            {dateTime(open.summary.openedAt)} – {open.summary.closedAt ? clock(open.summary.closedAt) : t('shifts.running')}
          </p>
          <ShiftKV report={open.summary} currencies={currencies} />
          <div className="dialog-actions no-print">
            <button className="btn" onClick={() => window.print()}>
              {t('shift.print')}
            </button>
            <button className="btn btn-primary" onClick={() => setOpen(null)}>
              {t('common.close')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/* ---- Activity log ------------------------------------------------------------------------------ */

function actionLabel(a: string): string {
  const label = t(`action.${a}`);
  return label.startsWith('action.') ? a : label;
}

function describe(e: AuditEntry): string {
  try {
    const after = e.after ? (JSON.parse(e.after) as Record<string, unknown>) : null;
    if (after && typeof after.description === 'string') return after.description;
    if (after && typeof after.name === 'string') return after.name;
    if (after && typeof after.reason === 'string') return after.reason;
    if (after && typeof after.displayName === 'string') return after.displayName;
    if (after && typeof after.code === 'string') return after.code;
  } catch {
    /* not JSON */
  }
  return '';
}

function Activity() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const loadMore = useCallback((before?: number) => {
    api
      .get<AuditEntry[]>(`/api/audit${before ? `?before=${before}` : ''}`)
      .then((page) => {
        setRows((r) => (before ? [...r, ...page] : page));
        if (page.length < 100) setDone(true);
      })
      .catch(() => setDone(true));
  }, []);
  useEffect(() => loadMore(), [loadMore]);

  return (
    <>
      <Head title={t('settings.activity')} intro={t('activity.intro')} />
      <div className="settings-body">
        {rows.length > 0 && (
          <div className="list">
            {rows.map((e) => {
              const detail = describe(e);
              return (
                <div key={e.seq} className="activity-row">
                  <time dateTime={new Date(e.at).toISOString()}>{dateTime(e.at)}</time>
                  <div>
                    <b>{e.actorName ?? t('activity.system')}</b> · {actionLabel(e.action)}
                    {detail && <span style={{ color: 'var(--ink-2)' }}> · {detail}</span>}
                    {e.approvedByName && (
                      <div>
                        <small>{t('activity.approvedBy', { name: e.approvedByName })}</small>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!done && rows.length > 0 && (
          <button className="btn" style={{ justifySelf: 'start' }} onClick={() => loadMore(rows[rows.length - 1]!.seq)}>
            {t('activity.more')}
          </button>
        )}
      </div>
    </>
  );
}
