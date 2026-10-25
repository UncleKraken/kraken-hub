import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Checkout } from './Checkout';
import { clock, duration, money } from './format';
import { t } from './i18n';
import { pendingEstimate, sessionClock, stationState } from './stations';
import type { Currency, FloorState, Product, StationView, TabDetail, TabLine } from './types';
import { Dialog, useRun } from './ui';

const PREPAID_PRESETS = [30, 60, 90, 120];

export function Panel({
  state,
  now,
  base,
  station,
  tabId: counterTabId,
  onClose,
}: {
  state: FloorState;
  now: number;
  base: Currency;
  station: StationView | null;
  tabId: string | null;
  onClose: () => void;
}) {
  const { run } = useRun();
  const tabId = station ? (station.tab?.id ?? null) : counterTabId;
  const [tab, setTab] = useState<TabDetail | null>(null);
  const [checkout, setCheckout] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!tabId) {
      setTab(null);
      return;
    }
    api
      .get<TabDetail>(`/api/tabs/${tabId}`)
      .then((d) => !cancelled && setTab(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tabId, state.now]);

  const title = station ? station.name : tab?.label || t('tab.title');
  const live = station?.session ?? null;
  const pending = station ? pendingEstimate(station, now, state.now) : 0;
  const balance = tab?.totals.balanceMinor ?? 0;

  const stopAndPay = async () => {
    if (!live) return;
    const res = await run<{ tabId: string }>('session.end', { sessionId: live.id });
    if (!res) return;
    // Load the tab with the time charge on it before showing the payment screen.
    const fresh = await api.get<TabDetail>(`/api/tabs/${res.tabId}`).catch(() => null);
    if (fresh) {
      setTab(fresh);
      if (fresh.totals.balanceMinor > 0) setCheckout(true);
    }
  };

  return (
    <aside className="panel" aria-label={title}>
      <div className="panel-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="panel-title">{title}</div>
          {station && (
            <div className="panel-sub">
              {station.plan.name} · {t(`state.${stationState(station, now)}`)}
            </div>
          )}
        </div>
        <button className="btn btn-quiet" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>

      <div className="panel-body">
        {station && !live && !station.outOfOrder && <StartOptions station={station} base={base} />}
        {station && live && <LiveControls station={station} now={now} fetchedAt={state.now} base={base} />}
        {station?.device && <DeviceBox station={station} isManager={state.me.role === 'manager'} />}

        {tab && (
          <section>
            <h3 className="section-title">{t('tab.title')}</h3>
            <TabLines tab={tab} base={base} state={state} now={now} />
            <Totals tab={tab} pending={pending} base={base} />
          </section>
        )}

        {(tabId || station) && <ProductPicker products={state.products} base={base} target={tabId ? { tabId } : { stationId: station!.id }} />}

        {station && !live && <StationTools station={station} state={state} />}
      </div>

      <div className="panel-foot">
        {live ? (
          <button className="btn btn-primary btn-big btn-block" onClick={() => void stopAndPay()}>
            {t('station.end')} · {t('tab.checkout')}
          </button>
        ) : balance > 0 ? (
          <button className="btn btn-primary btn-big btn-block" onClick={() => setCheckout(true)}>
            {t('tab.checkout')} · {money(balance, base)}
          </button>
        ) : tab && tab.status === 'open' ? (
          <button className="btn btn-block" onClick={() => void run('tab.close', { tabId: tab.id }).then((r) => r && !station && onClose())}>
            {t('tab.close')}
          </button>
        ) : null}
      </div>

      {checkout && tab && (
        <Checkout
          tabId={tab.id}
          title={title}
          balanceMinor={balance}
          currencies={state.currencies}
          settings={state.settings}
          onClose={() => setCheckout(false)}
          onPaid={() => {
            setCheckout(false);
            if (!station) onClose();
          }}
        />
      )}
    </aside>
  );
}

/* ---- Starting a session ------------------------------------------------------------ */

function StartOptions({ station, base }: { station: StationView; base: Currency }) {
  const { run } = useRun();
  const cfg = station.plan.config;
  const playerCounts = cfg.kind === 'hourly' ? Object.keys(cfg.rates).map(Number).sort((a, b) => a - b) : [1];
  const [players, setPlayers] = useState(playerCounts[0] ?? 1);
  const [custom, setCustom] = useState('');
  const start = (payload: Record<string, unknown>) => run('session.start', { stationId: station.id, players, ...payload });

  if (cfg.kind === 'per_session') {
    return (
      <section>
        <button className="start-option primary" onClick={() => void start({})}>
          <b>{t('station.startGame')}</b>
          <span>{money(cfg.priceMinor, base)}</span>
        </button>
      </section>
    );
  }

  const rate = cfg.rates[String(players)] ?? cfg.rates['1'] ?? 0;
  const price = (min: number) => money(Math.round((min / 60) * rate), base);

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      {playerCounts.length > 1 && (
        <div>
          <h3 className="section-title">{t('station.players')}</h3>
          <div className="seg" role="group" aria-label={t('station.players')}>
            {playerCounts.map((n) => (
              <button key={n} aria-pressed={players === n} onClick={() => setPlayers(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="start-option primary" onClick={() => void start({ mode: 'postpaid' })}>
        <b>{t('station.openTime')}</b>
        <span>
          {t('station.openTimeHint')} · {money(rate, base)}/h
        </span>
      </button>
      <div>
        <h3 className="section-title">{t('station.prepaid')}</h3>
        <div className="btn-grid">
          {PREPAID_PRESETS.map((m) => (
            <button key={m} className="start-option" onClick={() => void start({ mode: 'prepaid', prepaidMinutes: m })}>
              <b>
                {m >= 60 ? `${m / 60}h` : `${m} ${t('station.minutes')}`}
              </b>
              <span>{price(m)}</span>
            </button>
          ))}
        </div>
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const m = Number(custom);
            if (m > 0) void start({ mode: 'prepaid', prepaidMinutes: Math.round(m) }).then(() => setCustom(''));
          }}
        >
          <input className="input" inputMode="numeric" placeholder={`${t('station.custom')} (${t('station.minutes')})`} value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} />
          <button className="btn" disabled={!Number(custom)}>
            {t('station.start')}
            {Number(custom) > 0 && ` · ${price(Number(custom))}`}
          </button>
        </form>
      </div>
    </section>
  );
}

/* ---- A running session -------------------------------------------------------------- */

function LiveControls({ station, now, fetchedAt, base }: { station: StationView; now: number; fetchedAt: number; base: Currency }) {
  const { run } = useRun();
  const sess = station.session!;
  const info = sessionClock(station, now, fetchedAt)!;
  const cfg = station.plan.config;
  const playerCounts = cfg.kind === 'hourly' ? Object.keys(cfg.rates).map(Number).sort((a, b) => a - b) : [];

  return (
    <section className="live">
      <div className="live-meta">
        <span>{info.counting === 'down' ? t('station.remaining') : t('station.elapsed')}</span>
        <span>{clock(sess.startedAt)}</span>
      </div>
      <div className="live-time">{duration(info.ms)}</div>
      {sess.mode === 'postpaid' && cfg.kind === 'hourly' && (
        <div className="live-meta">
          <span>{t('station.timeSoFar')}</span>
          <span>{money(pendingEstimate(station, now, fetchedAt), base)}</span>
        </div>
      )}

      {sess.mode === 'prepaid' && (
        <div>
          <h3 className="section-title">{t('station.extend')}</h3>
          <div className="btn-grid">
            {[15, 30, 60].map((m) => (
              <button key={m} className="btn" onClick={() => void run('session.extend', { sessionId: sess.id, minutes: m })}>
                +{m >= 60 ? `${m / 60}h` : `${m} ${t('station.minutes')}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {sess.mode === 'postpaid' && cfg.kind === 'hourly' && (
        <div className="row" style={{ alignItems: 'center' }}>
          {playerCounts.length > 1 && (
            <div className="seg" role="group" aria-label={t('station.players')} style={{ flex: 'none' }}>
              {playerCounts.map((n) => (
                <button key={n} aria-pressed={sess.players === n} onClick={() => void run('session.setPlayers', { sessionId: sess.id, players: n })}>
                  {n}P
                </button>
              ))}
            </div>
          )}
          {sess.status === 'active' ? (
            <button className="btn" onClick={() => void run('session.pause', { sessionId: sess.id })}>
              {t('station.pause')}
            </button>
          ) : (
            <button className="btn" onClick={() => void run('session.resume', { sessionId: sess.id })}>
              {t('station.resume')}
            </button>
          )}
        </div>
      )}

      <button className="btn btn-danger" onClick={() => void run('session.end', { sessionId: sess.id })}>
        {t('station.end')}
      </button>
    </section>
  );
}

/* ---- Tab lines ---------------------------------------------------------------------- */

function TabLines({ tab, base, state, now }: { tab: TabDetail; base: Currency; state: FloorState; now: number }) {
  const { run } = useRun();
  const [removing, setRemoving] = useState<TabLine | null>(null);
  if (tab.lines.length === 0) return <p className="empty-note">{t('tab.empty')}</p>;
  const windowMs = state.settings.operatorFixWindowMinutes * 60_000;

  return (
    <div className="lines">
      {tab.lines.map((l) => {
        const reversal = !!l.reversesId;
        const removable = tab.status === 'open' && !reversal && !l.reversed && l.kind !== 'rounding' && l.kind !== 'transfer';
        const own = l.actorId === state.me.id && now - l.createdAt <= windowMs;
        return (
          <div key={l.id} className={`line${l.reversed ? ' is-reversed' : ''}${reversal ? ' is-reversal' : ''}`}>
            <div className="line-desc">
              <div>
                {l.qty > 1 && !reversal ? `${l.qty} × ` : ''}
                {reversal ? `${t('tab.removed')}: ${l.description}` : l.description}
              </div>
              <small>
                {clock(l.createdAt)} · {l.actorName}
                {l.reason ? ` · ${l.reason}` : ''}
              </small>
            </div>
            <span className="line-amt">{money(l.amountMinor, base)}</span>
            {removable ? (
              <button className="btn btn-quiet line-remove" onClick={() => setRemoving(l)} title={own || state.me.role === 'manager' ? undefined : t('error.needs_manager')}>
                {t('tab.remove')}
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      {removing && (
        <RemoveDialog
          line={removing}
          base={base}
          onClose={() => setRemoving(null)}
          onRemove={async (reason) => {
            const res = await run('tab.reverseEntry', { entryId: removing.id, reason });
            if (res) setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

function RemoveDialog({ line, base, onClose, onRemove }: { line: TabLine; base: Currency; onClose: () => void; onRemove: (reason: string) => Promise<void> }) {
  const [other, setOther] = useState('');
  const reasons = [t('tab.reasonWrong'), t('tab.reasonDouble'), t('tab.reasonComplaint')];
  return (
    <Dialog title={`${t('tab.remove')}: ${line.description} · ${money(line.amountMinor, base)}`} onClose={onClose}>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>{t('tab.removeReason')}</p>
      <div style={{ display: 'grid', gap: 8 }}>
        {reasons.map((r) => (
          <button key={r} className="btn" onClick={() => void onRemove(r)}>
            {r}
          </button>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (other.trim()) void onRemove(other.trim());
          }}
        >
          <input className="input" value={other} onChange={(e) => setOther(e.target.value)} maxLength={120} placeholder="…" />
          <button className="btn" disabled={!other.trim()}>
            {t('tab.remove')}
          </button>
        </form>
      </div>
    </Dialog>
  );
}

function Totals({ tab, pending, base }: { tab: TabDetail; pending: number; base: Currency }) {
  return (
    <div className="totals" style={{ marginTop: 10 }}>
      {tab.totals.paidMinor !== 0 && (
        <>
          <div>
            <span>{t('tab.total')}</span>
            <span>{money(tab.totals.chargedMinor, base)}</span>
          </div>
          <div>
            <span>{t('tab.paid')}</span>
            <span>{money(tab.totals.paidMinor, base)}</span>
          </div>
        </>
      )}
      <div className="due">
        <span>{t('tab.due')}</span>
        <b>{money(tab.totals.balanceMinor, base)}</b>
      </div>
      {pending > 0 && (
        <div>
          <span>{t('tab.pendingTime')}</span>
          <span>+{money(pending, base)}</span>
        </div>
      )}
    </div>
  );
}

/* ---- Products ------------------------------------------------------------------------- */

function ProductPicker({ products, base, target }: { products: Product[]; base: Currency; target: { tabId: string } | { stationId: string } }) {
  const { run } = useRun();
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))], [products]);
  const [cat, setCat] = useState<string | null>(null);
  if (products.length === 0) return null;
  const shown = cat === null ? products : products.filter((p) => p.category === cat);
  return (
    <section>
      <h3 className="section-title">{t('tab.add')}</h3>
      {categories.length > 1 && (
        <div className="cat-tabs" role="group" style={{ marginBottom: 8 }}>
          <button aria-pressed={cat === null} onClick={() => setCat(null)}>
            ★
          </button>
          {categories.map((c) => (
            <button key={c} aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c || '—'}
            </button>
          ))}
        </div>
      )}
      <div className="products">
        {shown.map((p) => (
          <button key={p.id} className="product" onClick={() => void run('tab.addItem', { ...target, productId: p.id })}>
            <b>{p.name}</b>
            <span>{money(p.priceMinor, base)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ---- Customer PC controls ------------------------------------------------------------------ */

function DeviceBox({ station, isManager }: { station: StationView; isManager: boolean }) {
  const { run, toast } = useRun();
  const d = station.device!;
  const [confirm, setConfirm] = useState<'restart' | 'shutdown' | 'logoff' | null>(null);
  const [messaging, setMessaging] = useState(false);
  const [text, setText] = useState('');
  const labels = { restart: t('dev.restart'), shutdown: t('dev.shutdown'), logoff: t('dev.logoff') };

  const send = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = await run('station.remote', { stationId: station.id, action, ...extra });
    if (r) toast(t('dev.sent', { name: station.name }), 'success');
    return r;
  };

  return (
    <section className="device-box">
      <header>
        <span>
          <span className={`dot${d.online ? '' : ' off'}`} aria-hidden="true" />
          <b>{d.online ? t('dev.online') : t('dev.offline')}</b>
        </span>
        <small>
          {d.hostname} · {d.ip}
        </small>
      </header>
      {!d.online && d.lastSeenAt && <small>{t('dev.lastSeen', { time: clock(d.lastSeenAt) })}</small>}
      <div className="btn-grid">
        <button className="btn" disabled={!d.online} onClick={() => setMessaging(true)}>
          {t('dev.message')}
        </button>
        {(['restart', 'shutdown', 'logoff'] as const).map((a) => (
          <button key={a} className="btn" disabled={!d.online} onClick={() => setConfirm(a)}>
            {labels[a]}
          </button>
        ))}
      </div>
      {isManager && (
        <button
          className="btn btn-quiet"
          style={{ justifySelf: 'start' }}
          onClick={() => void run('device.remove', { deviceId: d.id })}
        >
          {t('dev.unpair')}
        </button>
      )}
      {confirm && (
        <Dialog title={t('dev.confirm', { action: labels[confirm], name: station.name })} onClose={() => setConfirm(null)}>
          <div className="dialog-actions">
            <button className="btn btn-quiet" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void send(confirm).then(() => setConfirm(null))}>
              {labels[confirm]}
            </button>
          </div>
        </Dialog>
      )}
      {messaging && (
        <Dialog title={`${t('dev.message')} · ${station.name}`} onClose={() => setMessaging(false)}>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim())
                void send('message', { text: text.trim() }).then((r) => {
                  if (r) {
                    setMessaging(false);
                    setText('');
                  }
                });
            }}
          >
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder={t('dev.messagePlaceholder')} autoFocus />
            <div className="dialog-actions">
              <button type="button" className="btn btn-quiet" onClick={() => setMessaging(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" disabled={!text.trim()}>
                {t('dev.message')}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}

/* ---- Station tools ------------------------------------------------------------------------ */

function StationTools({ station, state }: { station: StationView; state: FloorState }) {
  const { run } = useRun();
  const [moving, setMoving] = useState(false);
  const targets = state.stations.filter((s) => s.id !== station.id && !s.tab && !s.session && !s.outOfOrder);
  return (
    <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {station.tab && station.tab.balanceMinor > 0 && (
        <button className="btn btn-quiet" onClick={() => setMoving(true)}>
          {t('station.move')}
        </button>
      )}
      <button className="btn btn-quiet" onClick={() => void run('station.setOutOfOrder', { stationId: station.id, outOfOrder: !station.outOfOrder })}>
        {station.outOfOrder ? t('station.markBack') : t('station.markOut')}
      </button>
      {moving && station.tab && (
        <Dialog title={t('station.moveTo')} onClose={() => setMoving(false)}>
          <div className="btn-grid">
            {targets.map((s) => (
              <button
                key={s.id}
                className="btn"
                onClick={() => void run('tab.move', { tabId: station.tab!.id, toStationId: s.id }).then((r) => r && setMoving(false))}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </section>
  );
}
