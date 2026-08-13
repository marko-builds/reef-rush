// Headless verification (Phase 4 feature 1) — coin counting, headless.
// Clears the ad level with the same greedy policy as verify-winnability.mjs,
// draining pigs.vfx[] each step and awarding coins EXACTLY like main.js's
// updateCoins: a dewrap peel = 0, 'M' = 0, 'W' = 3, everything else 1, and a
// 'mineExplode' awards per destroyed block (the blast emits no fire events).
// Asserts the destruction accounting too: every block dies exactly once, via
// a destroying shot or the blast, and each wrapped sub-block peels once.
import { Board } from './src/board.js';
import { Conveyor } from './src/conveyor.js';
import { PigManager } from './src/pigs.js';
import { CONFIG, LEVELS, makeRng } from './src/level.js';

const scene = { add() {}, remove() {} };
const DT = 1 / 60;
const level = LEVELS[0];
const board = new Board(scene, null, level);
const conveyor = new Conveyor(board);
const pigs = new PigManager(scene, board, conveyor, null, level, makeRng(1));

function exposedColors() {
  const found = new Set();
  for (let s = 0; s < 18; s++) {
    for (const dir of ['down', 'up', 'right', 'left']) {
      const b = firstAlive(s, dir);
      if (b) found.add(b.colorKey);
    }
  }
  return found;
}
function firstAlive(sub, dir) {
  for (let k = 0; k < 18; k++) {
    let scol, srow;
    if (dir === 'down') { scol = sub; srow = 17 - k; }
    else if (dir === 'up') { scol = sub; srow = k; }
    else if (dir === 'right') { scol = k; srow = sub; }
    else { scol = 17 - k; srow = sub; }
    const b = board.grid.get(board._key(scol, srow));
    if (b && b.alive) return b;
  }
  return null;
}

let coins = 0, fireDestroys = 0, dewraps = 0, blastBlocks = 0;
const coinAward = (c) => (c === 'W' ? 3 : c === 'M' ? 0 : 1); // mirrors main.js
const totalBlocks = board.aliveCount();
const mineSubs = board.blocks.filter((b) => b.colorKey === 'M').length;
const wrappedSubs = board.blocks.filter((b) => b.wrapped).length;
let steps = 0;
while (pigs.state === 'playing' && steps < 600000) {
  if (steps % 6 === 0) {
    const exposed = exposedColors();
    const aliveBy = {};
    for (const c of level.colors) aliveBy[c] = 0;
    for (const b of board.blocks) if (b.alive) aliveBy[b.colorKey]++;
    const committed = {};
    for (const c of level.colors) committed[c] = 0;
    // GOLDEN pigs (Phase 4) hit any color: exposed while anything lives, the
    // whole board as budget — same treatment as the winnability solver. Without
    // this, 'G' heads clog lanes forever (they're never lane-sync culled, and
    // since the Phase 5 visibility lock the sync can't churn visible rows).
    let aliveAll = 0;
    for (const c of level.colors) aliveAll += aliveBy[c];
    aliveBy['G'] = aliveAll;
    committed['G'] = 0;
    if (aliveAll > 0) exposed.add('G');
    for (const p of pigs.conveyorPigs) committed[p.colorKey] += p.ammo;
    for (const p of pigs.slots) if (p) committed[p.colorKey] += p.ammo;
    let guard = 0;
    while (pigs.conveyorPigs.length < CONFIG.conveyorCapacity && guard++ < 16) {
      let acted = false;
      for (let i = 0; i < pigs.slots.length; i++) {
        const p = pigs.slots[i];
        if (p && exposed.has(p.colorKey)) { acted = pigs.relaunchSlot(i); if (acted) break; }
      }
      const active = pigs.conveyorPigs.length + pigs.occupiedSlots();
      if (!acted && active < CONFIG.waitingSlots) {
        for (const h of pigs.laneHeads()) {
          const c = h.pig.colorKey;
          if (exposed.has(c) && committed[c] + h.pig.ammo <= aliveBy[c]) {
            acted = pigs.launchLane(h.laneIndex);
            if (acted) { committed[c] += h.pig.ammo; break; }
          }
        }
      }
      if (!acted && active < CONFIG.waitingSlots) {
        for (const h of pigs.laneHeads()) {
          const c = h.pig.colorKey;
          if (exposed.has(c) && aliveBy[c] > 0 && committed[c] === 0) {
            acted = pigs.launchLane(h.laneIndex);
            if (acted) { committed[c] += h.pig.ammo; break; }
          }
        }
      }
      // FLUSH (Phase 5 visibility lock): no exposed move at all -> dig a useful
      // pig out of the cheapest lane (the sync no longer churns visible rows,
      // so stale heads must be launched out — mirrors verify-winnability rule d).
      const heads = pigs.laneHeads();
      const anyExposedMove =
        heads.some((h) => exposed.has(h.pig.colorKey)) ||
        pigs.slots.some((p) => p && exposed.has(p.colorKey));
      if (!acted && !anyExposedMove && active < CONFIG.waitingSlots) {
        const isUseful = (p) =>
          exposed.has(p.colorKey) &&
          (committed[p.colorKey] + p.ammo <= aliveBy[p.colorKey] || committed[p.colorKey] === 0);
        let best = null, bestRun = Infinity;
        for (const h of heads) {
          const idx = pigs.lanes[h.laneIndex].findIndex(isUseful);
          if (idx !== -1 && idx < bestRun) { bestRun = idx; best = h; }
        }
        const pendingParks = pigs.occupiedSlots() +
          pigs.conveyorPigs.filter((p) => !exposed.has(p.colorKey)).length;
        if (best && bestRun <= CONFIG.waitingSlots - pendingParks) {
          acted = pigs.launchLane(best.laneIndex);
        }
      }
      if (!acted) break;
    }
  }
  pigs.update(DT);
  // drain the event queue exactly like the render side (main.js updateCoins)
  for (const ev of pigs.vfx) {
    if (ev.type === 'fire') {
      if (ev.dewrap) dewraps++; // peels armor, destroys nothing, awards nothing
      else { fireDestroys++; coins += coinAward(ev.blockColor); }
    } else if (ev.type === 'mineExplode') {
      for (const b of ev.blocks) { blastBlocks++; coins += coinAward(b.blockColor); }
    }
  }
  pigs.vfx.length = 0;
  steps++;
}

// Every block dies exactly once (by shot or blast); each wrapped sub-block
// peels exactly once; the coin total is destroyed blocks minus the 0-award
// mine sub-blocks (the ad level has no wilds).
const expectCoins = totalBlocks - mineSubs;
console.log(`"${level.name}": blocks ${totalBlocks} -> ${board.aliveCount()}, state='${pigs.state}', steps=${steps}`);
console.log(`destroying shots: ${fireDestroys}  + blast blocks: ${blastBlocks}  (expect ${totalBlocks} together)`);
console.log(`dewrap peels:     ${dewraps}  (expect ${wrappedSubs} — one per wrapped sub-block)`);
console.log(`coins:            ${coins}  (expect ${expectCoins} — 1/block, mine sub-blocks award 0)`);
const pass = pigs.state === 'won' &&
  fireDestroys + blastBlocks === totalBlocks &&
  dewraps === wrappedSubs &&
  coins === expectCoins;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
