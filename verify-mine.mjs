// Headless verification (Phase 4 feature 4) — MINE blocks, the needs.md tests.
// 1) mine FIRST in line -> ANY pig color triggers it; the blast clears EXACTLY
//    the 6x6 small-block square (the mine cell's 3x3 big-block neighborhood,
//    clipped at edges); trigger costs 1 ammo; mine fully consumed.
// 2) mine BEHIND a wrong-color front -> still BLOCKED (no shot, no ammo).
// 3) slots full of C1 pigs, only the MINE exposed -> reachability TRUE for all
//    colors (re-lap, no lockup); control without the mine -> lockup fires.
// Plus: the 'mineExplode' event carries per-block coin data (colored = 1,
// wild = 3, mine sub-blocks = 0), and the L2-L5 board printouts for placement.
import * as THREE from 'three';
import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { LEVELS, expandPattern, makeRng } from './src/level.js';

const scene = { add() {}, remove() {} };
const board = new Board(scene, null, LEVELS[0]);
const conveyor = new Conveyor(board);
const pigs = new PigManager(scene, board, conveyor, null, LEVELS[0], makeRng(1));

function resetBoard() {
  for (const b of board.blocks) board.group.remove(b.mesh);
  board.blocks = [];
  board.grid = new Map();
}
function place(scol, srow, colorKey) {
  const mesh = new THREE.Mesh(board._subGeo, board._materialFor(colorKey));
  board.group.add(mesh);
  const block = { scol, srow, colorKey, alive: true, mesh };
  board.blocks.push(block);
  board.grid.set(board._key(scol, srow), block);
  return block;
}
// place a full cell-aligned MINE big block (2x2 sub-blocks) at cell (c, r)
function placeMine(c, r) {
  return [
    place(2 * c, 2 * r, 'M'), place(2 * c + 1, 2 * r, 'M'),
    place(2 * c, 2 * r + 1, 'M'), place(2 * c + 1, 2 * r + 1, 'M'),
  ];
}

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// pig on the TOP edge (t=0.60 on the CCW path) firing DOWN its sub-column
const s = conveyor.sample(0.60);
const mineCell = Math.floor(s.alignIndex / 2); // mine cell under the fire column
console.log(`probe: edge=${s.edge} alignSub=${s.alignIndex} -> mine cell col ${mineCell}\n`);

console.log('=== (1) MINE first in line -> ANY pig triggers; blast = exact 6x6 (clipped) ===');
{
  resetBoard();
  // mine at cell (mineCell, 8) = sub cols 2c..2c+1, sub rows 16..17 (TOP row —
  // also exercises blast clipping past srow 17). A C2 field fills rows 10..15
  // in EVERY column; the mine is the first alive block in the fire column.
  placeMine(mineCell, 8);
  for (let scol = 0; scol < 18; scol++)
    for (let srow = 10; srow <= 15; srow++) place(scol, srow, 'C2');
  const probe = pigs._makePig('C1', 7); // C1 pig vs a colorless mine + C2 field
  probe.location = 'conveyor'; probe.t = 0.60;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.update(0.001);
  const events = [...pigs.vfx];
  pigs.vfx.length = 0;
  pigs.conveyorPigs = [];

  // blast square: sub cols [2c-2, 2c+3], sub rows [14, 19] (18-19 off-board)
  const c0 = 2 * mineCell - 2, c1 = 2 * mineCell + 3;
  const inBlast = (b) => b.scol >= c0 && b.scol <= c1 && b.srow >= 14 && b.srow <= 19;
  const wrong = board.blocks.filter((b) => b.alive === inBlast(b));
  check('C1 pig triggered the colorless mine (ammo 7 -> 6, exactly 1)', probe.ammo === 6);
  check('every block in the 6x6 blast square destroyed, every block outside intact',
    wrong.length === 0);
  check('mine fully consumed (all 4 sub-blocks dead)',
    board.blocks.filter((b) => b.colorKey === 'M' && b.alive).length === 0);
  const boom = events.find((e) => e.type === 'mineExplode');
  const fires = events.filter((e) => e.type === 'fire');
  check(`exactly one 'fire' (the trigger) + one 'mineExplode' event`,
    fires.length === 1 && events.filter((e) => e.type === 'mineExplode').length === 1);
  // blast destroyed: 3 remaining mine subs + 12 C2 (6 cols x rows 14-15)
  check(`blast event carries the destroyed blocks (15 = 3 mine subs + 12 C2)`,
    boom && boom.blocks.length === 15);
  // coin data on the event: colored = 1, mine subs = 0 (wild would be 3)
  const award = (k) => (k === 'W' ? 3 : k === 'M' ? 0 : 1);
  const coins = boom ? boom.blocks.reduce((n, b) => n + award(b.blockColor), 0) : -1;
  check('blast coin data: 12 coins (C2 x12 = 12, mine subs x3 = 0)', coins === 12);
}

console.log('\n=== (2) wrong-color front, MINE BEHIND -> still BLOCKED ===');
{
  resetBoard();
  const front = place(s.alignIndex, 17, 'C2'); // wrong color for a C1 pig
  const mine = placeMine(mineCell, 6);         // mine buried behind it (rows 12-13)
  const probe = pigs._makePig('C1', 7);
  probe.location = 'conveyor'; probe.t = 0.60;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.update(0.001);
  pigs.vfx.length = 0;
  check('target is null (BLOCKED)', pigs._lineTarget(probe) === null);
  check('front C2 intact, mine intact, ammo unchanged',
    front.alive && mine.every((b) => b.alive) && probe.ammo === 7);
  pigs.conveyorPigs = [];
}

console.log('\n=== (3) slots full of C1 pigs, only the MINE exposed -> reachable, no lockup ===');
{
  resetBoard();
  // a mine wall exposed from the top; only C2 blocks buried below (no C1 at all)
  for (let c = 0; c < 9; c++) placeMine(c, 8);
  for (let scol = 0; scol < 18; scol++) place(scol, 8, 'C2');
  console.log('  reachability scan with only M exposed:');
  for (const c of ['C1', 'C2', 'C3', 'C4']) {
    check(`hasExposedColor('${c}') === true (mine counts for any color)`, board.hasExposedColor(c) === true);
  }
  for (let i = 0; i < 5; i++) {
    const parked = pigs._makePig('C1', 5);
    parked.location = 'slot'; parked.slotIndex = i;
    pigs.slots[i] = parked;
  }
  const rider = pigs._makePig('C1', 5);
  rider.location = 'conveyor'; rider.t = 0.9999;
  rider.fireTimer = 999; // suppress firing this frame; we only test the routing
  pigs.conveyorPigs = [rider]; pigs.state = 'playing';
  pigs.update(0.01); // crosses t>=1 at the belt end
  check(`state stays 'playing' (re-laps; lockup does NOT fire)`, pigs.state === 'playing');
  check('rider re-entered the conveyor', rider.location === 'conveyor' && rider.t < 0.1);
  // control: clear the mines -> no reachable match -> the lockup DOES fire
  for (const b of [...board.blocks]) if (b.colorKey === 'M') board.destroy(b);
  rider.t = 0.9999;
  pigs.update(0.01);
  check(`control: without the mines the same jam IS the lockup (state 'lost')`, pigs.state === 'lost');
}

console.log('\n=== Board printout + authored mine placement (the ad level) ===');
for (const level of LEVELS) {
  console.log(`  L${level.id} "${level.name}" (pattern row 0 = TOP):`);
  for (const row of level.pattern) console.log(`    ${row}`);
  // This loop once printed levels 2-5 of the source roster; after the single-
  // ad-level cut it iterated NOTHING and could not fail. Assert the placement:
  // exactly one mine, in the ring's bottom edge (col 4, world row 4).
  const mines = expandPattern(level).filter((c) => c.color === 'M');
  check(`L${level.id}: exactly one authored mine, at col 4 row 4`,
    mines.length === 1 && mines[0].col === 4 && mines[0].row === 4);
}

console.log('\n' + (allPass ? '=== ALL MINE-BLOCK CHECKS PASS ===' : '=== MINE-BLOCK CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
