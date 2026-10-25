import { useState } from 'react';
import { LangSwitch } from './Auth';
import { money } from './format';
import { t } from './i18n';
import type { Currency } from './types';
import { MoneyInput, useRun } from './ui';

/** A labelled −/number/+ stepper. Module-scope so it isn't remounted on every parent render. */
function Counter({ label, value, set, max = 64 }: { label: string; value: number; set: (n: number) => void; max?: number }) {
  return (
    <div className="count-field">
      <span>{label}</span>
      <div className="count-stepper">
        <button type="button" className="btn" onClick={() => set(Math.max(0, value - 1))} aria-label={`${label} −`}>
          −
        </button>
        <input
          className="input"
          inputMode="numeric"
          value={value}
          onChange={(e) => set(Math.max(0, Math.min(max, Number(e.target.value.replace(/\D/g, '')) || 0)))}
          aria-label={label}
        />
        <button type="button" className="btn" onClick={() => set(Math.min(max, value + 1))} aria-label={`${label} +`}>
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Guided first-run setup, shown to a manager whose venue has no stations yet. Collects the few
 * things that block running the floor — an hourly rate, how many stations, and (optionally) the
 * first operator — and creates them all at once via admin.quickSetup. Skippable: the manager can
 * set everything up by hand in Settings instead.
 */
export function Onboarding({ base, onDone, onSkip }: { base: Currency; onDone: () => void; onSkip: () => void }) {
  const { run, toast } = useRun();
  const [rate, setRate] = useState(0);
  const [pcCount, setPcCount] = useState(8);
  const [consoleCount, setConsoleCount] = useState(0);
  const [tableCount, setTableCount] = useState(0);
  const [addOperator, setAddOperator] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const total = pcCount + consoleCount + tableCount;
  const operatorReady = !addOperator || (displayName.trim() && /^[a-zA-Z0-9._-]{2,32}$/.test(username) && password.length >= 6);
  const canCreate = total > 0 && rate >= 0 && operatorReady && !busy;

  const create = async () => {
    setBusy(true);
    const res = await run('admin.quickSetup', {
      hourlyRateMinor: rate,
      pcCount,
      consoleCount,
      tableCount,
      ...(addOperator ? { operator: { username: username.trim(), displayName: displayName.trim(), password } } : {}),
    });
    setBusy(false);
    if (res) {
      toast(t('onboard.created', { n: total }), 'success');
      onDone();
    }
  };

  return (
    <div className="auth">
      <div className="auth-card onboard">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="auth-mark">
            {t('onboard.title')}
            <small>{t('onboard.intro')}</small>
          </div>
          <div style={{ flex: 'none' }}>
            <LangSwitch />
          </div>
        </div>

        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) void create();
          }}
        >
          <section>
            <h3>{t('onboard.pricing')}</h3>
            <label className="field">
              <span>{t('onboard.hourlyRate')}</span>
              <MoneyInput currency={base} label={t('onboard.hourlyRate')} value={rate} onChange={setRate} />
              <small className="hint">{t('onboard.hourlyRateHint')}</small>
            </label>
          </section>

          <section>
            <h3>{t('onboard.stations')}</h3>
            <div className="count-grid">
              <Counter label={t('onboard.pcs')} value={pcCount} set={setPcCount} />
              <Counter label={t('onboard.consoles')} value={consoleCount} set={setConsoleCount} max={32} />
              <Counter label={t('onboard.tables')} value={tableCount} set={setTableCount} max={32} />
            </div>
            <small className="hint">{total > 0 ? t('onboard.stationsSummary', { n: total }) : t('onboard.stationsNone')}</small>
          </section>

          <section>
            <label className="check">
              <input type="checkbox" checked={addOperator} onChange={(e) => setAddOperator(e.target.checked)} />
              {t('onboard.addOperator')}
            </label>
            <small className="hint">{t('onboard.operatorHint')}</small>
            {addOperator && (
              <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                <label className="field">
                  <span>{t('setup.displayName')}</span>
                  <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} />
                </label>
                <div className="row">
                  <label className="field">
                    <span>{t('setup.username')}</span>
                    <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" pattern="[a-zA-Z0-9._\-]{2,32}" />
                  </label>
                  <label className="field">
                    <span>{t('setup.password')}</span>
                    <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  </label>
                </div>
              </div>
            )}
          </section>

          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={onSkip}>
              {t('onboard.later')}
            </button>
            <button className="btn btn-primary btn-big" disabled={!canCreate}>
              {t('onboard.create')}
              {total > 0 ? ` · ${t('onboard.createCount', { n: total })}` : ''}
            </button>
          </div>
          {rate > 0 && <small className="hint">{t('onboard.rateEcho', { amount: money(rate, base) })}</small>}
        </form>
      </div>
    </div>
  );
}
