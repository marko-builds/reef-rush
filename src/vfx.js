// vfx.js — v3 JUICE layer (Fish of Fortune). ADDITIVE cosmetic feedback only.
//
// This module owns every v3 dynamic-feedback effect: the fired SHOT bubble, the
// cube-pop SPLASH burst + neighbor NUDGE, the fire MUZZLE puff, the slot-rack
// fill/vacate flourishes, and the WIN / LOSE transitions. It NEVER touches gameplay
// state, firing, routing, slots, win/lose logic, or the v2 timing VALUES.
//
// It is driven entirely off render-safe hooks:
//   - pigs.vfx[]   : a DATA event queue update() appends to (fire / slotFill /
//                    slotVacate). The same render-only hook pattern as the v2
//                    recoil/ammoPulse fields. Drained here each frame.
//   - pigs.state   : 'playing' | 'won' | 'lost'  (read for the transitions).
//
// All sprites are POOLED (allocated once at construction, reused) and DISPOSED in
// dispose(). All motion is delta-timed. The headless harnesses construct PigManager
// with no renderer and never build a VfxLayer, so none of this can crash them.
//
// Art is OWNED by the asset pipeline (technical-artist): we only consume the
// authored `shot` + `particle` sprites via assets.get(); if a sprite is missing the
// pipeline already hands back a placeholder texture, so we still never crash.

import * as THREE from 'three';
import { CELL, SUB_COLS, SUB_ROWS } from './board.js';
import { COLORS } from './level.js';
import { clamp01, easeOutCubic, easeOutQuart } from './easing.js';

// ---- tuning (all delta-timed; logged in docs/feel-changelog.md) -------------
const SHOT_TRAVEL = 0.09;   // 90ms pig->cube flight: reads, lands inside 130ms cadence
const SHOT_SIZE   = CELL * 0.42;
const SHOT_BOW    = CELL * 0.45; // perpendicular arc bow: lobs inward like a thrown
                                 // bait/hook, not a laser. sin(pi*p) -> 0 at both ends
                                 // so the bubble still LANDS exactly on the cube at p=1.

const POP_COUNT   = 6;      // sparkles per cube pop (radial)
const POP_LIFE    = 0.32;   // 320ms: a quick splash, gone before the next column read
const POP_SIZE    = CELL * 0.30;
const POP_SPEED   = CELL * 2.4;  // outward burst speed (world units/sec at t=0)

const PUFF_LIFE   = 0.16;   // 160ms muzzle puff at the firing pig (pairs w/ recoil)
const PUFF_SIZE   = CELL * 0.5;

const NUDGE_DUR   = 0.16;   // 160ms neighbor cube "shove" reaction
const NUDGE_MAG   = CELL * 0.10; // peak positional nudge away from the popped cube

// LEAVE flourish: a larger, softer OUTWARD ring of bubbles when a pig spends its
// ammo and leaves. Distinct from a cube-pop (more particles, longer life, bigger,
// evenly-spaced ring) so it reads as a celebratory "spent — job done", not a hit.
const LEAVE_COUNT = 14;     // bubbles in the ring (vs POP_COUNT 6 -> clearly fuller)
const LEAVE_LIFE  = 0.55;   // 550ms: lingers longer than a 320ms pop (soft fade)
const LEAVE_SIZE  = CELL * 0.40;  // baseScale ~ slightly larger than a pop sparkle
const LEAVE_SPEED = CELL * 1.6;   // gentle outward drift (softer than POP_SPEED 2.4)

const WIN_BURST   = 90;     // rising celebration sparkles on board-clear
const WIN_LIFE    = 1.6;    // each celebration sparkle lifetime (s)
const WIN_SIZE    = CELL * 0.5;

// Phase 4 COMBO CHAIN visual (spec: Combo chain visual) — PURELY VISUAL. When a
// shot clears a big block's LAST small block, same-color ADJACENT big blocks that
// are now fully exposed on some inward line glow-pulse briefly: "now shootable."
const COMBO_DUR   = 0.30;        // 300ms pulse, easeOutCubic decay
const COMBO_SCALE = 0.08;        // peak +8% scale flash on the alive sub-blocks
const COMBO_GLOW_OPACITY = 0.55; // soft glow quad over each sub-block (pooled)
const COMBO_GLOW_SIZE = CELL * 0.62; // covers a SUB_SIZE 0.5-cell tile w/ soft edge

// Phase 4 COIN RAIN (spec: Coin economy) — the level-clear flourish: pooled gold
// coins arc from the BOARD CENTER outward under gravity, spinning and fading, while
// the HUD counter rolls up. Fires on WIN only (inside the winBurstDone latch),
// never on the lockup-lose.
const COIN_RAIN_COUNT = 16;        // pooled coins per flourish (needs.md: 12-20)
const COIN_RAIN_LIFE  = 1.15;      // seconds airborne before fully faded
const COIN_SIZE       = CELL * 0.38;
const COIN_GRAVITY    = CELL * 9.0;   // downward pull (world units/s^2) on the arc
const COIN_SPEED_X    = CELL * 2.6;   // max horizontal scatter speed (+/-)
const COIN_SPEED_Y_MIN = CELL * 2.0;  // upward launch speed range -> staggered arcs
const COIN_SPEED_Y_MAX = CELL * 4.6;

// Phase 4 MINE blocks (spec: Mine blocks) — the idle danger pulse + the EXPLOSION.
// The explosion must read as a clearly bigger event than any cube pop: a fast hot
// radial burst + a white flash over the whole blast square + a brief screen shake.
const MINE_PULSE_S    = 0.8;     // idle glow throb loop — faster than the wild 1.2s
const MINE_PULSE_SCALE = 0.03;   // ±3% scale breath on top of the color throb
const BOOM_COUNT  = 26;          // radial burst particles (needs.md: 20-30)
const BOOM_LIFE   = 0.55;        // s — lingers past a 320ms pop, gone before 600ms
const BOOM_SIZE   = CELL * 0.42; // bigger chunks than a pop sparkle (0.30)
const BOOM_SPEED  = CELL * 5.2;  // much faster than POP_SPEED 2.4 — a real blast
const BOOM_TINTS  = [0xff5a2a, 0xffa53d, 0xffe27a, 0xffffff]; // ember..white-hot
const FLASH_DUR   = 0.28;        // white flash over the blast square, easeOutCubic
const FLASH_OPACITY = 0.75;
const FLASH_SIZE  = CELL * 3.2;  // covers the 3x3-cell blast square + soft margin
const SHAKE_AMP   = 0.15;        // world units (needs.md)
const SHAKE_DECAY = 0.85;        // amplitude multiplier per 60fps frame (delta-timed)

// Phase 4 SEAWEED WRAPS (spec: Seaweed-wrapped blocks) — the armor overlay quad
// per wrapped sub-block + the dewrap STRIP (slide-up + fade) when the wrap peels.
// The strip fires when the landing SHOT arrives (synced to the hit, like the pop);
// a wrapped block killed by a mine blast just drops its overlay with the block.
const WRAP_SIZE   = CELL * 0.59; // matches the tiles' rendered footprint (0.5 x 1.18)
const STRIP_DUR   = 0.20;        // 200ms slide-up + fade (needs.md), easeOutCubic
const STRIP_RISE  = CELL * 0.45; // upward slide distance over the strip
const STRIP_BITS  = 4;           // loose kelp flecks floating up off the peel
const STRIP_BIT_LIFE = 0.30;
const STRIP_TINTS = [0x2e9e63, 0x7fd6a4, 0x1f7a4d]; // kelp greens (sprite palette)
const STRIP_FALLBACK_AGE = 0.22; // auto-strip if the landing never arrives (pool dry)

// Phase 4 GOLDEN PIG (spec: Golden pig) — the FX are the pig's primary
// identifier (the hue alone is too close to C4 on level 5): a pulsing glow
// border behind any WAITING golden pig (queue lane or slot — notice it before
// tapping), a very subtle idle sparkle cycle, and a brief particle trail as it
// launches onto the belt. The gold pierce tracer falls out of COLORS.G via the
// per-color shot materials; the pierce (2nd) tracer renders a touch larger.
const GOLD_GLOW_POOL    = 10;          // 4 lane heads + 5 slots + 1 spare
const GOLD_GLOW_SIZE    = CELL * 1.05; // soft halo quad behind the PIG_SIZE 0.7 pig
const GOLD_GLOW_MIN     = 0.22;        // pulse floor (opacity)
const GOLD_GLOW_MAX     = 0.46;        // pulse peak — faint, never a beacon
const GOLD_GLOW_PULSE_S = 1.4;         // slow breath, calmer than the tap rings
const GOLD_SPARK_EVERY  = 0.45;        // s between idle glints per golden pig
const GOLD_SPARK_LIFE   = 0.5;         // -> ~1-2 glints alive per pig (2-3 peak)
const GOLD_TRAIL_DUR    = 0.7;         // s of trail after a launch onto the belt
const GOLD_TRAIL_EVERY  = 0.055;       // s between trail bits (~13 over the trail)
const GOLD_TRAIL_LIFE   = 0.35;
const PIERCE_SHOT_MUL   = 1.25;        // the pierce tracer reads a step bigger

// mine idle throb endpoints (multiply-tints on the shared 'M' material): full
// white = the sprite as authored; the warm value dims toward ember and back.
const _MINE_TINT_A = new THREE.Color(0xffffff);
const _MINE_TINT_B = new THREE.Color(0xffb088);

// pool sizes (max simultaneous): a pig sprays ~7-8/s; pops/shots overlap a little.
const SHOT_POOL   = 24;
const PART_POOL   = 220;    // covers POP_COUNT bursts overlapping + the win cascade

export class VfxLayer {
  constructor(scene, assets, board, conveyor, pigs, slotRack, opts = {}) {
    // Phase 5 (5.11 win screen): the level-5 TREASURE finale rains a bigger
    // coin burst (30-40 per the playbook) than the per-level clear (16).
    this._rainCount = opts.finaleRain ? 32 : null; // null -> COIN_RAIN_COUNT
    this.scene = scene;
    this.assets = assets;
    this.board = board;
    this.conveyor = conveyor;
    this.pigs = pigs;
    this.slotRack = slotRack;     // { frames:[{loop, mat}], ... } from main.js
    this.group = new THREE.Group();
    scene.add(this.group);

    this._disposables = [];
    this._track = (o) => { this._disposables.push(o); return o; };

    const shotRec = assets ? assets.get('shot') : null;
    const partRec = assets ? assets.get('particle') : null;

    // --- SHOT bubble pool (one shared geo; one material PER COLOR for tinting) -
    this._shotGeo = this._track(new THREE.PlaneGeometry(SHOT_SIZE, SHOT_SIZE));
    this._shotMats = new Map(); // colorKey -> material
    this._shotTex = shotRec ? shotRec.texture : null;
    this.shots = [];
    for (let i = 0; i < SHOT_POOL; i++) {
      const mesh = new THREE.Mesh(this._shotGeo, this._neutralShotMat());
      mesh.visible = false;
      mesh.position.z = 0.25; // above cubes/pigs, below UI rings
      this.group.add(mesh);
      this.shots.push({ mesh, active: false, age: 0, fromX: 0, fromY: 0, toX: 0, toY: 0 });
    }

    // --- PARTICLE pool (pops + muzzle puffs + win cascade share it) -----------
    this._partGeo = this._track(new THREE.PlaneGeometry(POP_SIZE, POP_SIZE));
    this._partTex = partRec ? partRec.texture : null;
    // one shared material per tint key so we don't allocate per particle; we pool
    // by giving each particle its own lightweight material (cheap, count is bounded)
    this.particles = [];
    for (let i = 0; i < PART_POOL; i++) {
      const mat = this._track(this._partTex
        ? new THREE.MeshBasicMaterial({ map: this._partTex, transparent: true, depthWrite: false })
        : new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
      const mesh = new THREE.Mesh(this._partGeo, mat);
      mesh.visible = false;
      mesh.position.z = 0.26;
      this.group.add(mesh);
      // baseOpacity scales the whole fade curve so soft spawns (puff 0.7, leave
      // 0.9, combo glow 0.55) keep their authored softness for their full life.
      this.particles.push({ mesh, mat, active: false, age: 0, life: 0, vx: 0, vy: 0, baseScale: 1, spin: 0, baseOpacity: 1 });
    }

    // --- COIN-RAIN pool (Phase 4 coin economy: the level-clear flourish) ------
    // Uses the authored coin sprite; if missing, the shared particle texture
    // tinted treasure-gold (the asset-pipeline placeholder rule: never crash).
    const coinRec = assets ? assets.get('coin') : null;
    this._coinGeo = this._track(new THREE.PlaneGeometry(COIN_SIZE, COIN_SIZE));
    this._coinTex = coinRec ? coinRec.texture : this._partTex;
    this.coinRain = [];
    for (let i = 0; i < (this._rainCount ?? COIN_RAIN_COUNT); i++) {
      const mat = this._track(this._coinTex
        ? new THREE.MeshBasicMaterial({ map: this._coinTex, transparent: true, depthWrite: false })
        : new THREE.MeshBasicMaterial({ color: 0xffc91f, transparent: true, depthWrite: false }));
      if (!coinRec) mat.color.setHex(0xffc91f); // gold-tint the fallback texture
      const mesh = new THREE.Mesh(this._coinGeo, mat);
      mesh.visible = false;
      mesh.position.z = 0.32; // above the win cascade sparkles
      this.group.add(mesh);
      this.coinRain.push({ mesh, mat, active: false, age: 0, vx: 0, vy: 0, spin: 0 });
    }

    // --- neighbor-nudge bookkeeping (render-only transient on cube meshes) -----
    // We restore each nudged cube's mesh position after the pulse so we never drift
    // its authored grid position. Keyed by cube ref.
    this.nudges = []; // { cube, age, dx, dy, baseX, baseY }

    // --- COMBO CHAIN bookkeeping (Phase 4, purely visual) ---------------------
    // Static index of the board's big-block cells (alive flags change; the cell
    // list does not): "cellCol,cellRow" -> { colorKey, blocks[≤4] }. Blocks from
    // the harnesses' hand-placed boards lack cell fields and simply never index.
    this.cellMap = new Map();
    for (const b of board.blocks) {
      if (b.cellCol == null) continue;
      const key = b.cellCol + ',' + b.cellRow;
      let cell = this.cellMap.get(key);
      if (!cell) { cell = { colorKey: b.colorKey, blocks: [] }; this.cellMap.set(key, cell); }
      cell.blocks.push(b);
    }
    this.comboPulses = []; // { mesh, age, baseScale } — scale flash, restored exactly

    // --- WILD block idle pulse (Phase 4, look only) ---------------------------
    // Every wild ('W') small block breathes ±2% on a 1.2 s sin loop so "any pig
    // can shoot me" reads at a glance. Base scale captured once (SPRITE_FILL).
    this.wildBlocks = board.blocks.filter((b) => b.colorKey === 'W')
      .map((b) => ({ block: b, baseScale: b.mesh.scale.x }));
    this.wildPhase = 0;

    // --- MINE block state (Phase 4, look only) ---------------------------------
    // Idle danger throb: ±3% scale + a white↔ember color throb on the SHARED 'M'
    // material (all mine sub-blocks pulse together — cheap, and a mine is one
    // cell anyway). The explosion owns a dedicated white flash quad (one mine
    // per level -> one quad) + a decaying camera-shake offset main.js applies.
    this.mineBlocks = board.blocks.filter((b) => b.colorKey === 'M')
      .map((b) => ({ block: b, baseScale: b.mesh.scale.x }));
    this.minePhase = 0;
    this.mineMat = board._materials ? board._materials.get('M') ?? null : null;
    {
      const geo = this._track(new THREE.PlaneGeometry(FLASH_SIZE, FLASH_SIZE));
      const mat = this._track(new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
      }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.position.z = 0.29; // over cubes + burst particles, under the lose veil
      this.group.add(mesh);
      this.mineFlash = { mesh, mat, active: false, age: 0 };
    }
    this.shake = 0;                    // current shake amplitude (world units)
    this.shakeOffset = { x: 0, y: 0 }; // read by main.js to offset the camera

    // --- SEAWEED WRAP overlays (Phase 4, look only) ---------------------------
    // One quad per wrapped sub-block, just above its tile. Each has its OWN
    // material (individual fade); count is bounded by the authored wraps (max 1
    // row per level = 36 sub-blocks). Keyed "scol,srow" so the landing shot can
    // find its overlay. 90° rotation variety stops a wrapped row from tiling.
    const wrapRec = assets ? assets.get('seaweed') : null;
    this._wrapGeo = this._track(new THREE.PlaneGeometry(WRAP_SIZE, WRAP_SIZE));
    this._wrapTex = wrapRec ? wrapRec.texture : null;
    this.wrapOverlays = new Map();
    for (const b of board.blocks) {
      if (!b.wrapped) continue;
      const mat = this._track(this._wrapTex
        ? new THREE.MeshBasicMaterial({ map: this._wrapTex, transparent: true, depthWrite: false })
        : new THREE.MeshBasicMaterial({ color: 0x2e9e63, transparent: true, opacity: 0.8, depthWrite: false }));
      const mesh = new THREE.Mesh(this._wrapGeo, mat);
      mesh.position.set(b.mesh.position.x, b.mesh.position.y, 0.03); // over the tile, under pigs
      mesh.rotation.z = ((b.scol * 7 + b.srow * 13) % 4) * (Math.PI / 2);
      this.group.add(mesh);
      this.wrapOverlays.set(b.scol + ',' + b.srow, {
        block: b, mesh, mat, state: 'idle', age: 0, pendingAge: 0,
        baseY: b.mesh.position.y, baseOpacity: mat.opacity,
      });
    }

    // --- GOLDEN PIG fx (Phase 4, look only) ------------------------------------
    // Pooled halo quads parked behind WAITING golden pigs (re-assigned every
    // frame — goldens are rare, the pool never realistically runs dry), plus
    // the shared phase/timers for the sparkle cycle and per-pig launch trails.
    this._goldGlowGeo = this._track(new THREE.PlaneGeometry(GOLD_GLOW_SIZE, GOLD_GLOW_SIZE));
    this.goldenGlows = [];
    for (let i = 0; i < GOLD_GLOW_POOL; i++) {
      const mat = this._track(this._partTex
        ? new THREE.MeshBasicMaterial({ map: this._partTex, transparent: true, depthWrite: false, color: COLORS.G ?? 0xffe27a })
        : new THREE.MeshBasicMaterial({ color: COLORS.G ?? 0xffe27a, transparent: true, depthWrite: false }));
      mat.opacity = 0;
      const mesh = new THREE.Mesh(this._goldGlowGeo, mat);
      mesh.visible = false;
      mesh.position.z = 0.06; // under the pigs (0.1), over tiles/slots
      this.group.add(mesh);
      this.goldenGlows.push({ mesh, mat });
    }
    this.goldenPhase = 0;
    this.goldenSparkTimer = 0;
    this.goldenTrails = new Map(); // pig -> { onBelt, left, accum }

    // --- slot-rack flourish state (one timer per seat) ------------------------
    this.slotFx = (slotRack ? slotRack.frames : []).map(() => ({ age: 0, kind: null }));

    // --- transition state -----------------------------------------------------
    this.shownState = 'playing';  // last state we reacted to
    this.winBurstDone = false;
    this.loseVeil = null;         // calm dim panel mesh (built on lose)
    this._buildLoseVeil();
  }

  _neutralShotMat() {
    const mat = this._track(this._shotTex
      ? new THREE.MeshBasicMaterial({ map: this._shotTex, transparent: true, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    return mat;
  }

  // A tinted shot material per color (the shot SVG is authored light for multiply).
  _shotMatFor(colorKey) {
    if (!this._shotMats.has(colorKey)) {
      const mat = this._track(this._shotTex
        ? new THREE.MeshBasicMaterial({ map: this._shotTex, transparent: true, depthWrite: false, color: COLORS[colorKey] })
        : new THREE.MeshBasicMaterial({ color: COLORS[colorKey], transparent: true, depthWrite: false }));
      this._shotMats.set(colorKey, mat);
    }
    return this._shotMats.get(colorKey);
  }

  _buildLoseVeil() {
    // A calm, low-opacity teal veil that fades in over the board when the queue
    // jams — telegraphs the locked state WITHOUT a punishing flash. Built hidden.
    const geo = this._track(new THREE.PlaneGeometry(CELL * 60, CELL * 60));
    const mat = this._track(new THREE.MeshBasicMaterial({
      color: 0x0a3b4a, transparent: true, opacity: 0, depthWrite: false,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = 0.4; // above playfield, below the DOM banner
    mesh.visible = false;
    this.group.add(mesh);
    this.loseVeil = { mesh, mat, age: 0 };
  }

  // ---- pool acquire helpers -------------------------------------------------
  _freeShot() { for (const s of this.shots) if (!s.active) return s; return null; }
  _freePart() { for (const p of this.particles) if (!p.active) return p; return null; }

  // ---- spawn helpers --------------------------------------------------------
  _spawnShot(ev) {
    const s = this._freeShot();
    if (!s) return; // pool exhausted -> drop silently (cosmetic, never gates)
    s.active = true; s.age = 0;
    s.fromX = ev.fromX; s.fromY = ev.fromY; s.toX = ev.toX; s.toY = ev.toY;
    // Phase 4 WRAPS: a dewrap landing strips the seaweed instead of popping.
    s.dewrap = ev.dewrap === true;
    s.stripKey = ev.scol != null ? ev.scol + ',' + ev.srow : null;
    // Phase 4 GOLDEN PIG: the pierce (2nd hit of a golden shot) tracer renders
    // a step larger — both tracers are already gold-tinted via COLORS.G.
    s.pierce = ev.pierce === true;
    s.mesh.material = this._shotMatFor(ev.colorKey);
    s.mesh.visible = true;
    s.mesh.position.set(ev.fromX, ev.fromY, 0.25);
    s.mesh.scale.setScalar(1);
  }

  // burst of POP_COUNT radial sparkles at (x,y), tinted to the cube color.
  _spawnPop(x, y, colorKey) {
    const tint = COLORS[colorKey] ?? 0xffffff;
    for (let i = 0; i < POP_COUNT; i++) {
      const p = this._freePart();
      if (!p) return;
      const ang = (i / POP_COUNT) * Math.PI * 2 + Math.random() * 0.5;
      const spd = POP_SPEED * (0.6 + Math.random() * 0.6);
      p.active = true; p.age = 0; p.life = POP_LIFE;
      p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd;
      p.baseScale = 0.7 + Math.random() * 0.6;
      p.spin = (Math.random() - 0.5) * 6;
      p.mat.color.setHex(tint);
      p.mat.opacity = 1;
      p.baseOpacity = 1;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, 0.26);
      p.mesh.scale.setScalar(p.baseScale);
      p.mesh.rotation.z = Math.random() * Math.PI;
    }
  }

  // LEAVE flourish: an evenly-spaced OUTWARD ring of soft bubbles at (x,y), tinted
  // to the departing pig's color. Larger + longer-lived + fuller than a cube-pop so
  // "spent its ammo and left" reads as a distinct, celebratory-but-quick send-off.
  _spawnLeave(x, y, colorKey) {
    const tint = COLORS[colorKey] ?? 0xffffff;
    for (let i = 0; i < LEAVE_COUNT; i++) {
      const p = this._freePart();
      if (!p) return;
      // evenly spaced ring (small jitter) for a clean outward bloom
      const ang = (i / LEAVE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const spd = LEAVE_SPEED * (0.85 + Math.random() * 0.3);
      p.active = true; p.age = 0; p.life = LEAVE_LIFE;
      p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd;
      p.baseScale = (LEAVE_SIZE / POP_SIZE) * (0.85 + Math.random() * 0.35);
      p.spin = (Math.random() - 0.5) * 3;
      p.mat.color.setHex(tint);
      p.mat.opacity = 0.9;     // softer than a pop's hard 1.0
      p.baseOpacity = 0.9;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, 0.27);
      p.mesh.scale.setScalar(p.baseScale);
      p.mesh.rotation.z = Math.random() * Math.PI;
    }
  }

  // one soft white puff at the firing pig (pairs with the v2 motion recoil).
  _spawnPuff(x, y) {
    const p = this._freePart();
    if (!p) return;
    p.active = true; p.age = 0; p.life = PUFF_LIFE;
    p.vx = 0; p.vy = 0;
    p.baseScale = (PUFF_SIZE / POP_SIZE) * 1.0; // scale shared geo up to puff size
    p.spin = 0;
    p.mat.color.setHex(0xeafcff); // soft sea-foam white, not tinted
    p.mat.opacity = 0.7;
    p.baseOpacity = 0.7;
    p.mesh.visible = true;
    p.mesh.position.set(x, y, 0.24);
    p.mesh.scale.setScalar(p.baseScale);
    p.mesh.rotation.z = 0;
  }

  // a quick positional shove on the small blocks orthogonally adjacent to a popped one.
  _nudgeNeighbors(cell) {
    if (!cell) return;
    const grid = this.board.grid;
    const around = [
      [cell.scol + 1, cell.srow, +1, 0],
      [cell.scol - 1, cell.srow, -1, 0],
      [cell.scol, cell.srow + 1, 0, +1],
      [cell.scol, cell.srow - 1, 0, -1],
    ];
    for (const [c, r, sx, sy] of around) {
      const nb = grid.get(c + ',' + r);
      if (!nb || !nb.alive) continue;
      // push AWAY from the popped cube
      this.nudges.push({
        cube: nb, age: 0,
        dx: sx * NUDGE_MAG, dy: sy * NUDGE_MAG,
        baseX: nb.mesh.position.x, baseY: nb.mesh.position.y,
      });
    }
  }

  // ---- main per-frame update ------------------------------------------------
  update(dt) {
    // 1) drain the gameplay VFX event queue (data records appended by pigs.update)
    const q = this.pigs.vfx;
    if (q && q.length) {
      for (const ev of q) {
        if (ev.type === 'fire') {
          // The cube it's destroying is already gone from the grid, but we kept
          // its world pos in the event. Find the neighbor nudge from the CELL.
          this._spawnShot(ev);
          this._spawnPuff(ev.fromX, ev.fromY);
          // shot LANDS at SHOT_TRAVEL -> we defer the pop+nudge to when it arrives
          // (handled in the shot update below). Stash the color/landing on the shot.
          // (already carried; the landing spawns the pop.)
          // Phase 4 combo chain: if this destruction COMPLETED a big block, pulse
          // the now-exposed same-color neighbors (purely visual, board untouched).
          // A DEWRAP hit destroys nothing -> no completion possible, skip it (the
          // landing shot strips the seaweed overlay instead of popping).
          if (!ev.dewrap) this._comboCheck(ev);
        } else if (ev.type === 'mineExplode') {
          // Phase 4: a triggered mine -> hot radial burst + white flash over the
          // blast square + a brief decaying screen shake. Clearly NOT a pop.
          this._spawnBoom(ev);
        } else if (ev.type === 'leave') {
          // a pig spent its ammo + left -> a soft outward send-off ring at its exit.
          this._spawnLeave(ev.x, ev.y, ev.colorKey);
        } else if (ev.type === 'slotFill') {
          const fx = this.slotFx[ev.slot];
          if (fx) { fx.age = 0; fx.kind = 'fill'; }
        } else if (ev.type === 'slotVacate') {
          const fx = this.slotFx[ev.slot];
          if (fx) { fx.age = 0; fx.kind = 'vacate'; }
        }
      }
      q.length = 0; // consumed
    }

    this._updateShots(dt);
    this._updateParticles(dt);
    this._updateCoinRain(dt);
    this._updateNudges(dt);
    this._updateWildPulse(dt);
    this._updateMinePulse(dt);
    this._updateMineFlash(dt);
    this._updateShake(dt);
    this._updateWrapOverlays(dt);
    this._updateComboPulses(dt);
    this._updateGoldenFx(dt);
    this._updateSlotFx(dt);
    this._updateTransitions(dt);
  }

  // ---- Phase 4 GOLDEN PIG fx (purely visual) --------------------------------

  // One pass over the pigs: halo behind WAITING goldens (queue/slot), the idle
  // sparkle cycle on every visible golden, and the brief launch trail while a
  // golden enters the belt. Pool-bounded; gameplay state is only READ.
  _updateGoldenFx(dt) {
    if (!Array.isArray(this.pigs.pigs)) return; // harness stubs pass a bare {vfx,state}
    this.goldenPhase = (this.goldenPhase + dt / GOLD_GLOW_PULSE_S) % 1;
    const pulse = 0.5 + 0.5 * Math.sin(this.goldenPhase * Math.PI * 2);
    this.goldenSparkTimer -= dt;
    const sparkNow = this.goldenSparkTimer <= 0;
    if (sparkNow) this.goldenSparkTimer = GOLD_SPARK_EVERY;
    let gi = 0;
    for (const pig of this.pigs.pigs) {
      if (pig.colorKey !== 'G' || pig.location === 'gone' || !pig.mesh.visible) continue;
      const px = pig.mesh.position.x, py = pig.mesh.position.y;
      // faint glow border behind a WAITING golden (notice it before tapping)
      if ((pig.location === 'queue' || pig.location === 'slot') && gi < this.goldenGlows.length) {
        const g = this.goldenGlows[gi++];
        g.mesh.visible = true;
        g.mesh.position.set(px, py, 0.06);
        g.mat.opacity = GOLD_GLOW_MIN + (GOLD_GLOW_MAX - GOLD_GLOW_MIN) * pulse;
        g.mesh.scale.setScalar(1 + 0.06 * pulse);
      }
      // idle sparkle: one tiny glint per cycle, drifting up off the pig
      if (sparkNow) this._spawnGoldSpark(px, py);
      // launch trail: dotted gold bits for the first moments on the belt
      let tr = this.goldenTrails.get(pig);
      if (!tr) { tr = { onBelt: false, left: 0, accum: 0 }; this.goldenTrails.set(pig, tr); }
      if (pig.location === 'conveyor') {
        if (!tr.onBelt) { tr.onBelt = true; tr.left = GOLD_TRAIL_DUR; tr.accum = 0; }
        if (tr.left > 0) {
          tr.left -= dt;
          tr.accum += dt;
          while (tr.accum >= GOLD_TRAIL_EVERY) {
            tr.accum -= GOLD_TRAIL_EVERY;
            this._spawnGoldTrailBit(px, py);
          }
        }
      } else {
        tr.onBelt = false; // re-arm: a slot relaunch trails again
      }
    }
    for (; gi < this.goldenGlows.length; gi++) {
      this.goldenGlows[gi].mesh.visible = false;
      this.goldenGlows[gi].mat.opacity = 0;
    }
  }

  // a single small white-gold glint near (x,y) — the "very subtle" idle cycle.
  _spawnGoldSpark(x, y) {
    const p = this._freePart();
    if (!p) return;
    p.active = true; p.age = 0; p.life = GOLD_SPARK_LIFE;
    p.vx = (Math.random() - 0.5) * CELL * 0.3;
    p.vy = CELL * (0.4 + Math.random() * 0.4); // drift gently upward
    p.baseScale = 0.3 + Math.random() * 0.2;   // tiny — a glint, not a burst
    p.spin = (Math.random() - 0.5) * 5;
    p.mat.color.setHex(Math.random() < 0.5 ? (COLORS.G ?? 0xffe27a) : 0xfff6d8);
    p.mat.opacity = 0.85;
    p.baseOpacity = 0.85;
    p.mesh.visible = true;
    p.mesh.position.set(
      x + (Math.random() - 0.5) * CELL * 0.7,
      y + (Math.random() - 0.5) * CELL * 0.7, 0.27);
    p.mesh.scale.setScalar(p.baseScale);
    p.mesh.rotation.z = Math.random() * Math.PI;
  }

  // one stationary trail bit dropped at the launching golden pig's position —
  // as the pig moves, the fading bits read as a short golden wake.
  _spawnGoldTrailBit(x, y) {
    const p = this._freePart();
    if (!p) return;
    p.active = true; p.age = 0; p.life = GOLD_TRAIL_LIFE;
    p.vx = 0; p.vy = 0; // stays put; the pig moves away from it
    p.baseScale = 0.45 + Math.random() * 0.2;
    p.spin = 0;
    p.mat.color.setHex(COLORS.G ?? 0xffe27a);
    p.mat.opacity = 0.7;
    p.baseOpacity = 0.7;
    p.mesh.visible = true;
    p.mesh.position.set(x, y, 0.22); // under the shot tracers, over tiles
    p.mesh.scale.setScalar(p.baseScale);
    p.mesh.rotation.z = Math.random() * Math.PI;
  }

  // ---- Phase 4 MINES (purely visual; the blast itself ran in board.js) -------

  // MINE idle pulse: ±3% scale + a white↔ember throb on the shared material,
  // 0.8s sin loop — hotter and faster than the wild breath, reads as "danger".
  // Once every mine is dead the material resets to white and the loop retires.
  _updateMinePulse(dt) {
    if (this.mineBlocks.length === 0) return;
    if (!this.mineBlocks.some((m) => m.block.alive)) {
      if (this.mineMat) this.mineMat.color.setHex(0xffffff);
      this.mineBlocks.length = 0;
      return;
    }
    this.minePhase = (this.minePhase + dt / MINE_PULSE_S) % 1;
    const k = 0.5 + 0.5 * Math.sin(this.minePhase * Math.PI * 2);
    if (this.mineMat) this.mineMat.color.copy(_MINE_TINT_A).lerp(_MINE_TINT_B, k);
    const s = 1 + MINE_PULSE_SCALE * Math.sin(this.minePhase * Math.PI * 2);
    for (const m of this.mineBlocks) {
      if (m.block.alive && m.block.mesh) m.block.mesh.scale.setScalar(m.baseScale * s);
    }
  }

  // EXPLOSION: BOOM_COUNT hot radial chunks from the blast center, the white
  // flash quad over the 3x3-cell blast square, and the screen shake kick.
  _spawnBoom(ev) {
    for (let i = 0; i < BOOM_COUNT; i++) {
      const p = this._freePart();
      if (!p) break;
      const ang = (i / BOOM_COUNT) * Math.PI * 2 + Math.random() * 0.4;
      const spd = BOOM_SPEED * (0.5 + Math.random() * 0.7);
      p.active = true; p.age = 0; p.life = BOOM_LIFE * (0.7 + Math.random() * 0.5);
      p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd;
      p.baseScale = (BOOM_SIZE / POP_SIZE) * (0.7 + Math.random() * 0.7);
      p.spin = (Math.random() - 0.5) * 8;
      p.mat.color.setHex(BOOM_TINTS[i % BOOM_TINTS.length]);
      p.mat.opacity = 1;
      p.baseOpacity = 1;
      p.mesh.visible = true;
      p.mesh.position.set(ev.x, ev.y, 0.28);
      p.mesh.scale.setScalar(p.baseScale);
      p.mesh.rotation.z = Math.random() * Math.PI;
    }
    const f = this.mineFlash;
    f.active = true; f.age = 0;
    f.mesh.visible = true;
    f.mesh.position.set(ev.x, ev.y, 0.29);
    f.mat.opacity = FLASH_OPACITY;
    this.shake = SHAKE_AMP;
  }

  _updateMineFlash(dt) {
    const f = this.mineFlash;
    if (!f.active) return;
    f.age += dt;
    const t = clamp01(f.age / FLASH_DUR);
    f.mat.opacity = FLASH_OPACITY * (1 - easeOutCubic(t));
    if (t >= 1) { f.active = false; f.mesh.visible = false; }
  }

  // Screen shake: a random jitter whose amplitude decays by SHAKE_DECAY per
  // 60fps frame (delta-timed via pow). main.js adds shakeOffset to the camera.
  _updateShake(dt) {
    if (this.shake <= 0.002) {
      if (this.shake !== 0) { this.shake = 0; this.shakeOffset.x = 0; this.shakeOffset.y = 0; }
      return;
    }
    this.shake *= Math.pow(SHAKE_DECAY, dt * 60);
    this.shakeOffset.x = (Math.random() * 2 - 1) * this.shake;
    this.shakeOffset.y = (Math.random() * 2 - 1) * this.shake;
  }

  // ---- Phase 4 SEAWEED WRAPS (purely visual; the wrap flip ran in pigs.js) ---

  // The dewrap STRIP: kick the overlay's slide-up+fade and float a few loose
  // kelp flecks at the hit point. Called by the landing shot (hit-synced).
  _stripWrap(key, x, y) {
    const o = key != null ? this.wrapOverlays.get(key) : null;
    if (o && o.state === 'idle') { o.state = 'strip'; o.age = 0; }
    for (let i = 0; i < STRIP_BITS; i++) {
      const p = this._freePart();
      if (!p) return;
      p.active = true; p.age = 0; p.life = STRIP_BIT_LIFE;
      p.vx = (Math.random() - 0.5) * CELL * 1.2;
      p.vy = CELL * (0.8 + Math.random() * 1.0); // drift UP like loose kelp
      p.baseScale = 0.5 + Math.random() * 0.4;
      p.spin = (Math.random() - 0.5) * 7;
      p.mat.color.setHex(STRIP_TINTS[i % STRIP_TINTS.length]);
      p.mat.opacity = 0.9;
      p.baseOpacity = 0.9;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, 0.27);
      p.mesh.scale.setScalar(p.baseScale);
      p.mesh.rotation.z = Math.random() * Math.PI;
    }
  }

  // Overlay lifecycle: idle (armored) -> strip (200ms slide-up + fade) -> done.
  // Killed-while-wrapped (mine blast) just drops the overlay with the block;
  // a dewrap whose landing shot never arrived (pool dry) auto-strips shortly.
  _updateWrapOverlays(dt) {
    if (this.wrapOverlays.size === 0) return;
    for (const o of this.wrapOverlays.values()) {
      if (o.state === 'done') continue;
      if (o.state === 'idle') {
        if (!o.block.alive) { o.state = 'done'; o.mesh.visible = false; continue; }
        if (!o.block.wrapped) {
          o.pendingAge += dt; // dewrapped; landing strips it ~90ms after the hit
          if (o.pendingAge > STRIP_FALLBACK_AGE) { o.state = 'strip'; o.age = 0; }
        }
        continue;
      }
      o.age += dt;
      const t = clamp01(o.age / STRIP_DUR);
      const e = easeOutCubic(t);
      o.mesh.position.y = o.baseY + STRIP_RISE * e;
      o.mat.opacity = o.baseOpacity * (1 - e);
      if (t >= 1) { o.state = 'done'; o.mesh.visible = false; }
    }
  }

  // ---- Phase 4 COMBO CHAIN (purely visual) ----------------------------------

  // Fired once per destroyed small block. If its parent big block is now FULLY
  // cleared, find the up/down/left/right neighbor cells that (a) exist, (b) are
  // the SAME color, (c) still have an alive block, and (d) are now fully EXPOSED
  // on at least one perimeter inward line — then glow-pulse them.
  _comboCheck(ev) {
    if (ev.scol == null) return; // defensive: events from hand-placed test boards
    const cellCol = Math.floor(ev.scol / 2);
    const cellRow = Math.floor(ev.srow / 2);
    const cleared = this.cellMap.get(cellCol + ',' + cellRow);
    if (!cleared) return;
    if (cleared.blocks.some((b) => b.alive)) return; // not a COMPLETION -> no combo
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = this.cellMap.get((cellCol + dc) + ',' + (cellRow + dr));
      if (!nb) continue;                                  // (a) exists
      if (nb.colorKey !== cleared.colorKey) continue;     // (b) same color
      if (!nb.blocks.some((b) => b.alive)) continue;      // (c) not already cleared
      if (!this._cellExposed(cellCol + dc, cellRow + dr, nb.colorKey)) continue; // (d)
      this._pulseCell(nb);
    }
  }

  // EXPOSED = on some inward sub-line through this cell, every alive small block
  // between the belt edge and the cell is the SAME color (same-color fronts don't
  // disqualify — the same pig color can peel them first; spec: Combo chain visual).
  _cellExposed(cellCol, cellRow, colorKey) {
    const grid = this.board.grid;
    const inCell = (b) =>
      Math.floor(b.scol / 2) === cellCol && Math.floor(b.srow / 2) === cellRow;
    const walk = (line, dir) => {
      // line = the fixed sub index; dir picks the traversal of the other axis.
      for (let k = 0; k < (dir === 'down' || dir === 'up' ? SUB_ROWS : SUB_COLS); k++) {
        let scol, srow;
        if (dir === 'down')      { scol = line; srow = SUB_ROWS - 1 - k; }
        else if (dir === 'up')   { scol = line; srow = k; }
        else if (dir === 'right'){ scol = k; srow = line; }
        else                     { scol = SUB_COLS - 1 - k; srow = line; }
        const b = grid.get(scol + ',' + srow);
        if (!b || !b.alive) continue;
        if (inCell(b)) return true;              // reached the cell unblocked
        if (b.colorKey !== colorKey) return false; // different-color front blocks
        // same color in front: keep walking (peelable by the same pig color)
      }
      return false; // line holds no alive block of this cell
    };
    const cols = [2 * cellCol, 2 * cellCol + 1];
    const rows = [2 * cellRow, 2 * cellRow + 1];
    for (const c of cols) { if (walk(c, 'down') || walk(c, 'up')) return true; }
    for (const r of rows) { if (walk(r, 'right') || walk(r, 'left')) return true; }
    return false;
  }

  // Glow pulse on every ALIVE sub-block of the cell: a +8% scale flash decaying
  // over 300ms (easeOutCubic) + a soft stationary glow quad from the particle
  // pool, tinted toward white from the cell color. Pooled; no new geometry.
  _pulseCell(cell) {
    const glowTint = new THREE.Color(COLORS[cell.colorKey] ?? 0xffffff).lerp(
      new THREE.Color(0xffffff), 0.6);
    for (const b of cell.blocks) {
      if (!b.alive || !b.mesh) continue;
      // restart an in-flight pulse instead of stacking a second one on the mesh
      const existing = this.comboPulses.find((cp) => cp.mesh === b.mesh);
      if (existing) { existing.age = 0; }
      else this.comboPulses.push({ mesh: b.mesh, age: 0, baseScale: b.mesh.scale.x });
      const p = this._freePart();
      if (!p) continue; // glow quad is optional polish; scale flash still reads
      p.active = true; p.age = 0; p.life = COMBO_DUR;
      p.vx = 0; p.vy = 0;
      p.baseScale = COMBO_GLOW_SIZE / POP_SIZE;
      p.spin = 0;
      p.mat.color.copy(glowTint);
      p.mat.opacity = COMBO_GLOW_OPACITY;
      p.baseOpacity = COMBO_GLOW_OPACITY;
      p.mesh.visible = true;
      p.mesh.position.set(b.mesh.position.x, b.mesh.position.y, 0.23);
      p.mesh.scale.setScalar(p.baseScale);
      p.mesh.rotation.z = 0;
    }
  }

  // WILD idle pulse: ±2% scale breath, 1.2 s sin loop, on every alive wild block.
  // Runs BEFORE the combo pulse update so a (rare) combo flash on a wild mesh wins.
  _updateWildPulse(dt) {
    if (this.wildBlocks.length === 0) return;
    this.wildPhase = (this.wildPhase + dt / 1.2) % 1;
    const s = 1 + 0.02 * Math.sin(this.wildPhase * Math.PI * 2);
    for (const w of this.wildBlocks) {
      if (w.block.alive && w.block.mesh) w.block.mesh.scale.setScalar(w.baseScale * s);
    }
  }

  _updateComboPulses(dt) {
    for (let i = this.comboPulses.length - 1; i >= 0; i--) {
      const cp = this.comboPulses[i];
      cp.age += dt;
      const t = clamp01(cp.age / COMBO_DUR);
      // snap up to +8%, ease back down (easeOutCubic decay) — restored exactly
      cp.mesh.scale.setScalar(cp.baseScale * (1 + COMBO_SCALE * (1 - easeOutCubic(t))));
      if (t >= 1) {
        cp.mesh.scale.setScalar(cp.baseScale);
        this.comboPulses.splice(i, 1);
      }
    }
  }

  _updateShots(dt) {
    for (const s of this.shots) {
      if (!s.active) continue;
      s.age += dt;
      const p = clamp01(s.age / SHOT_TRAVEL);
      const e = easeOutCubic(p);
      let x = s.fromX + (s.toX - s.fromX) * e;
      let y = s.fromY + (s.toY - s.fromY) * e;
      // ARC: bow the path along the perpendicular (left-hand normal) of from->to by
      // a sin(pi*p) amount. Zero at p=0 and p=1 so the launch + the landing are
      // exact (pop still fires at the cube on p>=1); peak bow at midflight reads as
      // a gentle inward lob. We use the raw p (not the eased e) for the bow phase so
      // the crest sits centered over the flight regardless of the ease.
      const dx = s.toX - s.fromX;
      const dy = s.toY - s.fromY;
      const len = Math.hypot(dx, dy);
      if (len > 1e-4) {
        const nx = -dy / len; // left-hand perpendicular unit
        const ny = dx / len;
        const bow = SHOT_BOW * Math.sin(Math.PI * p);
        x += nx * bow;
        y += ny * bow;
      }
      s.mesh.position.set(x, y, 0.25);
      // a touch of grow then settle as it flies, fading slightly toward landing
      s.mesh.scale.setScalar((0.7 + 0.5 * e) * (s.pierce ? PIERCE_SHOT_MUL : 1));
      s.mesh.material.opacity = 0.95;
      if (p >= 1) {
        if (s.dewrap) {
          // LANDED on a WRAPPED block -> the hit PEELS: strip the seaweed
          // overlay + float a few kelp flecks. The block survives, so no
          // pop burst and no neighbor nudge (those mean "destroyed").
          this._stripWrap(s.stripKey, s.toX, s.toY);
        } else {
          // LANDED -> burst the pop + nudge neighbors at the cube cell.
          const cube = this._cubeAtWorld(s.toX, s.toY);
          const colorKey = this._shotColorKey(s.mesh.material);
          this._spawnPop(s.toX, s.toY, colorKey);
          this._nudgeNeighbors(cube);
        }
        s.active = false; s.mesh.visible = false;
      }
    }
  }

  // resolve which colorKey a shot material represents (reverse of _shotMatFor)
  _shotColorKey(mat) {
    for (const [k, m] of this._shotMats) if (m === mat) return k;
    return null;
  }

  // find the SMALL-BLOCK cell containing world (x,y) (the popped block is already
  // removed from the grid, but its neighbors remain). Mirrors the board's hierarchical
  // small-block layout: nearest big cell, then its lower/upper + left/right half.
  _cubeAtWorld(x, y) {
    const col = Math.round((x - this.board.originX) / CELL);
    const row = Math.round((y - this.board.originY) / CELL);
    const scol = 2 * col + (x >= this.board.originX + col * CELL ? 1 : 0);
    const srow = 2 * row + (y >= this.board.originY + row * CELL ? 1 : 0);
    return { scol, srow };
  }

  _updateParticles(dt) {
    for (const p of this.particles) {
      if (!p.active) continue;
      p.age += dt;
      const t = clamp01(p.age / p.life);
      // drift + decelerate (drag), fade + shrink out
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.vx *= (1 - 2.5 * dt); // drag so the burst eases out
      p.vy *= (1 - 2.5 * dt);
      p.mesh.rotation.z += p.spin * dt;
      const fade = 1 - easeOutQuart(t);
      p.mat.opacity = p.baseOpacity * fade;
      p.mesh.scale.setScalar(p.baseScale * (1 - 0.6 * t));
      if (t >= 1) { p.active = false; p.mesh.visible = false; }
    }
  }

  _updateNudges(dt) {
    for (let i = this.nudges.length - 1; i >= 0; i--) {
      const n = this.nudges[i];
      n.age += dt;
      const t = clamp01(n.age / NUDGE_DUR);
      // out-and-back: a single eased shove that returns to rest (sin arch)
      const k = Math.sin(t * Math.PI);
      if (n.cube && n.cube.alive && n.cube.mesh) {
        n.cube.mesh.position.x = n.baseX + n.dx * k;
        n.cube.mesh.position.y = n.baseY + n.dy * k;
      }
      if (t >= 1) {
        if (n.cube && n.cube.mesh) { n.cube.mesh.position.x = n.baseX; n.cube.mesh.position.y = n.baseY; }
        this.nudges.splice(i, 1);
      }
    }
  }

  _updateSlotFx(dt) {
    if (!this.slotRack) return;
    const frames = this.slotRack.frames;
    for (let i = 0; i < this.slotFx.length; i++) {
      const fx = this.slotFx[i];
      const frame = frames[i];
      if (!frame || !fx.kind) continue;
      fx.age += dt;
      const dur = fx.kind === 'fill' ? 0.30 : 0.24; // fill settle vs vacate snap
      const t = clamp01(fx.age / dur);
      // fill = a subtle pop-and-settle (seat reacts to the pig landing); vacate =
      // a quick relax/shrink-back ripple as the seat empties. Both a single arch
      // (sin) that returns cleanly to scale 1, so the rack stays calm + readable.
      const arch = Math.sin(t * Math.PI);
      const scale = fx.kind === 'fill' ? 1 + 0.18 * arch : 1 - 0.12 * arch;
      frame.loop.scale.setScalar(scale);
      if (t >= 1) { fx.kind = null; frame.loop.scale.setScalar(1); }
    }
  }

  _updateTransitions(dt) {
    const state = this.pigs.state;

    // WIN: a single rising bubble/sparkle cascade across the cleared board,
    // plus the Phase 4 COIN RAIN flourish (win only — never on the lockup-lose).
    if (state === 'won' && !this.winBurstDone) {
      this.winBurstDone = true;
      this._spawnWinCascade();
      this._spawnCoinRain();
    }

    // LOSE: a calm teal veil fades in over the board (telegraphs the jam, no flash).
    if (state === 'lost') {
      const v = this.loseVeil;
      v.mesh.visible = true;
      v.age = Math.min(v.age + dt, 1);
      v.mat.opacity = 0.28 * easeOutCubic(clamp01(v.age / 0.6)); // ease to 0.28 over 600ms
    }

    this.shownState = state;
  }

  // WIN cascade: a field of upward-rising sparkles spread across the board bounds,
  // staggered, each tinted across the 4 gameplay colors for a celebratory pop.
  _spawnWinCascade() {
    const b = this.board.bounds;
    const keys = Object.keys(COLORS);
    for (let i = 0; i < WIN_BURST; i++) {
      const p = this._freePart();
      if (!p) break;
      const x = b.minX + Math.random() * (b.maxX - b.minX);
      const y = b.minY + Math.random() * (b.maxY - b.minY);
      p.active = true; p.age = -Math.random() * 0.5; // stagger the start (cascade)
      p.life = WIN_LIFE;
      p.vx = (Math.random() - 0.5) * CELL * 0.6;
      p.vy = CELL * (1.4 + Math.random() * 1.6); // rise like celebratory bubbles
      p.baseScale = (WIN_SIZE / POP_SIZE) * (0.6 + Math.random() * 0.8);
      p.spin = (Math.random() - 0.5) * 4;
      p.mat.color.setHex(COLORS[keys[i % keys.length]]);
      p.mat.opacity = 0;
      p.baseOpacity = 1;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, 0.3);
      p.mesh.scale.setScalar(p.baseScale);
      p.mesh.rotation.z = Math.random() * Math.PI;
    }
  }

  // COIN RAIN (Phase 4): all pooled coins launch at once from the board center,
  // fanned up-and-outward at staggered speeds so the arcs spread, then gravity
  // pulls them down as they spin and fade — "coins raining into the total".
  _spawnCoinRain() {
    for (let i = 0; i < this.coinRain.length; i++) {
      const c = this.coinRain[i];
      c.active = true;
      c.age = 0;
      // even horizontal fan (+ jitter) so the burst reads as a fountain
      const fan = (i / (this.coinRain.length - 1)) * 2 - 1; // -1 .. +1
      c.vx = fan * COIN_SPEED_X * (0.7 + Math.random() * 0.3);
      c.vy = COIN_SPEED_Y_MIN + Math.random() * (COIN_SPEED_Y_MAX - COIN_SPEED_Y_MIN);
      c.spin = (Math.random() - 0.5) * 8;
      c.mat.opacity = 1;
      c.mesh.visible = true;
      c.mesh.position.set(0, 0, 0.32); // board center (world origin)
      c.mesh.rotation.z = Math.random() * Math.PI;
      c.mesh.scale.setScalar(0.8 + Math.random() * 0.4);
    }
  }

  _updateCoinRain(dt) {
    for (const c of this.coinRain) {
      if (!c.active) continue;
      c.age += dt;
      const t = clamp01(c.age / COIN_RAIN_LIFE);
      c.vy -= COIN_GRAVITY * dt; // gravity bends the launch into an arc
      c.mesh.position.x += c.vx * dt;
      c.mesh.position.y += c.vy * dt;
      c.mesh.rotation.z += c.spin * dt;
      c.mat.opacity = 1 - easeOutQuart(Math.max(0, (t - 0.55) / 0.45)); // fade out late
      if (t >= 1) { c.active = false; c.mesh.visible = false; }
    }
  }

  dispose() {
    for (const o of this._disposables) if (o && o.dispose) o.dispose();
    this._disposables.length = 0;
    for (const m of this._shotMats.values()) m.dispose();
    this._shotMats.clear();
    this.scene.remove(this.group);
  }
}
