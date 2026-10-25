import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { dateTime, money } from './format';
import { t } from './i18n';
import type { Actor, Currency, Member, MemberDetail } from './types';
import { Dialog, useRun } from './ui';

/** The member directory. Operators create and look up members; managers also edit and adjust points. */
export function Members({ me, base, version, onClose }: { me: Actor; base: Currency; version: number; onClose: () => void }) {
  const isManager = me.role === 'manager';
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Member | 'new' | null>(null);

  const search = useCallback(() => api.get<Member[]>(`/api/members?q=${encodeURIComponent(query)}`).then(setList).catch(() => undefined), [query]);
  useEffect(() => {
    const id = setTimeout(() => void search(), 150);
    return () => clearTimeout(id);
  }, [search, version]);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('mem.title')}>
        <button onClick={onClose}>← {t('settings.backToFloor')}</button>
      </nav>
      <main className="settings-main">
        <header className="settings-head">
          <div>
            <h1>{t('mem.title')}</h1>
            <p>{t('mem.intro')}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            {t('mem.add')}
          </button>
        </header>
        <div className="settings-body">
          <input className="input" placeholder={t('mem.search')} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          {list.length === 0 ? (
            <p className="empty-note">{query ? t('mem.noMatch') : t('mem.none')}</p>
          ) : (
            <div className="list">
              {list.map((m) => (
                <div key={m.id} className="list-row">
                  <div className="list-main">
                    <b>{m.name}</b>
                    <small>
                      {[m.code, m.phone].filter(Boolean).join(' · ')}
                    </small>
                  </div>
                  <span className="list-meta">{t('mem.points', { n: m.points })}</span>
                  <button className="btn btn-quiet" onClick={() => setSelected(m.id)}>
                    {t('mem.history')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      {editing && (
        <MemberDialog member={editing === 'new' ? null : editing} isManager={isManager} onClose={() => setEditing(null)} onDone={search} />
      )}
      {selected && (
        <MemberDetailDialog id={selected} base={base} isManager={isManager} onClose={() => setSelected(null)} onEdit={(m) => { setSelected(null); setEditing(m); }} onChanged={search} />
      )}
    </div>
  );
}

function MemberDialog({ member, isManager, onClose, onDone }: { member: Member | null; isManager: boolean; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { run, toast } = useRun();
  const [name, setName] = useState(member?.name ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [code, setCode] = useState(member?.code ?? '');
  const [notes, setNotes] = useState(member?.notes ?? '');
  const [active, setActive] = useState(member?.active ?? true);
  // Existing members are edited by managers only; operators can still create new ones.
  const readonly = !!member && !isManager;

  const submit = async () => {
    const payload = { ...(member ? { id: member.id } : {}), name, phone, code: code.trim() || undefined, notes, ...(member ? { active } : {}) };
    const res = await run(member ? 'member.update' : 'member.create', payload);
    if (res) {
      toast(t('settings.saved'), 'success');
      await onDone();
      onClose();
    }
  };

  return (
    <Dialog title={member ? t('mem.edit') : t('mem.add')} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t('mem.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} disabled={readonly} autoFocus />
        </label>
        <div className="row">
          <label className="field">
            <span>{t('mem.phone')}</span>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" disabled={readonly} />
          </label>
          <label className="field">
            <span>{t('mem.code')}</span>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} disabled={readonly} />
          </label>
        </div>
        <small className="hint">{t('mem.codeHint')}</small>
        <label className="field">
          <span>{t('mem.notes')}</span>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} style={{ paddingTop: 10 }} disabled={readonly} />
        </label>
        {member && isManager && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('mem.active')}
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {!readonly && <button className="btn btn-primary">{t('common.save')}</button>}
        </div>
      </form>
    </Dialog>
  );
}

function MemberDetailDialog({
  id,
  base,
  isManager,
  onClose,
  onEdit,
  onChanged,
}: {
  id: string;
  base: Currency;
  isManager: boolean;
  onClose: () => void;
  onEdit: (m: Member) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { run, toast } = useRun();
  const [m, setM] = useState<MemberDetail | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const load = useCallback(() => api.get<MemberDetail>(`/api/members/${id}`).then(setM).catch(() => undefined), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!m) return null;

  return (
    <Dialog title={m.name} onClose={onClose} wide>
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="pay-due" style={{ flex: 1 }}>
          <small>{t('mem.pointsLabel')}</small>
          <b>{m.points}</b>
        </div>
        <div className="req-actions" style={{ flex: 'none' }}>
          <button className="btn btn-quiet" onClick={() => onEdit(m)}>
            {t('settings.edit')}
          </button>
          {isManager && (
            <button className="btn btn-quiet" onClick={() => setAdjusting(true)}>
              {t('mem.adjust')}
            </button>
          )}
        </div>
      </div>
      {(m.code || m.phone || m.notes) && (
        <p className="hint" style={{ margin: 0 }}>
          {[m.code, m.phone, m.notes].filter(Boolean).join(' · ')}
        </p>
      )}

      <section>
        <h3 className="section-title">{t('mem.history')}</h3>
        {m.movements.length === 0 ? (
          <p className="empty-note">{t('mem.noneYet')}</p>
        ) : (
          <div className="list">
            {m.movements.map((mv, i) => (
              <div key={i} className="activity-row">
                <time>{dateTime(mv.createdAt)}</time>
                <div>
                  <b style={{ color: mv.delta < 0 ? 'var(--ending)' : 'var(--free)' }}>
                    {mv.delta > 0 ? '+' : ''}
                    {mv.delta}
                  </b>{' '}
                  {t(`mem.${mv.reason === 'earn' ? 'earn' : mv.reason === 'redeem' ? 'redeem' : 'adjust'}`)}
                  {mv.note ? ` · ${mv.note}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {m.visits.length > 0 && (
        <section>
          <h3 className="section-title">{t('mem.visits')}</h3>
          <div className="list">
            {m.visits.map((v) => (
              <div key={v.id} className="activity-row">
                <time>{dateTime(v.openedAt)}</time>
                <div>
                  {v.stationName ?? t('tab.title')} · {money(v.chargedMinor, base)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {adjusting && (
        <AdjustPointsDialog
          member={m}
          onClose={() => setAdjusting(false)}
          onDone={async () => {
            await load();
            await onChanged();
          }}
        />
      )}
      <div className="dialog-actions no-print">
        <button className="btn btn-primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  );
}

function AdjustPointsDialog({ member, onClose, onDone }: { member: MemberDetail; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { run, toast } = useRun();
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  return (
    <Dialog title={t('mem.adjustTitle', { name: member.name })} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          const n = Number(delta);
          if (!Number.isInteger(n) || n === 0) return;
          const res = await run('member.adjustPoints', { id: member.id, delta: n, note });
          if (res) {
            toast(t('settings.saved'), 'success');
            await onDone();
            onClose();
          }
        }}
      >
        <label className="field">
          <span>{t('mem.delta')}</span>
          <input className="input input-money" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^0-9-]/g, ''))} autoFocus />
        </label>
        <label className="field">
          <span>{t('mem.adjustReason')}</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
        </label>
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

/** A compact picker used from the tab panel to attach a member. */
export function MemberPicker({ onPick, onClose }: { onPick: (m: Member) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Member[]>([]);
  const { run, toast } = useRun();
  const [creating, setCreating] = useState(false);
  const search = useCallback(() => api.get<Member[]>(`/api/members?q=${encodeURIComponent(query)}`).then(setList).catch(() => undefined), [query]);
  useEffect(() => {
    const id = setTimeout(() => void search(), 150);
    return () => clearTimeout(id);
  }, [search]);

  return (
    <Dialog title={t('mem.attachTitle')} onClose={onClose}>
      <input className="input" placeholder={t('mem.search')} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <div className="list" style={{ maxHeight: '40vh', overflow: 'auto' }}>
        {list.map((m) => (
          <button key={m.id} className="list-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--line-soft)' }} onClick={() => onPick(m)}>
            <div className="list-main">
              <b>{m.name}</b>
              <small>{[m.code, m.phone].filter(Boolean).join(' · ')}</small>
            </div>
            <span className="list-meta">{t('mem.points', { n: m.points })}</span>
          </button>
        ))}
      </div>
      {query.trim() && (
        <button
          className="btn"
          onClick={async () => {
            if (creating) return;
            setCreating(true);
            const res = await run<{ id: string }>('member.create', { name: query.trim() });
            setCreating(false);
            if (res) {
              toast(t('settings.saved'), 'success');
              onPick({ id: res.id, name: query.trim(), phone: '', code: null, points: 0, notes: '', active: true });
            }
          }}
        >
          {t('mem.add')}: “{query.trim()}”
        </button>
      )}
    </Dialog>
  );
}
