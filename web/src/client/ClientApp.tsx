import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { duration, money } from '../format';
import { setLang, t, useLang, type Lang } from '../i18n';
import { useTick } from '../store';

/**
 * What a customer sees on a PC. Runs inside the Windows client app (WebView2), which
 * passes the PC's identity in the URL hash and carries out system actions. Opened in a
 * normal browser it simulates a PC, which is useful for testing.
 */

interface Identity {
  machineId: string;
  hostname: string;
  mac: string;
  secret: string;
  version: string;
}

interface DeviceState {
  type: 'state';
  now: number;
  venueName: string;
  defaultLanguage: Lang;
  currency: { code: string; symbol: string; decimals: number };
  paired: boolean;
  station: { id: string; name: string; outOfOrder: boolean } | null;
  locked: boolean;
  reason: 'idle' | 'paused' | 'outOfOrder' | 'unpaired' | 'session';
  session: { mode: 'prepaid' | 'postpaid'; status: string; usedMs: number; pendingMinor: number; endsAt: number | null; players: number; planKind: string } | null;
  planKind: 'hourly' | 'per_session' | null;
  tab: { balanceMinor: number; lines: { description: string; qty: number; amountMinor: number; reversed: boolean }[] } | null;
  products: { id: string; name: string; category: string; priceMinor: number }[];
  guestRequest: { id: string; status: string; result: { decision?: string; toStationName?: string } | null; createdAt: number } | null;
  openRequests: { id: string; kind: string; createdAt: number }[];
}

/* ---- Native bridge ------------------------------------------------------------------------ */

interface WebViewBridge {
  postMessage: (m: unknown) => void;
  addEventListener: (type: 'message', fn: (e: { data: unknown }) => void) => void;
}
const bridge = (): WebViewBridge | null => (window as unknown as { chrome?: { webview?: WebViewBridge } }).chrome?.webview ?? null;
const toNative = (m: object) => bridge()?.postMessage(m);

type Mode = 'lock' | 'widget' | 'mini';

/* ---- Identity ------------------------------------------------------------------------------- */

function readIdentity(): Identity {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('secret') && hash.get('machineId')) {
    return {
      machineId: hash.get('machineId')!,
      hostname: hash.get('hostname') ?? 'PC',
      mac: hash.get('mac') ?? '',
      secret: hash.get('secret')!,
      version: hash.get('version') ?? '',
    };
  }
  // Browser simulation: keep a stable fake identity per browser.
  try {
    const saved = localStorage.getItem('kh.sim');
    if (saved) return JSON.parse(saved) as Identity;
  } catch {
    /* storage unavailable */
  }
  const rnd = () => crypto.randomUUID().replaceAll('-', '');
  const sim: Identity = { machineId: `SIM-${rnd().slice(0, 12)}`, hostname: `SIM-${rnd().slice(0, 4).toUpperCase()}`, mac: '', secret: rnd() + rnd(), version: 'web' };
  try {
    localStorage.setItem('kh.sim', JSON.stringify(sim));
  } catch {
    /* storage unavailable */
  }
  return sim;
}

const storageKey = (id: Identity) => `kh.device.${id.machineId}`;

/* ---- App -------------------------------------------------------------------------------------- */

export function ClientApp() {
  useLang();
  const identity = useMemo(readIdentity, []);
  const [deviceId, setDeviceId] = useState<string | null>(() => localStorage.getItem(storageKey(identity)));
  const [pairStatus, setPairStatus] = useState<'pending' | 'approved' | 'rejected' | 'removed' | 'error' | null>(null);

  // Pair (or re-check pairing) until approved.
  useEffect(() => {
    if (pairStatus === 'approved') return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/agent/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(identity),
        });
        const data = (await res.json()) as { deviceId?: string; status?: typeof pairStatus };
        if (stop || !data.deviceId) return;
        localStorage.setItem(storageKey(identity), data.deviceId);
        setDeviceId(data.deviceId);
        setPairStatus(data.status ?? 'error');
      } catch {
        if (!stop) setPairStatus('error');
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [identity, pairStatus]);

  if (pairStatus !== 'approved' || !deviceId) return <Pairing identity={identity} status={pairStatus} />;
  return <Live deviceId={deviceId} identity={identity} onUnpaired={() => setPairStatus(null)} />;
}

function Pairing({ identity, status }: { identity: Identity; status: string | null }) {
  useEffect(() => toNative({ type: 'mode', mode: 'lock' }), []);
  return (
    <div className="cl-lock">
      <LangToggle />
      <div className="cl-center">
        <div className="cl-venue">{t('app.name')}</div>
        <h1 className="cl-big">{t('client.pairing')}</h1>
        <p className="cl-lead">{status === 'rejected' ? t('client.pairRejected') : t('client.pairingIntro', { name: identity.hostname })}</p>
        <div className="cl-host">{identity.hostname}</div>
      </div>
    </div>
  );
}

/* ---- Live link ---------------------------------------------------------------------------------- */

function useAgentLink(deviceId: string, identity: Identity, onUnpaired: () => void) {
  const [state, setState] = useState<DeviceState | null>(null);
  const [online, setOnline] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const offset = useRef(0);
  const pending = useRef(new Map<string, (r: { ok: boolean; code?: string }) => void>());

  useEffect(() => {
    let closed = false;
    let backoff = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams({ deviceId, secret: identity.secret, version: identity.version });
      const ws = new WebSocket(`${proto}://${location.host}/api/agent/ws?${q}`);
      wsRef.current = ws;
      ws.onopen = () => {
        backoff = 500;
        setOnline(true);
        beat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'heartbeat' })), 10_000);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string } & Record<string, unknown>;
        if (m.type === 'state') {
          const s = m as unknown as DeviceState;
          offset.current = s.now - Date.now();
          setState(s);
        } else if (m.type === 'result') {
          pending.current.get(m.requestId as string)?.({ ok: !!m.ok, code: m.code as string | undefined });
          pending.current.delete(m.requestId as string);
        } else if (m.type === 'command') {
          ws.send(JSON.stringify({ type: 'ack', id: m.id, ok: true }));
          if (m.action === 'message') setMessage(String(m.text ?? ''));
          else toNative({ type: 'system', action: m.action });
        }
      };
      ws.onclose = (ev) => {
        clearInterval(beat);
        if (closed) return;
        setOnline(false);
        if (ev.code === 4401 && ev.reason !== 'unauthorized') {
          onUnpaired();
          return;
        }
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(beat);
      wsRef.current?.close();
    };
  }, [deviceId, identity, onUnpaired]);

  const send = useCallback((msg: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return Promise.resolve({ ok: false, code: 'error.network' });
    const requestId = crypto.randomUUID();
    ws.send(JSON.stringify({ ...msg, requestId }));
    return new Promise((resolve) => {
      pending.current.set(requestId, resolve);
      setTimeout(() => {
        if (pending.current.delete(requestId)) resolve({ ok: false, code: 'error.network' });
      }, 8000);
    });
  }, []);

  return { state, online, message, clearMessage: () => setMessage(null), send, serverNow: () => Date.now() + offset.current };
}

function Live({ deviceId, identity, onUnpaired }: { deviceId: string; identity: Identity; onUnpaired: () => void }) {
  const link = useAgentLink(deviceId, identity, onUnpaired);
  const [mini, setMini] = useState(false);
  useTick();
  const s = link.state;

  // Follow the venue's language unless the customer picked one on this PC.
  const langChosen = useRef(false);
  useEffect(() => {
    if (s && !langChosen.current && !sessionStorage.getItem('kh.clientLang')) setLang(s.defaultLanguage);
  }, [s?.defaultLanguage]); // eslint-disable-line react-hooks/exhaustive-deps

  const mode: Mode = !s || s.locked ? 'lock' : mini ? 'mini' : 'widget';
  useEffect(() => toNative({ type: 'mode', mode }), [mode]);
  // A new customer starts with the full widget.
  useEffect(() => {
    if (s?.locked) setMini(false);
  }, [s?.locked]);

  return (
    <>
      {!s ? (
        <div className="cl-lock">
          <div className="cl-center">
            <div className="cl-venue">{t('app.name')}</div>
            <p className="cl-lead">{t('client.offline')}</p>
          </div>
        </div>
      ) : s.locked ? (
        <LockScreen state={s} send={link.send} />
      ) : mini ? (
        <MiniBar state={s} now={link.serverNow()} onExpand={() => setMini(false)} />
      ) : (
        <Widget state={s} now={link.serverNow()} send={link.send} onMinimize={() => setMini(true)} />
      )}
      {!link.online && s && <div className="cl-offline">{t('client.offline')}</div>}
      {link.message !== null && (
        <div className="cl-message" role="alertdialog" aria-label={t('client.message')}>
          <div>
            <small>{t('client.message')}</small>
            <p>{link.message}</p>
            <button className="btn btn-primary btn-big" onClick={link.clearMessage}>
              {t('client.ok')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function LangToggle() {
  const lang = useLang();
  return (
    <div className="cl-lang lang-switch" role="group" aria-label="Language">
      {(['sq', 'en'] as Lang[]).map((l) => (
        <button
          key={l}
          aria-pressed={lang === l}
          onClick={() => {
            sessionStorage.setItem('kh.clientLang', l);
            setLang(l);
          }}
        >
          {t(`lang.${l}`)}
        </button>
      ))}
    </div>
  );
}

/* ---- Lock screen -------------------------------------------------------------------------------- */

function LockScreen({ state: s, send }: { state: DeviceState; send: (m: Record<string, unknown>) => Promise<{ ok: boolean; code?: string }> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const g = s.guestRequest;
  const owed = s.tab?.balanceMinor ?? 0;

  let title = t('client.welcome');
  let lead: string | null = null;
  let canRequest = false;
  if (s.reason === 'unpaired') lead = t('client.unassigned');
  else if (s.reason === 'outOfOrder') {
    title = t('client.outOfOrder');
    lead = t('client.outOfOrderHint');
  } else if (s.reason === 'paused') {
    title = t('client.paused');
    lead = t('client.pausedHint');
  } else {
    canRequest = owed === 0;
    if (g?.status === 'pending') lead = t('client.requestSent');
    else if (g?.status === 'expired') lead = t('client.goToCounter');
    else if (g?.result?.decision === 'move') lead = t('client.moveTo', { name: g.result.toStationName ?? '' });
    else if (g?.result?.decision === 'deny') lead = t('client.denied');
  }

  return (
    <div className="cl-lock">
      <LangToggle />
      <div className="cl-center">
        <div className="cl-venue">{s.venueName}</div>
        <h1 className="cl-big">{title}</h1>
        {s.station && <div className="cl-host">{s.station.name}</div>}
        {owed > 0 && s.reason !== 'paused' && <p className="cl-owed">{t('client.toPay', { amount: money(owed, s.currency) })}</p>}
        {lead && <p className="cl-lead">{lead}</p>}
        {canRequest && g?.status !== 'pending' && (
          <button
            className="btn btn-primary cl-guest"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const r = await send({ type: 'request', kind: 'guest', payload: {} });
              setBusy(false);
              if (!r.ok) setError(t(r.code ?? 'error.internal'));
            }}
          >
            {t('client.guest')}
          </button>
        )}
        {canRequest && g?.status === 'pending' && <div className="cl-waiting">{t('client.waiting')}</div>}
        {canRequest && !g && <p className="cl-hint">{t('client.guestHint')}</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

/* ---- In-session widget --------------------------------------------------------------------------- */

function clockFor(s: DeviceState, now: number): { ms: number; down: boolean } {
  const sess = s.session!;
  if (sess.endsAt) return { ms: Math.max(0, sess.endsAt - now), down: true };
  const live = sess.status === 'active' ? Math.max(0, now - s.now) : 0;
  return { ms: sess.usedMs + live, down: false };
}

function MiniBar({ state: s, now, onExpand }: { state: DeviceState; now: number; onExpand: () => void }) {
  const c = clockFor(s, now);
  return (
    <button className="cl-mini" onClick={onExpand} aria-label={t('client.expand')}>
      <span>{s.station?.name}</span>
      <b>{duration(c.ms)}</b>
    </button>
  );
}

type Panel = 'home' | 'order' | 'help' | 'end';

function Widget({
  state: s,
  now,
  send,
  onMinimize,
}: {
  state: DeviceState;
  now: number;
  send: (m: Record<string, unknown>) => Promise<{ ok: boolean; code?: string }>;
  onMinimize: () => void;
}) {
  const [panel, setPanel] = useState<Panel>('home');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [note, setNote] = useState<string | null>(null);
  const c = clockFor(s, now);
  const sess = s.session!;
  const tabDue = s.tab?.balanceMinor ?? 0;
  const pendingCost = sess.mode === 'postpaid' && s.planKind === 'hourly' ? sess.pendingMinor : 0;

  const request = async (kind: string, payload: object, okText: string) => {
    const r = await send({ type: 'request', kind, payload });
    setNote(r.ok ? okText : t(r.code ?? 'error.internal'));
    if (r.ok) {
      setPanel('home');
      setCart({});
    }
  };

  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const cartTotal = s.products.reduce((sum, p) => sum + (cart[p.id] ?? 0) * p.priceMinor, 0);

  return (
    <div className="cl-widget">
      <header className="cl-w-head">
        <span>{s.station?.name}</span>
        <button className="btn btn-quiet" onClick={onMinimize} aria-label={t('client.minimize')}>
          —
        </button>
      </header>

      <div className="cl-w-clock">
        <small>{c.down ? t('client.timeLeft') : t('client.elapsed')}</small>
        <b>{duration(c.ms)}</b>
        {(tabDue > 0 || pendingCost > 0) && (
          <span>
            {t('client.soFar')}: {money(tabDue + pendingCost, s.currency)}
          </span>
        )}
      </div>

      {note && (
        <p className="cl-note" role="status">
          {note}
        </p>
      )}
      {s.openRequests.length > 0 && <p className="cl-note">{t('client.waiting')}</p>}

      {panel === 'home' && (
        <div className="cl-w-actions">
          <button className="btn" onClick={() => setPanel('order')}>
            {t('client.order')}
          </button>
          <button className="btn" onClick={() => setPanel('help')}>
            {t('client.help')}
          </button>
          {sess.mode === 'prepaid' && (
            <button className="btn" onClick={() => void request('extend', { minutes: 30 }, t('client.extendSent'))}>
              {t('client.moreTime')}
            </button>
          )}
          <button className="btn btn-danger" onClick={() => setPanel('end')}>
            {t('client.end')}
          </button>
          {s.tab && s.tab.lines.length > 0 && (
            <div className="cl-tab">
              <small>{t('client.yourTab')}</small>
              {s.tab.lines
                .filter((l) => !l.reversed)
                .map((l, i) => (
                  <div key={i} className="cl-tab-line">
                    <span>
                      {l.qty > 1 ? `${l.qty} × ` : ''}
                      {l.description}
                    </span>
                    <span>{money(l.amountMinor, s.currency)}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {panel === 'order' && (
        <div className="cl-w-panel">
          <div className="cl-products">
            {s.products.map((p) => (
              <button key={p.id} className="product" onClick={() => setCart((x) => ({ ...x, [p.id]: (x[p.id] ?? 0) + 1 }))}>
                <b>
                  {(cart[p.id] ?? 0) > 0 ? `${cart[p.id]} × ` : ''}
                  {p.name}
                </b>
                <span>{money(p.priceMinor, s.currency)}</span>
              </button>
            ))}
          </div>
          <div className="cl-w-row">
            <button className="btn btn-quiet" onClick={() => (cartCount ? setCart({}) : setPanel('home'))}>
              {cartCount ? t('checkout.clear') : t('common.back')}
            </button>
            <button
              className="btn btn-primary"
              disabled={!cartCount}
              onClick={() =>
                void request(
                  'order',
                  { items: Object.entries(cart).filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId, qty })) },
                  t('client.orderSent'),
                )
              }
            >
              {t('client.send')}
              {cartCount > 0 && ` · ${money(cartTotal, s.currency)}`}
            </button>
          </div>
        </div>
      )}

      {panel === 'help' && (
        <div className="cl-w-panel">
          {(
            [
              ['pc', 'client.helpPc'],
              ['headphones', 'client.helpHeadphones'],
              ['operator', 'client.helpOperator'],
            ] as const
          ).map(([topic, key]) => (
            <button key={topic} className="btn btn-block" onClick={() => void request('help', { topic }, t('client.helpSent'))}>
              {t(key)}
            </button>
          ))}
          <button className="btn btn-quiet" onClick={() => setPanel('home')}>
            {t('common.back')}
          </button>
        </div>
      )}

      {panel === 'end' && (
        <div className="cl-w-panel">
          <p>{t('client.endConfirm')}</p>
          <button
            className="btn btn-danger btn-block"
            onClick={async () => {
              const r = await send({ type: 'endSession' });
              if (!r.ok) setNote(t(r.code ?? 'error.internal'));
            }}
          >
            {t('client.endYes')}
          </button>
          <button className="btn btn-quiet" onClick={() => setPanel('home')}>
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
