import { useEffect, useState } from 'react';
import { api } from './api';
import { clock, money } from './format';
import { t } from './i18n';
import type { Currency, FloorState, ShiftSummary } from './types';
import { Dialog, MoneyInput, useRun } from './ui';

export function StartShift({ state, onStarted, onSettings, onSignOut }: { state: FloorState; onStarted: () => void; onSettings?: () => void; onSignOut: () => void }) {
  const { run } = useRun();
  const [float, setFloat] = useState<Record<string, number>>(state.suggestedFloat);
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-mark">
          {state.settings.venueName}
          <small>{state.me.displayName}</small>
        </div>
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const res = await run('shift.open', { openingFloat: float });
            setBusy(false);
            if (res) onStarted();
          }}
        >
          <h2>{t('shift.startTitle')}</h2>
          <p style={{ margin: 0, color: 'var(--ink-2)' }}>{t('shift.startIntro')}</p>
          {state.currencies.map((c) => (
            <label className="field" key={c.code}>
              <span>{c.code}</span>
              <MoneyInput currency={c} label={c.code} value={float[c.code] ?? 0} onChange={(v) => setFloat((f) => ({ ...f, [c.code]: v }))} />
            </label>
          ))}
          <button className="btn btn-primary btn-big" disabled={busy}>
            {t('shift.start')}
          </button>
        </form>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {onSettings ? (
            <button type="button" className="btn" style={{ flex: 'none' }} onClick={onSettings}>
              {t('settings.open')}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn btn-quiet" style={{ flex: 'none' }} onClick={onSignOut}>
            {t('logout')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EndShift({ state, onClose, onEnded }: { state: FloorState; onClose: () => void; onEnded: (report: ShiftSummary) => void }) {
  const { run } = useRun();
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [floatLeft, setFloatLeft] = useState<Record<string, number>>({});
  const [tipsMarked, setTipsMarked] = useState(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const base = state.currencies.find((c) => c.isBase)!;

  useEffect(() => {
    api
      .get<{ shift: ShiftSummary | null }>('/api/shift/current')
      .then((r) => {
        setSummary(r.shift);
        if (r.shift) setFloatLeft(r.shift.openingFloat);
      })
      .catch(() => undefined);
  }, []);

  if (!summary) return null;

  const countedBase = counted[base.code] ?? 0;
  const surplus = summary.blind || countedBase === 0 ? null : countedBase - (summary.expectedCash[base.code] ?? 0);

  return (
    <Dialog title={t('shift.endTitle')} onClose={onClose} wide>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>{summary.blind ? t('shift.blind') : t('shift.countIntro')}</p>
      <div className="count-grid">
        <span className="head" />
        <span className="head">{t('shift.counted')}</span>
        <span className="head">{t('shift.floatLeft')}</span>
        {state.currencies.map((c) => (
          <Row key={c.code}>
            <span>
              <b>{c.code}</b>
              {!summary.blind && (
                <div className="expected" style={{ textAlign: 'left', fontSize: 13 }}>
                  {t('shift.expected')} {money(summary.expectedCash[c.code] ?? 0, c)}
                </div>
              )}
            </span>
            <MoneyInput currency={c} label={`${t('shift.counted')} ${c.code}`} value={counted[c.code] ?? 0} onChange={(v) => setCounted((x) => ({ ...x, [c.code]: v }))} />
            <MoneyInput currency={c} label={`${t('shift.floatLeft')} ${c.code}`} value={floatLeft[c.code] ?? 0} onChange={(v) => setFloatLeft((x) => ({ ...x, [c.code]: v }))} />
          </Row>
        ))}
      </div>

      <dl className="kv">
        <dt>{t('shift.tips')}</dt>
        <dd>{money(summary.tips.checkoutCashMinor + summary.tips.cardMinor, base)}</dd>
        {surplus !== null && surplus !== 0 && (
          <>
            <dt>{t('shift.overShort')}</dt>
            <dd style={{ color: surplus < 0 ? 'var(--ending)' : 'var(--free)' }}>{money(surplus, base)}</dd>
          </>
        )}
      </dl>

      <label className="field">
        <span>{t('shift.markTips')}</span>
        <MoneyInput currency={base} label={t('shift.markTips')} value={tipsMarked} onChange={setTipsMarked} />
      </label>

      {summary.openTabs.length > 0 && (
        <div>
          <h3 className="section-title">{t('shift.openTabs')}</h3>
          <dl className="kv">
            {summary.openTabs.map((tab) => {
              const name = state.stations.find((s) => s.id === tab.stationId)?.name ?? (tab.label || t('tab.title'));
              return (
                <Row key={tab.id}>
                  <dt>{name}</dt>
                  <dd>{money(tab.balanceMinor, base)}</dd>
                </Row>
              );
            })}
          </dl>
        </div>
      )}

      <label className="field">
        <span>{t('shift.notes')}</span>
        <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} style={{ paddingTop: 10 }} />
      </label>

      <div className="dialog-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-primary btn-big"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await run<ShiftSummary>('shift.close', { counted, floatLeft, tipsMarkedMinor: tipsMarked, notes });
            setBusy(false);
            if (res) onEnded(res);
          }}
        >
          {t('shift.submit')}
        </button>
      </div>
    </Dialog>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** The figures of a shift report; shared by the end-of-shift report and shift history. */
export function ShiftKV({ report, currencies }: { report: ShiftSummary; currencies: Currency[] }) {
  const base = currencies.find((c) => c.isBase)!;
  const cur = (code: string): Currency => currencies.find((c) => c.code === code) ?? { ...base, code, symbol: code };
  return (
    <dl className="kv">
      <dt>{t('shift.sales')}</dt>
      <dd>{money(report.salesMinor, base)}</dd>
      <dt>{t('shift.refunds')}</dt>
      <dd>{money(report.refundsMinor, base)}</dd>
      <dt>{t('shift.cash')}</dt>
      <dd>{money(report.collectedCashMinor, base)}</dd>
      <dt>{t('shift.card')}</dt>
      <dd>{money(report.collectedCardMinor, base)}</dd>
      <dt>{t('shift.tips')}</dt>
      <dd>{money(report.tips.totalMinor, base)}</dd>
      {report.closing &&
        Object.entries(report.closing.overShort).map(([code, v]) => (
          <Row key={`os-${code}`}>
            <dt>
              {t('shift.overShort')} · {code}
            </dt>
            <dd style={{ color: v < 0 ? 'var(--ending)' : undefined }}>{money(v, cur(code))}</dd>
          </Row>
        ))}
      {report.closing &&
        Object.entries(report.closing.dropped).map(([code, v]) => (
          <Row key={`dr-${code}`}>
            <dt>
              {t('shift.dropped')} · {code}
            </dt>
            <dd>{money(v, cur(code))}</dd>
          </Row>
        ))}
      {report.closing &&
        Object.entries(report.closing.floatLeft).map(([code, v]) => (
          <Row key={`fl-${code}`}>
            <dt>
              {t('shift.floatLeft')} · {code}
            </dt>
            <dd>{money(v, cur(code))}</dd>
          </Row>
        ))}
    </dl>
  );
}

export function ShiftReport({ report, state, onDone }: { report: ShiftSummary; state: FloorState; onDone: () => void }) {
  useEffect(() => {
    // Print automatically so the report can go in the drawer with the cash.
    const id = setTimeout(() => window.print(), 300);
    return () => clearTimeout(id);
  }, []);
  return (
    <Dialog title={`${t('shift.report')} · ${state.me.displayName}`} onClose={onDone}>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        {state.settings.venueName} · {clock(report.openedAt)}–{report.closedAt ? clock(report.closedAt) : ''}
      </p>
      <ShiftKV report={report} currencies={state.currencies} />
      <div className="dialog-actions no-print">
        <button className="btn" onClick={() => window.print()}>
          {t('shift.print')}
        </button>
        <button className="btn btn-primary" onClick={onDone}>
          {t('shift.done')}
        </button>
      </div>
    </Dialog>
  );
}
