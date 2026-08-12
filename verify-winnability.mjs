// Headless WINNABILITY + LOCKUP-REACHABILITY gate (graded criteria) — 5-level,
// INFINITE-QUEUE edition (spec re-lock #3). Drives the REAL Board/Conveyor/
// PigManager on every authored level with SEEDED RNGs and proves, by simulation:
//   (1) WIN is reachable on EVERY level — a greedy "launch only exposed-color
//       pigs, drain slots first" policy clears every cube (state 'won') for
//       multiple fixed seeds of the infinite random reserve.
//   (2) LOSE is reachable on the buried-color levels (2: C2 buried, 5: C4 buried)
//       — flooding the buried color fills the slots -> the structural lockup.
//       Reachability is existential, so the harness may search a few seeds.
// If either fails, the level patterns / reserve weighting must be retuned.
// Run: node verify-winnability.mjs   (from each build dir)

import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { CONFIG, LEVELS, makeRng } from './src/level.js';
import { applyCarryover } from './src/carryover.js';

const scene = { add() {}, remove() {} };
const DT = 1 / 60;
const WIN_MAX_STEPS = 600000;   // per seed (belt lap = 14s -> 840 steps/lap)
const LOSE_MAX_STEPS = 120000;  // per seed for the flood policy
const WIN_SEEDS = [1, 2, 3];    // every level must be won on ALL of these
const LOSE_SEED_SEARCH = 60;    // search seeds 1..N for one reachable lockup

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
  // Phase 4 WILD + MINE rule: an exposed 'W' or 'M' front is hittable by ANY
  // pig color, so it makes every level color count as exposed for launch/
  // relaunch decisions. (The mine's explosion needs no separate simulation —
  // the harness drives the REAL pigs.update/board.explodeMine code.)
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
// (1) GREEDY WIN, per level x seed. The policy a careful player approximates:
//   a) DRAIN first — relaunch any slotted pig whose color is exposed (frees a
//      seat, the active count is unchanged -> always safe).
//   b) Launch an exposed lane head WITHIN THE COLOR BUDGET: total ammo of
//      active pigs (belt + slots) of that color must fit inside its remaining
//      blocks. This is the anti-hog rule — without it, overkill pigs of a
//      nearly-cleared color return as permanent seat hogs and wedge the rack.
//   c) FINISHER exception: a color is exposed but every head of it overshoots
//      the budget and NO active pig of it exists -> accept ONE overkill pig
//      (someone has to clear the color's tail; at most one hog per color, and
//      colors ≤ 4 < the 5 seats).
//   d) Last resort (infinite queue): nothing launchable and the belt is idle ->
//      cycle a lane to reroll its head, keeping one seat spare.
// ---------------------------------------------------------------------------
// The greedy run for one (level, seed), extracted so the Phase 4 spin section
// (3) can re-prove the win on carry-modified boards with the SAME policy.
function runGreedyWin(level, seed) {
  {
    const { board, pigs } = newGame(level, seed);
    const total = board.aliveCount();
    let steps = 0;
    while (pigs.state === 'playing' && steps < WIN_MAX_STEPS) {
      // Decision tick every 6 steps (0.1s sim) — cheaper, same outcomes.
      if (steps % 6 === 0) {
        const exposed = exposedColors(board, level.colors);
        const aliveBy = {};
        let aliveWild = 0; // Phase 4: wild + mine blocks are targets for EVERY color
        for (const c of level.colors) aliveBy[c] = 0;
        for (const b of board.blocks) {
          if (!b.alive) continue;
          if (b.colorKey === 'W' || b.colorKey === 'M') aliveWild++;
          // Phase 4 WRAPS: a wrapped block costs 2 hits of its color (dewrap +
          // destroy), so it counts twice in the color's remaining-hit budget.
          else aliveBy[b.colorKey] += b.wrapped ? 2 : 1;
        }
        const committed = {}; // ammo already held by active pigs, per color
        const activeOf = {};  // active pig count per color
        for (const c of level.colors) { committed[c] = 0; activeOf[c] = 0; }
        // Phase 4 GOLDEN PIG (spec: Golden pig): the pierce runs in the REAL
        // game code the harness drives; the planner just treats 'G' as a wild
        // double-hitter — exposed while ANY block lives, the whole board as
        // its hit budget (so golden heads/slots flow through rules a/b/c/d/f
        // like any launchable pig).
        aliveBy['G'] = aliveWild;
        for (const c of level.colors) aliveBy['G'] += aliveBy[c];
        committed['G'] = 0; activeOf['G'] = 0;
        if (aliveBy['G'] > 0) exposed.add('G');
        for (const p of pigs.conveyorPigs) { committed[p.colorKey] += p.ammo; activeOf[p.colorKey]++; }
        for (const p of pigs.slots) if (p) { committed[p.colorKey] += p.ammo; activeOf[p.colorKey]++; }

        // SAFETY INVARIANT: keep active pigs (belt + slots) within the 5 seats —
        // then ANY returning pig finds a seat (the other ≤4 actives hold at most
        // 4) and the solver cannot lose. Liveness: (a) re-fires parked pigs the
        // moment their color re-exposes, (d) rerolls lanes through the infinite
        // reserve when nothing is launchable, and (f) is the player's last-ditch
        // full-rack escape (the only move that briefly risks a 6th active pig).
        let guard = 0;
        while (pigs.conveyorPigs.length < CONFIG.conveyorCapacity && guard++ < 16) {
          let acted = false;
          // a) drain an exposed slotted pig (active unchanged — always safe)
          for (let i = 0; i < pigs.slots.length; i++) {
            const p = pigs.slots[i];
            if (p && exposed.has(p.colorKey)) { acted = pigs.relaunchSlot(i); if (acted) break; }
          }
          const active = pigs.conveyorPigs.length + pigs.occupiedSlots();
          const heads = pigs.laneHeads();
          const inBudget = (h) =>
            exposed.has(h.pig.colorKey) &&
            committed[h.pig.colorKey] + h.pig.ammo <= aliveBy[h.pig.colorKey] + aliveWild;
          // b) exposed head within the color budget. Per-color active cap of 2:
          //    exposure is fragile (fronts deplete mid-lap), and 3+ same-color
          //    pigs blocking together is how the rack silts up with junk.
          if (!acted && active < CONFIG.waitingSlots) {
            for (const h of heads) {
              if (inBudget(h) && activeOf[h.pig.colorKey] < 2) {
                acted = pigs.launchLane(h.laneIndex);
                if (acted) { committed[h.pig.colorKey] += h.pig.ammo; activeOf[h.pig.colorKey]++; break; }
              }
            }
          }
          // c) finisher: exposed color, no active pig of it, only overkill heads
          if (!acted && active < CONFIG.waitingSlots) {
            for (const h of heads) {
              const c = h.pig.colorKey;
              if (exposed.has(c) && activeOf[c] === 0 && aliveBy[c] + aliveWild > 0) {
                acted = pigs.launchLane(h.laneIndex);
                if (acted) { committed[c] += h.pig.ammo; activeOf[c]++; break; }
              }
            }
          }
          // d) flush: NO exposed move exists at all -> launch a head purely to
          //    dig a USEFUL pig (exposed color, in budget) out of a lane. Every
          //    flushed pig parks (it can't shoot), so (1) flush the CHEAPEST
          //    lane — the one with the fewest non-useful pigs in front of a
          //    useful one — and (2) cap the unexposed actives at 3, keeping two
          //    seats of headroom for workers and transient parks. Skip stale
          //    heads that could never spend (dead/over-committed colors) unless
          //    they're the ones blocking the cheapest lane anyway.
          const anyExposedMove =
            heads.some((h) => exposed.has(h.pig.colorKey)) ||
            pigs.slots.some((p) => p && exposed.has(p.colorKey));
          if (!acted && !anyExposedMove && active < CONFIG.waitingSlots) {
            // "Useful" mirrors launch rules b AND c: in-budget, OR the
            // tail-finisher exception (no active pig of an exposed color ->
            // ONE overkill pig is acceptable; someone must clear the tail).
            // The finisher arm matters since the Phase 5 visibility lock:
            // the sync no longer culls stale pigs from the visible rows, so
            // the flush is the only way to dig a finisher out of a lane.
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
            // Seat ledger: every flushed junk pig will park, as will any belt
            // rider whose color is unexposed — the flush depth must fit the
            // seats left after those. The surfaced WORKER itself needs no seat:
            // an exposed-color pig that can't park RE-LAPS (game rule), and the
            // full-rack escape (f) below gets it onto the belt.
            const pendingParks = pigs.occupiedSlots() +
              pigs.conveyorPigs.filter((p) => !exposed.has(p.colorKey)).length;
            if (best && bestRun <= CONFIG.waitingSlots - pendingParks) {
              acted = pigs.launchLane(best.laneIndex);
            }
          }
          // f) full-rack escape: 5 parked, belt idle, but a USEFUL exposed head
          //    is waiting (in-budget, or the tail-finisher of a color with no
          //    active pig) -> cycle one parked pig out (preferring one whose
          //    color is still alive) and send the head after it. The head's
          //    color is exposed, so even if it can't park it RE-LAPS (game
          //    rule); the only risk is its exposure vanishing mid-lap.
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
}

console.log('=== (1) WIN reachable on EVERY level (budgeted exposed-only solver, seeded reserve) ===');
for (const level of LEVELS) {
  for (const seed of WIN_SEEDS) {
    const r = runGreedyWin(level, seed);
    console.log(`  L${level.id} "${level.name}" seed ${seed}: cubes ${r.total} -> ${r.remaining} in ${r.steps} steps; state='${r.state}'`);
    check(`L${level.id} seed ${seed}: cleared + won, no lockup`,
      r.remaining === 0 && r.state === 'won');
  }
}

// ---------------------------------------------------------------------------
// (2) LOCKUP REACHABLE on the buried-color levels: a careless run that FLOODS
// the color that starts fully buried (L2: C2 behind the C1 ring; L5: C4 behind
// three rings). Every flooded pig laps without a shot and parks with full ammo;
// the 5 slots fill, then the next returning pig finds no exposed match + no
// free seat -> the structural lockup. Reachability is EXISTENTIAL, so we search
// seeds (a stall just means that seed's lane heads dried up — try the next).
// ---------------------------------------------------------------------------
console.log('\n=== (2) LOSE reachable — flood the initially-buried colors until the slots jam ===');
for (const level of [LEVELS[1], LEVELS[4]]) {
  // The careless run: launch ONLY pigs whose color starts fully buried (L2: C2;
  // L5: C2+C3+C4 behind the outer ring). They lap without a shot and park with
  // full ammo; the 5 slots fill, then the next buried-color pig at the end finds
  // no exposed match + no free seat -> the lockup.
  const probe = newGame(level, 1);
  const exposedAtStart = exposedColors(probe.board, level.colors);
  const buried = level.colors.filter((c) => !exposedAtStart.has(c));
  let foundSeed = -1;
  for (let seed = 1; seed <= LOSE_SEED_SEARCH && foundSeed === -1; seed++) {
    const { pigs } = newGame(level, seed);
    let steps = 0;
    while (pigs.state === 'playing' && steps < LOSE_MAX_STEPS) {
      // Pure carelessness: prefer a buried-color head, else just tap the first
      // head available — keep the belt saturated, never drain a slot.
      let guard = 0;
      while (pigs.conveyorPigs.length < CONFIG.conveyorCapacity && guard++ < 8) {
        const heads = pigs.laneHeads();
        const h = heads.find((x) => buried.includes(x.pig.colorKey)) ?? heads[0];
        if (!h || !pigs.launchLane(h.laneIndex)) break;
      }
      pigs.update(DT);
      steps++;
    }
    if (pigs.state === 'lost') foundSeed = seed;
  }
  console.log(`  L${level.id} "${level.name}" flooding [${buried.join(',')}]: lockup ${foundSeed !== -1 ? `reached (seed ${foundSeed})` : 'NOT reached in seed search'}`);
  check(`L${level.id}: lockup reachable by flooding the buried colors`, foundSeed !== -1);
}

// ---------------------------------------------------------------------------
// (3) Phase 4 SPIN CARRY-FORWARD (spec: Level-clear spin, segment D): the
// wheel can inject ONE extra mine at a random VALID (inner = start-buried)
// cell into the next level's board. Re-prove the greedy win on levels 2-5
// with a seeded-random injection — the same applyCarryover code the game
// boot runs. (Golden head / dewrap / bonus slot only RELAX difficulty and
// need no re-proof; start-buried placement preserves the lockup gate in (2)
// structurally — nothing exposed at boot changes.)
// ---------------------------------------------------------------------------
console.log('\n=== (3) WIN still reachable with a spin-injected mine (levels 2-5, seeded positions) ===');
for (const level of LEVELS.slice(1)) {
  for (const seed of WIN_SEEDS) {
    const eff = applyCarryover(level, { mine: true }, makeRng(seed * 31));
    const r = runGreedyWin(eff, seed);
    const m = eff.injectedMine;
    console.log(`  L${level.id} + mine@(${m.col},${m.row}) seed ${seed}: cubes ${r.total} -> ${r.remaining} in ${r.steps} steps; state='${r.state}'`);
    check(`L${level.id} seed ${seed} (injected mine): cleared + won`,
      r.remaining === 0 && r.state === 'won');
  }
}

console.log('\n' + (allPass ? '=== WINNABILITY (ALL LEVELS) + LOCKUP BOTH REACHABLE ===' : '=== WINNABILITY/LOCKUP GATE FAILED ==='));
process.exit(allPass ? 0 : 1);
