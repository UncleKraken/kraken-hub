import { useState } from 'react';
import { FloorPlanView } from './FloorPlan';
import { clock, duration, money } from './format';
import { t } from './i18n';
import { Inbox } from './Requests';
import { KindIcon, pendingEstimate, sessionClock, stationState } from './stations';
import type { Currency, FloorState, StationView } from './types';

export type Selection = { kind: 'station'; id: string } | { kind: 'tab'; id: string } | null;

type FloorView = 'grid' | 'plan';
function initialView(): FloorView {
  try {
    return localStorage.getItem('kh.floorView') === 'plan' ? 'plan' : 'grid';
  } catch {
    return 'grid';
  }
}

export function Floor({
  state,
  now,
  base,
  selection,
  onSelect,
  onNewCounterTab,
}: {
  state: FloorState;
  now: number;
  base: Currency;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onNewCounterTab: () => void;
}) {
  const [view, setView] = useState<FloorView>(initialView);
  const choose = (v: FloorView) => {
    setView(v);
    try {
      localStorage.setItem('kh.floorView', v);
    } catch {
      /* private mode — not worth failing over */
    }
  };

  const zones = new Map<string, StationView[]>();
  for (const s of state.stations) {
    const z = s.zone || '';
    zones.set(z, [...(zones.get(z) ?? []), s]);
  }
  const hasPlan = state.stations.some((s) => s.layout) || state.floorPlan.areas.length > 0;

  if (state.stations.length === 0)
    return (
      <>
        <Inbox state={state} now={now} base={base} />
        <p className="empty-note">{t('floor.empty')}</p>
      </>
    );

  return (
    <>
      <Inbox state={state} now={now} base={base} />
      {hasPlan && (
        <div className="floor-views" role="tablist" aria-label={t('floor.view')}>
          <button role="tab" aria-selected={view === 'grid'} onClick={() => choose('grid')}>
            {t('floor.viewGrid')}
          </button>
          <button role="tab" aria-selected={view === 'plan'} onClick={() => choose('plan')}>
            {t('floor.viewPlan')}
          </button>
        </div>
      )}
      {view === 'plan' && hasPlan ? (
        <FloorPlanView state={state} now={now} base={base} selection={selection} onSelect={onSelect} />
      ) : (
        [...zones.entries()].map(([zone, stations]) => (
        <section className="zone" key={zone} aria-label={zone || undefined}>
          {zone && <h2 className="zone-title">{zone}</h2>}
          <div className="tiles">
            {stations.map((s) => (
              <Tile
                key={s.id}
                station={s}
                now={now}
                fetchedAt={state.now}
                base={base}
                selected={selection?.kind === 'station' && selection.id === s.id}
                onClick={() => onSelect(selection?.kind === 'station' && selection.id === s.id ? null : { kind: 'station', id: s.id })}
              />
            ))}
          </div>
        </section>
        ))
      )}

      <section className="zone">
        <h2 className="zone-title">{t('floor.counter')}</h2>
        <div className="counter-tabs">
          {state.counterTabs.map((tab, i) => (
            <button
              key={tab.id}
              className="chip-tab"
              aria-pressed={selection?.kind === 'tab' && selection.id === tab.id}
              onClick={() => onSelect({ kind: 'tab', id: tab.id })}
            >
              <span>{tab.label || `${t('tab.title')} ${i + 1}`}</span>
              <b>{money(tab.balanceMinor, base)}</b>
            </button>
          ))}
          <button className="btn btn-quiet" onClick={onNewCounterTab}>
            + {t('floor.newCounterTab')}
          </button>
        </div>
      </section>
    </>
  );
}

function Tile({ station, now, fetchedAt, base, selected, onClick }: { station: StationView; now: number; fetchedAt: number; base: Currency; selected: boolean; onClick: () => void }) {
  const state = stationState(station, now);
  const clockInfo = sessionClock(station, now, fetchedAt);
  const owed = (station.tab?.balanceMinor ?? 0) + pendingEstimate(station, now, fetchedAt);
  const sess = station.session;
  const progress =
    sess?.endsAt && sess.prepaidMinutes ? Math.min(100, Math.max(0, ((sess.endsAt - now) / (sess.prepaidMinutes * 60_000)) * 100)) : null;

  return (
    <button className="tile" data-state={state} aria-pressed={selected} onClick={onClick}>
      <div className="tile-head">
        <span className="tile-name">{station.name}</span>
        <span className="tile-head-right">
          {station.groupId && <span className="tile-group" title={t('group.pill')}>{t('group.pill')}</span>}
          {station.device && station.device.alerts.length > 0 && (
            <span
              className="tile-alert"
              title={station.device.alerts.map((a) => t(`health.${a}`)).join(', ')}
              aria-label={t('health.alert')}
            >
              ⚠
            </span>
          )}
          {station.device && (
            <span
              className={`dot${station.device.online ? '' : ' off'}`}
              title={station.device.online ? t('dev.online') : t('dev.offline')}
              aria-label={station.device.online ? t('dev.online') : t('dev.offline')}
            />
          )}
          <KindIcon kind={station.kind} className="tile-kind" />
        </span>
      </div>
      <div className="tile-time">
        {clockInfo ? (
          <>
            {duration(clockInfo.ms)}
            {sess && sess.players > 1 && <small>{sess.players}P</small>}
          </>
        ) : state === 'reserved' && station.reserved ? (
          <span className="tile-reserved">{clock(station.reserved.startsAt)}</span>
        ) : (
          <span aria-hidden="true">&nbsp;</span>
        )}
      </div>
      <div className="tile-foot">
        <span className="tile-state">
          {state === 'reserved' && station.reserved ? station.reserved.customerName : t(`state.${state}`)}
        </span>
        {owed > 0 && <span className="tile-amount">{money(owed, base)}</span>}
      </div>
      {progress !== null && <span className="tile-progress" style={{ width: `${progress}%` }} />}
    </button>
  );
}
