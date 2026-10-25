import { useEffect, useState } from 'react';
import { api, setToken } from './api';
import { LangSwitch } from './Auth';
import { Floor, type Selection } from './Floor';
import { clock } from './format';
import { setLang, t, useLang } from './i18n';
import { Panel } from './Panel';
import { EndShift, ShiftReport, StartShift } from './Shift';
import { useFloor, useTick } from './store';
import type { ShiftSummary } from './types';
import { RunProvider, useRun } from './ui';

export function Desk({ onSignedOut }: { onSignedOut: () => void }) {
  const floor = useFloor(true);
  const base = floor.state?.currencies.find((c) => c.isBase) ?? null;

  useEffect(() => {
    if (floor.authLost) onSignedOut();
  }, [floor.authLost, onSignedOut]);

  // First load in this browser: follow the venue's default language.
  useEffect(() => {
    if (floor.state && !localStorage.getItem('kh.lang')) setLang(floor.state.settings.defaultLanguage);
  }, [floor.state]);

  if (!floor.state || !base) return <div className="auth">{floor.online ? t('common.loading') : t('error.network')}</div>;

  return (
    <RunProvider baseCurrency={base}>
      <DeskInner floor={floor} onSignedOut={onSignedOut} />
    </RunProvider>
  );
}

function DeskInner({ floor, onSignedOut }: { floor: ReturnType<typeof useFloor>; onSignedOut: () => void }) {
  useLang();
  useTick();
  const { run } = useRun();
  const state = floor.state!;
  const base = state.currencies.find((c) => c.isBase)!;
  const now = floor.serverNow();
  const [selection, setSelection] = useState<Selection>(null);
  const [ending, setEnding] = useState(false);
  // Kept here, above the shift check: once the shift closes the desk would otherwise
  // switch to "Start your shift" and the report would vanish before it's read or printed.
  const [report, setReport] = useState<ShiftSummary | null>(null);

  // Drop the selection if the station or tab disappears (closed elsewhere).
  useEffect(() => {
    if (selection?.kind === 'tab' && !state.counterTabs.some((x) => x.id === selection.id)) setSelection(null);
    if (selection?.kind === 'station' && !state.stations.some((x) => x.id === selection.id)) setSelection(null);
  }, [state, selection]);

  const signOut = async () => {
    await api.post('/api/logout', {}).catch(() => undefined);
    setToken(null);
    onSignedOut();
  };

  if (report) return <ShiftReport report={report} state={state} onDone={() => void signOut()} />;
  if (!state.shift) return <StartShift state={state} onStarted={() => void floor.refresh()} />;

  const station = selection?.kind === 'station' ? (state.stations.find((s) => s.id === selection.id) ?? null) : null;
  const tabId = selection?.kind === 'tab' ? selection.id : null;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="topbar-venue">{state.settings.venueName}</span>
        <span className="topbar-spacer" />
        <span className="topbar-shift">{t('shift.since', { time: clock(state.shift.openedAt) })}</span>
        <span className="topbar-user">{state.me.displayName}</span>
        <LangSwitch />
        <button className="btn" onClick={() => setEnding(true)}>
          {t('shift.end')}
        </button>
        <button className="btn btn-quiet" onClick={() => void signOut()}>
          {t('logout')}
        </button>
      </header>
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
        {!floor.online ? <div className="offline-banner">{t('common.offline')}</div> : <div />}
        <div className={`workspace${station || tabId ? ' with-panel' : ''}`}>
          <main className="floor">
            <Floor
              state={state}
              now={now}
              base={base}
              selection={selection}
              onSelect={setSelection}
              onNewCounterTab={async () => {
                const res = await run<{ tabId: string }>('tab.openCounter', {});
                if (res) setSelection({ kind: 'tab', id: res.tabId });
              }}
            />
          </main>
          {(station || tabId) && <Panel key={selection?.id} state={state} now={now} base={base} station={station} tabId={tabId} onClose={() => setSelection(null)} />}
        </div>
      </div>
      {ending && (
        <EndShift
          state={state}
          onClose={() => setEnding(false)}
          onEnded={(r) => {
            setEnding(false);
            setReport(r);
          }}
        />
      )}
    </div>
  );
}
