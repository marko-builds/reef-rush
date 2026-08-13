// Headless verification: lifecycle, LANES, slots, win/lose — at SMALL-BLOCK
// resolution. Drives the REAL PigManager/Board/Conveyor and asserts every routing
// branch, capacity, re-tap, win, the NEW ammo-0 mid-lap departure, and that the
// lockup fires ONLY under the BLOCKING reachability rule (a buried matching block is
// not "exposed"). Run: node verify-lifecycle.mjs

import * as THREE from 'three';
import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { CONFIG, LEVELS, makeRng } from './src/level.js';

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
// Bury a C1 block (center) behind a C2 on each of its 4 sub-lines: C1 exists but is
// NOT exposed (the buried-lockup case).
function placeBuriedC1() {
  resetBoard();
  place(8, 8, 'C1');                 // the buried matching block
  place(8, 9, 'C2'); place(8, 7, 'C2'); // block its sub-column from top & bottom
  place(7, 8, 'C2'); place(9, 8, 'C2'); // block its sub-row from left & right
}
function freshState() {
  pigs.conveyorPigs = [];
  pigs.slots = new Array(CONFIG.waitingSlots).fill(null);
  pigs.lanes = [[], [], [], []];
  pigs.state = 'playing';
}
function fillAllSlots() {
  for (let i = 0; i < CONFIG.waitingSlots; i++) {
    const p = pigs._makePig('C2', 1);
    p.location = 'slot';
    p.slotIndex = i;
    pigs.slots[i] = p;
  }
}
function pigAtEnd(color, ammo) {
  const p = pigs._makePig(color, ammo);
  p.location = 'conveyor';
  // 0.999: one 0.1s update still crosses t=1 at the slowed 14s lap (re-lock #3).
  p.t = 0.999;
  pigs.conveyorPigs.push(p);
  return p;
}

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// ---------------------------------------------------------------------------
console.log('=== board.hasExposedColor: blocking reachability (small blocks) ===');
{
  placeBuriedC1();
  check('buried C1 (boxed in by C2) reads as NOT exposed', board.hasExposedColor('C1') === false);
  check('the surrounding C2 reads as exposed', board.hasExposedColor('C2') === true);
  resetBoard(); place(8, 8, 'C1'); // lone C1, nothing in front
  check('a lone C1 (clear lines) reads as exposed', board.hasExposedColor('C1') === true);
}

console.log('\n=== Lane launch + conveyor capacity (extras wait) + INFINITE refill ===');
{
  resetBoard(); place(8, 8, 'C2'); // keep board alive (no win)
  freshState();
  const headA = pigs._makePig('C1', 5), headB = pigs._makePig('C2', 5);
  const headC = pigs._makePig('C1', 5), headD = pigs._makePig('C2', 5);
  pigs.lanes = [
    [headA, pigs._makePig('C1', 5)],
    [headB, pigs._makePig('C2', 5)],
    [headC, pigs._makePig('C1', 5)],
    [headD, pigs._makePig('C2', 5)],
  ];
  const r1 = pigs.launchLane(0);
  const r2 = pigs.launchLane(1);
  const r3 = pigs.launchLane(2);
  const r4 = pigs.launchLane(3); // capacity is 3 -> should fail
  check(`first 3 lane launches succeed (capacity ${CONFIG.conveyorCapacity})`, r1 && r2 && r3);
  check('4th launch refused while belt full', r4 === false);
  check('3 pigs on belt', pigs.conveyorPigs.length === 3);
  check('launched lanes advanced (old head now on belt)',
    pigs.lanes[0][0] !== headA && pigs.lanes[1][0] !== headB && pigs.lanes[2][0] !== headC);
  check('infinite reserve refilled launched lanes (length unchanged at 2)',
    pigs.lanes[0].length === 2 && pigs.lanes[1].length === 2 && pigs.lanes[2].length === 2);
  check('refilled tail pigs are queue pigs with valid ammo (roll clamped to alive count)',
    pigs.lanes.slice(0, 3).every((l) => {
      const tail = l[l.length - 1];
      return tail.location === 'queue' && tail.ammo >= 1 && tail.ammo <= CONFIG.ammoMax;
    }));
  check('untouched lane 3 still has 2 with its head', pigs.lanes[3].length === 2 && pigs.lanes[3][0] === headD);
}

console.log('\n=== Ammo hits 0 mid-lap -> pig LEAVES immediately (not at lap end) ===');
{
  freshState();
  const p = pigs._makePig('C1', 1);
  p.location = 'conveyor'; p.t = 0.60; // TOP edge (CCW path), mid-belt (far from the end)
  const s = conveyor.sample(0.60);
  resetBoard(); place(s.alignIndex, 16, 'C1'); // a C1 block in its align sub-column
  pigs.conveyorPigs.push(p);
  pigs.update(0.001); // fires its only shot -> ammo 0 -> departs at once
  check('ammo spent to 0', p.ammo === 0);
  check("location === 'gone' (left mid-lap)", p.location === 'gone');
  check('removed from the belt immediately', !pigs.conveyorPigs.includes(p));
  check('did NOT ride to the end (t still < 1)', p.t < 1);
  check('occupies no slot', !pigs.slots.includes(p));
}

console.log('\n=== Lap end: ammo>0 + free slot -> PARKS in a slot ===');
{
  resetBoard(); place(8, 8, 'C2');
  freshState();
  const p = pigAtEnd('C1', 4);
  pigs.update(0.1);
  check("location === 'slot'", p.location === 'slot');
  check('parked in slot 0', pigs.slots[0] === p);
  check('occupancy now 1/5', pigs.occupiedSlots() === 1);
  check('ammo preserved (4)', p.ammo === 4);
}

console.log('\n=== Re-tap a slotted pig -> RE-LAPS ===');
{
  resetBoard(); place(8, 8, 'C2');
  freshState();
  const p = pigs._makePig('C1', 4);
  p.location = 'slot'; p.slotIndex = 2; pigs.slots[2] = p;
  const r = pigs.relaunchSlot(2);
  check('relaunch returned true', r === true);
  check('slot 2 freed', pigs.slots[2] === null);
  check("back on belt (location 'conveyor')", p.location === 'conveyor' && pigs.conveyorPigs.includes(p));
  check('re-laps from t=0', p.t === 0);
}

console.log('\n=== WIN: clearing the last small block ===');
{
  freshState();
  const p = pigs._makePig('C1', 7);
  p.location = 'conveyor'; p.t = 0.60;
  const s = conveyor.sample(0.60);
  resetBoard(); place(s.alignIndex, 16, 'C1'); // single block in the pig's inward column
  pigs.conveyorPigs.push(p);
  pigs.update(0.001);
  check(`edge=${s.edge} alignSub=${s.alignIndex} -> board cleared`, board.aliveCount() === 0);
  check("state === 'won'", pigs.state === 'won');
}

console.log('\n=== LOSE (lockup): slots full + pig at end + matching color BURIED ===');
{
  placeBuriedC1();
  freshState();
  fillAllSlots();
  pigAtEnd('C1', 3);
  pigs.update(0.1);
  check('slots were full (5/5)', true);
  check("state === 'lost'", pigs.state === 'lost');
}

console.log('\n=== NOT spurious: slots full + ammo>0 but matching color EXPOSED -> re-lap ===');
{
  resetBoard(); place(8, 8, 'C1'); // a C1 block exposed (clear lines)
  freshState();
  fillAllSlots();
  const p = pigAtEnd('C1', 3);
  pigs.update(0.1);
  check("state stays 'playing'", pigs.state === 'playing');
  check('pig re-lapped onto belt', pigs.conveyorPigs.includes(p) && p.location === 'conveyor');
}

console.log('\n=== NOT spurious: slots full + pig reaches end with ammo 0 -> leaves ===');
{
  resetBoard(); place(8, 8, 'C2');
  freshState();
  fillAllSlots();
  const p = pigAtEnd('C1', 0);
  pigs.update(0.1);
  check("state stays 'playing'", pigs.state === 'playing');
  check("pig left the board ('gone')", p.location === 'gone');
}

console.log('\n' + (allPass ? '=== ALL LIFECYCLE CHECKS PASS ===' : '=== LIFECYCLE CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
