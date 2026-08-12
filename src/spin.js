// spin.js — Phase 4 LEVEL-CLEAR SPIN (spec: Level-clear spin). STYLED build only.
//
// The most Fish-of-Fortune moment in the game: after a level-1..4 clear, a
// small 6-segment fortune wheel pops in, winds BACK 15° (the FoF anticipation
// beat), spins forward ~3 turns decelerating with easeOutQuart into a
// RESULT-PREDETERMINED segment under a fixed TOP pointer, then a result banner
// pops in (easeOutBack). The first tap at the banner dismisses AND advances.
//
// This is a render-side overlay CONTROLLER — it owns its Three.js meshes + the
// #spinBanner / #spinFlash DOM nodes and exposes a tiny surface to main.js:
//   start(rand?)   — roll the result + begin the timeline (idempotent)
//   update(dt)     — advance the timeline (delta-timed)
//   active         — true from start() until dismissal
//   atBanner()     — true once the result banner is up (taps may now advance)
//   dismiss()      — hide everything (called by main.js right before reload)
// Results are applied through ONE callback (onResult(segment), fired exactly
// once at spin settle) — main.js adds coins / writes the carry flags there.
// No gameplay file knows the spin exists. Headless harnesses never build one.

import * as THREE from 'three';
import { CELL } from './board.js';
import { clamp01, easeOutBack, easeOutCubic, easeOutQuart } from './easing.js';

// ---- tuning (logged in docs/feel-changelog.md) ------------------------------
export const SPIN_DELAY    = 0.5;                  // s after the win before the wheel
export const WINDBACK_ANGLE = 15 * (Math.PI / 180); // 15° backward anticipation
export const WINDBACK_DUR  = 0.4;                  // s of wind-back
export const SPIN_DUR      = 2.5;                  // s of forward spin, easeOutQuart
export const SPIN_TURNS    = 3;                    // full clockwise turns before settling
const ENTER_DUR    = 0.35;        // wheel pop-in, easeOutBack scale
const WHEEL_R      = CELL * 3.2;  // wheel radius (player direction: larger, board-centered)
const BACKDROP_OP  = 0.38;        // dim veil behind the wheel
const BANNER_IN    = 0.4;         // result banner entrance, easeOutBack
const FLASH_DUR    = 0.30;        // jackpot screen flash fade (DOM)
const FLASH_PEAK   = 0.55;        // jackpot flash peak opacity

// The 6 segments (spec: Level-clear spin). `carry` names the flag written to
// the fof-spin-carry channel; `coins` is added to the run total at settle.
// Colors: each reward type gets a distinct FoF-palette hue (gold/amber for
// coin tiers, the golden pig's white-gold, the mine's hot red, kelp green for
// dewrap, the C2 cyan for the bonus slot).
export const SEGMENTS = [
  { key: 'coins500',  color: 0xffc91f, coins: 500,  banner: '+500 COINS', icon: 'coin' },
  { key: 'coins1000', color: 0xff9d2e, coins: 1000, banner: '+1000 COINS', icon: 'coin' },
  { key: 'golden',    color: 0xffe27a, carry: 'golden',    jackpot: true,
    banner: 'GOLDEN BAIT\nguaranteed next level', icon: 'pig_g' },
  { key: 'mine',      color: 0xff4030, carry: 'mine',      jackpot: true,
    banner: 'MINE DROP\nburied in the next level', icon: 'cube_m' },
  { key: 'dewrap',    color: 0x2e9e63, carry: 'dewrap',
    banner: 'SEAWEED CLEARED\nnext level starts unwrapped', icon: 'seaweed' },
  { key: 'bonusSlot', color: 0x13c4c4, coins: 300, carry: 'bonusSlot',
    banner: '+300 COINS\n+1 waiting slot next level', icon: 'slot' },
];

// PURE rotation math (exported for the headless harness): the final wheel
// rotation that parks segment i's CENTER under the fixed TOP pointer after
// `turns` extra clockwise (negative-z) turns. Authored layout: segment i
// spans thetaStart = i*60°; rotation r displays authored angle θ at θ + r,
// so r = 90° − (i + 0.5)·60° − turns·360°.
export function wheelTarget(i, turns = SPIN_TURNS) {
  return Math.PI / 2 - (i + 0.5) * (Math.PI / 3) - turns * 2 * Math.PI;
}

export class SpinWheel {
  // centerX/centerY: where the wheel sits — Phase 5 player direction: the
  // BOARD's center (the blocks + conveyor ring), not the screen center.
  // assets (optional): the sprite registry — each segment carries an icon
  // (coin / golden bait / mine / seaweed / bucket) drawn from existing art;
  // null (headless) -> plain colored slices, no icons.
  constructor(scene, centerX, centerY, onResult, assets = null) {
    this.scene = scene;
    this.assets = assets;
    this.onResult = onResult;
    this.active = false;
    this.phase = 'idle'; // idle|delay|spin|banner  (windback folded into spin time)
    this.age = 0;
    this.result = -1;
    this._disposables = [];
    const track = (o) => { this._disposables.push(o); return o; };

    this.group = new THREE.Group();
    this.group.position.set(centerX, centerY, 0);
    this.group.visible = false;
    scene.add(this.group);

    // dim backdrop (over the playfield + win cascade, under the wheel)
    {
      const geo = track(new THREE.PlaneGeometry(CELL * 80, CELL * 80));
      this.backdropMat = track(new THREE.MeshBasicMaterial({
        color: 0x06303d, transparent: true, opacity: 0, depthWrite: false,
      }));
      const mesh = new THREE.Mesh(geo, this.backdropMat);
      mesh.position.z = 0.5;
      this.group.add(mesh);
    }

    // wheel: dark rim disc + 6 flat-colored slices + a small hub. The slices
    // live on a sub-group so only the WHEEL rotates (backdrop/pointer fixed).
    this.wheel = new THREE.Group();
    this.wheel.position.z = 0.55;
    this.group.add(this.wheel);
    {
      const rim = track(new THREE.CircleGeometry(WHEEL_R * 1.06, 48));
      const rimMat = track(new THREE.MeshBasicMaterial({ color: 0x083c4c, transparent: true, depthWrite: false }));
      this.wheel.add(new THREE.Mesh(rim, rimMat));
      for (let i = 0; i < SEGMENTS.length; i++) {
        const geo = track(new THREE.CircleGeometry(WHEEL_R, 16, i * (Math.PI / 3), Math.PI / 3));
        const mat = track(new THREE.MeshBasicMaterial({ color: SEGMENTS[i].color, transparent: true, depthWrite: false }));
        const slice = new THREE.Mesh(geo, mat);
        slice.position.z = 0.01;
        this.wheel.add(slice);
        // Phase 5: each segment carries its reward ICON (existing sprite art),
        // riding the wheel sub-group so it spins with the slices, oriented
        // radially (its top points outward) like a real prize wheel.
        const rec = this.assets && SEGMENTS[i].icon ? this.assets.get(SEGMENTS[i].icon) : null;
        if (rec) {
          const mid = (i + 0.5) * (Math.PI / 3);
          const size = WHEEL_R * 0.34;
          const iGeo = track(new THREE.PlaneGeometry(size, size));
          const iMat = track(new THREE.MeshBasicMaterial({
            map: rec.texture, transparent: true, depthWrite: false,
          }));
          const icon = new THREE.Mesh(iGeo, iMat);
          icon.position.set(Math.cos(mid) * WHEEL_R * 0.62, Math.sin(mid) * WHEEL_R * 0.62, 0.02);
          icon.rotation.z = mid - Math.PI / 2;
          this.wheel.add(icon);
        }
      }
      const hub = track(new THREE.CircleGeometry(WHEEL_R * 0.16, 24));
      const hubMat = track(new THREE.MeshBasicMaterial({ color: 0x083c4c, transparent: true, depthWrite: false }));
      const hubMesh = new THREE.Mesh(hub, hubMat);
      hubMesh.position.z = 0.02;
      this.wheel.add(hubMesh);
    }

    // fixed pointer: a downward triangle just above the rim (the FoF model —
    // the pointer holds still, the wheel rotates). Phase 5 player direction:
    // CORAL-RED, not gold — the gold handle vanished against the gold segments;
    // a hot contrasting hue reads instantly as "the needle".
    {
      const tri = new THREE.Shape();
      tri.moveTo(0, -WHEEL_R * 0.22);
      tri.lineTo(-WHEEL_R * 0.13, WHEEL_R * 0.10);
      tri.lineTo(WHEEL_R * 0.13, WHEEL_R * 0.10);
      tri.closePath();
      const geo = track(new THREE.ShapeGeometry(tri));
      const mat = track(new THREE.MeshBasicMaterial({ color: 0xff5a4d, transparent: true, depthWrite: false }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, WHEEL_R * 1.02, 0.58);
      this.group.add(mesh);
    }

    // DOM: the result banner + the jackpot flash (styled in index.html).
    this.bannerEl = document.getElementById('spinBanner');
    this.flashEl = document.getElementById('spinFlash');
    this.bannerAge = -1;
    this.flashAge = -1;
    this._resultFired = false;
  }

  // Begin the timeline. `rand` is injectable (default Math.random); the result
  // is rolled HERE — result-predetermined, the animation just lands on it.
  start(rand = Math.random) {
    if (this.active || this._done) return; // _done: dismissed, awaiting reload
    this.active = true;
    this.phase = 'delay';
    this.age = 0;
    this.result = Math.floor(rand() * SEGMENTS.length) % SEGMENTS.length;
  }

  atBanner() {
    return this.phase === 'banner';
  }

  // Hide everything (the tap that dismisses also reloads, but we clean up so
  // the last rendered frame is calm, and tests can assert the end state).
  dismiss() {
    this.active = false;
    this._done = true;
    this.phase = 'idle';
    this.group.visible = false;
    if (this.bannerEl) this.bannerEl.style.display = 'none';
    if (this.flashEl) this.flashEl.style.opacity = '0';
  }

  update(dt) {
    if (!this.active) return;
    this.age += dt;

    if (this.phase === 'delay') {
      if (this.age >= SPIN_DELAY) {
        this.phase = 'spin';
        this.age = 0;
        this.group.visible = true;
      }
      return;
    }

    if (this.phase === 'spin') {
      // entrance: pop-in scale + backdrop fade (concurrent with the wind-back)
      const enter = clamp01(this.age / ENTER_DUR);
      this.group.scale.setScalar(0.25 + 0.75 * easeOutBack(enter));
      this.backdropMat.opacity = BACKDROP_OP * easeOutCubic(enter);
      // rotation timeline: wind BACK 15° over 0.4s, then 2.5s forward into the
      // predetermined target (easeOutQuart deceleration through ≥3 full turns).
      if (this.age < WINDBACK_DUR) {
        this.wheel.rotation.z = WINDBACK_ANGLE * easeOutCubic(clamp01(this.age / WINDBACK_DUR));
      } else {
        const p = clamp01((this.age - WINDBACK_DUR) / SPIN_DUR);
        const target = wheelTarget(this.result);
        this.wheel.rotation.z = WINDBACK_ANGLE + (target - WINDBACK_ANGLE) * easeOutQuart(p);
        if (p >= 1) this._settle();
      }
      return;
    }

    if (this.phase === 'banner') {
      // banner entrance: easeOutBack scale pop (a bigger pop on jackpots)
      this.bannerAge += dt;
      const seg = SEGMENTS[this.result];
      const p = clamp01(this.bannerAge / BANNER_IN);
      const e = easeOutBack(p);
      const peak = seg.jackpot ? 1.12 : 1.0; // jackpot scale-pop overshoot
      if (this.bannerEl) {
        this.bannerEl.style.opacity = String(clamp01(this.bannerAge / (BANNER_IN * 0.5)));
        this.bannerEl.style.transform =
          `translate(-50%, -50%) scale(${(0.4 + (0.6 * peak) * e).toFixed(3)})`;
      }
      // jackpot screen flash: quick white veil fading out
      if (this.flashAge >= 0 && this.flashEl) {
        this.flashAge += dt;
        const f = clamp01(this.flashAge / FLASH_DUR);
        this.flashEl.style.opacity = String(FLASH_PEAK * (1 - easeOutCubic(f)));
        if (f >= 1) this.flashAge = -1;
      }
    }
  }

  // spin settled on the result: fire the apply-callback ONCE, show the banner.
  _settle() {
    if (this._resultFired) return;
    this._resultFired = true;
    this.phase = 'banner';
    this.bannerAge = 0;
    const seg = SEGMENTS[this.result];
    if (this.onResult) this.onResult(seg);
    if (this.bannerEl) {
      this.bannerEl.textContent = seg.banner;
      this.bannerEl.style.display = 'block';
      this.bannerEl.style.opacity = '0';
    }
    if (seg.jackpot) this.flashAge = 0;
  }

  dispose() {
    for (const o of this._disposables) if (o && o.dispose) o.dispose();
    this._disposables.length = 0;
    this.scene.remove(this.group);
  }
}
