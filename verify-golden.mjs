// Headless verification (Phase 4 feature 6) — GOLDEN PIG (spec: Golden pig).
// 1) two same-color blocks in line -> ONE shot destroys both (pierce), ammo -2
// 2) different-color pair (C2 front, C1 behind) -> BOTH destroyed (color ignored)
// 3) only one block in line -> destroys that one only, ammo -1
// 4) ammo 1 -> first hit only (no pierce without ammo), pig departs spent
// 5) wrapped front block -> peel + destroy the SAME block in one shot, ammo -2
// 6) mine as FIRST hit -> explosion, pierce CONSUMED (no second target read)
// 7) mine as SECOND (pierce) hit -> explosion triggers normally
// 8) lockup semantics: a returning GOLDEN pig re-laps while ANY block lives;
//    a slotted golden does NOT veto another pig's lockup (locked-spec reading)
// 9) reserve generation: ~3% golden rate, color 'G', fixed ammo 5
// 10) lane sync NEVER culls golden pigs
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
function place(scol, srow, colorKey, wrapped = false) {
  const mesh = new THREE.Mesh(board._subGeo, board._materialFor(colorKey));
  board.group.add(mesh);
  const block = { scol, srow, colorKey, alive: true, wrapped, mesh };
  board.blocks.push(block);
  board.grid.set(board._key(scol, srow), block);
  return block;
}
function goldenProbe(ammo = CONFIG.goldenAmmo) {
  const p = pigs._makePig('G', ammo);
  p.golden = true;
  return p;
}
function fireOnce(probe, t) {
  probe.location = 'conveyor'; probe.t = t; probe.fireTimer = 0;
  pigs.conveyorPigs = [probe]; pigs.state = 'playing';
  pigs.vfx.length = 0;
  pigs.update(0.001);
  const events = [...pigs.vfx];
  pigs.vfx.length = 0;
  pigs.conveyorPigs = [];
  return events;
}

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// find a RIGHT-edge belt position (fires leftward along its sub-row): the CCW
// path is bottom -> right -> top -> left, so scan t for edge === 'right'.
let tRight = -1;
for (let t = 0; t < 1; t += 0.002) {
  const s = conveyor.sample(t);
  if (s.edge === 'right' && s.alignIndex >= 4 && s.alignIndex <= 13) { tRight = t; break; }
}
const sR = conveyor.sample(tRight);
const ROW = sR.alignIndex; // the sub-row the right-edge probe fires along
console.log(`probe: t=${tRight.toFixed(3)} edge=${sR.edge} alignSub=${ROW}\n`);

console.log('=== (1) pierce: two C1 blocks first in line -> ONE shot kills both, ammo -2 ===');
{
  resetBoard();
  const first = place(16, ROW, 'C1');
  const second = place(12, ROW, 'C1');
  const keep = place(2, ROW, 'C2'); // third block: must NOT be hit (pierce depth 2)
  const probe = goldenProbe();
  const ev = fireOnce(probe, tRight);
  check('both C1 blocks destroyed', !first.alive && !second.alive);
  check('third block untouched (pierce stops at 2)', keep.alive === true);
  check(`ammo ${CONFIG.goldenAmmo} -> ${CONFIG.goldenAmmo - 2} (1 per hit)`, probe.ammo === CONFIG.goldenAmmo - 2);
  const fires = ev.filter((e) => e.type === 'fire');
  check('one shot = two fire events, second flagged pierce',
    fires.length === 2 && fires[0].pierce === undefined && fires[1].pierce === true);
  check('one cadence cooldown set for the pair', probe.fireTimer > 0);
}

console.log('\n=== (2) color ignored: C2 front + C1 behind -> BOTH destroyed ===');
{
  resetBoard();
  const front = place(16, ROW, 'C2');
  const behind = place(10, ROW, 'C1');
  const probe = goldenProbe();
  fireOnce(probe, tRight);
  check('C2 front destroyed by the golden pig', front.alive === false);
  check('C1 behind destroyed by the pierce', behind.alive === false);
  check('ammo -2', probe.ammo === CONFIG.goldenAmmo - 2);
}

console.log('\n=== (3) single block in line -> one hit only, ammo -1 ===');
{
  resetBoard();
  const only = place(16, ROW, 'C2');
  place(16, (ROW + 4) % 18, 'C1'); // another row: keeps the board non-empty
  const probe = goldenProbe();
  const ev = fireOnce(probe, tRight);
  check('the only block destroyed', only.alive === false);
  check('ammo -1 (no phantom pierce)', probe.ammo === CONFIG.goldenAmmo - 1);
  check('exactly one fire event', ev.filter((e) => e.type === 'fire').length === 1);
}

console.log('\n=== (4) ammo 1 -> no pierce without ammo; pig departs spent ===');
{
  resetBoard();
  const first = place(16, ROW, 'C1');
  const second = place(12, ROW, 'C1');
  const probe = goldenProbe(1);
  fireOnce(probe, tRight);
  check('first block destroyed', first.alive === false);
  check('second SURVIVES (pierce needs ammo left)', second.alive === true);
  check('ammo 1 -> 0, pig left mid-lap', probe.ammo === 0 && probe.location === 'gone');
}

console.log('\n=== (5) wrapped front block -> peel + destroy the SAME block in one shot ===');
{
  resetBoard();
  const wrapped = place(16, ROW, 'C1', true);
  place(2, ROW, 'C2'); // far behind: must survive (the pierce lands on the rewrapped front)
  const probe = goldenProbe();
  const ev = fireOnce(probe, tRight);
  const fires = ev.filter((e) => e.type === 'fire');
  check('wrapped block destroyed in ONE shot (peel + pierce kill)', wrapped.alive === false);
  check('ammo -2 (the wrap costs the pierce)', probe.ammo === CONFIG.goldenAmmo - 2);
  check('event pair: dewrap first, destroying pierce second on the SAME block',
    fires.length === 2 && fires[0].dewrap === true && fires[1].dewrap === false &&
    fires[0].scol === fires[1].scol && fires[0].srow === fires[1].srow);
  check('block far behind untouched', board.grid.get(board._key(2, ROW)).alive === true);
}

console.log('\n=== (6) mine as FIRST hit -> explosion; pierce CONSUMED ===');
{
  resetBoard();
  const mine = place(16, ROW, 'M');
  const far = place(4, ROW, 'C1'); // outside the blast square (cols 14..19) AND past the pierce
  const probe = goldenProbe();
  const ev = fireOnce(probe, tRight);
  check('mine destroyed + explosion event fired',
    mine.alive === false && ev.some((e) => e.type === 'mineExplode'));
  check('ammo -1 only (the blast is free; the pierce is consumed)', probe.ammo === CONFIG.goldenAmmo - 1);
  check('block beyond the blast SURVIVES (no pierce after an explosion)', far.alive === true);
}

console.log('\n=== (7) mine as SECOND (pierce) hit -> explosion triggers normally ===');
{
  resetBoard();
  const front = place(16, ROW, 'C2');
  const mine = place(12, ROW, 'M'); // blast square cols 10..15: front@16 already gone
  const far = place(2, ROW, 'C1');  // outside the blast: survives
  const probe = goldenProbe();
  const ev = fireOnce(probe, tRight);
  check('front destroyed, mine pierced + exploded',
    front.alive === false && mine.alive === false && ev.some((e) => e.type === 'mineExplode'));
  check('ammo -2 (front hit + mine trigger)', probe.ammo === CONFIG.goldenAmmo - 2);
  check('block outside the blast survives', far.alive === true);
}

console.log('\n=== (8) lockup semantics ===');
{
  resetBoard();
  // only C2 blocks alive; no exposed C1 anywhere
  for (let scol = 0; scol < 18; scol++) place(scol, 16, 'C2');
  console.log('  reachability with only C2 fronts:');
  check(`hasExposedColor('G') === true (golden reaches anything)`, board.hasExposedColor('G') === true);
  check(`hasExposedColor('C1') === false (control)`, board.hasExposedColor('C1') === false);
  // 5 slots full; a GOLDEN rider crosses the belt end with ammo -> must RE-LAP.
  for (let i = 0; i < 5; i++) {
    const parked = pigs._makePig('C1', 5);
    parked.location = 'slot'; parked.slotIndex = i;
    pigs.slots[i] = parked;
  }
  const goldRider = goldenProbe();
  goldRider.location = 'conveyor'; goldRider.t = 0.9999;
  goldRider.fireTimer = 999; // routing only — suppress firing this frame
  pigs.conveyorPigs = [goldRider]; pigs.state = 'playing';
  pigs.update(0.01);
  check(`returning GOLDEN pig re-laps (state stays 'playing')`,
    pigs.state === 'playing' && goldRider.location === 'conveyor' && goldRider.t < 0.1);
  pigs.conveyorPigs = [];
  // swap slot 0 to a GOLDEN pig; a C1 rider jams -> the slotted golden does
  // NOT veto the lockup (locked spec: condition 3 is the RETURNING pig only).
  pigs.slots[0] = goldenProbe();
  pigs.slots[0].location = 'slot'; pigs.slots[0].slotIndex = 0;
  const c1Rider = pigs._makePig('C1', 5);
  c1Rider.location = 'conveyor'; c1Rider.t = 0.9999;
  c1Rider.fireTimer = 999;
  pigs.conveyorPigs = [c1Rider]; pigs.state = 'playing';
  pigs.update(0.01);
  check(`C1 rider with no exposed C1 still LOCKS UP despite a slotted golden`, pigs.state === 'lost');
  pigs.conveyorPigs = []; pigs.slots.fill(null);
}

console.log('\n=== (9) reserve generation: goldens are SCRIPTED, never random (ad build) ===');
{
  // The ad's one golden is the goldenHead boot option; goldenChance stays 0 so
  // the random reserve can never mint a second on top of the scripted moment.
  check('goldenChance is 0 (the golden moment is scripted, not rolled)', CONFIG.goldenChance === 0);
  const b2 = new Board(scene, null, LEVELS[0]);
  const c2 = new Conveyor(b2);
  const p2 = new PigManager(scene, b2, c2, null, LEVELS[0], makeRng(42));
  const N = 5000;
  let golden = 0;
  for (let i = 0; i < N; i++) if (p2._spawnQueuePig().colorKey === 'G') golden++;
  check(`${N} reserve draws mint ZERO random goldens`, golden === 0);
  // forceGolden (the scripted path) still mints a real one, without an rng draw.
  const forced = p2._spawnQueuePig(true);
  check(`forceGolden mints color G, ammo ${CONFIG.goldenAmmo}, golden flag`,
    forced.colorKey === 'G' && forced.ammo === CONFIG.goldenAmmo && forced.golden === true);
  // And the goldenHead boot option seats exactly ONE golden, at a lane head.
  const b3 = new Board(scene, null, LEVELS[0]);
  const p3 = new PigManager(scene, b3, new Conveyor(b3), null, LEVELS[0], makeRng(7), { goldenHead: true });
  const goldHeads = p3.laneHeads().filter((h) => h.pig.colorKey === 'G').length;
  const goldTotal = p3.lanes.flat().filter((p) => p.colorKey === 'G').length;
  check('goldenHead boot: exactly ONE golden in the lanes, seated at a head', goldHeads === 1 && goldTotal === 1);
}

console.log('\n=== (10) lane sync NEVER culls golden pigs ===');
{
  resetBoard();
  place(0, 0, 'C1'); // one lone C1 block: C2 cap is 0, C1 cap is 1
  for (const lane of pigs.lanes) for (const p of lane) { p.location = 'gone'; p.mesh.visible = false; }
  pigs.lanes = Array.from({ length: CONFIG.laneCount }, () => []);
  for (const lane of pigs.lanes) {
    while (lane.length < CONFIG.laneDepth) lane.push(goldenProbe());
  }
  pigs._syncLanesToBoard();
  const allGolden = pigs.lanes.every((lane) =>
    lane.length === CONFIG.laneDepth && lane.every((p) => p.colorKey === 'G'));
  check('all-golden lanes untouched by the sync (no cull, no replacement)', allGolden);
}

console.log('\n' + (allPass ? '=== ALL GOLDEN-PIG CHECKS PASS ===' : '=== GOLDEN-PIG CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
