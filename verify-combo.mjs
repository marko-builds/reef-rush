// Headless verification (Phase 4 feature 2) — combo chain visual, headless.
// Custom board: C=(4,4) A is cleared; neighbors: UP (4,5) A exposed (clear column
// above), DOWN (4,3) A exposed (clear column below), LEFT (3,4) A but fully
// BURIED behind B on all four lines, RIGHT (5,4) B (wrong color).
// Expected pulses on completion: UP + DOWN only (8 alive sub-block meshes).
// Also: NO pulse on the 3 intermediate hits, only on the 4th (completion).
import { Board } from './src/board.js';
import { VfxLayer } from './src/vfx.js';

const level = {
  id: 99, name: 'combo-test', colors: ['C1', 'C2'],
  pattern: [
    '.........',
    '.........',
    '.........',
    '...BA....',
    '..BAAB...',
    '...BA....',
    '.........',
    '.........',
    '.........',
  ],
};

const scene = { add() {}, remove() {} };
const board = new Board(scene, null, level);
const pigsStub = { vfx: [], state: 'playing' };
const vfx = new VfxLayer(scene, null, board, null, pigsStub, null);

const cellBlocks = (c, r) => board.blocks.filter(
  (b) => b.cellCol === c && b.cellRow === r);

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// destroy C's 4 small blocks one at a time, pushing the fire event like update()
const target = cellBlocks(4, 4);
check('center cell (4,4) has 4 small blocks', target.length === 4);
for (let i = 0; i < 4; i++) {
  const b = target[i];
  board.destroy(b);
  pigsStub.vfx.push({ type: 'fire', colorKey: 'C1', fromX: 0, fromY: 0,
    toX: b.mesh.position.x, toY: b.mesh.position.y,
    scol: b.scol, srow: b.srow, blockColor: b.colorKey });
  vfx.update(1 / 60);
  if (i < 3) {
    check(`hit ${i + 1}/4 (intermediate): NO combo pulse`, vfx.comboPulses.length === 0);
  }
}

// after the 4th hit the cell is complete -> UP+DOWN pulse, LEFT+RIGHT don't
const pulsed = new Set(vfx.comboPulses.map((cp) => cp.mesh));
const upMeshes = cellBlocks(4, 5).filter((b) => b.alive).map((b) => b.mesh);
const downMeshes = cellBlocks(4, 3).filter((b) => b.alive).map((b) => b.mesh);
const leftMeshes = cellBlocks(3, 4).filter((b) => b.alive).map((b) => b.mesh);
const rightMeshes = cellBlocks(5, 4).filter((b) => b.alive).map((b) => b.mesh);

check('completion fired a combo (pulses exist)', pulsed.size > 0);
check(`UP neighbor (4,5) A exposed -> all 4 sub-blocks pulse`, upMeshes.every((m) => pulsed.has(m)));
check(`DOWN neighbor (4,3) A exposed -> all 4 sub-blocks pulse`, downMeshes.every((m) => pulsed.has(m)));
check(`LEFT neighbor (3,4) A BURIED (B on all 4 lines) -> no pulse`, leftMeshes.every((m) => !pulsed.has(m)));
check(`RIGHT neighbor (5,4) wrong color B -> no pulse`, rightMeshes.every((m) => !pulsed.has(m)));
check(`pulse set is EXACTLY up+down (${pulsed.size} === ${upMeshes.length + downMeshes.length})`,
  pulsed.size === upMeshes.length + downMeshes.length);

// already-cleared neighbor: clear UP fully, re-complete a fresh board? cheaper:
// re-fire the last event (cell already complete, neighbors unchanged except UP
// now cleared) -> destroy UP's blocks, re-push completion event, expect no UP pulse
for (const b of cellBlocks(4, 5)) board.destroy(b);
vfx.comboPulses.length = 0;
const last = target[3];
pigsStub.vfx.push({ type: 'fire', colorKey: 'C1', fromX: 0, fromY: 0,
  toX: last.mesh.position.x, toY: last.mesh.position.y,
  scol: last.scol, srow: last.srow, blockColor: last.colorKey });
vfx.update(1 / 60);
const pulsed2 = new Set(vfx.comboPulses.map((cp) => cp.mesh));
check('already-cleared UP neighbor -> no pulse (only DOWN pulses now)',
  upMeshes.every((m) => !pulsed2.has(m)) && downMeshes.every((m) => pulsed2.has(m)));

console.log('\n' + (allPass ? '=== COMBO CHAIN CHECKS PASS ===' : '=== COMBO CHAIN CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
