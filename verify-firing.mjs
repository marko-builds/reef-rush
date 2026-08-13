// Headless verification for the firing rule — BLOCKING, at SMALL-BLOCK resolution.
// One shot removes only the FIRST (closest) small block in the pig's inward sub-line,
// and only if it matches its color; a wrong-color front BLOCKS it (HOLD). For each of
// the four edges we sample the pig's align sub-line, then assert:
//   A) first block MATCHES        -> it is the target; one hit destroys it, ammo-1.
//   B) first block WRONG color    -> target is null (BLOCKED); the buried matching
//                                    block behind it is left intact, ammo unchanged.
// Run: node verify-firing.mjs   (from primitive_version_v1/)

import * as THREE from 'three';
import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { LEVELS, makeRng } from './src/level.js';

const scene = { add() {}, remove() {} };
const board = new Board(scene, null, LEVELS[0]);
const conveyor = new Conveyor(board);
const pigs = new PigManager(scene, board, conveyor, null, LEVELS[0], makeRng(1));

// --- helpers to drive a controlled board ----------------------------------
function resetBoard() {
  for (const b of board.blocks) board.group.remove(b.mesh);
  board.blocks = [];
  board.grid = new Map();
}
// A single small block at sub-coords (scol,srow). Exercises destroy()/grid faithfully.
function place(scol, srow, colorKey) {
  const mesh = new THREE.Mesh(board._subGeo, board._materialFor(colorKey));
  board.group.add(mesh);
  const block = { scol, srow, colorKey, alive: true, mesh };
  board.blocks.push(block);
  board.grid.set(board._key(scol, srow), block);
  return block;
}

// Given an edge + align SUB index, return the NEAR sub-cell (first reached by the
// inward ray) and a FAR sub-cell (buried behind it on the same sub-line).
function nearFar(edge, ai) {
  switch (edge) {
    case 'top':    return { near: [ai, 16], far: [ai, 8] }; // scan srow high->low
    case 'bottom': return { near: [ai, 1],  far: [ai, 8] }; // scan srow low->high
    case 'left':   return { near: [1, ai],  far: [8, ai] }; // scan scol low->high
    case 'right':  return { near: [16, ai], far: [8, ai] }; // scan scol high->low
    default:       return null;
  }
}

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };
const same = (b, scol, srow, color) => b && b.scol === scol && b.srow === srow && b.colorKey === color;

// CCW path (re-lock #3): bottom ~[0,0.21), right ~[0.25,0.46), top ~[0.5,0.71),
// left ~[0.75,0.96) — sample each edge squarely mid-span.
const EDGES = [
  { name: 'TOP  (fires DOWN a sub-column)',   t: 0.60 },
  { name: 'BOTTOM (fires UP a sub-column)',   t: 0.10 },
  { name: 'LEFT (fires RIGHT along sub-row)', t: 0.85 },
  { name: 'RIGHT (fires LEFT along sub-row)', t: 0.35 },
];

console.log('=== BLOCKING: first-small-block-only targeting, per edge ===\n');
for (const e of EDGES) {
  const probe = pigs._makePig('C1', 7);
  probe.location = 'conveyor';
  probe.t = e.t;
  const s = conveyor.sample(e.t);
  const nf = nearFar(s.edge, s.alignIndex);
  console.log(`${e.name}  @t=${e.t}  -> edge=${s.edge} alignSub=${s.alignIndex}`);
  check(`align index is on-board (not a corner)`, s.alignIndex >= 0 && nf !== null);
  if (s.alignIndex < 0 || !nf) { console.log(''); continue; }

  // (A) first block MATCHES the pig -> it is the target.
  resetBoard();
  place(nf.near[0], nf.near[1], 'C1');
  place(nf.far[0], nf.far[1], 'C1'); // another match further in (NOT picked first)
  const tA = pigs._lineTarget(probe);
  check(`first block matches -> target is the NEAR block ${JSON.stringify(nf.near)}`,
    same(tA, nf.near[0], nf.near[1], 'C1'));

  // (B) first block is WRONG color, a matching block buried behind it -> BLOCKED.
  resetBoard();
  place(nf.near[0], nf.near[1], 'C2');           // wrong-color front
  const buried = place(nf.far[0], nf.far[1], 'C1'); // matching, but buried
  const tB = pigs._lineTarget(probe);
  check(`wrong-color front -> target is null (BLOCKED)`, tB === null);
  check(`the buried matching block is left intact`, buried.alive === true);
  console.log('');
}

// --- one hit destroys exactly the FRONT block + decrements ammo by one --------
console.log('=== One hit = the front (matching) small block destroyed + ammo-1 ===');
{
  const probe = pigs._makePig('C1', 7);
  const s = conveyor.sample(0.60); // TOP edge (CCW path)
  const nf = nearFar(s.edge, s.alignIndex);
  resetBoard();
  const front = place(nf.near[0], nf.near[1], 'C1');
  const behind = place(nf.far[0], nf.far[1], 'C1'); // same big-block-ish, behind
  probe.location = 'conveyor';
  probe.t = 0.60;
  pigs.conveyorPigs = [probe];
  pigs.state = 'playing';

  const aliveBefore = board.aliveCount();
  const ammoBefore = probe.ammo;
  pigs.update(0.001); // tiny dt: fires once (cooldown=0), barely advances t

  check(`alive ${aliveBefore} -> ${board.aliveCount()} (expect -1, only ONE block)`, board.aliveCount() === aliveBefore - 1);
  check(`ammo ${ammoBefore} -> ${probe.ammo} (expect -1)`, probe.ammo === ammoBefore - 1);
  check(`the FRONT block was destroyed`, front.alive === false);
  check(`the block behind it survives (one shot = one block)`, behind.alive === true);
}

// --- HOLD: front block is wrong color -> no shot, ammo unchanged --------------
console.log('\n=== HOLD when the front block is a different color (blocked) ===');
{
  const probe = pigs._makePig('C1', 7);
  const s = conveyor.sample(0.85); // LEFT edge (CCW path)
  const nf = nearFar(s.edge, s.alignIndex);
  resetBoard();
  place(nf.near[0], nf.near[1], 'C2'); // wrong-color front blocks the sub-row
  place(nf.far[0], nf.far[1], 'C1');   // a C1 sits behind, unreachable
  probe.location = 'conveyor';
  probe.t = 0.85;
  pigs.conveyorPigs = [probe];
  pigs.state = 'playing';

  const aliveBefore = board.aliveCount();
  const ammoBefore = probe.ammo;
  pigs.update(0.001);
  check(`blocked: alive unchanged (${aliveBefore}) & ammo unchanged (${ammoBefore})`,
    board.aliveCount() === aliveBefore && probe.ammo === ammoBefore);
}

console.log('\n' + (allPass ? '=== ALL FIRING CHECKS PASS ===' : '=== FIRING CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
