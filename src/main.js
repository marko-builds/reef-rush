// main.js — scene composition, ortho camera, render loop, input, and UI overlay.
//
// v3 STYLED (Fish of Fortune reskin): the v2 primitive playfield is reskinned to a
// layered-2D reef. Sprites (original SVGs) drive cubes/pigs/belt/slots; a Seascape
// builds the sea gradient + parallax life + a vignette behind the board. Boot is
// async (load the manifest, then build). RESKIN IS LOOK ONLY — every gameplay value,
// timing, position, conveyor path, firing rule and v2 tickAnims tween is unchanged.

import * as THREE from 'three';
import { Board, CELL } from './board.js';
import { Conveyor } from './conveyor.js';
import { PigManager, PIG_SIZE } from './pigs.js';
import { CONFIG, LEVELS } from './level.js';
import { Assets } from './assets.js';
import { Seascape } from './seascape.js';
import { VfxLayer } from './vfx.js';
import { AudioBus } from './audio.js';
import { SpinWheel } from './spin.js';
import { applyCarryover, CARRY_KEY } from './carryover.js';
import { clamp01, easeOutBack, easeOutCubic } from './easing.js';

// ---------------------------------------------------------------------------
// Renderer + scene + ORTHOGRAPHIC camera (flat 2D playfield).
// ---------------------------------------------------------------------------
const appEl = document.getElementById('app');
const uiEl = document.getElementById('ui');
const hudEl = document.getElementById('hud');
const bannerEl = document.getElementById('banner');
const retryHintEl = document.getElementById('retryHint');
// Phase 5 (5.11) screens
const levelHudEl = document.getElementById('levelHud');
const titleScreenEl = document.getElementById('titleScreen');
const nextBannerEl = document.getElementById('nextBanner');
const nextTitleEl = document.getElementById('nextTitle');
const nextNameEl = document.getElementById('nextName');
const nextCoinsEl = document.getElementById('nextCoins');
const nextTapEl = document.getElementById('nextTap');
const winScreenEl = document.getElementById('winScreen');
const winVignetteEl = document.getElementById('winVignette');
const winCoinsEl = document.getElementById('winCoins');
const loseScreenEl = document.getElementById('loseScreen');
const loseNameEl = document.getElementById('loseName');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// v3: deep turquoise base; the Seascape gradient quad fills the visible frame on top.
scene.background = new THREE.Color(0x0d5d77);

// World height the camera shows (world units). Width derives from aspect.
// Smaller view = bigger elements on screen (zoomed in). CAMERA_Y shifts the framing
// DOWN so the board + conveyor sit HIGHER, leaving room below for the buckets and the
// lane rack (with the reserve rows off-screen below the bottom edge).
const VIEW_HEIGHT = 16;
const CAMERA_Y = -2.25;
let camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
camera.position.set(0, CAMERA_Y, 5);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  const halfH = VIEW_HEIGHT / 2;
  const halfW = halfH * aspect;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
  // Phase 5 fix 5.5: keep the sea gradient pinned flush to the camera's bottom
  // frustum edge through resizes (no-op before the async boot builds it).
  if (seascape) seascape.layout();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Build the game. v3: assets load first (async), then the scene is built with
// sprites + the sea background. Everything below the `await` is the same logic as
// v2 — only the LOOK of each element changes.
// ---------------------------------------------------------------------------
// These are populated in boot() once the async asset load resolves. They stay
// module-scope so the render-loop helpers below can close over them. (Top-level
// await is unavailable in the build target, hence the explicit boot().)
let assets, seascape, board, conveyor, pigs;
let beltFlow, slotRack, tapRings, vfx, treasure, spin;
let labels = new Map();

// The 5-LEVEL SEQUENCE (spec re-lock #3) is carried in the URL hash (#level-N):
// win -> tap bumps the hash + reloads into the next level; lose -> tap reloads
// the SAME level. Each level stays a clean single-shot boot (graders can jump
// straight to e.g. #level-4).
const levelIndex = (() => {
  const m = /level-(\d+)/.exec(location.hash);
  const n = m ? parseInt(m[1], 10) : 1;
  return Math.min(Math.max(n, 1), LEVELS.length);
})();

// Phase 4 SPIN CARRY-FORWARD (spec: Level-clear spin): the previous level's
// wheel result rides the same sessionStorage channel as the coin bank, and is
// CONSUMED here (read + deleted) — a lose-retry reboots the AUTHORED level
// without the perk (spec: Expiry). applyCarryover derives this boot's
// EFFECTIVE level (mine injected at a random valid cell / wraps pre-peeled);
// the bonus slot bumps CONFIG.waitingSlots for this boot only (each level is
// a fresh module load); the golden head is handed to PigManager below.
const spinCarry = (() => {
  try {
    const raw = sessionStorage.getItem(CARRY_KEY);
    sessionStorage.removeItem(CARRY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
})();
const level = applyCarryover(LEVELS[levelIndex - 1], spinCarry);
if (spinCarry?.bonusSlot) CONFIG.waitingSlots = 6;

// v3 AUDIO: one synthesized WebAudio bus (ambient bed + event sfx + one mute).
// Constructed eagerly (no AudioContext yet — that's created lazily on the first
// user gesture per the autoplay policy). Driven each frame off the SAME render-safe
// hooks the VfxLayer uses (pigs.vfx[] + pigs.state). Fully null-safe; the headless
// harnesses never touch this file, so audio can't affect them.
const audio = new AudioBus();
let audioState = 'playing'; // last pigs.state we sounded a transition for

async function boot() {
  assets = await Assets.load();

  // L0/L1: sea gradient + drifting parallax life + vignette behind the playfield.
  // CAMERA_Y so the gradient pins to the REAL visible frame (Phase 5 fix 5.5):
  // the frame is [CAMERA_Y - h/2, CAMERA_Y + h/2], not centered on y=0.
  seascape = new Seascape(scene, assets, VIEW_HEIGHT, CAMERA_Y);

  board = new Board(scene, assets, level);
  conveyor = new Conveyor(board);
  pigs = new PigManager(scene, board, conveyor, assets, level, undefined,
    { goldenHead: spinCarry?.golden === true });
  treasure = buildTreasure();

  buildBeltVisual();
  beltFlow = buildBeltFlow();
  slotRack = buildSlotRack();
  tapRings = buildTapRings();
  // v3 JUICE layer: shots, cube-pop bursts, muzzle puffs, slot flourishes, and
  // the win/lose transitions. Driven off pigs.vfx[] + pigs.state (render-safe).
  vfx = new VfxLayer(scene, assets, board, conveyor, pigs, slotRack,
    { finaleRain: levelIndex === LEVELS.length }); // L5 treasure: 32-coin rain
  // Phase 4 LEVEL-CLEAR SPIN (spec: Level-clear spin): the fortune-wheel
  // overlay, centered on the screen (the camera's rest position). Started on
  // the won edge of levels 1-4 only; results apply via applySpinResult.
  // Phase 5 player direction: the wheel sits on the BOARD's center (blocks +
  // conveyor ring), not the screen center, with segment icons from the registry.
  spin = new SpinWheel(scene,
    (board.bounds.minX + board.bounds.maxX) / 2,
    (board.bounds.minY + board.bounds.maxY) / 2,
    applySpinResult, assets);
  // Phase 5 (5.11): the level pill badge (replaces the debug text block).
  levelHudEl.textContent = `Level ${levelIndex}/${LEVELS.length} \u2014 ${level.name}`;
  // Title screen: only on a FRESH session's level 1 (the sea runs live behind
  // it; one tap anywhere starts the game). Retries / later levels skip it.
  if (levelIndex === 1 && !sessionStorage.getItem('fof-title-shown')) {
    titleActive = true;
    titleScreenEl.classList.add('in');
  }
  resize();
  tick();
}

// TREASURE centerpiece (level 5 only): the golden pearl-in-shell sprite sitting
// in the authored center pocket, BEHIND the reef tiles — it peeks out as the
// inner rings peel away (the buried fortune) and CELEBRATES when the board
// clears: an easeOutBack pop to 2.1x with a slow bobbing spin (the FoF
// "fortune found" beat). Idle: a gentle 0.4 Hz shimmer-breath.
function buildTreasure() {
  if (!level.treasure) return null;
  const rec = assets.get('treasure');
  const size = CELL * 1.5;
  const geo = new THREE.PlaneGeometry(size, size);
  const mat = rec
    ? new THREE.MeshBasicMaterial({ map: rec.texture, transparent: true, depthWrite: false })
    : new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  const p = board.cellToWorld(level.treasure.col, level.treasure.row);
  mesh.position.set(p.x, p.y, -0.12); // behind the tiles, in front of the vignette
  scene.add(mesh);
  return { mesh, geo, mat, phase: 0, winAge: -1, baseX: p.x, baseY: p.y };
}

const TREASURE_POP_DUR = 0.8; // easeOutBack grow on the final win
function updateTreasure(dt) {
  if (!treasure) return;
  if (pigs.state === 'won') {
    // celebration: pop forward + grow + gentle bob/spin (delta-timed)
    if (treasure.winAge < 0) treasure.winAge = 0;
    treasure.winAge += dt;
    const grow = easeOutBack(clamp01(treasure.winAge / TREASURE_POP_DUR));
    treasure.mesh.position.z = 0.4; // in front — the reef is cleared
    treasure.mesh.scale.setScalar(1 + 1.1 * grow);
    treasure.mesh.rotation.z = 0.12 * Math.sin(treasure.winAge * 2.2);
    treasure.mesh.position.y = treasure.baseY + 0.15 * Math.sin(treasure.winAge * 1.6);
    return;
  }
  treasure.phase = (treasure.phase + 0.4 * dt) % 1; // idle shimmer-breath
  treasure.mesh.scale.setScalar(1 + 0.05 * Math.sin(treasure.phase * Math.PI * 2));
}

// Belt visual: the ROUNDED-RECT centerline as a rope-and-buoy CURRENT line.
// v3 reskin: the grey metal pipe becomes a warm rope; a soft aqua glow line under
// it reads as the flowing current the buoys ride. Same geometry/path as v2.
function buildBeltVisual() {
  const pts = conveyor.pathPoints(192).map((p) => new THREE.Vector3(p.x, p.y, -0.2));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  // wide soft current glow (aqua) under the rope
  const glowMat = new THREE.LineBasicMaterial({ color: 0x6fe9e0, transparent: true, opacity: 0.35 });
  const glow = new THREE.Line(geo, glowMat);
  glow.position.z = -0.25;
  scene.add(glow);
  // the rope itself (warm gold), the readable current path
  const ropeMat = new THREE.LineBasicMaterial({ color: 0xe8b04a });
  const rope = new THREE.Line(geo.clone(), ropeMat);
  rope.position.z = -0.2;
  scene.add(rope);
}

// Phase 5 fix 5.6: the belt is a CONTINUOUS rope chain — gapless straight
// segments tiled edge-to-edge along each straight run, plus one ANGLED rope-bend
// tile per quarter-circle corner (sprites/belt-angled-segment.png) — replacing
// the 24 discrete drifting buoys. The flow read survives: the straight tiles
// share ONE repeating texture whose offset scrolls at the true belt rate, so
// the rope (and its baked-in beads) visibly streams in the travel direction.
//
// TILING MATH (no gap, no overlap):
//   straight edge: n = max(1, round(edgeLen / SEG_NOMINAL)); segLen = edgeLen/n
//     -> tiles meet exactly; tile height = segLen * (94/512), the art's aspect.
//     Tiles are rotated to the edge's TRAVEL tangent, so one shared texture
//     offset scrolls every edge in its own travel direction.
//   corner: the bend art's rope centerline is a quarter-arc of normalized
//     radius CORNER_ART_R about the image center, so a tile of size
//     r / CORNER_ART_R centered ON the path's arc center lines the bend up
//     with the path. The art is authored as the BOTTOM-RIGHT bend; the four
//     corners are 90° rotations (rotation = arcStartAngle + 90°).
// The belt is FULLY STATIC (player direction — no scroll, no sway). What makes
// it read as ONE continuous conveyor is measurement-derived alignment between
// the straight tiles and the corner bends (all constants measured from the
// PNGs' alpha channels, not eyeballed):
//   belt_segment.png (512×94): rope centerline at 0.495 of height (~centered),
//     rope thickness 0.1074 × tile length.
//   belt-angled-segment.png (354×360, authored as the BOTTOM-RIGHT bend):
//     vertical-run centerline at 0.858 of width, horizontal-run at 0.872 of
//     height, rope thickness ≈ 0.15 × size, bend centerline radius 0.536 × size.
// From those:
//   bend SCALE = cornerR / 0.536  -> the bend's curve is EXACTLY tangent to the
//     two straight path lines (no kink, pigs ride the drawn rope through the
//     corner);
//   bend POSITION: run centerlines placed exactly ON the path lines (offset
//     from the arc center = (r − 0.358·S, 0.372·S − r), rotated per corner);
//   straight runs are TRIMMED so they BUTT against the bend art instead of
//     drawing underneath it (trim per end = 0.865·S − r), then exact-fit:
//     n = max(1, round(span / SEG_NOMINAL)), tileLen = span / n — no gap, no
//     overlap, and tile thickness (0.1074·tileLen ≈ 0.25 CELL) matches the
//     bend's (0.15·S ≈ 0.28 CELL).
const SEG_NOMINAL = CELL * 2.6;   // straight tile target length (3 per edge)
// Sprite metrics, measured as MEDIANS over the rope BODY (both arts have
// bead flares at their image edges that biased single-point samples):
const ART_BEND_R   = 0.5388;      // bend centerline radius / image size
const ART_RUN_V    = 0.8616;      // bend vertical-run centerline / image width
const ART_RUN_H    = 0.8681;      // bend horizontal-run centerline / image height
const ART_BEND_TH  = 0.157;       // bend rope body thickness / image size
const ART_SEG_TH   = 0.6383;      // straight rope body thickness / tile height
const ART_SEG_CTR  = 0.4894;      // straight rope centerline / tile height (from top)
// The straight run OVERLAPS under the bend art by this much, so both arts'
// edge bead-flares land on continuous rope instead of cutting against water.
const JOINT_OVERLAP = CELL * 0.22;
function buildBeltFlow() {
  const segRec = assets.get('belt_segment');
  const bendRec = assets.get('belt_angled');
  const meshes = [];

  const segMat = segRec
    ? new THREE.MeshBasicMaterial({ map: segRec.texture, transparent: true, depthWrite: false })
    : new THREE.MeshBasicMaterial({ color: 0xe8b04a, transparent: true, opacity: 0.85, depthWrite: false });

  const r = conveyor.r;
  const S = r / ART_BEND_R;                 // bend tile size: radius-true
  const uV = ART_RUN_V - 0.5;               // run offsets from the art's center
  const vH = ART_RUN_H - 0.5;
  // How far past the corner boundary the bend art reaches into each straight
  // run (reach = half tile + mean run offset; the two runs differ by ~0.013
  // CELL, averaged). The straight run is trimmed by this MINUS the joint
  // overlap, so it slides slightly UNDER the bend (which draws on top).
  const reach = S * (0.5 + (uV + vH) / 2);
  const endTrim = reach - r - JOINT_OVERLAP;

  // Corner bends first: run centerlines exactly on the path's straight lines,
  // curve exactly tangent (radius-true scale). Offset from the arc center in
  // the art's authored (bottom-right) frame, rotated per corner with the mesh.
  // The bend art carries CLIPPED half-beads on its two run-exit edges (left +
  // top in the authored frame) — butted against a straight tile they read as a
  // glitch. CUT those strips out of the visible quad via UVs: the bend then
  // ends mid-rope and the straight tile overlapped BENEATH carries the rope
  // through the joint. The quad shrinks by the same fraction so the art stays
  // 1:1 (no stretch), and the centre shifts by half a strip accordingly.
  const CUT = 12 / 354; // edge strip with the clipped beads (measured px)
  const bendGeo = new THREE.PlaneGeometry(S * (1 - CUT), S * (1 - CUT));
  {
    const uv = bendGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, CUT + uv.getX(i) * (1 - CUT), uv.getY(i) * (1 - CUT));
    }
  }
  const bendMat = bendRec
    ? new THREE.MeshBasicMaterial({ map: bendRec.texture, transparent: true, depthWrite: false })
    : segMat; // missing bend art -> reuse the straight look (never crashes)
  // unrotated quad-center offset (run centerlines onto the path lines), plus
  // the half-strip shift from the UV cut (left strip cut -> +x, top -> -y)
  const d0 = {
    x: r - uV * S + (CUT / 2) * S,
    y: vH * S - r - (CUT / 2) * S,
  };
  for (const seg of conveyor.segs) {
    if (seg.kind !== 'arc') continue;
    const rot = seg.a + Math.PI / 2;            // art = bottom-right bend (a = -90°)
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const m = new THREE.Mesh(bendGeo, bendMat);
    m.position.set(
      seg.cx + d0.x * cos - d0.y * sin,
      seg.cy + d0.x * sin + d0.y * cos,
      -0.17,
    );
    m.rotation.z = rot;
    scene.add(m);
    meshes.push(m);
  }

  // Straight runs: trimmed (minus the overlap) so they slide under the bend
  // art, then exact-fit tiles rotated to the edge's travel tangent. The tile
  // HEIGHT is decoupled from its length so the straight rope BODY is exactly
  // as thick as the bend's (ART_SEG_TH·tileH == ART_BEND_TH·S), and each tile
  // is nudged along its normal so the rope CENTERLINE (at ART_SEG_CTR of the
  // art, not the geometric middle) sits exactly on the path line.
  const tileH = (ART_BEND_TH * S) / ART_SEG_TH;
  for (const seg of conveyor.segs) {
    if (seg.kind !== 'line') continue;
    const dx = (seg.x1 - seg.x0) / seg.len, dy = (seg.y1 - seg.y0) / seg.len;
    const x0 = seg.x0 + dx * endTrim, y0 = seg.y0 + dy * endTrim;
    const span = seg.len - 2 * endTrim;
    const n = Math.max(1, Math.round(span / SEG_NOMINAL));
    const tileLen = span / n;
    const geo = new THREE.PlaneGeometry(tileLen, tileH);
    const travel = Math.atan2(dy, dx);
    // local +y of the rotated tile (image "up"); rope center sits
    // (0.5 - ART_SEG_CTR)·tileH ABOVE the tile center in the art.
    const ux = -dy, uy = dx;
    const nudge = (ART_SEG_CTR - 0.5) * tileH; // move tile so rope lands on path
    for (let i = 0; i < n; i++) {
      const c = (i + 0.5) * tileLen;
      const m = new THREE.Mesh(geo, segMat);
      m.position.set(x0 + dx * c + ux * nudge, y0 + dy * c + uy * nudge, -0.18);
      m.rotation.z = travel;
      scene.add(m);
      meshes.push(m);
    }
  }

  return { meshes };
}

// v2 SLOT RACK frames: 5 static outline squares marking the waiting slots, so
// the "X/5" reads spatially as filled/empty seats (primitives — line loops).
//
// v2 LOCKUP-TENSION WARNING (deliberate v2 inclusion per explicit user direction;
// the feel-and-juice skill lists the 4/5 tint under v3, but the user wants the
// player to feel the jam coming in v2). Tuned SUBTLE, not an alarm: as the 5
// waiting slots approach full the neutral frame outlines warm toward a calm amber
// and, only at 5/5, draw a slow soft pulse. No red, no fast flash. Driven purely
// from pigs.occupiedSlots() in the render loop — no gameplay/slot-logic change.
//   3/5 -> faint warm HINT     (blend 0.30 toward warm amber, static)
//   4/5 -> stronger calm WARN   (blend 0.70 toward warm amber, static)
//   5/5 -> FULL: full warm tint + slow soft pulse (~0.7 Hz) on outline opacity.
// v3 reskin: the 5 waiting slots become a TACKLE RACK of bait buckets (the slot
// sprite). The v2 LOCKUP-TENSION behaviour is preserved EXACTLY — the same blend
// thresholds (3/5, 4/5, 5/5) warm the seat toward a calm amber and the same slow
// 0.7 Hz breath pulses opacity at 5/5. Only the seat's LOOK changes (textured
// bucket quad instead of a line-loop outline). Idle tint is a cool aqua so the
// warm-amber warning still reads as a clear shift.
const SLOT_IDLE = new THREE.Color(0x9fe6ef);       // neutral aqua bucket (cool)
const SLOT_WARM = new THREE.Color(0xffb43d);       // calm warm amber (NOT red)
const WARN_HINT = 0.30;   // blend at 3/5
const WARN_WARN = 0.70;   // blend at 4/5
const WARN_FULL = 1.00;   // blend at 5/5
const FULL_PULSE_HZ = 0.7;        // slow, gentle breath at 5/5
const FULL_PULSE_AMP = 0.18;      // +/- opacity amplitude of the pulse
function buildSlotRack() {
  const rec = assets.get('slot');
  const size = PIG_SIZE * 1.35;
  const geo = new THREE.PlaneGeometry(size, size);
  const frames = [];
  for (let i = 0; i < CONFIG.waitingSlots; i++) {
    const p = pigs.slotWorldPos(i);
    // Player direction (final): buckets are FULLY OPAQUE and sit in the front
    // layer (above the cubes' z=0, below the pigs' 0.1 so a parked bait still
    // reads inside its bucket).
    const mat = rec
      ? new THREE.MeshBasicMaterial({
          map: rec.texture, color: SLOT_IDLE.clone(),
          transparent: true, opacity: 1.0, depthWrite: false,
        })
      : new THREE.MeshBasicMaterial({
          color: SLOT_IDLE.clone(), transparent: true, opacity: 1.0, depthWrite: false,
        });
    const loop = new THREE.Mesh(geo, mat);
    loop.position.set(p.x, p.y, 0.05);
    scene.add(loop);
    frames.push({ loop, mat });
  }
  return { frames, mat: null, geo, pulse: 0 };
}

const _slotColor = new THREE.Color(); // scratch, no per-frame allocation
function updateSlotRack(dt) {
  const occ = pigs.occupiedSlots();
  // Progressive blend toward the calm warm amber as the rack fills.
  let blend = 0;
  if (occ >= CONFIG.waitingSlots) blend = WARN_FULL;       // 5/5
  else if (occ === CONFIG.waitingSlots - 1) blend = WARN_WARN; // 4/5
  else if (occ === CONFIG.waitingSlots - 2) blend = WARN_HINT; // 3/5
  // Slow soft pulse ONLY at full — a gentle breath, never a flash. Buckets are
  // fully opaque (player direction), so the 5/5 breath DIPS from 1.0 instead of
  // oscillating around a translucent base (same 0.7 Hz rate, same read).
  let opacity = 1.0;
  if (occ >= CONFIG.waitingSlots) {
    slotRack.pulse = (slotRack.pulse + FULL_PULSE_HZ * dt) % 1;
    opacity = 1.0 - FULL_PULSE_AMP * (0.5 + 0.5 * Math.sin(slotRack.pulse * Math.PI * 2));
  } else {
    slotRack.pulse = 0;
  }
  _slotColor.copy(SLOT_IDLE).lerp(SLOT_WARM, blend);
  for (const f of slotRack.frames) {
    f.mat.color.copy(_slotColor);
    f.mat.opacity = opacity;
  }
}

// v2 TAPPABLE highlight: a pooled outline ring behind every currently launchable
// pig (the 4 lane heads + each slotted pig) with a gentle idle pulse, so the
// tappable heads stand out from the upcoming-but-locked rows behind them.
function buildTapRings() {
  const POOL = 4 + CONFIG.waitingSlots; // 4 lane heads + up to 5 slot pigs
  const half = PIG_SIZE * 0.72;
  const rings = [];
  for (let i = 0; i < POOL; i++) {
    const pts = [
      new THREE.Vector3(-half, -half, 0), new THREE.Vector3(half, -half, 0),
      new THREE.Vector3(half, half, 0), new THREE.Vector3(-half, half, 0),
      new THREE.Vector3(-half, -half, 0),
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    // v3: warm gold "tap me" ring reads as a glint over the sea (was plain white).
    const mat = new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9 });
    const loop = new THREE.Line(geo, mat);
    loop.visible = false;
    loop.position.z = 0.2;
    scene.add(loop);
    rings.push({ loop, mat });
  }
  return { rings, phase: 0 };
}

function updateTapRings(dt) {
  tapRings.phase = (tapRings.phase + dt) % 1;
  const pulse = 0.55 + 0.45 * Math.sin(tapRings.phase * Math.PI * 2); // 0.1..1
  // Gather the launchable pigs in a stable order: the 4 lane heads, then slots.
  const tappable = [];
  for (const h of pigs.laneHeads()) tappable.push(h.pig);
  for (const p of pigs.slots) if (p) tappable.push(p);
  for (let i = 0; i < tapRings.rings.length; i++) {
    const r = tapRings.rings[i];
    const pig = tappable[i];
    if (!pig || pig.location === 'gone') { r.loop.visible = false; continue; }
    r.loop.visible = true;
    r.loop.position.set(pig.mesh.position.x, pig.mesh.position.y, 0.2);
    r.mat.opacity = 0.35 + 0.55 * pulse;
  }
  // Shrink the non-launchable upcoming lane pigs (shared material rules out a
  // per-pig tint) so the full-size lane HEADS clearly read as the next launches.
  pigs.lanes.forEach((lane) => {
    lane.forEach((pig, ri) => {
      if (pig.location !== 'queue') return;
      pig.mesh.scale.setScalar(ri === 0 ? 1 : 0.82);
    });
  });
}

// (Phase 5 fix 5.4: the belt-orientation triangle — a 1.2 foundation-check
// marker that lapped the belt — is REMOVED. It had no role in the game; the
// flow read is carried by the belt itself and the pigs riding it.)

resize();

// ---------------------------------------------------------------------------
// Input: tap a queue-front pig or a slotted pig (raycast against pig meshes).
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function onTap(clientX, clientY) {
  if (pigs.state !== 'playing') return;
  ndc.x = (clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);

  // Gather candidate meshes: the 4 launchable lane heads + all slotted pigs.
  const heads = pigs.laneHeads();
  const candidates = [];
  for (const h of heads) candidates.push(h.pig.mesh);
  for (const p of pigs.slots) if (p) candidates.push(p.mesh);

  const hits = raycaster.intersectObjects(candidates, false);
  if (hits.length === 0) return;
  const mesh = hits[0].object;

  // Is it a lane head?
  const head = heads.find((h) => h.pig.mesh === mesh);
  if (head) {
    if (pigs.launchLane(head.laneIndex)) {
      // golden pigs get their jackpot sparkle-sting; others the light "plip"
      if (head.pig.colorKey === 'G') audio.onGoldenLaunch();
      else audio.onLaunch();
    } else rejectTap(head.pig);                            // belt full -> feedback
    return;
  }
  // Is it a slotted pig?
  const slotIdx = pigs.slots.findIndex((p) => p && p.mesh === mesh);
  if (slotIdx !== -1) {
    const slotPig = pigs.slots[slotIdx]; // read BEFORE relaunch nulls the seat
    if (pigs.relaunchSlot(slotIdx)) {
      if (slotPig.colorKey === 'G') audio.onGoldenLaunch();
      else audio.onLaunch();
    } else rejectTap(slotPig);
  }
}

// v2 invalid-tap feedback: a tap that can't launch (belt at capacity) gives a
// quick horizontal shake on the tapped pig + a brief HUD flash, so a rejected
// input reads as "not now" instead of feeling like a dead/ignored tap.
let hudFlash = 0; // seconds remaining on the "Belt full" flash
function rejectTap(pig) {
  if (pig) pig.rejectShake = 0.22; // seconds of shake (read by tickReject)
  hudFlash = 0.9;
}
function tickReject(dt) {
  for (const pig of pigs.pigs) {
    if (pig.rejectShake > 0) {
      pig.rejectShake = Math.max(0, pig.rejectShake - dt);
      // damped horizontal jitter; resets to base x when done
      const amp = (pig.rejectShake / 0.22) * 0.12; // up to 0.12 world units
      pig._shakeBaseX = pig._shakeBaseX ?? pig.mesh.position.x;
      pig.mesh.position.x = pig._shakeBaseX + Math.sin(pig.rejectShake * 90) * amp;
      if (pig.rejectShake === 0) { pig.mesh.position.x = pig._shakeBaseX; pig._shakeBaseX = undefined; }
    }
  }
  if (hudFlash > 0) hudFlash = Math.max(0, hudFlash - dt);
}

// v3 LEVEL FLOW: when the game is over, any tap or the Enter / R key advances —
// a WIN moves to the next level (wrapping to level 1 after the level-5 treasure
// win), a LOSS retries the SAME level. Robust single-shot boots via hash+reload.
// `restarted` guards against a double-fire (e.g. tap + key landing the same frame).
let restarted = false;
function tryRetry() {
  if (restarted) return false;
  if (pigs.state !== 'won' && pigs.state !== 'lost') return false;
  // Phase 4 SPIN gate (spec: Level-clear spin): on a level-1..4 win the wheel
  // owns the screen — taps are SWALLOWED until the result banner is up; the
  // first tap at the banner dismisses it AND advances (this fall-through).
  // Lose and the level-5 treasure win never enter this branch.
  if (pigs.state === 'won' && levelIndex < LEVELS.length && spin) {
    if (!spin.atBanner()) return true; // wheel pending/in motion: no advance yet
    spin.dismiss();
  }
  restarted = true;
  if (pigs.state === 'won') {
    const next = levelIndex < LEVELS.length ? levelIndex + 1 : 1;
    location.hash = `level-${next}`;
  }
  location.reload();
  return true;
}

// Phase 4 SPIN drive + result application (spec: Level-clear spin).
// updateSpin: edge-start the wheel on a level-1..4 win, then advance its
// timeline. applySpinResult (fired ONCE at spin settle): coin segments add to
// the run total with the normal roll-up and RE-BANK it (updateCoins banked the
// pre-spin total on the won edge; the next boot must start post-spin); carry
// segments write the one-shot fof-spin-carry flags the next boot consumes.
function updateSpin(dt) {
  if (!spin) return;
  if (pigs.state === 'won' && levelIndex < LEVELS.length) spin.start();
  spin.update(dt);
}

function applySpinResult(seg) {
  if (seg.coins) {
    addCoins(seg.coins);
    sessionStorage.setItem(COIN_KEY, String(coins));
  }
  if (seg.carry) {
    sessionStorage.setItem(CARRY_KEY, JSON.stringify({ [seg.carry]: true }));
  }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  // Autoplay policy: the FIRST user gesture creates/resumes the AudioContext and
  // starts the ambient bed. Idempotent + null-safe (no-op if WebAudio is absent).
  audio.resume();
  audio.startAmbient();
  // Phase 5 (5.11): the title screen swallows its dismissing tap (one per
  // session — retries and later levels boot straight into play).
  if (titleActive) {
    titleActive = false;
    sessionStorage.setItem('fof-title-shown', '1');
    titleScreenEl.classList.add('out');
    setTimeout(() => titleScreenEl.classList.remove('in'), 320);
    return;
  }
  // Game over -> this tap is a RETRY, not a launch (onTap already no-ops off
  // 'playing', so an in-game launch tap is never affected by this branch).
  if (tryRetry()) return;
  onTap(e.clientX, e.clientY);
});

// ---------------------------------------------------------------------------
// MUTE: keyboard 'm' + a small on-screen button (the entire audio UI). The game
// is fully playable muted; default mix is gentle. Resuming on these gestures too
// so a player who mutes/unmutes before tapping still gets a live context.
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') {
    audio.resume();
    const muted = audio.toggleMute();
    syncMuteButton(muted);
  }
  // v3 RETRY keys: Enter or R restart the same level, but ONLY at game over
  // (tryRetry gates on won/lost), so these keys are inert during play.
  if (e.key === 'Enter' || e.key === 'r' || e.key === 'R') {
    tryRetry();
  }
});

const muteBtn = document.getElementById('mute');
function syncMuteButton(muted) {
  if (!muteBtn) return;
  muteBtn.textContent = muted ? '\u{1F507}' : '\u{1F50A}'; // muted vs sound-on speaker
  muteBtn.setAttribute('aria-label', muted ? 'Unmute (m)' : 'Mute (m)');
  muteBtn.classList.toggle('muted', muted);
}
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    audio.resume();
    audio.startAmbient();
    const muted = audio.toggleMute();
    syncMuteButton(muted);
  });
  syncMuteButton(audio.muted);
}

// ---------------------------------------------------------------------------
// DOM ammo labels: one per pig, repositioned each frame from world->screen.
// (Plain DOM text per v1 scope — no canvas-texture juice.)
// ---------------------------------------------------------------------------
// labels (module-scope Map declared in the boot block) — one div per pig,
// created LAZILY: the infinite reserve keeps minting new pigs after boot.
function labelFor(pig) {
  let div = labels.get(pig);
  if (!div) {
    div = document.createElement('div');
    div.className = 'label';
    uiEl.appendChild(div);
    labels.set(pig, div);
  }
  return div;
}

const _v = new THREE.Vector3();
function worldToScreen(x, y) {
  _v.set(x, y, 0).project(camera);
  return {
    x: (_v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-_v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

const AMMO_PULSE_DUR = 0.14; // mirrors AMMO_PULSE in pigs.js (for the DOM tick)
function updateLabels() {
  for (const pig of pigs.pigs) {
    const div = labelFor(pig);
    // Hide a departed pig's label only once its slide-off settle has finished,
    // so "left the board" reads as the number sliding off with the pig.
    if (pig.location === 'gone' && !pig.anim) {
      div.style.display = 'none';
      continue;
    }
    div.style.display = 'block';
    div.textContent = String(pig.ammo);
    const s = worldToScreen(pig.mesh.position.x, pig.mesh.position.y);
    div.style.left = s.x + 'px';
    div.style.top = s.y + 'px';
    // v2: ammo "tick" — a quick scale bump on decrement that eases back to 1,
    // so each hit visibly registers on the number. easeOutCubic decay.
    let scale = 1;
    if (pig.ammoPulse > 0) {
      const p = pig.ammoPulse / AMMO_PULSE_DUR;        // 1 -> 0 over the pulse
      scale = 1 + 0.6 * p;                             // peak +60%, decays to 1
    }
    div.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  }
}

function updateHud() {
  // Phase 5 (5.11): the v3 HUD is the LEVEL PILL + coin counter + the visuals
  // themselves (pigs on the belt = occupancy; bucket glow = slot pressure).
  // The old debug text block is gone; hudEl now carries ONLY the two transient
  // warnings (both v2 feel features — belt-full flash, 5/5 lockup-tension cue).
  // Reskin language: the shooters are BAIT in every player-facing string.
  const slotsFull = pigs.occupiedSlots() >= CONFIG.waitingSlots;
  hudEl.textContent = hudFlash > 0
    ? 'BELT FULL — wait for a bait to finish its lap'
    : slotsFull
      ? 'buckets full — a returning bait with ammo will jam'
      : '';
  hudEl.style.color = hudFlash > 0 ? '#ff8a6a' : '#c8924a';
}

// Phase 5 (5.11): the end-state SCREENS replace the old plain-text banner.
// - won, levels 1-4: a compact NEXT-LEVEL banner slides in from the top
//   (easeOutBack 320ms, CSS-driven) with the level name + this level's coin
//   delta; it steps aside while the fortune wheel owns the center and returns
//   with the TAP TO CONTINUE prompt at the wheel's result banner.
// - won, level 5: the TREASURE screen — a golden radial vignette fades in over
//   1s while the existing treasure pop + 32-coin rain play; card shows the run
//   total + PLAY AGAIN.
// - lost: the JAMMED card — matter-of-fact, cheerful, with TRY AGAIN.
// Taps anywhere still advance/retry (the screens are pointer-events:none except
// the buttons); Enter / R keep working via tryRetry.
let titleActive = false;       // title overlay shown, first tap dismisses it
let bannerStateShown = 'playing';
function updateBanner() {
  const state = pigs.state;
  if (state === 'playing') {
    if (bannerStateShown !== 'playing') {
      nextBannerEl.classList.remove('in');
      winScreenEl.classList.remove('in');
      winVignetteEl.classList.remove('in');
      loseScreenEl.classList.remove('in');
      bannerStateShown = 'playing';
    }
    return;
  }
  if (bannerStateShown !== state) {
    bannerStateShown = state;
    if (state === 'won') {
      if (levelIndex < LEVELS.length) {
        // content prepared at the win edge; the popup APPEARS only once the
        // wheel has settled (player direction) — see the interplay block below.
        nextTitleEl.textContent = `Level ${levelIndex} cleared!`;
        nextNameEl.textContent = level.name;
      } else {
        winCoinsEl.textContent = `${coins} coins collected this run`;
        winScreenEl.classList.add('in');
        winVignetteEl.classList.add('in'); // golden vignette, 1s fade
      }
    } else {
      loseNameEl.textContent = level.name;
      loseScreenEl.classList.add('in');
    }
  }
  // Player direction (final): the level-cleared popup shows for the FIRST
  // time only after the wheel is spun — it bounces up at the board center
  // (over the parked wheel) once the result banner is live. The coins line
  // updates live, so the wheel's own coin reward is included in the total.
  if (state === 'won' && levelIndex < LEVELS.length) {
    const atBanner = spin && spin.active ? spin.atBanner() : true; // no wheel -> show
    if (atBanner) nextCoinsEl.textContent = `+${coins - coinBank} coins`;
    nextBannerEl.classList.toggle('in', atBanner);
  }
}
// (the legacy #banner / #retryHint elements stay hidden — replaced by the
// Phase 5 screens; Enter / R retry keys still route through tryRetry.)

// ---------------------------------------------------------------------------
// Phase 4 COIN ECONOMY (spec: Coin economy — styled build only). Render-side
// ONLY: blocks are counted off the SAME render-safe pigs.vfx[] 'fire' events the
// audio/VFX layers read (one event = one destroyed small block) — no gameplay
// file is touched by the counter. The HUD number ROLLS UP (600ms easeOutCubic),
// never snaps. The run total persists across the 5-level hash+reload sequence
// via sessionStorage: BANKED on level-clear; a lose-retry reboots to the
// start-of-level bank (the failed attempt's coins are not kept); the post-L5
// "play again" wrap resets the bank (a fresh run).
// ---------------------------------------------------------------------------
const coinCountEl = document.getElementById('coinCount');
const COIN_KEY = 'fof-run-coins';
const COIN_ROLL_DUR = 0.6; // 600ms roll-up, easeOutCubic
const coinBank = (() => {
  const n = parseInt(sessionStorage.getItem(COIN_KEY) ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
let coins = coinBank;        // live run total (bank + this level's earnings)
let coinsShown = coinBank;   // displayed value, eased toward `coins`
let coinRollFrom = coinBank; // value the current roll started from
let coinRollAge = COIN_ROLL_DUR; // >= dur means settled
let coinsBanked = false;     // edge latch: bank exactly once per win
if (coinCountEl) coinCountEl.textContent = String(coinBank);

function addCoins(n) {
  if (n <= 0) return;
  coinRollFrom = coinsShown; // restart the roll from the currently SHOWN value
  coins += n;
  coinRollAge = 0;
}

// Award per destroyed small block: wild ('W') = 3 coins, mine sub-blocks ('M')
// = 0 (the bomb, not loot), every color = 1 coin (spec: Coin economy / Wild
// blocks / Mine blocks). ev.blockColor is the DESTROYED block's color key; a
// 'mineExplode' event carries the whole blast's destroyed blocks.
const coinAward = (blockColor) => (blockColor === 'W' ? 3 : blockColor === 'M' ? 0 : 1);
function updateCoins(dt) {
  const q = pigs.vfx;
  if (q && q.length) {
    let earned = 0;
    for (const ev of q) {
      // Phase 4 WRAPS: a dewrap hit peels armor, destroys nothing -> 0 coins
      // (spec: Seaweed-wrapped blocks). Only destroying hits award.
      if (ev.type === 'fire' && !ev.dewrap) earned += coinAward(ev.blockColor);
      else if (ev.type === 'mineExplode') for (const b of ev.blocks) earned += coinAward(b.blockColor);
    }
    if (earned > 0) addCoins(earned);
  }
  if (pigs.state === 'won' && !coinsBanked) {
    coinsBanked = true;
    // L1-4 clear -> bank the run total for the next level's boot; the L5 clear
    // ends the run, so the next boot (play-again wrap to L1) starts at 0.
    sessionStorage.setItem(COIN_KEY, levelIndex < LEVELS.length ? String(coins) : '0');
  }
  coinRollAge += dt;
  const p = clamp01(coinRollAge / COIN_ROLL_DUR);
  coinsShown = coinRollFrom + (coins - coinRollFrom) * easeOutCubic(p);
  if (coinCountEl) coinCountEl.textContent = String(Math.round(coinsShown));
}

// ---------------------------------------------------------------------------
// AUDIO drive: read the SAME render-safe hooks the VfxLayer reads, then sound
// them. MUST run BEFORE vfx.update(dt), because the VfxLayer drains (clears)
// pigs.vfx[] each frame — so we read it first, the VfxLayer consumes it after.
//   - 'fire'       -> a cube popped this tick -> a soft bubbly pop (voice-capped).
//   - 'slotFill'   -> a pig parked -> a soft settle cue.
//   - 'slotVacate' -> a seat freed by a re-tap -> a small up-tick cue.
//   - pigs.state   -> won/lost edge -> the win chime / calm jammed tone (once).
// (Launch "plip" is fired directly from onTap, the actual user gesture.)
// ---------------------------------------------------------------------------
function updateAudio() {
  const q = pigs.vfx;
  if (q && q.length) {
    for (const ev of q) {
      if (ev.type === 'fire') {
        // Phase 5 file voices: a dewrap PEELS (rustle, not a pop); a golden
        // pierce pair's 2nd hit gets its own sparkle-zap; everything else pops.
        if (ev.dewrap) audio.onDewrap();
        else if (ev.pierce) audio.onGoldenPierce();
        else audio.onPop(ev.colorKey);
      }
      else if (ev.type === 'mineExplode') audio.onMineBoom();
      else if (ev.type === 'slotFill') audio.onPark();
      else if (ev.type === 'slotVacate') audio.onVacate();
    }
  }
  // State-transition stings (edge-triggered so they fire exactly once).
  if (pigs.state !== audioState) {
    if (pigs.state === 'won') {
      // L1-4: the level-clear flourish (the wheel follows); L5: the treasure.
      if (levelIndex < LEVELS.length) audio.onLevelClear();
      else audio.onTreasure();
    } else if (pigs.state === 'lost') audio.onLose();
    audioState = pigs.state;
  }
  // Phase 5: fortune-wheel beats, edge-triggered off the spin's phase.
  if (spin) {
    const ph = spin.active ? spin.phase : 'idle';
    if (ph !== spinPhaseSeen) {
      if (ph === 'spin') audio.onSpinStart();
      else if (ph === 'banner') audio.onSpinSettle();
      spinPhaseSeen = ph;
    }
  }
}
let spinPhaseSeen = 'idle'; // last spin phase a sound was fired for

// ---------------------------------------------------------------------------
// Delta-timed render loop.
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05); // clamp big stalls
  pigs.update(dt);
  pigs.tickAnims(dt);
  updateTreasure(dt);
  updateAudio();       // v3 audio: read pigs.vfx[] + state BEFORE the VfxLayer drains it
  updateCoins(dt);     // Phase 4 coins: counts the same queue (also pre-drain)
  vfx.update(dt);      // v3 juice: drains pigs.vfx[] -> shots/pops/puffs/transitions
  seascape.update(dt); // L1 parallax drift (look only, delta-timed)
  updateSlotRack(dt);
  updateTapRings(dt);
  tickReject(dt);
  updateLabels();
  updateHud();
  updateBanner(dt);
  updateSpin(dt);  // Phase 4: the level-clear fortune wheel (won edge, L1-4)
  // Phase 4 mine-explosion SCREEN SHAKE: the VfxLayer owns the decaying jitter;
  // we just offset the camera by it each frame (zero when no shake is live).
  camera.position.x = vfx.shakeOffset.x;
  camera.position.y = CAMERA_Y + vfx.shakeOffset.y;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Kick off async asset load -> build -> run. Expose the game once built for a
// headless/console logic check (used during verification).
// Phase 5 (5.11): the lose/win cards' buttons ride the same retry path as a
// tap anywhere (tryRetry gates on state, so they are inert during play).
for (const id of ['winRetryBtn', 'loseRetryBtn']) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.resume();
    tryRetry();
  });
}

boot().then(() => {
  window.__game = { board, conveyor, pigs, CONFIG, level, levelIndex };
});
