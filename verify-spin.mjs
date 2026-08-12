// Headless LEVEL-CLEAR SPIN gate (Phase 4, spec: Level-clear spin).
// The wheel itself is presentation; everything that can change a BOOT is pure
// data and is proven here:
//   (A) validMineCells: only INNER (start-buried) color cells — never '.',
//       never an authored W/M, never a seaweed-wrapped cell — on levels 2-5.
//   (B) applyCarryover MINE: the effective pattern gains exactly ONE extra 'M'
//       at the reported cell; wilds/wraps untouched; the AUTHORED level object
//       is never mutated. Board printout for review.
//   (C) applyCarryover DEWRAP: the effective level boots with ZERO wrapped
//       blocks; the authored level keeps its wraps.
//   (D) no carry -> the authored object passes through by REFERENCE.
//   (E) goldenHead option: exactly one golden pig among the 4 lane heads,
//       fixed ammo, lanes at full depth; option off -> no forced golden.
//   (F) wheelTarget math: every segment's CENTER lands under the TOP pointer
//       after >= SPIN_TURNS clockwise turns (result-predetermined model).
//   (G) SEGMENTS table sanity: the 6 authored rewards.
//   (H) bonus slot: CONFIG.waitingSlots = 6 is honored by the slot rack.
// Run: node verify-spin.mjs   (from styled_fof_version/)

import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { CONFIG, LEVELS, GRID_COLS, GRID_ROWS, makeRng } from './src/level.js';
import { validMineCells, applyCarryover } from './src/carryover.js';
import { SEGMENTS, wheelTarget, SPIN_TURNS } from './src/spin.js';

const scene = { add() {}, remove() {} };
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

const cellChar = (level, col, row) => level.pattern[GRID_ROWS - 1 - row][col];
const printBoard = (level, note) => {
  console.log(`  board ${note}:`);
  for (const line of level.pattern) console.log(`    ${line.split('').join(' ')}`);
};

// ---------------------------------------------------------------------------
console.log('=== (A) validMineCells: inner color cells only (levels 2-5) ===');
for (const level of LEVELS.slice(1)) {
  const cells = validMineCells(level);
  const wrapSet = new Set((level.wraps ?? []).map((w) => w.col + ',' + w.row));
  let ok = cells.length > 0;
  for (const { col, row } of cells) {
    const ch = cellChar(level, col, row);
    if (col < 1 || col > GRID_COLS - 2 || row < 1 || row > GRID_ROWS - 2) ok = false;
    if (ch === '.' || ch === 'W' || ch === 'M') ok = false;
    if (wrapSet.has(col + ',' + row)) ok = false;
  }
  check(`L${level.id}: ${cells.length} valid cells, all inner + color + unwrapped`, ok);
}

// ---------------------------------------------------------------------------
console.log('\n=== (B) carry MINE: one extra M at the reported cell, authored level untouched ===');
for (const level of LEVELS.slice(1)) {
  const authoredM = level.pattern.join('').split('M').length - 1;
  const authoredW = level.pattern.join('').split('W').length - 1;
  const eff = applyCarryover(level, { mine: true }, makeRng(7));
  const effM = eff.pattern.join('').split('M').length - 1;
  const effW = eff.pattern.join('').split('W').length - 1;
  const pick = eff.injectedMine;
  check(`L${level.id}: M count ${authoredM} -> ${effM} (+1) at injected (${pick.col},${pick.row})`,
    effM === authoredM + 1 && cellChar(eff, pick.col, pick.row) === 'M');
  check(`L${level.id}: wilds unchanged (${effW}) + authored pattern unmutated`,
    effW === authoredW &&
    level.pattern.join('').split('M').length - 1 === authoredM &&
    validMineCells(level).some((c) => c.col === pick.col && c.row === pick.row));
}
printBoard(applyCarryover(LEVELS[1], { mine: true }, makeRng(7)), 'L2 with injected mine (seed 7)');

// ---------------------------------------------------------------------------
console.log('\n=== (C) carry DEWRAP: effective level boots with zero wrapped blocks ===');
for (const level of [LEVELS[3], LEVELS[4]]) {
  const eff = applyCarryover(level, { dewrap: true });
  const effBoard = new Board(scene, null, eff);
  const authBoard = new Board(scene, null, level);
  const effWrapped = effBoard.blocks.filter((b) => b.wrapped).length;
  const authWrapped = authBoard.blocks.filter((b) => b.wrapped).length;
  check(`L${level.id}: wrapped sub-blocks ${authWrapped} -> ${effWrapped}; authored wraps kept (${level.wraps.length} cells)`,
    effWrapped === 0 && authWrapped === level.wraps.length * 4 && level.wraps.length > 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== (D) no carry: authored level passes through by reference ===');
check('applyCarryover(L3, null) === L3', applyCarryover(LEVELS[2], null) === LEVELS[2]);
check('applyCarryover(L3, {}) === L3 (no flags set)', applyCarryover(LEVELS[2], {}) === LEVELS[2]);

// ---------------------------------------------------------------------------
console.log('\n=== (E) goldenHead option: exactly one golden lane head ===');
{
  const level = LEVELS[1];
  const mk = (opts) => {
    const board = new Board(scene, null, level);
    const conveyor = new Conveyor(board);
    return new PigManager(scene, board, conveyor, null, level, makeRng(2), opts);
  };
  const pigs = mk({ goldenHead: true });
  const goldenHeads = pigs.laneHeads().filter((h) => h.pig.colorKey === 'G');
  check('exactly 1 golden head; golden=true; ammo=goldenAmmo',
    goldenHeads.length === 1 &&
    goldenHeads[0].pig.golden === true &&
    goldenHeads[0].pig.ammo === CONFIG.goldenAmmo);
  check('all 4 lanes still at full depth',
    pigs.lanes.every((l) => l.length === CONFIG.laneDepth));
  const plain = mk({});
  // seed 2 mints no natural golden in the first 24 pigs -> heads are colors
  check('option off (same seed): no golden head',
    plain.laneHeads().every((h) => h.pig.colorKey !== 'G'));
}

// ---------------------------------------------------------------------------
console.log('\n=== (F) wheelTarget: every segment center parks under the TOP pointer ===');
{
  const TAU = Math.PI * 2;
  let ok = true;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const r = wheelTarget(i);
    const shown = (((i + 0.5) * (Math.PI / 3) + r) % TAU + TAU) % TAU; // displayed angle
    const atTop = Math.abs(shown - Math.PI / 2) < 1e-9;
    const turns = Math.abs(r) / TAU; // travel includes >= SPIN_TURNS full turns
    if (!atTop || turns < SPIN_TURNS - 1) ok = false;
    console.log(`  segment ${i} (${SEGMENTS[i].key}): rotation ${r.toFixed(3)} rad -> shown at ${(shown * 180 / Math.PI).toFixed(1)} deg`);
  }
  check(`all 6 segments land at 90 deg (pointer) with >= ${SPIN_TURNS - 1} full turns of travel`, ok);
}

// ---------------------------------------------------------------------------
console.log('\n=== (G) SEGMENTS table sanity ===');
check('6 segments; rewards = 500/1000/300 coins + golden/mine/dewrap/bonusSlot carries',
  SEGMENTS.length === 6 &&
  SEGMENTS.filter((s) => s.coins).map((s) => s.coins).sort((a, b) => a - b).join(',') === '300,500,1000' &&
  ['golden', 'mine', 'dewrap', 'bonusSlot'].every((k) => SEGMENTS.some((s) => s.carry === k)));
check('jackpot flag on golden + mine only',
  SEGMENTS.filter((s) => s.jackpot).map((s) => s.carry).sort().join(',') === 'golden,mine');

// ---------------------------------------------------------------------------
console.log('\n=== (H) bonus slot: CONFIG.waitingSlots = 6 honored ===');
{
  const level = LEVELS[1];
  const prev = CONFIG.waitingSlots;
  CONFIG.waitingSlots = 6;
  const board = new Board(scene, null, level);
  const pigs = new PigManager(scene, board, new Conveyor(board), null, level, makeRng(1));
  check('slot rack boots with 6 seats', pigs.slots.length === 6);
  CONFIG.waitingSlots = prev;
}

console.log('\n' + (allPass ? '=== SPIN CARRY-FORWARD GATE PASSED ===' : '=== SPIN GATE FAILED ==='));
process.exit(allPass ? 0 : 1);
