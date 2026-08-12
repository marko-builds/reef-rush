// Headless verification (Phase 4 feature 3) — wild blocks, the three needs.md tests.
// 1) wild FIRST in line -> any pig color fires, destroys it, ammo -1
// 2) wrong-color front with a wild BEHIND -> still BLOCKED (no shot, no ammo)
// 3) slots full of C1 pigs, only WILD exposed -> reachability TRUE (no lockup)
import * as THREE from 'three';
import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { LEVELS, makeRng } from './src/level.js';

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

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// pig on the TOP edge (t=0.60 on the CCW path) firing DOWN its sub-column
const s = conveyor.sample(0.60);
console.log(`probe: edge=${s.edge} alignSub=${s.alignIndex}\n`);

console.log('=== (1) WILD first in line -> ANY pig color hits it, ammo -1 ===');
{
  resetBoard();
  const wild = place(s.alignIndex, 16, 'W');   // first block the inward ray meets
  place(s.alignIndex, 8, 'C2');                // something buried behind it
  const probe = pigs._makePig('C1', 7);
  probe.location = 'conveyor'; probe.t = 0.60;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.update(0.001);
  pigs.vfx.length = 0;
  check('wild block destroyed by a C1 pig', wild.alive === false);
  check('ammo 7 -> 6 (cost 1 as normal)', probe.ammo === 6);
  pigs.conveyorPigs = [];
}

console.log('\n=== (2) wrong-color front, wild BEHIND -> still BLOCKED ===');
{
  resetBoard();
  const front = place(s.alignIndex, 16, 'C2'); // wrong color for a C1 pig
  const wild = place(s.alignIndex, 8, 'W');    // wild buried behind it
  const probe = pigs._makePig('C1', 7);
  probe.location = 'conveyor'; probe.t = 0.60;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.update(0.001);
  pigs.vfx.length = 0;
  check('target is null (BLOCKED)', pigs._lineTarget(probe) === null);
  check('front C2 intact, wild intact, ammo unchanged',
    front.alive && wild.alive && probe.ammo === 7);
  pigs.conveyorPigs = [];
}

console.log('\n=== (3) slots full of C1 pigs, only WILD exposed -> reachable, no lockup ===');
{
  resetBoard();
  // a wild wall exposed from the top; C1 blocks fully buried behind it
  for (let scol = 0; scol < 18; scol++) place(scol, 16, 'W');
  for (let scol = 0; scol < 18; scol++) place(scol, 8, 'C2'); // no exposed C1 at all
  console.log('  reachability scan with only W exposed:');
  for (const c of ['C1', 'C2', 'C3', 'C4']) {
    check(`hasExposedColor('${c}') === true (wild counts for any color)`, board.hasExposedColor(c) === true);
  }
  // drive the REAL lockup branch: 5 slots full, a C1 pig crosses the belt end
  // with ammo left -> per spec it must RE-LAP (not lose), because wild is reachable.
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
  // control: remove the wild wall -> no reachable match -> the lockup DOES fire
  for (const b of [...board.blocks]) if (b.colorKey === 'W') board.destroy(b);
  rider.t = 0.9999;
  pigs.update(0.01);
  check(`control: without wilds the same jam IS the lockup (state 'lost')`, pigs.state === 'lost');
}

console.log('\n' + (allPass ? '=== ALL WILD-BLOCK CHECKS PASS ===' : '=== WILD-BLOCK CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
