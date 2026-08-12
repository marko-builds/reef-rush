// conveyor.js — the perimeter belt as a parametric ROUNDED-RECT path.
//
//   sample(t in [0,1)) -> { x, y, pos, edge, inwardNormal, alignIndex }
//     pos          : { x, y } world position of a point at parameter t
//     x, y         : same, flattened (kept for callers that read .x/.y)
//     edge         : 'top' | 'right' | 'bottom' | 'left' | 'corner'
//     inwardNormal : { x, y } unit vector pointing INWARD (toward the board).
//                      top -> (0,-1)  right -> (-1,0)  bottom -> (0,+1)  left -> (+1,0)
//                      on a corner it sweeps continuously between the two edge normals.
//     alignIndex   : the board SUB-column (top/bottom) or SUB-row (left/right) the
//                      point is lined up with — small-block resolution, 0..2*N-1 — or
//                      -1 on a corner / outside the board span (the pig HOLDS).
//
// The belt is a rounded rectangle ringing the board, offset OUTWARD by BELT_GAP,
// with quarter-circle corners of radius CORNER_R. A pig rides facing the inward
// normal. START (t=0) and END (t=1) are the SAME point: the BOTTOM-LEFT (the left
// end of the bottom edge, just past the bottom-left corner). Travel is
// COUNTER-CLOCKWISE (spec re-lock #3): bottom(right) -> right(up) -> top(left) ->
// left(down) -> back to the bottom-left.
//
// CAPACITY (max pigs on the belt at once) is a gameplay rule enforced by the pig
// manager via CONFIG.conveyorCapacity; the path exposes it here for convenience.
//
// Built from board bounds -> fully data-driven.

import { CELL } from './board.js';
import { CONFIG } from './level.js';

const BELT_GAP = CELL * 1.1;  // how far outside the board the belt sits
const CORNER_R = CELL * 1.0;  // quarter-circle corner radius

// Inward unit normals per straight edge (perpendicular, pointing at the board).
const EDGE_NORMAL = {
  left:   { x: +1, y: 0 },
  top:    { x: 0, y: -1 },
  right:  { x: -1, y: 0 },
  bottom: { x: 0, y: +1 },
};

export class Conveyor {
  constructor(board) {
    const b = board.bounds;
    this.board = board;
    this.capacity = CONFIG.conveyorCapacity;

    // Belt-centerline rectangle (world space).
    this.left   = b.minX - BELT_GAP;
    this.right  = b.maxX + BELT_GAP;
    this.bottom = b.minY - BELT_GAP;
    this.top    = b.maxY + BELT_GAP;
    this.r      = CORNER_R;

    // Board span used to map a position to a column/row.
    this.boardMinX = b.minX;
    this.boardMinY = b.minY;
    this.cols = b.cols;
    this.rows = b.rows;

    const L = this.left, R = this.right, B = this.bottom, T = this.top, r = this.r;
    const straightV = (T - B) - 2 * r; // vertical straight length (left/right edges)
    const straightH = (R - L) - 2 * r; // horizontal straight length (top/bottom)
    const arc = (Math.PI / 2) * r;     // quarter-circle arc length

    // Eight segments in COUNTER-CLOCKWISE travel order, starting at the
    // bottom-left. Straight segments carry an edge + normal; corner segments
    // sweep the normal between their neighbouring edge normals. 'a' is the arc
    // start angle (radians), swept by +PI/2 over the segment (CCW).
    this.segs = [
      { kind: 'line', edge: 'bottom', len: straightH, x0: L + r, y0: B,     x1: R - r, y1: B },
      { kind: 'arc',  edge: 'corner', len: arc, cx: R - r, cy: B + r, a: -Math.PI / 2 },     // -90 -> 0
      { kind: 'line', edge: 'right',  len: straightV, x0: R,     y0: B + r, x1: R,     y1: T - r },
      { kind: 'arc',  edge: 'corner', len: arc, cx: R - r, cy: T - r, a: 0 },                // 0 -> 90
      { kind: 'line', edge: 'top',    len: straightH, x0: R - r, y0: T,     x1: L + r, y1: T },
      { kind: 'arc',  edge: 'corner', len: arc, cx: L + r, cy: T - r, a: Math.PI / 2 },      // 90 -> 180
      { kind: 'line', edge: 'left',   len: straightV, x0: L,     y0: T - r, x1: L,     y1: B + r },
      { kind: 'arc',  edge: 'corner', len: arc, cx: L + r, cy: B + r, a: Math.PI },          // 180 -> 270
    ];

    this.total = this.segs.reduce((acc, s) => acc + s.len, 0);
    // Cumulative arc-length at each segment start.
    this.cum = [0];
    for (const s of this.segs) this.cum.push(this.cum[this.cum.length - 1] + s.len);

    // START / END (same point): the bottom-left — left end of the bottom edge.
    this.startPos = { x: L + r, y: B };
    this.endPos = { x: L + r, y: B };
  }

  // Map a world Y on a vertical edge to the nearest SUB-ROW (-1 if off-span). The
  // board is an 18x18 small-block grid (2 sub-rows per big cell), so alignment is at
  // small-block resolution: pick the nearest big-cell row, then its lower/upper half.
  _rowAt(y) {
    const r = Math.round((y - this.boardMinY) / CELL);
    if (r < 0 || r > this.rows - 1) return -1;
    const cy = this.boardMinY + r * CELL;
    return 2 * r + (y >= cy ? 1 : 0);
  }

  // Map a world X on a horizontal edge to the nearest SUB-COLUMN (-1 if off-span).
  _colAt(x) {
    const c = Math.round((x - this.boardMinX) / CELL);
    if (c < 0 || c > this.cols - 1) return -1;
    const cx = this.boardMinX + c * CELL;
    return 2 * c + (x >= cx ? 1 : 0);
  }

  // Sample the path at t in [0,1).
  sample(t) {
    t = ((t % 1) + 1) % 1; // wrap into [0,1)
    const dist = t * this.total;

    // Find the active segment.
    let i = 0;
    while (i < this.segs.length - 1 && dist >= this.cum[i + 1]) i++;
    const seg = this.segs[i];
    const f = seg.len > 0 ? (dist - this.cum[i]) / seg.len : 0; // 0..1 within segment

    let x, y, edge, inwardNormal;

    if (seg.kind === 'line') {
      x = seg.x0 + f * (seg.x1 - seg.x0);
      y = seg.y0 + f * (seg.y1 - seg.y0);
      edge = seg.edge;
      const n = EDGE_NORMAL[seg.edge];
      inwardNormal = { x: n.x, y: n.y };
    } else {
      // Quarter-circle: angle sweeps from seg.a by +PI/2 (counter-clockwise).
      const ang = seg.a + f * (Math.PI / 2);
      x = seg.cx + this.r * Math.cos(ang);
      y = seg.cy + this.r * Math.sin(ang);
      edge = 'corner';
      // Inward = from the arc point toward its centre (the corner's inside).
      inwardNormal = { x: -Math.cos(ang), y: -Math.sin(ang) };
    }

    // Align index only on straight edges; corners HOLD.
    let alignIndex = -1;
    if (edge === 'left' || edge === 'right') alignIndex = this._rowAt(y);
    else if (edge === 'top' || edge === 'bottom') alignIndex = this._colAt(x);

    return { x, y, pos: { x, y }, edge, inwardNormal, alignIndex };
  }

  // Polyline points tracing the belt centerline (for drawing the rounded loop).
  pathPoints(steps = 160) {
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const s = this.sample(k / steps);
      pts.push({ x: s.x, y: s.y });
    }
    return pts;
  }
}
