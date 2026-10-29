import { useEffect, useRef, useState } from 'react';
import type { Selection } from './Floor';
import { duration, money } from './format';
import { t } from './i18n';
import { shapeSize } from './shapes';
import { KindIcon, pendingEstimate, sessionClock, stationState } from './stations';
import type { Currency, FloorState, StationView } from './types';

/** Tracks how much the design-unit canvas must be scaled to fit its container width. */
export function useScale(ref: React.RefObject<HTMLElement | null>, canvasW: number): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1.4, (el.clientWidth || canvasW) / canvasW));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, canvasW]);
  return scale;
}

/**
 * The spatial floor map: décor areas drawn behind, each station drawn as its shape at its real
 * place, coloured live by state. Stations that haven't been placed yet sit in a tray beneath, so
 * nothing is ever unreachable. Clicking a station selects it, exactly like the grid tiles.
 */
export function FloorPlanView({
  state,
  now,
  base,
  selection,
  onSelect,
}: {
  state: FloorState;
  now: number;
  base: Currency;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasW = state.floorPlan.w;
  const canvasH = state.floorPlan.h;
  const scale = useScale(wrapRef, canvasW);

  const placed = state.stations.filter((s) => s.layout);
  const unplaced = state.stations.filter((s) => !s.layout);

  return (
    <section className="zone" aria-label={t('plan.title')}>
      {placed.length === 0 && state.floorPlan.areas.length === 0 ? (
        <p className="empty-note">{t('plan.empty')}</p>
      ) : (
        <div className="plan-wrap" ref={wrapRef} style={{ height: canvasH * scale }}>
          <div className="plan-canvas" style={{ width: canvasW, height: canvasH, transform: `scale(${scale})` }}>
            {state.floorPlan.areas.map((a) => (
              <div
                key={a.id}
                className={`plan-area area-${a.color ?? 'slate'}`}
                style={{ left: a.x, top: a.y, width: a.w, height: a.h }}
              >
                {a.label && <span className="plan-area-label">{a.label}</span>}
              </div>
            ))}
            {placed.map((s) => (
              <PlanNode
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
        </div>
      )}

      {unplaced.length > 0 && (
        <div className="plan-tray">
          <span className="plan-tray-label">{t('plan.unplaced')}</span>
          {unplaced.map((s) => {
            const st = stationState(s, now);
            return (
              <button
                key={s.id}
                className="plan-chip"
                data-state={st}
                aria-pressed={selection?.kind === 'station' && selection.id === s.id}
                onClick={() => onSelect(selection?.kind === 'station' && selection.id === s.id ? null : { kind: 'station', id: s.id })}
              >
                <KindIcon kind={s.kind} className="plan-chip-kind" />
                {s.name}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PlanNode({
  station,
  now,
  fetchedAt,
  base,
  selected,
  onClick,
}: {
  station: StationView;
  now: number;
  fetchedAt: number;
  base: Currency;
  selected: boolean;
  onClick: () => void;
}) {
  const layout = station.layout!;
  const size = shapeSize(layout);
  const st = stationState(station, now);
  const clockInfo = sessionClock(station, now, fetchedAt);
  const owed = (station.tab?.balanceMinor ?? 0) + pendingEstimate(station, now, fetchedAt);

  return (
    <button
      className={`plan-node shape-${layout.shape}`}
      data-state={st}
      aria-pressed={selected}
      title={station.name}
      style={{ left: layout.x, top: layout.y, width: size.w, height: size.h }}
      onClick={onClick}
    >
      <span className="plan-node-top">
        {station.groupId && <span className="plan-node-group" title={t('group.pill')}>{t('group.pill')}</span>}
        {station.device && station.device.alerts.length > 0 && <span className="plan-node-alert" aria-label={t('health.alert')}>⚠</span>}
        <KindIcon kind={station.kind} className="plan-node-kind" />
      </span>
      <span className="plan-node-name">{station.name}</span>
      <span className="plan-node-status">
        {clockInfo ? duration(clockInfo.ms) : owed > 0 ? money(owed, base) : t(`state.${st}`)}
      </span>
    </button>
  );
}
