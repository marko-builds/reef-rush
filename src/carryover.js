// carryover.js — Phase 4 LEVEL-CLEAR SPIN carry-forwards (spec: Level-clear spin).
//
// PURE DATA transforms only — no THREE, no DOM, no storage. The spin writes one
// sessionStorage key at settle; the next boot consumes it and calls these to
// derive an EFFECTIVE level for that single boot. The level generator
// (expandPattern / Board) never learns the spin exists, and the headless
// harnesses can drive these functions deterministically with a seeded rand.
//
// Carry flags (JSON under CARRY_KEY): { golden, mine, dewrap, bonusSlot } —
// all optional booleans. Consumed (read + deleted) at boot; a lose-retry
// reboots the AUTHORED level (spec: Expiry — first boot of the next level only).

import { GRID_COLS, GRID_ROWS } from './level.js';

export const CARRY_KEY = 'fof-spin-carry';

// VALID injected-mine cells (spec: Level-clear spin, segment D): an INNER cell
// (col,row in 1..GRID-2 — start-buried by construction on these fully-ringed
// boards, which keeps the graded flood-lockup on L2/L5 reachable) holding a
// plain COLOR block — never '.', never an authored 'W'/'M', and never a
// seaweed-wrapped cell (mines can't wrap; we don't silently eat a wrap either).
export function validMineCells(level) {
  const wrapSet = new Set((level.wraps ?? []).map((w) => w.col + ',' + w.row));
  const cells = [];
  for (let row = 1; row <= GRID_ROWS - 2; row++) {
    const pr = GRID_ROWS - 1 - row; // PATTERN[0] = top row
    for (let col = 1; col <= GRID_COLS - 2; col++) {
      const ch = level.pattern[pr][col];
      if (ch === '.' || ch === 'W' || ch === 'M') continue;
      if (wrapSet.has(col + ',' + row)) continue;
      cells.push({ col, row });
    }
  }
  return cells;
}

// Derive the EFFECTIVE level for this boot from the authored one + the carry
// flags. Returns the authored object untouched when nothing applies (so the
// no-carry boot is bit-identical to today). The mine pick uses `rand` (game:
// Math.random; harnesses: a seeded rng) and reports the chosen cell on the
// returned level as `injectedMine` (for the HUD-free verify printouts).
export function applyCarryover(level, carry, rand = Math.random) {
  if (!carry) return level;
  let lv = level;
  if (carry.mine) {
    const cells = validMineCells(level);
    if (cells.length > 0) {
      const pick = cells[Math.floor(rand() * cells.length) % cells.length];
      const pr = GRID_ROWS - 1 - pick.row;
      const pattern = level.pattern.slice();
      pattern[pr] = pattern[pr].slice(0, pick.col) + 'M' + pattern[pr].slice(pick.col + 1);
      lv = { ...lv, pattern, injectedMine: pick };
    }
  }
  if (carry.dewrap && (lv.wraps?.length ?? 0) > 0) {
    lv = lv === level ? { ...lv, wraps: [] } : Object.assign(lv, { wraps: [] });
  }
  return lv;
}
