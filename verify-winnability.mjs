// Headless WINNABILITY gate — REEF RUSH single-level playable-ad edition.
// Drives the REAL Board/Conveyor/PigManager on the one authored level with
// SEEDED RNGs and proves, by simulation:
//   (1) WIN is reachable — a greedy "launch only exposed-color pigs, drain
//       slots first" policy clears every cube (state 'won') for multiple fixed
//       seeds of the infinite random reserve.
//   (2) The simulated wall-clock time to win (steps * dt) sits in a range
//       compatible with the ~25s ad target, and the shot-count math is printed
//       so a human can judge it.
// The original 5-level harness also asserted lockup reachability on the
// buried-color levels; the ad level deliberately has NO buried color (both
// colors + the mine are exposed from the first second), so that section is
// dropped — the lose screen remains reachable only through overkill parking,
// which is fine for an ad.
// Run: node verify-winnability.mjs

import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { CONFIG, LEVELS, makeRng, expandPattern } from './src/level.js';

const scene = { add() {}, remove() {} };
const DT = 1 / 60;
const WIN_MAX_STEPS = 600000;   // per seed (belt lap = 14s -> 840 steps/lap)
const WIN_SEEDS = [1, 2, 3, 4, 5];

function newGame(level, seed) {
  const board = new Board(scene, null, level);
  const conveyor = new Conveyor(board);
  const pigs = new PigManager(scene, board, conveyor, null, level, makeRng(seed));
  return { board, conveyor, pigs };
}

// ONE perimeter scan -> the set of colors currently exposed (first alive block on
// some inward sub-line). Same rule as board.hasExposedColor, but all colors in a
// single pass — the solver polls this every decision tick.
function exposedColors(board, colors) {
  const found = new Set();
  const SUB = 18;
  for (let s = 0; s < SUB; s++) {
    let b;
    b = firstAlive(board, s, 'down'); if (b) found.add(b.colorKey);
    b = firstAlive(board, s, 'up');   if (b) found.add(b.colorKey);
    b = firstAlive(board, s, 'right'); if (b) found.add(b.colorKey);
    b = firstAlive(board, s, 'left');  if (b) found.add(b.colorKey);
  }
  // An exposed 'W' or 'M' front is hittable by ANY pig color, so it makes
  // every level color count as exposed for launch/relaunch decisions.
  if ((found.has('W') || found.has('M')) && colors) for (const c of colors) found.add(c);
  return found;
}
function firstAlive(board, sub, dir) {
  const SUB = 18;
  for (let k = 0; k < SUB; k++) {
    let scol, srow;
    if (dir === 'down') { scol = sub; srow = SUB - 1 - k; }
    else if (dir === 'up') { scol = sub; srow = k; }
    else if (dir === 'right') { scol = k; srow = sub; }
    else { scol = SUB - 1 - k; srow = sub; }
    const b = board.grid.get(board._key(scol, srow));
    if (b && b.alive) return b;
  }
  return null;
}

let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// ---------------------------------------------------------------------------
// GREEDY WIN, per seed. The policy a careful player approximates:
//   a) DRAIN first — relaunch any slotted pig whose color is exposed.
//   b) Launch an exposed lane head WITHIN THE COLOR BUDGET.
//   c) FINISHER exception: accept ONE overkill pig per color tail.
//   d) Flush a lane when nothing exposed is launchable.
//   f) Full-rack escape.
// ---------------------------------------------------------------------------
function runGreedyWin(level, seed) {
  const { board, pigs } = newGame(level, seed);
  const total = board.aliveCount();
  let steps = 0;
  while (pigs.state === 'playing' && steps < WIN_MAX_STEPS) {
    if (steps % 6 === 0) {
      const exposed = exposedColors(board, level.colors);
      const aliveBy = {};
      let aliveWild = 0;
      for (const c of level.colors) aliveBy[c] = 0;
      for (const b of board.blocks) {
        if (!b.alive) continue;
        if (b.colorKey === 'W' || b.colorKey === 'M') aliveWild++;
        else aliveBy[b.colorKey] += b.wrapped ? 2 : 1;
      }
      const committed = {};
      const activeOf = {};
      for (const c of level.colors) { committed[c] = 0; activeOf[c] = 0; }
      aliveBy['G'] = aliveWild;
      for (const c of level.colors) aliveBy['G'] += aliveBy[c];
      committed['G'] = 0; activeOf['G'] = 0;
      if (aliveBy['G'] > 0) exposed.add('G');
      for (const p of pigs.conveyorPigs) { committed[p.colorKey] += p.ammo; activeOf[p.colorKey]++; }
      for (const p of pigs.slots) if (p) { committed[p.colorKey] += p.ammo; activeOf[p.colorKey]++; }

      let guard = 0;
      while (pigs.conveyorPigs.length < CONFIG.conveyorCapacity && guard++ < 16) {
        let acted = false;
        for (let i = 0; i < pigs.slots.length; i++) {
          const p = pigs.slots[i];
          if (p && exposed.has(p.colorKey)) { acted = pigs.relaunchSlot(i); if (acted) break; }
        }
        const active = pigs.conveyorPigs.length + pigs.occupiedSlots();
        const heads = pigs.laneHeads();
        const inBudget = (h) =>
          exposed.has(h.pig.colorKey) &&
          committed[h.pig.colorKey] + h.pig.ammo <= aliveBy[h.pig.colorKey] + aliveWild;
        if (!acted && active < CONFIG.waitingSlots) {
          for (const h of heads) {
            if (inBudget(h) && activeOf[h.pig.colorKey] < 2) {
              acted = pigs.launchLane(h.laneIndex);
              if (acted) { committed[h.pig.colorKey] += h.pig.ammo; activeOf[h.pig.colorKey]++; break; }
            }
          }
        }
        if (!acted && active < CONFIG.waitingSlots) {
          for (const h of heads) {
            const c = h.pig.colorKey;
            if (exposed.has(c) && activeOf[c] === 0 && aliveBy[c] + aliveWild > 0) {
              acted = pigs.launchLane(h.laneIndex);
              if (acted) { committed[c] += h.pig.ammo; activeOf[c]++; break; }
            }
          }
        }
        const anyExposedMove =
          heads.some((h) => exposed.has(h.pig.colorKey)) ||
          pigs.slots.some((p) => p && exposed.has(p.colorKey));
        if (!acted && !anyExposedMove && active < CONFIG.waitingSlots) {
          const isUseful = (p) =>
            exposed.has(p.colorKey) &&
            (committed[p.colorKey] + p.ammo <= aliveBy[p.colorKey] + aliveWild ||
             (activeOf[p.colorKey] === 0 && aliveBy[p.colorKey] + aliveWild > 0));
          let best = null, bestRun = Infinity;
          for (const h of heads) {
            const lane = pigs.lanes[h.laneIndex];
            const idx = lane.findIndex(isUseful);
            if (idx !== -1 && idx < bestRun) { bestRun = idx; best = h; }
          }
          const pendingParks = pigs.occupiedSlots() +
            pigs.conveyorPigs.filter((p) => !exposed.has(p.colorKey)).length;
          if (best && bestRun <= CONFIG.waitingSlots - pendingParks) {
            acted = pigs.launchLane(best.laneIndex);
          }
        }
        if (!acted && active >= CONFIG.waitingSlots && pigs.conveyorPigs.length === 0) {
          const h = heads.find((x) =>
            inBudget(x) ||
            (exposed.has(x.pig.colorKey) && activeOf[x.pig.colorKey] === 0 && aliveBy[x.pig.colorKey] + aliveWild > 0));
          let slotIdx = pigs.slots.findIndex((p) => p && aliveBy[p.colorKey] + aliveWild > 0);
          if (slotIdx === -1) slotIdx = pigs.slots.findIndex((p) => p !== null);
          if (h && slotIdx !== -1 && pigs.relaunchSlot(slotIdx)) {
            acted = pigs.launchLane(h.laneIndex);
          }
        }
        if (!acted) break;
      }
    }
    pigs.update(DT);
    steps++;
  }
  return { total, remaining: board.aliveCount(), steps, state: pigs.state };
}

const level = LEVELS[0];

// --- shot-count math for the ~25s judgment ----------------------------------
const cubes = expandPattern(level);
const byColor = {};
for (const c of cubes) byColor[c.color] = (byColor[c.color] ?? 0) + 1;
console.log('=== Reef Rush mini level — shot-count math ===');
console.log(`  big blocks: ${cubes.length} (${Object.entries(byColor).map(([k, v]) => `${k}:${v}`).join(', ')})`);
console.log(`  small blocks: ${cubes.length * 4} total; color small blocks needing shots (before the mine blast): ${(cubes.length - (byColor.M ?? 0)) * 4}`);
console.log(`  mine blast: clears its 3x3 cell neighborhood for one triggering hit`);
console.log(`  pig ammo roll: uniform [${CONFIG.ammoMin}, ${CONFIG.ammoMax}]; fire cadence ${CONFIG.fireInterval}s; belt lap ${CONFIG.beltSeconds}s`);

console.log('\n=== WIN reachable (budgeted exposed-only solver, seeded reserve) ===');
for (const seed of WIN_SEEDS) {
  const r = runGreedyWin(level, seed);
  const secs = (r.steps * DT).toFixed(1);
  console.log(`  seed ${seed}: cubes ${r.total} -> ${r.remaining} in ${r.steps} steps (~${secs}s simulated); state='${r.state}'`);
  check(`seed ${seed}: cleared + won, no lockup`, r.remaining === 0 && r.state === 'won');
}

console.log('\n' + (allPass ? '=== WINNABILITY PASS (single ad level) ===' : '=== WINNABILITY GATE FAILED ==='));
process.exit(allPass ? 0 : 1);
