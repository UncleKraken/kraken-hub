import { useEffect, useRef, useState } from 'react';
import { clock, money } from './format';
import { t } from './i18n';
import type { ClientRequest, Currency, FloorState } from './types';
import { Dialog, useRun } from './ui';

/** A short, soft two-tone chime so a busy operator notices a new request. */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const tone = (freq: number, at: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.3);
    };
    tone(880, 0);
    tone(1320, 0.18);
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio unavailable */
  }
}

function ago(ts: number, now: number): string {
  const min = Math.floor((now - ts) / 60_000);
  return min < 1 ? t('req.now') : t('req.ago', { min });
}

/**
 * The operator's inbox for things customer PCs ask for, plus PCs waiting to be approved.
 * Shown above the floor only while there is something to answer.
 */
export function Inbox({ state, now, base }: { state: FloorState; now: number; base: Currency }) {
  const count = state.requests.length + state.pendingDevices.length;
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = [...state.requests.map((r) => r.id), ...state.pendingDevices.map((d) => d.id)];
    // No chime for what was already waiting when the screen opened; only for new arrivals.
    if (seen.current && ids.some((id) => !seen.current!.has(id))) chime();
    seen.current = new Set([...(seen.current ?? []), ...ids]);
  }, [state.requests, state.pendingDevices]);

  if (count === 0) return null;
  return (
    <section className="inbox" aria-label={t('req.title')} aria-live="polite">
      {state.pendingDevices.map((d) => (
        <PendingDevice key={d.id} device={d} state={state} />
      ))}
      {state.requests.map((r) => (
        <RequestCard key={r.id} req={r} state={state} now={now} base={base} />
      ))}
    </section>
  );
}

function PendingDevice({ device, state }: { device: FloorState['pendingDevices'][number]; state: FloorState }) {
  const { run } = useRun();
  const [open, setOpen] = useState(false);
  const candidates = state.stations.filter((s) => s.kind === 'pc' || s.kind === 'sim' || s.kind === 'other');
  return (
    <div className="req req-device">
      <div className="req-text">
        <b>{t('dev.wants', { name: device.hostname })}</b>
        <small>{device.ip}</small>
      </div>
      <div className="req-actions">
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          {t('dev.approve')}
        </button>
        <button className="btn btn-quiet" onClick={() => void run('device.reject', { deviceId: device.id })}>
          {t('dev.reject')}
        </button>
      </div>
      {open && (
        <Dialog title={t('dev.approveTitle', { name: device.hostname })} onClose={() => setOpen(false)}>
          <p style={{ margin: 0, color: 'var(--ink-2)' }}>{t('dev.approveIntro')}</p>
          <div className="btn-grid">
            {candidates.map((s) => (
              <button
                key={s.id}
                className="start-option"
                onClick={() => void run('device.approve', { deviceId: device.id, stationId: s.id }).then((r) => r && setOpen(false))}
              >
                <b>{s.name}</b>
                <span>{s.device ? t('dev.replaces', { name: s.device.hostname }) : t(`kind.${s.kind}`)}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

function RequestCard({ req, state, now, base }: { req: ClientRequest; state: FloorState; now: number; base: Currency }) {
  const { run } = useRun();
  const [moving, setMoving] = useState(false);
  const station = state.stations.find((s) => s.id === req.stationId);
  const name = req.stationName ?? '—';

  let detail = '';
  if (req.kind === 'order') {
    const parts = (req.payload.items ?? []).map((it) => {
      const p = state.products.find((x) => x.id === it.productId);
      return { label: `${it.qty > 1 ? `${it.qty} × ` : ''}${p?.name ?? '?'}`, total: (p?.priceMinor ?? 0) * it.qty };
    });
    detail = `${parts.map((x) => x.label).join(', ')} · ${money(parts.reduce((s, x) => s + x.total, 0), base)}`;
  }
  if (req.kind === 'help') {
    const topic = req.payload.topic ?? 'operator';
    detail = t(topic === 'pc' ? 'client.helpPc' : topic === 'headphones' ? 'client.helpHeadphones' : 'client.helpOperator');
  }
  if (req.kind === 'extend') detail = `+${req.payload.minutes ?? 30} min`;

  const resolve = (decision: 'done' | 'declined') => run('request.resolve', { requestId: req.id, decision });
  const guest = (payload: Record<string, unknown>) => run('request.resolveGuest', { requestId: req.id, ...payload });
  const cfg = station?.plan.config;
  // Warn the operator if this PC is reserved soon, so a walk-in doesn't eat a booking.
  const reserved = req.kind === 'guest' ? station?.reserved : null;

  return (
    <div className={`req req-${req.kind}${reserved ? ' req-warn' : ''}`}>
      <div className="req-text">
        <b>
          {name} {t(`req.${req.kind}`)}
        </b>
        <small>
          {detail && `${detail} · `}
          {ago(req.createdAt, now)}
          {reserved && ` · ⚠ ${t('book.reservedSoon', { name: reserved.customerName, time: clock(reserved.startsAt) })}`}
        </small>
      </div>
      <div className="req-actions">
        {req.kind === 'guest' && (
          <>
            <button className="btn btn-primary" onClick={() => void guest({ decision: 'approve', mode: 'postpaid' })}>
              {t('req.openTime')}
            </button>
            {cfg?.kind === 'hourly' &&
              [60, 120].map((m) => (
                <button key={m} className="btn" onClick={() => void guest({ decision: 'approve', mode: 'prepaid', prepaidMinutes: m })}>
                  {t('req.prepaid', { min: m })}
                </button>
              ))}
            <button className="btn btn-quiet" onClick={() => setMoving(true)}>
              {t('req.move')}
            </button>
            <button className="btn btn-quiet" onClick={() => void guest({ decision: 'deny' })}>
              {t('req.deny')}
            </button>
          </>
        )}
        {req.kind === 'order' && (
          <>
            <button className="btn btn-primary" onClick={() => void resolve('done')}>
              {t('req.delivered')}
            </button>
            <button className="btn btn-quiet" onClick={() => void resolve('declined')}>
              {t('req.cancel')}
            </button>
          </>
        )}
        {req.kind === 'help' && (
          <button className="btn btn-primary" onClick={() => void resolve('done')}>
            {t('req.done')}
          </button>
        )}
        {req.kind === 'extend' && (
          <>
            <button className="btn btn-primary" onClick={() => void resolve('done')}>
              {t('req.add', { min: req.payload.minutes ?? 30 })}
            </button>
            <button className="btn btn-quiet" onClick={() => void resolve('declined')}>
              {t('req.deny')}
            </button>
          </>
        )}
      </div>
      {moving && (
        <Dialog title={t('req.moveTitle')} onClose={() => setMoving(false)}>
          <div className="btn-grid">
            {state.stations
              .filter((s) => s.id !== req.stationId && !s.session && !s.outOfOrder && !(s.tab && s.tab.balanceMinor > 0))
              .map((s) => (
                <button key={s.id} className="btn" onClick={() => void guest({ decision: 'move', toStationId: s.id }).then((r) => r && setMoving(false))}>
                  {s.name}
                </button>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
