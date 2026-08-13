// Headless verification (Phase 4 feature 5) — seaweed-wrapped blocks.
// needs.md 5c tests + the data-model/coverage checks:
//   A) level-4 board printout: wraps cover ROW 4 only (mine cell excluded);
//      level-5 wraps cover ROW 2; wrapped sub-block counts are exact
//   B) two same-color shots: 1st DEWRAPS (alive, ammo -1, event dewrap:true),
//      2nd DESTROYS (alive=false, ammo -1, event dewrap:false)
//   C) wrong-color shot at a wrapped front -> BLOCKED (no dewrap, no ammo)
//   D) lockup reachability: a wrapped exposed block still counts as reachable
//   E) mine blast kills wrapped blocks OUTRIGHT (no dewrap step)
import * as THREE from 'three';
import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { LEVELS, expandPattern, GRID_COLS, GRID_ROWS, makeRng } from './src/level.js';

const scene = { add() {}, remove() {} };

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// ---------------------------------------------------------------------------
// (A) data model + authored coverage. Printout: UPPERCASE = plain cell,
// lowercase = WRAPPED cell, '.' = empty — so the wrap rows read at a glance.
// ---------------------------------------------------------------------------
console.log('=== (A) authored wrap coverage (L4 row 4, L5 row 2) ===');
for (const level of [LEVELS[3], LEVELS[4]]) {
  const cubes = expandPattern(level);
  const byCell = new Map(cubes.map((c) => [c.col + ',' + c.row, c]));
  console.log(`  L${level.id} "${level.name}" board (lowercase = wrapped):`);
  for (let row = GRID_ROWS - 1; row >= 0; row--) {
    let line = '    ';
    for (let col = 0; col < GRID_COLS; col++) {
      const c = byCell.get(col + ',' + row);
      if (!c) { line += '.'; continue; }
      const ch = c.color === 'W' ? 'W' : c.color === 'M' ? 'M' : c.color[1] === '1' ? 'A' : c.color[1] === '2' ? 'B' : c.color[1] === '3' ? 'C' : 'D';
      line += c.wrapped ? ch.toLowerCase() : ch;
    }
    console.log(line);
  }
  const wrappedCells = cubes.filter((c) => c.wrapped);
  const expectRow = level.id === 4 ? 4 : 2;
  const expectCount = level.id === 4 ? 8 : 9;
  check(`L${level.id}: ${expectCount} wrapped cells, all on row ${expectRow}`,
    wrappedCells.length === expectCount && wrappedCells.every((c) => c.row === expectRow));
  check(`L${level.id}: no wild/mine cell is wrapped`,
    wrappedCells.every((c) => c.color !== 'W' && c.color !== 'M'));
  const board = new Board(scene, null, level);
  const wrappedBlocks = board.blocks.filter((b) => b.wrapped);
  check(`L${level.id}: board carries ${expectCount * 4} wrapped SUB-blocks (4 per cell)`,
    wrappedBlocks.length === expectCount * 4);
  check(`L${level.id}: every non-wrap block defaults wrapped=false`,
    board.blocks.every((b) => b.wrapped === wrappedBlocks.includes(b)));
}

// ---------------------------------------------------------------------------
// hand-placed probes (same rig as verify-wild.mjs): pig on the TOP edge.
// ---------------------------------------------------------------------------
const board = new Board(scene, null, LEVELS[0]);
const conveyor = new Conveyor(board);
const pigs = new PigManager(scene, board, conveyor, null, LEVELS[0], makeRng(1));

function resetBoard() {
  for (const b of board.blocks) board.group.remove(b.mesh);
  board.blocks = [];
  board.grid = new Map();
}
function place(scol, srow, colorKey, wrapped = false) {
  const mesh = new THREE.Mesh(board._subGeo, board._materialFor(colorKey));
  board.group.add(mesh);
  const block = { scol, srow, colorKey, alive: true, wrapped, mesh };
  board.blocks.push(block);
  board.grid.set(board._key(scol, srow), block);
  return block;
}

const s = conveyor.sample(0.60);
console.log(`\nprobe: edge=${s.edge} alignSub=${s.alignIndex}`);

console.log('\n=== (B) wrapped C1 block vs a C1 pig: hit 1 DEWRAPS, hit 2 DESTROYS ===');
{
  resetBoard();
  const target = place(s.alignIndex, 16, 'C1', true); // wrapped, first in line
  const probe = pigs._makePig('C1', 7);
  probe.location = 'conveyor'; probe.t = 0.60;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.vfx.length = 0;

  pigs.update(0.001); // shot 1
  const ev1 = pigs.vfx.find((e) => e.type === 'fire');
  check('hit 1: wrap peeled (wrapped=false)', target.wrapped === false);
  check('hit 1: block STAYS ALIVE', target.alive === true);
  check('hit 1: ammo 7 -> 6', probe.ammo === 6);
  check("hit 1: fire event flags dewrap:true (render side: 0 coins, strip anim)",
    ev1 != null && ev1.dewrap === true);

  pigs.vfx.length = 0;
  probe.t = 0.60; probe.fireTimer = 0; // same spot, cadence elapsed
  pigs.update(0.001); // shot 2
  const ev2 = pigs.vfx.find((e) => e.type === 'fire');
  check('hit 2: block destroyed', target.alive === false);
  check('hit 2: ammo 6 -> 5', probe.ammo === 5);
  check('hit 2: fire event flags dewrap:false (normal award + pop)',
    ev2 != null && ev2.dewrap === false);
  pigs.conveyorPigs = []; pigs.vfx.length = 0;
}

console.log('\n=== (C) wrapped C1 front vs a C2 pig: BLOCKED (wrong color, even wrapped) ===');
{
  resetBoard();
  const target = place(s.alignIndex, 16, 'C1', true);
  place(s.alignIndex, 8, 'C2'); // a matching block buried BEHIND the wrap
  const probe = pigs._makePig('C2', 7);
  probe.location = 'conveyor'; probe.t = 0.60;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.update(0.001);
  check('target is null (BLOCKED)', pigs._lineTarget(probe) === null);
  check('wrap intact, block alive, ammo unchanged',
    target.wrapped === true && target.alive === true && probe.ammo === 7);
  pigs.conveyorPigs = []; pigs.vfx.length = 0;
}

console.log('\n=== (D) reachability: a wrapped exposed block still counts for its color ===');
{
  resetBoard();
  for (let scol = 0; scol < 18; scol++) place(scol, 16, 'C1', true); // wrapped C1 wall
  check("hasExposedColor('C1') === true (wrapped is still interactable)",
    board.hasExposedColor('C1') === true);
  check("hasExposedColor('C2') === false (wrap adds no wildcard)",
    board.hasExposedColor('C2') === false);
}

console.log('\n=== (E) mine blast destroys wrapped blocks OUTRIGHT (no dewrap step) ===');
{
  resetBoard();
  const mine = place(8, 8, 'M');
  const wrappedNear = place(7, 8, 'C1', true);  // inside the 6x6 blast square
  const wrappedFar = place(2, 8, 'C1', true);   // outside it
  board.explodeMine(mine);
  check('wrapped block inside the blast: DEAD in one step (wrap ignored)',
    wrappedNear.alive === false);
  check('wrapped block outside the blast: untouched, still wrapped',
    wrappedFar.alive === true && wrappedFar.wrapped === true);
}

console.log('\n' + (allPass ? '=== ALL SEAWEED-WRAP CHECKS PASS ===' : '=== SEAWEED-WRAP CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
