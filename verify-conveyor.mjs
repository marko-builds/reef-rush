// Headless verification for step 1.2: sample the conveyor path and print
// edge + inwardNormal across t, then assert the four straight-edge normals.
// Run: node verify-conveyor.mjs   (from primitive_version/)

import { Conveyor } from './src/conveyor.js';

// Fake board matching level.js (9x9 grid, CELL=1, centered on origin).
const GRID_COLS = 9, GRID_ROWS = 9, CELL = 1.0;
const originX = -(GRID_COLS - 1) * CELL * 0.5;
const originY = -(GRID_ROWS - 1) * CELL * 0.5;
const board = {
  bounds: {
    minX: originX, maxX: originX + (GRID_COLS - 1) * CELL,
    minY: originY, maxY: originY + (GRID_ROWS - 1) * CELL,
    cols: GRID_COLS, rows: GRID_ROWS,
  },
};

const c = new Conveyor(board);
const f = (n) => (n >= 0 ? ' ' : '') + n.toFixed(2);

console.log('t      edge     inwardNormal      pos                 align');
console.log('-'.repeat(64));
for (let k = 0; k <= 20; k++) {
  const t = k / 20;
  const s = c.sample(t);
  console.log(
    `${t.toFixed(2)}   ${s.edge.padEnd(7)}  (${f(s.inwardNormal.x)},${f(s.inwardNormal.y)})   ` +
    `(${f(s.pos.x)},${f(s.pos.y)})   ${s.alignIndex}`
  );
}

// Assertions: pick a t squarely on each straight edge and check the normal.
// COUNTER-CLOCKWISE travel order (re-lock #3): bottom -> right -> top -> left.
const expect = { left: [1, 0], top: [0, -1], right: [-1, 0], bottom: [0, 1] };
const samples = { bottom: 0.10, right: 0.35, top: 0.60, left: 0.85 };
let ok = true;
console.log('\nStraight-edge normal checks (CCW order: bottom/right/top/left):');
for (const [edge, t] of Object.entries(samples)) {
  const s = c.sample(t);
  const [ex, ey] = expect[edge];
  const pass = s.edge === edge &&
    Math.abs(s.inwardNormal.x - ex) < 1e-9 && Math.abs(s.inwardNormal.y - ey) < 1e-9;
  ok = ok && pass;
  console.log(`  ${edge.padEnd(7)} @t=${t}: edge=${s.edge} normal=(${f(s.inwardNormal.x)},${f(s.inwardNormal.y)}) -> ${pass ? 'PASS' : 'FAIL'}`);
}

// START/END must be the BOTTOM-LEFT (left end of the bottom edge) and travel must
// move +X along the bottom first (counter-clockwise).
{
  const expectStart = { x: c.left + c.r, y: c.bottom };
  const s0 = c.sample(0.001);
  const passStart =
    Math.abs(c.startPos.x - expectStart.x) < 1e-9 && Math.abs(c.startPos.y - expectStart.y) < 1e-9 &&
    Math.abs(c.endPos.x - expectStart.x) < 1e-9 && Math.abs(c.endPos.y - expectStart.y) < 1e-9;
  const passDir = s0.edge === 'bottom' && s0.x > c.startPos.x;
  ok = ok && passStart && passDir;
  console.log(`  start/end at bottom-left (${f(expectStart.x)},${f(expectStart.y)}) -> ${passStart ? 'PASS' : 'FAIL'}`);
  console.log(`  travel from start is +X along the bottom (CCW) -> ${passDir ? 'PASS' : 'FAIL'}`);
}

console.log(`\nSTART pos (${f(c.startPos.x)},${f(c.startPos.y)})  END pos (${f(c.endPos.x)},${f(c.endPos.y)})  capacity=${c.capacity}`);
console.log(ok ? '\nALL NORMAL CHECKS PASS' : '\nNORMAL CHECKS FAILED');
process.exit(ok ? 0 : 1);
