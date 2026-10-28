import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Checkout } from './Checkout';
import { MemberPicker } from './Members';
import { clock, dateTime, duration, money } from './format';
import { t } from './i18n';
import { pendingEstimate, sessionClock, stationState } from './stations';
import type { Currency, DeviceHealthDetail, FloorState, HealthSummary, Product, StationView, TabDetail, TabLine } from './types';
import { Dialog, useRun } from './ui';

const PREPAID_PRESETS = [30, 60, 90, 120];

export function Panel({
  state,
  now,
  base,
  station,
  tabId: counterTabId,
  onClose,
  onReceipt,
}: {
  state: FloorState;
  now: number;
  base: Currency;
  station: StationView | null;
  tabId: string | null;
  onClose: () => void;
  onReceipt: (tabId: string) => void;
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

  const groupId = station?.groupId ?? null;

  const stopAndPay = async () => {
    if (!live) return;
    // A grouped station stops the whole group at once; both post time to the shared tab.
    const res = groupId
      ? await run<{ tabId: string }>('session.endGroup', { groupId })
      : await run<{ tabId: string }>('session.end', { sessionId: live.id });
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
        {station && !live && !station.outOfOrder && <StartOptions station={station} state={state} base={base} />}
        {station && live && <LiveControls station={station} state={state} now={now} fetchedAt={state.now} base={base} />}
        {groupId && <GroupBar state={state} groupId={groupId} stationId={station?.id} />}
        {station?.device && <DeviceBox station={station} isManager={state.me.role === 'manager'} />}

        {tab && (
          <section>
            <h3 className="section-title">{t('tab.title')}</h3>
            <TabLines tab={tab} base={base} state={state} now={now} />
            <Totals tab={tab} pending={pending} base={base} />
            <MemberBar tab={tab} settings={state.settings} base={base} />
          </section>
        )}

        {(tabId || station) && <ProductPicker products={state.products} base={base} target={tabId ? { tabId } : { stationId: station!.id }} />}

        {station && !live && <StationTools station={station} state={state} />}
      </div>

      <div className="panel-foot">
        {live ? (
          <button className="btn btn-primary btn-big btn-block" onClick={() => void stopAndPay()}>
            {groupId ? t('group.stopPay') : `${t('station.end')} · ${t('tab.checkout')}`}
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
          onReceipt={onReceipt}
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

function StartOptions({ station, state, base }: { station: StationView; state: FloorState; base: Currency }) {
  const { run } = useRun();
  const cfg = station.plan.config;
  const playerCounts = cfg.kind === 'hourly' ? Object.keys(cfg.rates).map(Number).sort((a, b) => a - b) : [1];
  const [players, setPlayers] = useState(playerCounts[0] ?? 1);
  const [custom, setCustom] = useState('');
  const [grouping, setGrouping] = useState(false);
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
      <button className="btn btn-quiet" style={{ justifySelf: 'start' }} onClick={() => setGrouping(true)}>
        {t('group.start')}
      </button>
      {grouping && <GroupStartDialog station={station} state={state} base={base} onClose={() => setGrouping(false)} />}
    </section>
  );
}

/** Shows which stations share this group tab, from any member's panel. */
function GroupBar({ state, groupId, stationId }: { state: FloorState; groupId: string; stationId?: string }) {
  const members = state.stations.filter((s) => s.groupId === groupId);
  if (members.length === 0) return null;
  return (
    <div className="group-bar">
      <span className="group-pill">{t('group.badge', { n: members.length })}</span>
      <span className="group-members">{members.map((m) => (m.id === stationId ? `[${m.name}]` : m.name)).join(' · ')}</span>
    </div>
  );
}

/** Picks the stations to link into one group tab and starts them together. */
function GroupStartDialog({ station, state, onClose }: { station: StationView; state: FloorState; base: Currency; onClose: () => void }) {
  const { run, toast } = useRun();
  const free = state.stations.filter((s) => !s.session && !s.tab && !s.outOfOrder);
  const [selected, setSelected] = useState<Set<string>>(new Set([station.id]));
  const [mode, setMode] = useState<'open' | number>('open');
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const ids = [...selected];
  const canStart = ids.length >= 2 && !busy;

  const startGroup = async () => {
    setBusy(true);
    const payload = mode === 'open' ? { mode: 'postpaid' } : { mode: 'prepaid', prepaidMinutes: mode };
    const res = await run('session.startGroup', { stationIds: ids, ...payload });
    setBusy(false);
    if (res) {
      toast(t('group.started', { n: ids.length }), 'success');
      onClose();
    }
  };

  return (
    <Dialog title={t('group.title')} onClose={onClose}>
      <p className="hint">{t('group.intro')}</p>
      <div className="group-grid">
        {free.map((s) => (
          <button key={s.id} type="button" className={`group-pick${selected.has(s.id) ? ' on' : ''}`} aria-pressed={selected.has(s.id)} onClick={() => toggle(s.id)}>
            {s.name}
          </button>
        ))}
      </div>
      <h3 className="section-title">{t('group.time')}</h3>
      <div className="btn-grid">
        <button type="button" className={`start-option${mode === 'open' ? ' primary' : ''}`} onClick={() => setMode('open')}>
          <b>{t('station.openTime')}</b>
        </button>
        {PREPAID_PRESETS.map((m) => (
          <button type="button" key={m} className={`start-option${mode === m ? ' primary' : ''}`} onClick={() => setMode(m)}>
            <b>{m >= 60 ? `${m / 60}h` : `${m} ${t('station.minutes')}`}</b>
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={!canStart} onClick={() => void startGroup()}>
          {t('group.startN', { n: ids.length })}
        </button>
      </div>
    </Dialog>
  );
}

/* ---- A running session -------------------------------------------------------------- */

function LiveControls({ station, state, now, fetchedAt, base }: { station: StationView; state: FloorState; now: number; fetchedAt: number; base: Currency }) {
  const { run } = useRun();
  const sess = station.session!;
  const info = sessionClock(station, now, fetchedAt)!;
  const cfg = station.plan.config;
  const playerCounts = cfg.kind === 'hourly' ? Object.keys(cfg.rates).map(Number).sort((a, b) => a - b) : [];
  const [moving, setMoving] = useState(false);

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

      <div className="row" style={{ gap: 8 }}>
        {!station.groupId && (
          <button className="btn" onClick={() => setMoving(true)}>
            {t('station.moveSession')}
          </button>
        )}
        <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => void run('session.end', { sessionId: sess.id })}>
          {t('station.end')}
        </button>
      </div>
      {moving && <MoveSessionDialog station={station} state={state} onClose={() => setMoving(false)} />}
    </section>
  );
}

/** Picks a free station to move a live session to (when a PC freezes or dies). */
function MoveSessionDialog({ station, state, onClose }: { station: StationView; state: FloorState; onClose: () => void }) {
  const { run, toast } = useRun();
  const free = state.stations.filter((s) => s.id !== station.id && !s.session && !s.tab && !s.outOfOrder && !s.groupId);
  const move = async (to: StationView) => {
    const r = await run('session.move', { sessionId: station.session!.id, toStationId: to.id });
    if (r) {
      toast(t('station.moved', { name: to.name }), 'success');
      onClose();
    }
  };
  return (
    <Dialog title={t('station.moveTitle', { name: station.name })} onClose={onClose}>
      <p className="hint">{t('station.moveHint')}</p>
      {free.length === 0 ? (
        <p className="empty-note">{t('station.moveNone')}</p>
      ) : (
        <div className="station-pick">
          {free.map((s) => (
            <button key={s.id} type="button" className="pick" onClick={() => void move(s)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </Dialog>
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

/* ---- Member on the tab ---------------------------------------------------------------- */

function MemberBar({ tab, settings, base }: { tab: TabDetail; settings: FloorState['settings']; base: Currency }) {
  const { run, toast } = useRun();
  const [picking, setPicking] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const canRedeem = settings.redeemValueMinor > 0 && tab.member && tab.member.points > 0 && tab.totals.balanceMinor > 0;

  if (!tab.member) {
    return (
      <div className="member-bar">
        <button className="btn btn-quiet" onClick={() => setPicking(true)}>
          + {t('mem.attach')}
        </button>
        {picking && (
          <MemberPicker
            onClose={() => setPicking(false)}
            onPick={async (m) => {
              setPicking(false);
              await run('tab.setMember', { tabId: tab.id, memberId: m.id });
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="member-bar">
      <div className="member-info">
        <b>{tab.member.name}</b>
        <small>{t('mem.points', { n: tab.member.points })}</small>
      </div>
      <div className="req-actions">
        {canRedeem && (
          <button className="btn btn-quiet" onClick={() => setRedeeming(true)}>
            {t('mem.redeemPoints')}
          </button>
        )}
        <button className="btn btn-quiet" onClick={() => void run('tab.setMember', { tabId: tab.id, memberId: null })}>
          {t('mem.remove')}
        </button>
      </div>
      {redeeming && tab.member && (
        <RedeemDialog
          tab={tab}
          base={base}
          valueMinor={settings.redeemValueMinor}
          onClose={() => setRedeeming(false)}
          onDone={async (pts) => {
            const res = await run<{ discountMinor: number }>('member.redeem', { tabId: tab.id, points: pts });
            if (res) toast(t('mem.redeem'), 'success');
            setRedeeming(false);
          }}
        />
      )}
    </div>
  );
}

function RedeemDialog({ tab, base, valueMinor, onClose, onDone }: { tab: TabDetail; base: Currency; valueMinor: number; onClose: () => void; onDone: (points: number) => void }) {
  const member = tab.member!;
  // Most points that can usefully be redeemed: capped by the balance.
  const maxByBalance = Math.ceil(tab.totals.balanceMinor / valueMinor);
  const maxPoints = Math.min(member.points, maxByBalance);
  const [points, setPoints] = useState(maxPoints);
  return (
    <Dialog title={t('mem.redeemTitle', { name: member.name })} onClose={onClose}>
      <div className="form-grid">
        <label className="field">
          <span>{t('mem.redeemHow')}</span>
          <input className="input input-money" type="number" min={1} max={maxPoints} value={points} onChange={(e) => setPoints(Math.max(1, Math.min(maxPoints, Number(e.target.value))))} autoFocus />
        </label>
        <p className="hint" style={{ margin: 0 }}>
          {t('mem.redeemWorth', { points, amount: money(points * valueMinor, base) })}
        </p>
        <div className="dialog-actions">
          <button className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => onDone(points)}>
            {t('mem.redeemPoints')}
          </button>
        </div>
      </div>
    </Dialog>
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
      <HealthPanel device={d} />
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

/* ---- PC health ---------------------------------------------------------------------------- */

function uptimeShort(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

/** A compact stat with an optional bar; `warn` tints it when the value is in alert territory. */
function Stat({ label, value, pct, warn }: { label: string; value: string; pct?: number | null; warn?: boolean }) {
  return (
    <div className={`health-stat${warn ? ' warn' : ''}`}>
      <small>{label}</small>
      <b>{value}</b>
      {pct != null && (
        <span className="health-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </span>
      )}
    </div>
  );
}

function HealthPanel({ device }: { device: NonNullable<StationView['device']> }) {
  const { run, toast } = useRun();
  const h = device.health;
  const alerts = device.alerts;
  const [history, setHistory] = useState(false);
  const diskWarn = alerts.includes('low_disk');
  const tempWarn = alerts.includes('high_temp');

  const ack = async () => {
    const r = await run('device.ackHealth', { deviceId: device.id });
    if (r) toast(t('health.cleared'), 'success');
  };

  return (
    <div className="health">
      {alerts.length > 0 && (
        <div className="health-alerts">
          <span className="health-alerts-list">
            {alerts.map((a) => (
              <span key={a} className="health-chip">
                {t(`health.${a}`)}
              </span>
            ))}
          </span>
          <button className="btn btn-quiet btn-sm" onClick={() => void ack()}>
            {t('health.clear')}
          </button>
        </div>
      )}
      {h ? (
        <div className="health-stats">
          <Stat
            label={t('health.disk')}
            value={h.diskFreePct != null ? `${h.diskFreePct}%` : '—'}
            pct={h.diskFreePct != null ? 100 - h.diskFreePct : null}
            warn={diskWarn}
          />
          <Stat label={t('health.memory')} value={h.memPct != null ? `${h.memPct}%` : '—'} pct={h.memPct} />
          <Stat label={t('health.cpu')} value={h.cpuPct != null ? `${h.cpuPct}%` : '—'} pct={h.cpuPct} />
          <Stat label={t('health.temp')} value={h.tempC != null ? `${h.tempC}°C` : '—'} warn={tempWarn} />
          <Stat label={t('health.uptime')} value={h.uptimeMs != null ? uptimeShort(h.uptimeMs) : '—'} />
        </div>
      ) : (
        <small className="hint">{t('health.noData')}</small>
      )}
      <button className="btn btn-quiet btn-sm" style={{ justifySelf: 'start' }} onClick={() => setHistory(true)}>
        {t('health.history')}
      </button>
      {history && <HealthHistory deviceId={device.id} onClose={() => setHistory(false)} />}
    </div>
  );
}

function HealthHistory({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const [data, setData] = useState<DeviceHealthDetail | null>(null);
  useEffect(() => {
    void api.get<DeviceHealthDetail>(`/api/devices/${deviceId}/health`).then(setData).catch(() => undefined);
  }, [deviceId]);
  return (
    <Dialog title={t('health.history')} onClose={onClose} wide>
      {!data ? (
        <p className="empty-note">{t('common.loading')}</p>
      ) : data.events.length === 0 ? (
        <p className="empty-note">{t('health.noneYet')}</p>
      ) : (
        <div className="list">
          {data.events.map((e) => (
            <div key={e.id} className="activity-row">
              <time>{dateTime(e.at)}</time>
              <div>
                <span className={`health-sev ${e.severity}`}>{t(`health.sev.${e.severity}`)}</span> {t(`health.${e.kind}`)}
                {e.kind === 'high_temp' && typeof e.detail.tempC === 'number' ? ` · ${e.detail.tempC}°C` : ''}
                {e.kind === 'low_disk' && typeof e.detail.freePct === 'number' ? ` · ${e.detail.freePct}%` : ''}
                {e.acknowledgedAt ? ` · ${t('health.acked')}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn btn-primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
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
