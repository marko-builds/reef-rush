// Headless verification for the QUEUE VISIBILITY LOCK (spec: Visibility boundary,
// Phase 5 fix 5.1): the visible 4x3 grid — rows 0..2 of every lane — is FROZEN
// once the level starts. The lane<->board winnability sync may remove/replace
// pigs ONLY in row 3 and deeper (the off-screen reserve).
//
// Drill: build a level, snapshot the visible rows, then SLAUGHTER one color's
// blocks so its queued pigs go massively over-quota and trigger the sync.
// Assert: rows 0-2 of all 4 lanes are bit-identical (same pig objects, same
// color/ammo); the cut happened in the reserve rows only.
// Run: node verify-queuelock.mjs   (from the repo root)

import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager, VISIBLE_ROWS } from './src/pigs.js';
import { CONFIG, makeRng } from './src/level.js';

const scene = { add() {}, remove() {} };

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

const snapshot = (pigs) =>
  pigs.lanes.map((lane) =>
    lane.slice(0, VISIBLE_ROWS).map((p) => ({ ref: p, colorKey: p.colorKey, ammo: p.ammo }))
  );

const fmt = (rows) =>
  rows.map((lane, li) => `lane${li}[` + lane.map((e) => `${e.colorKey}:${e.ammo}`).join(' ') + ']').join('  ');

// The shipped roster is the ONE ad level, so the drill authors its own fixture:
// a Bullseye-style two-color board (a C1 shell around a buried C2 core) with
// plenty of stale-pig pressure once the shell color is slaughtered below.
const FIXTURE = {
  id: 99,
  name: 'Queue-lock fixture',
  colors: ['C1', 'C2'],
  pattern: [
    '.........',
    '.AAAAAAA.',
    '.ABBBBBA.',
    '.ABBBBBA.',
    '.ABBBBBA.',
    '.ABBBBBA.',
    '.ABBBBBA.',
    '.AAAAAAA.',
    '.........',
  ],
};

for (const seed of [1, 2, 3]) {
  const level = FIXTURE;
  const board = new Board(scene, null, level);
  const conveyor = new Conveyor(board);
  const pigs = new PigManager(scene, board, conveyor, null, level, makeRng(seed));

  console.log(`\n=== seed ${seed} — level "${level.name}" ===`);
  const before = snapshot(pigs);
  console.log('  visible rows BEFORE sync: ' + fmt(before));

  // Mid-level shock: destroy almost every block of the first color so the queue
  // is suddenly far over that color's allowance -> the sync MUST fire.
  const victim = level.colors[0];
  let left = 2; // leave a couple alive so cap = 1 (deep over-quota, not zero)
  for (const b of board.blocks) {
    if (b.alive && b.colorKey === victim) {
      if (left > 0) { left--; continue; }
      board.destroy(b);
    }
  }
  const deepBefore = pigs.lanes.map((l) => l.slice(VISIBLE_ROWS).map((p) => `${p.colorKey}:${p.ammo}`).join(' '));
  pigs._syncLanesToBoard();
  const after = snapshot(pigs);
  console.log('  visible rows AFTER  sync: ' + fmt(after));

  let frozen = true;
  for (let li = 0; li < before.length; li++) {
    for (let ri = 0; ri < VISIBLE_ROWS; ri++) {
      const b = before[li][ri], a = after[li][ri];
      if (!a || b.ref !== a.ref || b.colorKey !== a.colorKey || b.ammo !== a.ammo) frozen = false;
    }
  }
  check(`rows 0-${VISIBLE_ROWS - 1} of all ${CONFIG.laneCount} lanes unchanged (same pigs)`, frozen);

  const deepAfter = pigs.lanes.map((l) => l.slice(VISIBLE_ROWS).map((p) => `${p.colorKey}:${p.ammo}`).join(' '));
  const reserveChanged = deepBefore.join('|') !== deepAfter.join('|');
  check(`the cut landed in the off-screen reserve (rows ${VISIBLE_ROWS}+ changed)`, reserveChanged);

  check('lanes still full depth (reserve refilled)',
    pigs.lanes.every((l) => l.length === CONFIG.laneDepth));
}

console.log(allPass ? '\nALL PASS' : '\nFAILURES');
process.exit(allPass ? 0 : 1);
