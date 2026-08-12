// level.js — DATA-DRIVEN level definitions for the v3 styled reef build.
//
// Nothing in here is logic; it is the authored 5-LEVEL SEQUENCE (spec re-lock #3).
// Every level is a 9x9 cell pattern; each cell holds a big block unless authored
// EMPTY ('.', used only for level 5's center treasure pocket).
//
// Colors: 4 build-agnostic palette SLOTS (C1..C4); firing matches by key string,
// never hex, so this reskin is look-only. Levels 1-3 use C1+C2, level 4
// introduces C3, level 5 introduces C4. Reef hues (reskin brief): C1 coral-orange,
// C2 bright teal/cyan (saturated — never the muted sea blue), C3 reef green
// (starfish/turtle sprites), C4 treasure gold. All four pop over the aqua sea
// and the board vignette guarantees contrast.
//
// Firing is BLOCKING: a pig hits only the FIRST cube in its inward line, and only
// if that cube is its color (see board.js). The queue is an INFINITE random
// reserve (see pigs.js) whose color weighting follows the blocks still alive, so
// every level stays winnable; winnability and lockup-reachability are asserted
// headlessly by verify-winnability.mjs.

export const COLORS = {
  C1: 0xff6a3d, // coral-orange (warm slot)
  C2: 0x13c4c4, // bright teal/cyan (cool slot — saturated, distinct from the sea)
  C3: 0xc05ed9, // bright purple (introduced in level 4 — matches the player's generated c3 art; shots/particles tint from this slot)
  C4: 0xffc91f, // treasure gold (introduced in level 5 — matches the c4 sprites)
  W:  0xa855f7, // WILD — jellyfish purple (Phase 4): hittable by ANY pig color.
                // NOT a pig color; never in a level's `colors` list (the reserve
                // never mints wild pigs and the weighting ignores wild blocks).
  M:  0xff4030, // MINE — hot red/orange (Phase 4): triggered by ANY pig color;
                // explodes its 3x3 big-block neighborhood (6x6 small blocks).
                // NOT a pig color, same exclusions as 'W'.
  G:  0xffe27a, // GOLDEN PIG — radiant white-gold (Phase 4): a rare QUEUE pig,
                // never a board block. Deliberately paler than C4's treasure
                // gold so the two stay distinct on level 5 (the glow/sparkle
                // FX are the primary identifier). Tints its fallback quad,
                // ammo-irrelevant shot tracers, and the queue glow.
};

// Board grid dimensions (in cells). Square 9x9 for every level. The conveyor
// rings the outside of this grid.
export const GRID_COLS = 9;
export const GRID_ROWS = 9;

// Pattern chars: 'A'..'D' = C1..C4, 'W' = WILD big block (Phase 4 — all 4
// sub-blocks wild, any pig color can hit them), 'M' = MINE big block (Phase 4 —
// any pig color triggers it; the blast clears its 3x3 big-block neighborhood),
// '.' = EMPTY cell (no block). PATTERN[0] is the TOP row (row GRID_ROWS-1).
const CHAR_TO_COLOR = { A: 'C1', B: 'C2', C: 'C3', D: 'C4', W: 'W', M: 'M' };

// The ONE authored playable-ad level: a gold ring guards the center treasure
// pocket, one mine sits in the ring's bottom edge for the blast moment, two
// coral accents teach color matching. Both colors are exposed from the first
// second (gold from above, coral + the mine from below), so a first-try player
// is always able to act; the mine blast clears the ring's lower half in one
// bang. Tuned for a 20-30 second first-try win.
export const LEVELS = [
  {
    id: 1,
    name: 'Reef Rush',
    colors: ['C1', 'C4'],
    pattern: [
      '.........',
      '.........',
      '...DDD...',
      '...D.D...',
      '...DMD...',
      '.A.....A.',
      '.........',
      '.........',
      '.........',
    ],
    // The center '.' pocket (pattern row 3, col 4 -> world row 5) holds the
    // treasure, revealed by the final clear (the existing finale mechanic).
    treasure: { col: 4, row: 5 },
  },
];

// Expand a level's PATTERN into its authored cube list { col, row, color, wrapped }.
// '.' cells are skipped (empty — no block, the firing scan sees through them).
// Phase 4 SEAWEED WRAPS (spec: Seaweed-wrapped blocks): cells listed in the
// level's optional `wraps` array start ARMORED (wrapped: true on all 4
// sub-blocks). Wraps are only valid on COLOR cells — a listed wild/mine cell
// is an authoring error and is ignored here.
export function expandPattern(level) {
  const wrapSet = new Set((level.wraps ?? []).map((w) => w.col + ',' + w.row));
  const cubes = [];
  for (let pr = 0; pr < GRID_ROWS; pr++) {
    const row = GRID_ROWS - 1 - pr; // PATTERN[0] = top row
    const line = level.pattern[pr];
    for (let col = 0; col < GRID_COLS; col++) {
      const ch = line[col];
      if (ch === '.') continue;
      const color = CHAR_TO_COLOR[ch];
      const wrapped = wrapSet.has(col + ',' + row) && color !== 'W' && color !== 'M';
      cubes.push({ col, row, color, wrapped });
    }
  }
  return cubes;
}

// Seedable PRNG (mulberry32) for the infinite queue: the game seeds it randomly
// per run; the headless harnesses pass fixed seeds for deterministic verification.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tunable gameplay constants (v2 feel — identical to v1 except fireInterval).
export const CONFIG = {
  conveyorCapacity: 3,   // pigs allowed on the belt at once
  beltSeconds: 14.0,     // seconds for one full lap (t: 0 -> 1). Re-lock #3: slowed
                         // from 6.0 so per-sub-column dwell (~0.163s) stays >= the
                         // v2/v3 fire cadence + a 30fps frame — a pig can never
                         // ride past a matching front block between shots.
  fireInterval: 0.13,    // v2 SIGNATURE FEEL = 130ms cooldown between shots.
                         // v1 was 0 (instant — a whole line vanished in one frame).
                         // 130ms makes a pig SPRAY its ammo in a visible rhythm so
                         // cubes pop one at a time, reading as a satisfying burst.
                         // Tuned by feel: <90ms blurs into "instant", >170ms drags.
  waitingSlots: 5,       // the "X/5"
  laneCount: 4,          // independent queue lanes (only the 4 heads launchable)
  laneDepth: 6,          // pigs kept per lane (3 visible + 3 off-screen reserve)
  goldenChance: 0,       // golden pigs are OFF in the playable-ad build (the
                         // pig_g sprite is dropped by the asset diet; one level
                         // never rolls the bonus anyway).
  goldenAmmo: 5,         // a golden pig's fixed ammo (1 ammo = 1 block hit, as
                         // for every pig; the pierce's 2nd hit needs ammo left).
  ammoMin: 8,            // infinite-reserve ammo roll, uniform [ammoMin, ammoMax].
  ammoMax: 16,           // Kept SMALL-ish so pigs spend out and leave mid-lap more
                         // often than they park — large rolls turn into permanent
                         // seat hogs once their color thins out (verified: the
                         // 12-20 range wedged the solver on the 3/4-color levels).
};
