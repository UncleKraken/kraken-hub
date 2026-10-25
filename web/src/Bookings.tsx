import { useMemo, useState } from 'react';
import { clock, dateTime, money } from './format';
import { t } from './i18n';
import type { Booking, BookingSource, Currency, FloorState } from './types';
import { Dialog, MoneyInput, useRun } from './ui';

const SOURCES: BookingSource[] = ['phone', 'message', 'instagram', 'walk_in', 'other'];

/** Local datetime-local value (no timezone) <-> epoch ms, so the picker shows wall-clock time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}

function isToday(ms: number): boolean {
  const a = new Date(ms);
  const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The bookings page. Both roles see the list and can check customers in or mark no-shows;
 * only the manager can create, edit or cancel. Active bookings come from the floor state;
 * the manager additionally loads recent history.
 */
export function Bookings({ state, base, onClose }: { state: FloorState; base: Currency; onClose: () => void }) {
  const isManager = state.me.role === 'manager';
  const [editing, setEditing] = useState<Booking | 'new' | null>(null);
  const [checkIn, setCheckIn] = useState<Booking | null>(null);

  // Active bookings (booked + checked-in) from the floor; split today vs later.
  const active = state.bookings;
  const groups = useMemo(() => {
    const booked = active.filter((b) => b.status === 'booked' || b.status === 'checked_in');
    const today = booked.filter((b) => isToday(b.startsAt)).sort((a, b) => a.startsAt - b.startsAt);
    const upcoming = booked.filter((b) => !isToday(b.startsAt) && b.startsAt > Date.now()).sort((a, b) => a.startsAt - b.startsAt);
    return { today, upcoming };
  }, [active]);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('book.title')}>
        <button onClick={onClose}>← {t('settings.backToFloor')}</button>
      </nav>
      <main className="settings-main">
        <header className="settings-head">
          <div>
            <h1>{t('book.title')}</h1>
            <p>{t('book.count', { n: groups.today.length + groups.upcoming.length })}</p>
          </div>
          {isManager && (
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              {t('book.add')}
            </button>
          )}
        </header>
        <div className="settings-body">
          {groups.today.length === 0 && groups.upcoming.length === 0 && <p className="empty-note">{t('book.none')}</p>}
          {groups.today.length > 0 && (
            <section>
              <h2 className="list-group">{t('book.today')}</h2>
              <div className="list">
                {groups.today.map((b) => (
                  <BookingRow key={b.id} booking={b} base={base} isManager={isManager} onEdit={() => setEditing(b)} onCheckIn={() => setCheckIn(b)} />
                ))}
              </div>
            </section>
          )}
          {groups.upcoming.length > 0 && (
            <section>
              <h2 className="list-group">{t('book.upcoming')}</h2>
              <div className="list">
                {groups.upcoming.map((b) => (
                  <BookingRow key={b.id} booking={b} base={base} isManager={isManager} onEdit={() => setEditing(b)} onCheckIn={() => setCheckIn(b)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
      {editing && <BookingDialog booking={editing === 'new' ? null : editing} state={state} base={base} onClose={() => setEditing(null)} />}
      {checkIn && <CheckInDialog booking={checkIn} state={state} onClose={() => setCheckIn(null)} />}
    </div>
  );
}

function BookingRow({
  booking: b,
  base,
  isManager,
  onEdit,
  onCheckIn,
}: {
  booking: Booking;
  base: Currency;
  isManager: boolean;
  onEdit: () => void;
  onCheckIn: () => void;
}) {
  const { run } = useRun();
  const stationNames = b.stations.map((s) => s.name).join(', ');
  return (
    <div className="list-row booking-row">
      <div className="list-main">
        <b>
          {b.customerName}
          {b.status === 'checked_in' && <span className="badge">{t('book.checkedIn')}</span>}
          {b.overdue && b.status === 'booked' && <span className="badge badge-warn">{t('book.overdue')}</span>}
        </b>
        <small>
          {clock(b.startsAt)} · {b.durationMinutes >= 60 ? `${Math.round((b.durationMinutes / 60) * 10) / 10}${t('book.hours')}` : `${b.durationMinutes} ${t('book.minutes')}`} · {stationNames}
          {b.phone ? ` · ${b.phone}` : ''}
          {b.depositMinor > 0 ? ` · ${t('book.deposits', { amount: money(b.depositMinor, base) })}` : ''}
          {b.notes ? ` · ${b.notes}` : ''}
        </small>
      </div>
      <div className="req-actions">
        {b.status === 'booked' && (
          <>
            <button className="btn btn-primary" onClick={onCheckIn}>
              {t('book.checkIn')}
            </button>
            <button className="btn btn-quiet" onClick={() => void run('booking.noShow', { id: b.id })}>
              {t('book.noShow')}
            </button>
            {isManager && (
              <>
                <button className="btn btn-quiet" onClick={onEdit}>
                  {t('settings.edit')}
                </button>
                <button className="btn btn-quiet" onClick={() => void run('booking.cancel', { id: b.id })}>
                  {t('book.cancel')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BookingDialog({ booking, state, base, onClose }: { booking: Booking | null; state: FloorState; base: Currency; onClose: () => void }) {
  const { run, toast } = useRun();
  const [name, setName] = useState(booking?.customerName ?? '');
  const [phone, setPhone] = useState(booking?.phone ?? '');
  const [when, setWhen] = useState(toLocalInput(booking?.startsAt ?? Date.now() + 30 * 60_000));
  const [duration, setDuration] = useState(booking?.durationMinutes ?? 60);
  const [stationIds, setStationIds] = useState<string[]>(booking?.stations.map((s) => s.id) ?? []);
  const [notes, setNotes] = useState(booking?.notes ?? '');
  const [source, setSource] = useState<BookingSource>(booking?.source ?? 'phone');
  const [deposit, setDeposit] = useState(booking?.depositMinor ?? 0);
  const [error, setError] = useState('');

  const toggle = (id: string) => setStationIds((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const submit = async () => {
    if (stationIds.length === 0) {
      setError(t('book.pickStations'));
      return;
    }
    const payload = {
      ...(booking ? { id: booking.id } : {}),
      customerName: name,
      phone,
      startsAt: fromLocalInput(when),
      durationMinutes: duration,
      stationIds,
      notes,
      source,
      depositMinor: deposit,
    };
    const res = await run(booking ? 'booking.update' : 'booking.create', payload);
    if (res) {
      toast(t('settings.saved'), 'success');
      onClose();
    }
  };

  // Stations that take sessions (not needed to be free now — the booking may be for later).
  const bookable = state.stations;

  return (
    <Dialog title={booking ? t('book.edit') : t('book.add')} onClose={onClose} wide>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row">
          <label className="field">
            <span>{t('book.name')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
          </label>
          <label className="field">
            <span>{t('book.phone')}</span>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>{t('book.when')}</span>
            <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
          </label>
          <label className="field">
            <span>{t('book.duration')}</span>
            <select className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[30, 60, 90, 120, 180, 240, 300, 360].map((m) => (
                <option key={m} value={m}>
                  {m >= 60 ? `${m / 60} ${t('book.hours')}` : `${m} ${t('book.minutes')}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span>{t('book.stations')}</span>
          <div className="station-pick">
            {bookable.map((s) => (
              <button key={s.id} type="button" className="pick" aria-pressed={stationIds.includes(s.id)} onClick={() => toggle(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <label className="field">
            <span>{t('book.source')}</span>
            <select className="input" value={source} onChange={(e) => setSource(e.target.value as BookingSource)}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`book.source.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('book.deposit')}</span>
            <MoneyInput currency={base} label={t('book.deposit')} value={deposit} onChange={setDeposit} />
          </label>
        </div>
        <label className="field">
          <span>{t('book.notes')}</span>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} style={{ paddingTop: 10 }} />
        </label>
        {error && <div className="form-error">{error}</div>}
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

function CheckInDialog({ booking, state, onClose }: { booking: Booking; state: FloorState; onClose: () => void }) {
  const { run, toast } = useRun();
  const [mode, setMode] = useState<'postpaid' | 'prepaid'>('postpaid');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    const res = await run<{ started: unknown[]; busy: string[] }>('booking.checkIn', { id: booking.id, mode });
    setBusy(false);
    if (res) {
      if (res.busy.length > 0) toast(t('book.busyWarning', { names: res.busy.join(', ') }), 'error');
      else toast(t('book.checkedIn'), 'success');
      onClose();
    }
  };

  return (
    <Dialog title={t('book.checkInTitle', { name: booking.customerName })} onClose={onClose}>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        {booking.stations.map((s) => s.name).join(', ')} · {t('book.checkInMode')}
      </p>
      <div className="seg" role="group">
        <button type="button" aria-pressed={mode === 'postpaid'} onClick={() => setMode('postpaid')}>
          {t('station.openTime')}
        </button>
        <button type="button" aria-pressed={mode === 'prepaid'} onClick={() => setMode('prepaid')}>
          {booking.durationMinutes >= 60 ? `${booking.durationMinutes / 60} ${t('book.hours')}` : `${booking.durationMinutes} ${t('book.minutes')}`} {t('station.prepaid').toLowerCase()}
        </button>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary btn-big" disabled={busy} onClick={() => void go()}>
          {t('book.checkIn')}
        </button>
      </div>
    </Dialog>
  );
}
