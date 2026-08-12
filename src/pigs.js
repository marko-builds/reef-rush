// pigs.js — persistent pig entities + the full lifecycle loop.
//
// A pig: { color, ammo, location: 'queue'|'conveyor'|'slot'|'gone',
//          t, slotIndex, mesh, ... }
//
// Locations:
//   queue     : waiting in a lane to be launched (only the lane HEAD is launchable).
//   conveyor  : riding the belt, t in [0,1), auto-firing.
//   slot      : parked in one of CONFIG.waitingSlots with leftover ammo.
//   gone      : left the board (ammo spent on lap end).
//
// One update() per frame drives all phases, delta-timed. Tapping is via the
// input layer in main.js, which calls launchLane() / relaunchSlot().

import * as THREE from 'three';
import { COLORS, CONFIG, makeRng } from './level.js';
import { CELL } from './board.js';
import { clamp01, easeOutCubic, easeOutBack, easeInCubic, easeInOutCubic } from './easing.js';

export const PIG_SIZE = CELL * 0.7;

// The player-visible queue window: rows 0..2 of the 4x3 grid. The lane<->board
// winnability sync is FORBIDDEN from touching these rows (spec: Visibility
// boundary) — a pig the player can see must never be swapped out from under them.
export const VISIBLE_ROWS = 3;

// v2 visual-settle durations (seconds). These drive ONLY mesh scale/position in
// the render-side tickAnims(); they never touch pig.t, ammo, location, routing,
// or any value the gameplay update()/harnesses read.
const LAUNCH_EASE = 0.18;  // ease onto the belt (scale-in)
const RETURN_EASE = 0.26;  // settle into a slot (slide + easeOutBack)
const LEAVE_EASE  = 0.32;  // slide off + shrink when ammo spent
const DEPART_EASE = 0.45;  // ammo-0 mid-lap exit: turn 90° to the belt + bounce + shrink away
const AMMO_PULSE  = 0.14;  // ammo-label scale "tick" on each decrement
const LANE_EASE_K = 12;    // exp-smoothing rate for queue pieces sliding up into view

// v2 per-shot RECOIL (render-only). On each fired shot the pig kicks BACKWARD =
// outward (along the NEGATIVE inward normal, since it shoots inward) by a small
// offset that snaps out then cushions back to rest within ~the fire cadence, so
// the ~7-8 shots/sec burst reads as a string of distinct kicks. This is a mesh-
// position offset applied in tickAnims() ON TOP of the belt position — it never
// touches pig.t, ammo, firing, or routing (harnesses don't read it).
const RECOIL_OFFSET = CELL * 0.16; // peak kick distance (~0.16 cell, subtle)
const RECOIL_DUR    = 0.11;        // 110ms: settles within the 130ms cadence window

// Phase 5 FACING STATE MACHINE (spec: Facing — v3 only). While TRAVELLING a pig
// faces its direction of motion (the belt TANGENT = inward normal rotated 90° CW,
// since travel is CCW); it turns inward only to SHOOT:
//   TRAVELLING -> PRE_SHOOT : the fire cooldown is within ROT_PRESHOOT of
//     elapsing AND the inward line holds a valid front target -> rotate
//     tangent -> inward over 80ms (easeInOutCubic). The look-ahead means the
//     rotation lands exactly as the cooldown elapses, so the cadence is intact.
//   PRE_SHOOT -> AIMED      : facing within AIM_EPS (5°) of inward. The shot
//     fires ONLY in AIMED — at the end of the rotation, never mid-turn. A burst
//     stays AIMED between its shots (no re-rotation per shot).
//   PRE_SHOOT/AIMED -> POST_MISS : the target vanished (another pig cleared it)
//     or the front turned blocked -> rotate back to tangent over 60ms, then
//     TRAVELLING. Never fires into empty space.
//   LEAVING (ammo hit 0 mid-lap): rotate current -> tangent over 50ms FIRST,
//     then the bounce+shrink depart vanish plays (handled in the depart anim).
// The fire RULE (blocking, first-block-only, pierce, wraps, mines) is untouched;
// only WHEN a shot may leave changes: a pig arriving at a fresh target waits out
// the ≤80ms turn — well inside the ~163ms dwell, so the no-missed-blocks speed
// rule still holds. Headless probes that plant pigs directly (bypassing
// _enterConveyor) get a pre-AIMED face, so the firing/routing harnesses drive
// the unchanged rule; pigs entering the belt through play are armed TRAVELLING.
const ROT_PRESHOOT = 0.08; // tangent -> inward, before a shot
const ROT_POSTMISS = 0.06; // inward -> tangent, after a miss/abort
const ROT_LEAVING  = 0.05; // current -> tangent, before the depart vanish
const AIM_EPS = (5 * Math.PI) / 180; // "aimed" = within 5° of the inward normal

// Shortest-path angle helpers (radians).
const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const angleLerp = (a, b, t) => a + angleDelta(a, b) * t;

export class PigManager {
  // assets (optional): the v3 sprite registry. When present each pig draws its
  // color's reef-critter SVG; absent (or missing) -> flat color quad. LOOK ONLY —
  // lifecycle, routing, slot/queue positions, tickAnims values are all untouched.
  // level : one entry of LEVELS — supplies the color set the infinite queue draws
  //         from (and, via the board, the alive-count weighting).
  // rng   : seedable PRNG in [0,1) for the infinite reserve. The game lets it
  //         default to a random seed; the headless harnesses pass makeRng(seed)
  //         for deterministic winnability runs.
  // opts (optional, additive): Phase 4 spin carry-forward (spec: Level-clear
  // spin, segment C) — { goldenHead: true } forces ONE random lane HEAD to be
  // a golden pig at boot. Default {} = behaviour (and the seeded reserve
  // stream) bit-identical to before; the harness gates never set it.
  constructor(scene, board, conveyor, assets = null, level, rng = makeRng((Math.random() * 0xffffffff) >>> 0), opts = {}) {
    this.scene = scene;
    this.board = board;
    this.conveyor = conveyor;
    this.assets = assets;
    this.level = level;
    this.rng = rng;

    this.group = new THREE.Group();
    scene.add(this.group);

    this._geo = new THREE.PlaneGeometry(PIG_SIZE, PIG_SIZE);
    this._materials = new Map(); // colorKey -> material

    // The INFINITE queue (spec re-lock #3): 4 independent LANES (columns), each
    // topped up to CONFIG.laneDepth from the random reserve; lanes[k][0] is the
    // launchable HEAD. Every launch appends a fresh random pig (see launchLane).
    this.pigs = [];
    this.lanes = Array.from({ length: CONFIG.laneCount }, () => []);
    for (const lane of this.lanes) {
      while (lane.length < CONFIG.laneDepth) lane.push(this._spawnQueuePig());
    }
    // Phase 4 spin carry-forward (segment C): swap ONE random lane head for a
    // guaranteed golden pig — visible + tappable immediately. The displaced
    // pig is retired exactly like a lane-sync cull (gone + hidden).
    if (opts.goldenHead) {
      const lane = this.lanes[Math.floor(this.rng() * this.lanes.length) % this.lanes.length];
      const displaced = lane.shift();
      displaced.location = 'gone';
      displaced.mesh.visible = false;
      lane.unshift(this._spawnQueuePig(true));
    }

    this.conveyorPigs = []; // pigs currently on the belt
    this.slots = new Array(CONFIG.waitingSlots).fill(null); // slot -> pig|null

    this.state = 'playing'; // 'playing' | 'won' | 'lost'

    // --- v3 VFX EVENT QUEUE (cosmetic only, render-side drains it) -----------
    // update() pushes lightweight DATA records here when a cosmetic event occurs
    // (a shot fired, a cube popped, a pig parked/vacated). main.js's VfxLayer
    // drains this each frame to spawn pooled sprites. This is the SAME render-safe
    // hook pattern as the v2 recoil/ammoPulse fields: gameplay state, firing,
    // routing, slots, win/lose, and the v2 timing VALUES are all untouched, and
    // the headless harnesses (no renderer) simply never read the array. Plain
    // numbers/strings only — no THREE objects, no scene/asset access here.
    this.vfx = [];

    this._layoutLanes(true); // initial layout snaps; later launches slide (lane ease)
    this._layoutSlots();
  }

  _materialFor(colorKey) {
    if (!this._materials.has(colorKey)) {
      const rec = this.assets ? this.assets.byColor('pig', colorKey) : null;
      const mat = rec
        ? new THREE.MeshBasicMaterial({ map: rec.texture, transparent: true })
        : new THREE.MeshBasicMaterial({ color: COLORS[colorKey] });
      this._materials.set(colorKey, mat);
    }
    return this._materials.get(colorKey);
  }

  _makePig(colorKey, ammo) {
    const mesh = new THREE.Mesh(this._geo, this._materialFor(colorKey));
    // Small dark border via a slightly larger backing quad to read as a "pig".
    this.group.add(mesh);
    return {
      colorKey,
      ammo,
      location: 'queue',
      t: 0,
      slotIndex: -1,
      fireTimer: 0,
      mesh,
      // --- v2 visual-only settle state (read by render-side tickAnims) -------
      anim: null,        // { kind:'launch'|'return'|'leave'|'depart', age, dur, ... }
      laneTarget: null,  // {x,y} the pig eases toward while waiting in a lane (slide-up)
      ammoPulse: 0,      // >0 = seconds left in the ammo "tick" scale pulse
      rejectShake: 0,    // >0 = seconds left in the invalid-tap shake (render-side)
      recoil: 0,         // >0 = seconds left in the per-shot recoil kick (render-side)
      recoilDir: { x: 0, y: 0 }, // OUTWARD unit dir for the current kick (render-side)
      // Phase 5 facing state (spec: Facing). Default AIMED so headless probes
      // planted straight onto the belt fire on their first tick (the firing-rule
      // harnesses test targeting, not facing); _enterConveyor arms TRAVELLING.
      face: { state: 'AIMED', from: 0, age: 1 },
    };
  }

  // --- the infinite random reserve (spec re-lock #3) -------------------------

  // Roll one new queue pig. COLOR is drawn from the level's color set WEIGHTED by
  // the small blocks still alive per color, DOUBLED for colors currently EXPOSED
  // (first on some inward line) — the stream always keeps supplying the colors
  // the board still needs and leans toward immediately-useful ones, which is
  // what keeps every level winnable (buried colors still appear, so the lockup
  // stays reachable). AMMO is uniform in [ammoMin, ammoMax], CLAMPED to the
  // color's current alive count so late-game pigs arrive as right-sized
  // finishers instead of guaranteed seat hogs (spec winnability rule).
  _spawnQueuePig(forceGolden = false) {
    // Phase 4 GOLDEN PIG (spec: Golden pig): one rng draw FIRST — a hit mints
    // the rare jackpot pig (color 'G', fixed ammo, hits ANY color + pierces)
    // and skips the weighted color/ammo rolls entirely. 'G' is not a board
    // color, so the weighting/clamp below never see it. forceGolden (spin
    // carry-forward, segment C) mints one WITHOUT consuming an rng draw.
    if (forceGolden || this.rng() < CONFIG.goldenChance) {
      const pig = this._makePig('G', CONFIG.goldenAmmo);
      pig.golden = true;
      pig.location = 'queue';
      this.pigs.push(pig);
      return pig;
    }
    const aliveCounts = this.level.colors.map((key) => {
      let n = 0;
      for (const b of this.board.blocks) if (b.alive && b.colorKey === key) n++;
      return n;
    });
    const weights = this.level.colors.map((key, i) =>
      aliveCounts[i] * (aliveCounts[i] > 0 && this.board.hasExposedColor(key) ? 2 : 1)
    );
    let total = 0;
    for (const w of weights) total += w;
    let colorKey;
    let aliveOfColor = Infinity;
    if (total === 0) {
      // Board cleared (or about to be) — color no longer matters; stay uniform.
      colorKey = this.level.colors[Math.floor(this.rng() * this.level.colors.length)];
    } else {
      let roll = this.rng() * total;
      let idx = 0;
      while (idx < weights.length - 1 && roll >= weights[idx]) { roll -= weights[idx]; idx++; }
      colorKey = this.level.colors[idx];
      aliveOfColor = aliveCounts[idx];
    }
    const rolled = CONFIG.ammoMin + Math.floor(this.rng() * (CONFIG.ammoMax - CONFIG.ammoMin + 1));
    const ammo = Math.max(1, Math.min(rolled, aliveOfColor));
    const pig = this._makePig(colorKey, ammo);
    pig.location = 'queue';
    this.pigs.push(pig);
    return pig;
  }

  // Lane<->board sync (spec winnability rule): keep the QUEUE relevant to the
  // board. Per color the lanes hold at most ceil(alive / ammoMin) queued pigs
  // (0 once the color is cleared); the excess — stale pigs minted before their
  // color thinned out — is removed DEEPEST-FIRST and replaced from the reserve
  // (parked pigs are deliberately NOT rescued). Without this, stale pigs clog
  // all 4 lane heads and the endgame can become unwinnable.
  // Phase 4 GOLDEN PIG exemption (spec: Golden pig, lane sync): golden pigs are
  // NEVER culled — structurally, because the per-color allowance map below only
  // holds the level's colors, so a 'G' pig is never over-quota.
  _syncLanesToBoard() {
    const alive = new Map(this.level.colors.map((c) => [c, 0]));
    for (const b of this.board.blocks) {
      if (b.alive) alive.set(b.colorKey, alive.get(b.colorKey) + 1);
    }
    // Per-color allowance, then how many queued pigs are over it.
    const over = new Map();
    for (const c of this.level.colors) {
      const a = alive.get(c);
      const cap = a === 0 ? 0 : Math.max(1, Math.ceil(a / CONFIG.ammoMin));
      let queued = 0;
      for (const lane of this.lanes) for (const p of lane) if (p.colorKey === c) queued++;
      if (queued > cap) over.set(c, queued - cap);
    }
    if (over.size === 0) return;
    // Remove the excess deepest-first (row by row from the back) — but NEVER
    // from the visible window (spec: Visibility boundary, Phase 5 fix): rows
    // 0..VISIBLE_ROWS-1 are FROZEN once the level starts; only the off-screen
    // reserve (row 3+) may be culled/replaced. Excess that sits inside the
    // visible window simply stays (it drains via the player's own launches).
    for (let row = CONFIG.laneDepth - 1; row >= VISIBLE_ROWS; row--) {
      for (const lane of this.lanes) {
        const p = lane[row];
        if (!p) continue;
        const left = over.get(p.colorKey);
        if (left > 0) {
          over.set(p.colorKey, left - 1);
          lane.splice(row, 1);
          p.location = 'gone';
          p.mesh.visible = false;
        }
      }
    }
    const freshPigs = [];
    for (const lane of this.lanes) {
      while (lane.length < CONFIG.laneDepth) {
        const fresh = this._spawnQueuePig();
        lane.push(fresh);
        freshPigs.push(fresh);
      }
    }
    this._layoutLanes();
    // Snap replacements straight to their lane spots (no ease-in from origin).
    for (const fresh of freshPigs) {
      fresh.mesh.position.set(fresh.laneTarget.x, fresh.laneTarget.y, 0.1);
    }
  }

  // --- layout of off-belt pigs (purely positional; no gameplay effect) -------

  // Vertical stack BELOW the board: board+conveyor -> buckets (5 slots) -> lane HEAD
  // row -> deeper rows (those past the visible window wait OFF-SCREEN below and slide
  // up as heads launch). _layoutLanes sets laneTarget; queue pieces EASE toward it in
  // tickAnims (a freed lane slides up). The initial layout snaps.
  _layoutLanes(snap = false) {
    const b = this.board.bounds;
    const headY = b.minY - CELL * 3.7;       // head row, below the buckets
    const rowGapY = PIG_SIZE + 0.32;         // vertical gap between stacked pigs
    const laneGapX = (b.maxX - b.minX) / 3;  // 4 lanes spanning the board width
    this.lanes.forEach((lane, li) => {
      const x = b.minX + li * laneGapX;
      lane.forEach((pig, ri) => {
        pig.laneTarget = { x, y: headY - ri * rowGapY }; // ri 0 = head (top)
        pig.mesh.rotation.z = 0; // queued pigs face up (toward the board)
        pig.mesh.visible = true;
        if (snap) pig.mesh.position.set(pig.laneTarget.x, pig.laneTarget.y, 0.1);
      });
    });
  }

  // World position of bucket/slot i — a centered row just below the board/belt (also
  // used by main.js to draw the tackle-rack frames; purely positional).
  slotWorldPos(i) {
    const b = this.board.bounds;
    const spacing = PIG_SIZE + 0.6;
    const startX = -((CONFIG.waitingSlots - 1) * spacing) / 2; // centered on x=0
    return { x: startX + i * spacing, y: b.minY - CELL * 2.2 };
  }

  _layoutSlots() {
    for (let i = 0; i < this.slots.length; i++) {
      const pig = this.slots[i];
      if (pig) {
        const p = this.slotWorldPos(i);
        pig.mesh.position.set(p.x, p.y, 0.1);
        pig.mesh.rotation.z = 0; // parked pigs face up
        pig.mesh.visible = true;
      }
    }
  }

  // --- input actions ---------------------------------------------------------

  // Launch a lane's HEAD pig onto the belt (if capacity allows). Only the 4 lane
  // heads are launchable; the tapped lane then advances up — and the INFINITE
  // reserve appends a fresh random pig to that lane's tail (never runs dry).
  launchLane(laneIndex) {
    if (this.state !== 'playing') return false;
    if (this.conveyorPigs.length >= CONFIG.conveyorCapacity) return false;
    const lane = this.lanes[laneIndex];
    if (!lane || lane.length === 0) return false;
    const pig = lane.shift();
    this._enterConveyor(pig);
    const fresh = this._spawnQueuePig();
    lane.push(fresh);
    this._layoutLanes();
    // Snap the newly minted reserve pig straight to its (off-screen) lane spot —
    // it must not ease in from the world origin across the board.
    fresh.mesh.position.set(fresh.laneTarget.x, fresh.laneTarget.y, 0.1);
    return true;
  }

  // The launchable lane heads as { laneIndex, pig } (skips empty lanes).
  laneHeads() {
    const heads = [];
    this.lanes.forEach((lane, laneIndex) => {
      if (lane.length > 0) heads.push({ laneIndex, pig: lane[0] });
    });
    return heads;
  }

  // Re-launch a parked pig from a slot onto the belt (if capacity allows).
  relaunchSlot(slotIndex) {
    if (this.state !== 'playing') return false;
    if (this.conveyorPigs.length >= CONFIG.conveyorCapacity) return false;
    const pig = this.slots[slotIndex];
    if (!pig) return false;
    this.slots[slotIndex] = null;
    pig.slotIndex = -1;
    // v3 VFX event: a seat was VACATED by a re-tap -> the tackle-rack seat gives a
    // brief reactive flourish. Data only (slot index); drained by the VfxLayer.
    this.vfx.push({ type: 'slotVacate', slot: slotIndex });
    this._enterConveyor(pig);
    return true;
  }

  _enterConveyor(pig) {
    pig.location = 'conveyor';
    pig.t = 0;
    pig.fireTimer = 0;
    // Phase 5 facing: a pig entering the belt travels nose-forward (tangent)
    // and only turns inward to shoot (spec: Facing).
    pig.face = { state: 'TRAVELLING', from: 0, age: 0 };
    pig.mesh.visible = true;
    // v2: ease onto the belt (scale-in) instead of popping. Visual only.
    pig.anim = { kind: 'launch', age: 0, dur: LAUNCH_EASE };
    this.conveyorPigs.push(pig);
  }

  // free slot index, or -1
  _freeSlot() {
    return this.slots.indexOf(null);
  }

  occupiedSlots() {
    return this.slots.filter((s) => s !== null).length;
  }

  // --- main update -----------------------------------------------------------

  update(dt) {
    if (this.state !== 'playing') return;

    // Advance + fire each pig on the belt.
    const tPerSec = 1 / CONFIG.beltSeconds;
    const reachedEnd = [];
    const spent = []; // ammo hit 0 this frame -> leave immediately, mid-lap
    let fired = false; // a block died this frame -> run the lane sync below

    for (const pig of this.conveyorPigs) {
      // 1) advance along the belt
      pig.t += tPerSec * dt;

      // 2a) FACING state machine (Phase 5, spec: Facing) — advanced BEFORE the
      // fire check, because a shot may only leave once the pig is AIMED (facing
      // within AIM_EPS of the inward normal). The look-ahead arms the turn
      // ROT_PRESHOOT before the cooldown elapses so the cadence is unchanged.
      pig.fireTimer -= dt;
      const sNow = this.conveyor.sample(Math.min(pig.t, 0.99999));
      const inwardA  = Math.atan2(sNow.inwardNormal.y, sNow.inwardNormal.x) - Math.PI / 2;
      const tangentA = Math.atan2(-sNow.inwardNormal.x, sNow.inwardNormal.y) - Math.PI / 2;
      const face = pig.face;
      face.age += dt;
      // The look-ahead ALSO looks ahead POSITIONALLY (spec: Facing): the pig
      // starts its turn for the lines it will cross while the rotation plays
      // (the interval [t, t + beltSpeed*ROT_PRESHOOT]), so even an edge-
      // extremity sub-line with a sliver of dwell (~0.1 world units beside a
      // corner) is met already AIMED, never skipped. The interval is sampled
      // at 4 sub-steps (~0.06 units apart, finer than the narrowest window) —
      // a single far-point probe would sweep PAST a narrow window and abort
      // the turn before the pig arrives.
      const acquire = () => {
        const now = this._lineTarget(pig);
        if (now) return now;
        for (let k = 1; k <= 4; k++) {
          const tp = pig.t + (tPerSec * ROT_PRESHOOT * k) / 4;
          if (tp >= 1) break;
          const hit = this._lineTargetAt(pig, tp);
          if (hit) return hit;
        }
        return null;
      };
      if (pig.t < 1 && pig.ammo > 0) {
        if (face.state === 'TRAVELLING') {
          if (pig.fireTimer <= ROT_PRESHOOT && acquire()) {
            face.from = tangentA; face.state = 'PRE_SHOOT'; face.age = 0;
          }
        } else if (face.state === 'POST_MISS') {
          if (face.age >= ROT_POSTMISS) {
            face.state = 'TRAVELLING';
          } else if (pig.fireTimer <= ROT_PRESHOOT && acquire()) {
            // re-acquired mid-return: turn back inward from the current angle
            face.from = angleLerp(face.from, tangentA, easeInOutCubic(clamp01(face.age / ROT_POSTMISS)));
            face.state = 'PRE_SHOOT'; face.age = 0;
          }
        } else if (face.state === 'PRE_SHOOT' || face.state === 'AIMED') {
          if (!acquire()) {
            // target vanished (another pig cleared it) or the front turned
            // blocked -> abort to POST_MISS; never fire into empty space.
            face.from = face.state === 'AIMED'
              ? inwardA
              : angleLerp(face.from, inwardA, easeInOutCubic(clamp01(face.age / ROT_PRESHOOT)));
            face.state = 'POST_MISS'; face.age = 0;
          } else if (face.state === 'PRE_SHOOT') {
            const cur = angleLerp(face.from, inwardA, easeInOutCubic(clamp01(face.age / ROT_PRESHOOT)));
            if (Math.abs(angleDelta(cur, inwardA)) <= AIM_EPS) face.state = 'AIMED';
          }
        }
      }

      // 2b) fire check (only while still on the belt this frame, and only AIMED)
      if (pig.t < 1 && pig.ammo > 0 && pig.fireTimer <= 0 && face.state === 'AIMED') {
        const target = this._lineTarget(pig);
        if (target) {
          // v3 VFX: capture the destroyed small block's world position + the firing
          // pig's position BEFORE destroying it, so the render layer can fly a shot
          // bubble there and burst a pop. Pure data read; destroy/ammo unchanged.
          const blockPos = { x: target.mesh.position.x, y: target.mesh.position.y };
          const firePos = this.conveyor.sample(pig.t);
          // Phase 4 SEAWEED WRAPS (spec: Seaweed-wrapped blocks) — the ENTIRE
          // mechanic change: a wrapped block's first hit PEELS the wrap instead
          // of destroying it. Same shot cost/cadence/feedback; the block stays
          // alive (so no lane sync, no mine trigger, no completion this hit).
          const dewrap = target.wrapped === true;
          if (dewrap) {
            target.wrapped = false; // peel the seaweed — block STAYS ALIVE
          } else {
            this.board.destroy(target);
            fired = true;
          }
          pig.ammo -= 1;
          pig.fireTimer = CONFIG.fireInterval;
          pig.ammoPulse = AMMO_PULSE; // v2: visual tick on the ammo label
          // v2: trigger a render-only recoil kick. The pig shoots INWARD, so it
          // recoils OUTWARD = the NEGATIVE inward normal at its current position.
          // We only store a timer + direction here; tickAnims() applies the offset.
          const n = this.conveyor.sample(pig.t).inwardNormal;
          pig.recoil = RECOIL_DUR;
          pig.recoilDir = { x: -n.x, y: -n.y };
          // v3 VFX event: a shot fired -> {fly a bubble pig->block, then pop +
          // muzzle puff}. Data only; drained + spawned by main.js's VfxLayer.
          this.vfx.push({
            type: 'fire',
            colorKey: pig.colorKey,
            fromX: firePos.x, fromY: firePos.y,          // pig (muzzle) position
            toX: blockPos.x,  toY: blockPos.y,           // doomed small block position
            // Phase 4 (additive DATA only): the destroyed block's identity, for the
            // render-side coin award (wild = 3) + the combo-chain exposure check.
            scol: target.scol, srow: target.srow,
            blockColor: target.colorKey,
            // Phase 4 WRAPS: true = this hit PEELED a wrap (block still alive).
            // Render side: 0 coins, seaweed strip anim instead of a cube pop.
            dewrap,
          });
          // Phase 4 MINES (spec: Mine blocks): the trigger hit above was a
          // normal shot (ammo -1, cadence, fire event); now the mine EXPLODES —
          // the board clears the 6x6 blast square (color/blocking ignored, no
          // extra ammo). One 'mineExplode' DATA event carries the blast center
          // + the destroyed blocks for the render side (burst/shake/flash VFX
          // + per-block coin awards). Plain numbers/strings only, as ever.
          if (!dewrap && target.colorKey === 'M') {
            const blast = this.board.explodeMine(target);
            this.vfx.push({
              type: 'mineExplode',
              x: blast.cx, y: blast.cy,
              blocks: blast.destroyed.map((b) => ({
                x: b.mesh.position.x, y: b.mesh.position.y, blockColor: b.colorKey,
              })),
            });
          }
          // Phase 4 GOLDEN PIG pierce (spec: Golden pig, firing rule): a 'G'
          // pig's shot hits up to TWO blocks. After the first hit — unless it
          // triggered a mine (the explosion CONSUMES the pierce) — re-read the
          // same inward line: the next alive block (any color; after a dewrap,
          // the SAME now-unwrapped block) takes a second hit under the normal
          // per-hit rules (peel / destroy / mine-trigger, ammo -= 1 each).
          // One shot = one cadence cooldown + one recoil kick for the pair.
          if (pig.colorKey === 'G' && pig.ammo > 0 && !(!dewrap && target.colorKey === 'M')) {
            const second = this._lineTarget(pig);
            if (second) {
              const secondPos = { x: second.mesh.position.x, y: second.mesh.position.y };
              const dewrap2 = second.wrapped === true;
              if (dewrap2) {
                second.wrapped = false; // peel — the block stays alive
              } else {
                this.board.destroy(second);
                fired = true;
              }
              pig.ammo -= 1;
              pig.ammoPulse = AMMO_PULSE;
              this.vfx.push({
                type: 'fire',
                colorKey: pig.colorKey,
                fromX: firePos.x, fromY: firePos.y,
                toX: secondPos.x, toY: secondPos.y,
                scol: second.scol, srow: second.srow,
                blockColor: second.colorKey,
                dewrap: dewrap2,
                pierce: true, // render side: the second gold tracer of the pair
              });
              if (!dewrap2 && second.colorKey === 'M') {
                const blast = this.board.explodeMine(second);
                this.vfx.push({
                  type: 'mineExplode',
                  x: blast.cx, y: blast.cy,
                  blocks: blast.destroyed.map((b) => ({
                    x: b.mesh.position.x, y: b.mesh.position.y, blockColor: b.colorKey,
                  })),
                });
              }
            }
          }
          // spent its last shot -> leaves immediately at THIS spot (not at lap end).
          if (pig.ammo === 0) { spent.push(pig); continue; }
        }
        // no target -> HOLD (do not reset timer aggressively; keep scanning)
      }

      // 3) reached end?
      if (pig.t >= 1) reachedEnd.push(pig);

      // 4) position the mesh + FACE per the state machine (Phase 5, spec:
      //    Facing): nose along the travel tangent while TRAVELLING, easing
      //    inward through PRE_SHOOT, locked inward while AIMED, easing back
      //    through POST_MISS. The sprite's local +Y is its face/head.
      pig.mesh.position.set(sNow.x, sNow.y, 0.1);
      let ang;
      if (face.state === 'PRE_SHOOT')      ang = angleLerp(face.from, inwardA, easeInOutCubic(clamp01(face.age / ROT_PRESHOOT)));
      else if (face.state === 'AIMED')     ang = inwardA;
      else if (face.state === 'POST_MISS') ang = angleLerp(face.from, tangentA, easeInOutCubic(clamp01(face.age / ROT_POSTMISS)));
      else                                 ang = tangentA;
      pig.mesh.rotation.z = ang;
    }

    // Ammo emptied mid-lap -> leave RIGHT NOW: turn 90° to face the belt, bounce,
    // shrink and vanish at the current belt position (v3 'depart' anim + send-off).
    for (const pig of spent) {
      this._removeFromConveyor(pig);
      pig.location = 'gone';
      const s = this.conveyor.sample(Math.min(pig.t, 0.99999));
      pig.mesh.position.set(s.x, s.y, 0.1);
      // Phase 5 LEAVING (spec: Facing): rotate from the current facing to the
      // travel TANGENT over ROT_LEAVING first; the bounce+shrink vanish only
      // starts once the turn is complete (keeps the facing clean on exit).
      pig.face = { state: 'LEAVING', from: pig.mesh.rotation.z, age: 0 };
      pig.anim = {
        kind: 'depart', age: 0, dur: ROT_LEAVING + DEPART_EASE, rotDur: ROT_LEAVING,
        baseX: s.x, baseY: s.y, baseRot: pig.mesh.rotation.z,
        toRot: Math.atan2(-s.inwardNormal.x, s.inwardNormal.y) - Math.PI / 2, // tangent
        outX: -s.inwardNormal.x, outY: -s.inwardNormal.y, // away from the board
      };
      // v3 VFX: a "job done" send-off burst at the exit spot, tinted to its color.
      this.vfx.push({ type: 'leave', x: s.x, y: s.y, colorKey: pig.colorKey });
    }

    // Lap-end routing for pigs that crossed t=1 this frame (these still have ammo).
    for (const pig of reachedEnd) {
      this._removeFromConveyor(pig);
      if (pig.ammo === 0) {
        // (defensive — ammo-0 normally departs mid-lap above) leave for good.
        pig.location = 'gone';
        const end = this.conveyor.endPos;
        pig.anim = {
          kind: 'leave', age: 0, dur: LEAVE_EASE,
          from: { x: end.x, y: end.y },
          to:   { x: end.x - CELL * 2.4, y: end.y - CELL * 1.4 }, // outward off-belt
        };
        this.vfx.push({ type: 'leave', x: end.x, y: end.y, colorKey: pig.colorKey });
      } else {
        // leftover ammo -> park in a free slot, else LOCKUP
        const slot = this._freeSlot();
        if (slot !== -1) {
          this.slots[slot] = pig;
          pig.slotIndex = slot;
          pig.location = 'slot';
          const end = this.conveyor.endPos;
          this._layoutSlots(); // sets final slot position
          // v3 VFX event: a pig PARKED in a seat -> the tackle-rack seat reacts
          // (a brief settle flourish, timed to land with the v2 return ease).
          this.vfx.push({ type: 'slotFill', slot });
          // v2: settle INTO the slot from the belt end with easeOutBack so
          // "parked" reads as a deliberate land-and-settle. Visual only.
          pig.anim = {
            kind: 'return', age: 0, dur: RETURN_EASE,
            from: { x: end.x, y: end.y },
            to:   { x: pig.mesh.position.x, y: pig.mesh.position.y },
          };
        } else {
          // No free slot. Lockup only if this pig also cannot spend its ammo —
          // no matching cube is currently EXPOSED (first on some inward line). Per
          // spec all 3 conditions: trays full + blocked at end + no room to shoot.
          if (!this.board.hasExposedColor(pig.colorKey)) {
            pig.location = 'gone';
            pig.mesh.visible = false;
            this.state = 'lost';
          } else {
            // Slots full but the pig's color is still exposed somewhere: it cannot
            // park, but the jam is not yet structurally fatal in this strict
            // reading. We send the pig around again (it may clear more next lap).
            this._enterConveyor(pig);
          }
        }
      }
    }

    // A block died this frame: keep the infinite queue in sync with the board
    // (spec winnability rule — see _syncLanesToBoard).
    if (fired) this._syncLanesToBoard();

    // Win check: all cubes cleared.
    if (this.board.aliveCount() === 0) {
      this.state = 'won';
    }
  }

  // --- render-side visual settle (NOT called by gameplay update/harnesses) ---
  // Advances purely cosmetic launch/return/leave tweens and the ammo pulse.
  // Touches only mesh.scale / mesh.position / mesh.visible — never gameplay state.
  tickAnims(dt) {
    for (const pig of this.pigs) {
      // queue pieces slide up toward their lane slot — the off-screen reserve feeding
      // in from below as heads launch. Frame-rate-independent exponential smoothing.
      if (pig.location === 'queue' && pig.laneTarget) {
        const k = 1 - Math.exp(-LANE_EASE_K * dt);
        pig.mesh.position.x += (pig.laneTarget.x - pig.mesh.position.x) * k;
        pig.mesh.position.y += (pig.laneTarget.y - pig.mesh.position.y) * k;
        pig.mesh.position.z = 0.1;
      }
      const a = pig.anim;
      if (a) {
        a.age += dt;
        const p = clamp01(a.dur > 0 ? a.age / a.dur : 1);
        if (a.kind === 'launch') {
          // scale-in: 0.55 -> 1.0 with easeOutCubic; position already set by update()
          const s = 0.55 + 0.45 * easeOutCubic(p);
          pig.mesh.scale.setScalar(s);
        } else if (a.kind === 'return') {
          // slide from belt end to slot with easeOutBack (overshoot-settle)
          const e = easeOutBack(p);
          pig.mesh.position.x = a.from.x + (a.to.x - a.from.x) * e;
          pig.mesh.position.y = a.from.y + (a.to.y - a.from.y) * e;
          pig.mesh.scale.setScalar(1);
        } else if (a.kind === 'leave') {
          // slide outward off the belt + shrink + (when done) hide
          const e = easeOutCubic(p);
          pig.mesh.position.x = a.from.x + (a.to.x - a.from.x) * e;
          pig.mesh.position.y = a.from.y + (a.to.y - a.from.y) * e;
          pig.mesh.scale.setScalar(1 - 0.85 * e);
          if (p >= 1) pig.mesh.visible = false;
        } else if (a.kind === 'depart') {
          // ammo-0 mid-lap exit, Phase 5 LEAVING (spec: Facing): FIRST rotate
          // to the travel tangent over a.rotDur (50ms, easeInOutCubic), THEN
          // the small outward bounce + pop-and-shrink vanish (the vanish never
          // starts mid-turn, keeping the exit facing clean).
          const rotP = clamp01(a.rotDur > 0 ? a.age / a.rotDur : 1);
          pig.mesh.rotation.z = angleLerp(a.baseRot ?? 0, a.toRot ?? 0, easeInOutCubic(rotP));
          const p2 = clamp01((a.age - (a.rotDur ?? 0)) / (a.dur - (a.rotDur ?? 0)));
          const hop = Math.sin(Math.PI * p2) * CELL * 0.3; // out-and-back bounce
          pig.mesh.position.set(a.baseX + a.outX * hop, a.baseY + a.outY * hop, 0.1);
          const sc = p2 <= 0 ? 1 : p2 < 0.3 ? 1 + 0.3 * (p2 / 0.3) : 1.3 * (1 - easeInCubic((p2 - 0.3) / 0.7));
          pig.mesh.scale.setScalar(Math.max(0, sc));
          if (p >= 1) pig.mesh.visible = false;
        }
        if (p >= 1) {
          if (a.kind !== 'leave' && a.kind !== 'depart') pig.mesh.scale.setScalar(1);
          pig.anim = null;
        }
      }
      // ammo "tick" pulse: quick scale bump that decays back to 1.
      if (pig.ammoPulse > 0) {
        pig.ammoPulse = Math.max(0, pig.ammoPulse - dt);
        // expose normalized pulse for the DOM label (main.js reads it)
      }
      // per-shot RECOIL offset: snap outward, cushion back to rest within the
      // cadence. Applied ON TOP of the belt position update() already set this
      // frame (update() re-sets the pure belt pos every frame -> no drift). Only
      // a mesh-position nudge; gameplay state is untouched.
      if (pig.recoil > 0) {
        pig.recoil = Math.max(0, pig.recoil - dt);
        const p = clamp01(1 - pig.recoil / RECOIL_DUR); // 0 (just fired) -> 1 (rest)
        const mag = RECOIL_OFFSET * easeInCubic(1 - p);  // max at fire, eased to 0
        pig.mesh.position.x += pig.recoilDir.x * mag;
        pig.mesh.position.y += pig.recoilDir.y * mag;
      }
    }
  }

  _removeFromConveyor(pig) {
    const i = this.conveyorPigs.indexOf(pig);
    if (i !== -1) this.conveyorPigs.splice(i, 1);
    // Drop any in-flight recoil so the kick never bleeds into the return/leave
    // settle anims (those set mesh position themselves). Render-only cleanup.
    pig.recoil = 0;
  }

  // Resolve the FIRST cube in the pig's current inward line, returned only if it
  // matches the pig's color (BLOCKING; the board queries enforce it). null = HOLD.
  _lineTarget(pig) {
    return this._lineTargetAt(pig, pig.t);
  }

  // Same query at an arbitrary path parameter — used by the facing machine's
  // positional look-ahead (the line the pig is ABOUT to align with).
  _lineTargetAt(pig, t) {
    const s = this.conveyor.sample(t);
    if (s.alignIndex < 0) return null; // corner / outside board span -> HOLD
    switch (s.edge) {
      case 'top':    return this.board.nearestDownColumn(s.alignIndex, pig.colorKey);
      case 'bottom': return this.board.nearestUpColumn(s.alignIndex, pig.colorKey);
      case 'left':   return this.board.nearestRightRow(s.alignIndex, pig.colorKey);
      case 'right':  return this.board.nearestLeftRow(s.alignIndex, pig.colorKey);
      default:       return null;
    }
  }

  dispose() {
    this._geo.dispose();
    for (const m of this._materials.values()) m.dispose();
    this.scene.remove(this.group);
  }
}
