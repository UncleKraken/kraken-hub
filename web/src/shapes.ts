import type { StationKind, StationLayout, StationShape } from './types';

/** The design-unit canvas the floor map is laid out on; the view scales it to fit. Must match
 *  FLOOR_CANVAS in host/src/domain/venue.ts. */
export const FLOOR_CANVAS = { w: 1000, h: 680 };

/** Snap step (design units) used while dragging in the editor, so things line up tidily. */
export const GRID = 10;

export const SHAPES: StationShape[] = ['desk', 'seat', 'sofa', 'round', 'rect', 'counter', 'plain'];

/** Default footprint per shape, in design units. A station may override w/h. */
export const SHAPE_SIZE: Record<StationShape, { w: number; h: number }> = {
  desk: { w: 92, h: 62 },
  seat: { w: 74, h: 74 },
  sofa: { w: 128, h: 72 },
  round: { w: 92, h: 92 },
  rect: { w: 152, h: 74 },
  counter: { w: 176, h: 46 },
  plain: { w: 88, h: 62 },
};

/** The shape a station gets before anyone customises it, chosen to look like the real thing. */
export function defaultShape(kind: StationKind): StationShape {
  switch (kind) {
    case 'pc':
      return 'desk';
    case 'sim':
      return 'seat';
    case 'console':
      return 'sofa';
    case 'table':
      return 'round';
    default:
      return 'plain';
  }
}

/** Resolved size of a station on the map (its override, else the shape default). */
export function shapeSize(l: Pick<StationLayout, 'shape' | 'w' | 'h'>): { w: number; h: number } {
  const base = SHAPE_SIZE[l.shape] ?? SHAPE_SIZE.plain;
  return { w: l.w ?? base.w, h: l.h ?? base.h };
}

/** A layout for a station that has none yet, so it can be dropped onto the map. */
export function layoutFor(kind: StationKind, x: number, y: number): StationLayout {
  return { x, y, shape: defaultShape(kind) };
}

export const AREA_COLORS = ['slate', 'teal', 'violet', 'amber', 'rose', 'blue'] as const;
export type AreaColor = (typeof AREA_COLORS)[number];
export const DEFAULT_AREA_COLOR: AreaColor = 'slate';

/** Round a design-unit coordinate to the snap grid. */
export function snap(n: number): number {
  return Math.round(n / GRID) * GRID;
}
