import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useScale } from './FloorPlan';
import { t } from './i18n';
import { AREA_COLORS, DEFAULT_AREA_COLOR, FLOOR_CANVAS, SHAPES, defaultShape, shapeSize, snap } from './shapes';
import { KindIcon } from './stations';
import { useRun } from './ui';
import type { FloorState, StationKind, StationLayout, StationShape } from './types';

type Placement = StationLayout; // keyed by station id in a record
type Area = { id: string; x: number; y: number; w: number; h: number; label: string; color: string };
type Sel = { type: 'station'; id: string } | { type: 'area'; id: string } | null;

interface Stn {
  id: string;
  name: string;
  kind: StationKind;
}

/**
 * Lets the manager lay the room out as a map: drag each station to where it really stands, give it
 * a shape that looks like the real thing, and draw labelled areas (rooms, the bar) behind them.
 * Operators then recognise a station by its place and shape, not by reading a number off a card.
 */
export function FloorPlanEditor() {
  const { run, toast } = useRun();
  const [stations, setStations] = useState<Stn[]>([]);
  const [placed, setPlaced] = useState<Record<string, Placement>>({});
  const [areas, setAreas] = useState<Area[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const canvas = FLOOR_CANVAS;

  const load = useCallback(async () => {
    const s = await api.get<FloorState>('/api/state');
    setStations(s.stations.map((st) => ({ id: st.id, name: st.name, kind: st.kind })));
    const p: Record<string, Placement> = {};
    for (const st of s.stations) if (st.layout) p[st.id] = st.layout;
    setPlaced(p);
    setAreas(s.floorPlan.areas.map((a) => ({ ...a, label: a.label ?? '', color: a.color ?? DEFAULT_AREA_COLOR })));
    setSel(null);
    setDirty(false);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const scale = useScale(wrapRef, canvas.w);

  // One pointer drag at a time: move or resize, a station or an area.
  const drag = useRef<null | { mode: 'move' | 'resize'; type: 'station' | 'area'; id: string; dx: number; dy: number }>(null);

  const onPointerDown = (type: 'station' | 'area', id: string, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const cur = type === 'station' ? placed[id] : areas.find((a) => a.id === id);
    if (!cur) return;
    drag.current = { mode, type, id, dx: e.clientX, dy: e.clientY };
    setSel({ type, id } as Sel);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.dx) / scale;
    const dy = (e.clientY - d.dy) / scale;
    d.dx = e.clientX;
    d.dy = e.clientY;
    if (d.type === 'station') {
      setPlaced((prev) => {
        const cur = prev[d.id];
        if (!cur) return prev;
        const size = shapeSize(cur);
        const x = Math.max(0, Math.min(canvas.w - size.w, cur.x + dx));
        const y = Math.max(0, Math.min(canvas.h - size.h, cur.y + dy));
        return { ...prev, [d.id]: { ...cur, x, y } };
      });
    } else {
      setAreas((prev) =>
        prev.map((a) => {
          if (a.id !== d.id) return a;
          if (d.mode === 'move') {
            const x = Math.max(0, Math.min(canvas.w - a.w, a.x + dx));
            const y = Math.max(0, Math.min(canvas.h - a.h, a.y + dy));
            return { ...a, x, y };
          }
          const w = Math.max(60, Math.min(canvas.w - a.x, a.w + dx));
          const h = Math.max(50, Math.min(canvas.h - a.y, a.h + dy));
          return { ...a, w, h };
        }),
      );
    }
    setDirty(true);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // Snap to the grid on release so things line up without fighting the drag.
    if (d.type === 'station') {
      setPlaced((prev) => {
        const cur = prev[d.id];
        return cur ? { ...prev, [d.id]: { ...cur, x: snap(cur.x), y: snap(cur.y) } } : prev;
      });
    } else {
      setAreas((prev) => prev.map((a) => (a.id === d.id ? { ...a, x: snap(a.x), y: snap(a.y), w: snap(a.w), h: snap(a.h) } : a)));
    }
  };

  const place = (st: Stn) => {
    // Drop a new station in the first roughly-free slot near the top-left, then let the manager drag it.
    const n = Object.keys(placed).length;
    const x = snap(40 + (n % 8) * 110);
    const y = snap(40 + Math.floor(n / 8) * 90);
    setPlaced((prev) => ({ ...prev, [st.id]: { x: Math.min(x, canvas.w - 100), y: Math.min(y, canvas.h - 80), shape: defaultShape(st.kind) } }));
    setSel({ type: 'station', id: st.id });
    setDirty(true);
  };
  const unplace = (id: string) => {
    setPlaced((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSel(null);
    setDirty(true);
  };
  const setShape = (id: string, shape: StationShape) => {
    setPlaced((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], shape } } : prev));
    setDirty(true);
  };

  const addArea = () => {
    const id = `a_${Math.random().toString(36).slice(2, 8)}`;
    setAreas((prev) => [...prev, { id, x: snap(canvas.w / 2 - 110), y: snap(canvas.h / 2 - 80), w: 220, h: 160, label: '', color: DEFAULT_AREA_COLOR }]);
    setSel({ type: 'area', id });
    setDirty(true);
  };
  const editArea = (id: string, patch: Partial<Area>) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    setDirty(true);
  };
  const deleteArea = (id: string) => {
    setAreas((prev) => prev.filter((a) => a.id !== id));
    setSel(null);
    setDirty(true);
  };

  const autoArrange = () => {
    const perRow = Math.max(1, Math.floor((canvas.w - 40) / 110));
    const next: Record<string, Placement> = {};
    stations.forEach((st, i) => {
      next[st.id] = { x: snap(40 + (i % perRow) * 110), y: snap(40 + Math.floor(i / perRow) * 100), shape: placed[st.id]?.shape ?? defaultShape(st.kind) };
    });
    setPlaced(next);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        canvas: { w: canvas.w, h: canvas.h },
        stations: Object.entries(placed).map(([id, l]) => ({ id, x: l.x, y: l.y, shape: l.shape, ...(l.w ? { w: l.w } : {}), ...(l.h ? { h: l.h } : {}) })),
        areas: areas.map((a) => ({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h, label: a.label, color: a.color })),
      };
      const res = await run('admin.floor.layout', payload);
      if (res) {
        toast(t('plan.saved'), 'success');
        setDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const unplaced = stations.filter((s) => !placed[s.id]);
  const selStation = sel?.type === 'station' ? placed[sel.id] : null;
  const selArea = sel?.type === 'area' ? areas.find((a) => a.id === sel.id) : null;

  if (!loaded) return <p className="empty-note">{t('common.loading')}</p>;

  return (
    <div className="plan-editor">
      <div className="plan-editor-bar">
        <button className="btn btn-quiet" onClick={addArea}>
          + {t('plan.addArea')}
        </button>
        <button className="btn btn-quiet" onClick={autoArrange}>
          {t('plan.autoArrange')}
        </button>
        <span className="spacer" />
        {dirty && <span className="plan-dirty">{t('plan.unsaved')}</span>}
        <button className="btn btn-quiet" onClick={() => void load()} disabled={saving || !dirty}>
          {t('common.reset')}
        </button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
          {t('plan.save')}
        </button>
      </div>

      <p className="plan-editor-hint">{t('plan.hint')}</p>

      <div
        className="plan-wrap plan-wrap-edit"
        ref={wrapRef}
        style={{ height: canvas.h * scale }}
        onPointerDown={() => setSel(null)}
      >
        <div className="plan-canvas plan-canvas-edit" style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})` }}>
          {areas.map((a) => (
            <div
              key={a.id}
              className={`plan-area area-${a.color}${sel?.type === 'area' && sel.id === a.id ? ' sel' : ''}`}
              style={{ left: a.x, top: a.y, width: a.w, height: a.h }}
              onPointerDown={onPointerDown('area', a.id, 'move')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {a.label && <span className="plan-area-label">{a.label}</span>}
              <span className="plan-area-resize" onPointerDown={onPointerDown('area', a.id, 'resize')} aria-hidden="true" />
            </div>
          ))}
          {stations
            .filter((s) => placed[s.id])
            .map((s) => {
              const l = placed[s.id];
              if (!l) return null;
              const size = shapeSize(l);
              return (
                <div
                  key={s.id}
                  className={`plan-node shape-${l.shape} editable${sel?.type === 'station' && sel.id === s.id ? ' sel' : ''}`}
                  style={{ left: l.x, top: l.y, width: size.w, height: size.h }}
                  onPointerDown={onPointerDown('station', s.id, 'move')}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  title={s.name}
                >
                  <span className="plan-node-top">
                    <KindIcon kind={s.kind} className="plan-node-kind" />
                  </span>
                  <span className="plan-node-name">{s.name}</span>
                </div>
              );
            })}
        </div>
      </div>

      {selStation && sel?.type === 'station' && (
        <div className="plan-tools">
          <span className="plan-tools-title">{stations.find((s) => s.id === sel.id)?.name} — {t('plan.shape')}</span>
          <div className="plan-shapes">
            {SHAPES.map((sh) => (
              <button
                key={sh}
                className={`plan-shape-btn${selStation.shape === sh ? ' on' : ''}`}
                onClick={() => setShape(sel.id, sh)}
                title={t(`shape.${sh}`)}
                aria-pressed={selStation.shape === sh}
              >
                <span className={`shape-swatch shape-${sh}`} />
                {t(`shape.${sh}`)}
              </button>
            ))}
          </div>
          <button className="btn btn-quiet danger" onClick={() => unplace(sel.id)}>
            {t('plan.remove')}
          </button>
        </div>
      )}

      {selArea && sel?.type === 'area' && (
        <div className="plan-tools">
          <label className="plan-area-name">
            {t('plan.areaLabel')}
            <input value={selArea.label} maxLength={40} onChange={(e) => editArea(sel.id, { label: e.target.value })} />
          </label>
          <div className="plan-colors">
            {AREA_COLORS.map((c) => (
              <button
                key={c}
                className={`plan-color area-${c}${selArea.color === c ? ' on' : ''}`}
                onClick={() => editArea(sel.id, { color: c })}
                aria-label={c}
                aria-pressed={selArea.color === c}
              />
            ))}
          </div>
          <button className="btn btn-quiet danger" onClick={() => deleteArea(sel.id)}>
            {t('plan.deleteArea')}
          </button>
        </div>
      )}

      <div className="plan-tray">
        <span className="plan-tray-label">{unplaced.length > 0 ? t('plan.toPlace') : t('plan.allPlaced')}</span>
        {unplaced.map((s) => (
          <button key={s.id} className="plan-chip" onClick={() => place(s)}>
            <KindIcon kind={s.kind} className="plan-chip-kind" />
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}
