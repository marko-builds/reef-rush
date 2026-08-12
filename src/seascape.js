// seascape.js — v3 styled layered-2D SEA background + parallax life + vignette.
//
// Layer stack (scene-composition skill), back -> front, by position.z:
//   L0  sea gradient (turquoise/aqua) + seabed                          z = -5.0
//   L1  drifting parallax life: kelp, fish, bubbles (slow, delta-timed) z = -4.5..-3.5
//   Lv  VIGNETTE / soft darken panel behind the playfield               z = -1.0
//        (the playfield belt sits at -0.2..0, cubes/pigs at 0..0.3, UI above)
//
// LOOK ONLY. Nothing here reads or writes gameplay state. All motion is delta-timed
// and wraps; sprites are pooled (built once, repositioned), no per-frame allocation.

import * as THREE from 'three';

// Vertical gradient water: bright aqua near the top fading to deep turquoise below.
const SEA_TOP    = '#7fe9e0'; // bright aqua (sunlit surface)
const SEA_MID    = '#2bb6c8'; // turquoise
const SEA_BOTTOM = '#0d5d77'; // deep teal (depth)
const SEABED     = '#1b3a52'; // dim seabed band

function gradientTexture() {
  const w = 16, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, SEA_TOP);
  g.addColorStop(0.45, SEA_MID);
  g.addColorStop(0.85, SEA_BOTTOM);
  g.addColorStop(1.0, SEABED);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Soft radial vignette: transparent centre -> dark edges. Drawn as a big quad just
// behind the playfield so busy sea life never robs the board of contrast.
function vignetteTexture() {
  const px = 256;
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(px / 2, px / 2, px * 0.20, px / 2, px / 2, px * 0.60);
  g.addColorStop(0.0, 'rgba(3,20,30,0.0)');
  g.addColorStop(0.55, 'rgba(3,20,30,0.22)');
  g.addColorStop(1.0, 'rgba(3,20,30,0.52)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class Seascape {
  // assets: the loaded Assets registry (for fish/kelp/bubble textures).
  // viewHeight: world height the ortho camera shows (so we can size to fill).
  // cameraY: the ortho camera's rest Y — the visible frame is
  //   [cameraY - viewH/2, cameraY + viewH/2], NOT centered on world y=0.
  constructor(scene, assets, viewHeight, cameraY = 0) {
    this.scene = scene;
    this.assets = assets;
    this.viewH = viewHeight;
    this.cameraY = cameraY;
    this.worldW = viewHeight * 2.2; // wide enough for any reasonable aspect
    this.group = new THREE.Group();
    scene.add(this.group);
    this._disposables = [];
    this.drifters = []; // { mesh, vx, vy, baseScale, swayPhase, swayAmp, kind }

    this._buildGradient();
    this._buildCoral();
    this._buildVignette();
    this._buildLife();
    this.layout();
  }

  // Phase 5 fix 5.5: pin the sea gradient (and sun shafts) FLUSH to the
  // camera's BOTTOM frustum edge — position.y is derived from the camera
  // frame, never a hardcoded world unit. EDGE_MARGIN extends the planes a bit
  // PAST the edge so the mine-explosion camera shake (±0.15 world units) and
  // any DPI rounding can never expose a seam. Called once at build and again
  // on every window resize.
  layout() {
    const EDGE_MARGIN = 0.5; // world units of overshoot past the bottom edge
    const bottom = this.cameraY - this.viewH / 2 - EDGE_MARGIN;
    this._gradientMesh.position.y = bottom + this._gradientH / 2;
    this._shaftsMesh.position.y = bottom + this._shaftsH / 2;
    if (this._hazeMesh) this._hazeMesh.position.y = bottom + this._gradientH / 2;
    // Phase 5 (5.10): the coral reef band is anchored at the bottom too (its
    // height overshoots below by the same margin so no seam can show).
    if (this._coralMesh) this._coralMesh.position.y = bottom + this._coralH / 2;
  }

  // Phase 5 (5.10): CORAL backdrop — a wide reef band spanning the full scene
  // width at the bottom, BEHIND the kelp (z between the gradient and the kelp).
  // Static dressing: never moves, never animates. The borrowed corals.png
  // (2048×1372, from the wheel project) repeats horizontally to cover any
  // width; repeat count derives from the band height and the art's aspect.
  _buildCoral() {
    const rec = this.assets && this.assets.get ? this.assets.get('coral_bg') : null;
    if (!rec) return; // missing sprite -> simply no coral band (never crashes)
    this._coralH = 4.2; // band height in world units
    // Player direction (final): the REPEATING coral band is back (the single
    // stretch was reverted) — multiple corals tile the bottom at the art's own
    // aspect, fully opaque, IN FRONT of the kelp (kelp grows behind the reef).
    const tex = rec.texture;
    tex.wrapS = THREE.RepeatWrapping;
    const artAspect = 2048 / 1372;                       // corals.png w/h
    tex.repeat.set(this.worldW / (this._coralH * artAspect), 1);
    tex.needsUpdate = true;
    const geo = this._track(new THREE.PlaneGeometry(this.worldW, this._coralH));
    const mat = this._track(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      // fully opaque, slightly DARKENED (player direction) so the reef reads
      // rich but not louder than the playfield
      color: new THREE.Color(0xb9c2c6),
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = -4.6; // in FRONT of the kelp (-4.8), behind the fish (-3.8)
    mesh.renderOrder = -70;
    this.group.add(mesh);
    this._coralMesh = mesh; // y pinned in layout()
  }

  _track(obj) { this._disposables.push(obj); return obj; }

  _buildGradient() {
    const tex = this._track(gradientTexture());
    this._gradientH = this.viewH * 1.25; // overshoot extends ABOVE the top edge only
    const geo = this._track(new THREE.PlaneGeometry(this.worldW, this._gradientH));
    const mat = this._track(new THREE.MeshBasicMaterial({ map: tex, depthWrite: false }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = -5.0;
    mesh.renderOrder = -100;
    this.group.add(mesh);
    this._gradientMesh = mesh; // y pinned to the camera frame in layout()

    // Sun-shaft hint: a couple of faint light-blue angled bands for depth (procedural).
    this._shaftsH = this.viewH * 1.3;
    const shaftGeo = this._track(new THREE.PlaneGeometry(this.worldW, this._shaftsH));
    const shaftTex = this._track(this._shaftTexture());
    const shaftMat = this._track(new THREE.MeshBasicMaterial({
      map: shaftTex, transparent: true, opacity: 0.18, depthWrite: false,
    }));
    const shafts = new THREE.Mesh(shaftGeo, shaftMat);
    shafts.position.z = -4.8;
    shafts.renderOrder = -99;
    this.group.add(shafts);
    this._shaftsMesh = shafts; // y pinned to the camera frame in layout()

    // Player direction (final): a translucent copy of the gradient sits IN
    // FRONT of the coral/kelp band — water haze that settles the opaque reef
    // back into the scene (fish/board layers are in front and unaffected).
    const hazeMat = this._track(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.38, depthWrite: false,
    }));
    const haze = new THREE.Mesh(geo, hazeMat);
    haze.position.z = -4.4; // kelp -4.8, coral -4.6 < HAZE -4.4 < fish -3.8
    haze.renderOrder = -65;
    this.group.add(haze);
    this._hazeMesh = haze; // y pinned in layout()
  }

  _shaftTexture() {
    const w = 256, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#eafcff';
    for (const [x, wid] of [[40, 36], [120, 22], [200, 30]]) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.transform(1, 0, -0.35, 1, 0, 0);
      ctx.fillRect(0, 0, wid, h);
      ctx.restore();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildVignette() {
    const tex = this._track(vignetteTexture());
    // Phase 5 fix 5.5 (the REAL culprit of the bottom strip): the vignette must
    // cover the WHOLE visible frame. At viewH*1.25 centered on y=0 its bottom
    // edge (-10.0) fell short of the camera bottom (-10.25), so the last strip
    // of sea missed the vignette darkening and read as a LIGHTER band. Sized to
    // viewH*1.45 (±11.6) it covers the frame plus the shake margin while its
    // radial centre stays on the playfield.
    const geo = this._track(new THREE.PlaneGeometry(this.worldW, this.viewH * 1.45));
    const mat = this._track(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = -1.0; // just behind the playfield (belt at -0.2), darkens the board area
    mesh.renderOrder = -10;
    this.group.add(mesh);
  }

  _buildLife() {
    const a = this.assets;
    const halfW = this.worldW / 2;
    const halfH = this.viewH / 2;

    const spawn = (rec, opts) => {
      if (!rec) return;
      const e = rec.entry;
      const baseScale = (e.scale ?? 1) * (opts.scale ?? 1);
      // sprite art is square-ish 100x100 viewBox; size in world units:
      const sizeW = (opts.aspect ?? 1) * 3.0 * baseScale;
      const sizeH = 3.0 * baseScale;
      const geo = this._track(new THREE.PlaneGeometry(sizeW, sizeH));
      const mat = this._track(new THREE.MeshBasicMaterial({
        map: rec.texture, transparent: true, depthWrite: false,
        opacity: opts.opacity ?? 1,
        // desaturate far life so it never competes with the gameplay colors
        color: new THREE.Color(opts.tint ?? 0xbfeaf0),
      }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(opts.x, opts.y, opts.z);
      mesh.renderOrder = opts.renderOrder ?? -50;
      this.group.add(mesh);
      this.drifters.push({
        mesh, vx: opts.vx ?? 0, vy: opts.vy ?? 0,
        baseY: opts.y, baseX: opts.x,
        swayPhase: Math.random() * Math.PI * 2,
        swayAmp: opts.swayAmp ?? 0,
        swayRate: opts.swayRate ?? 1.4, // rad/s of the sin drift
        kind: opts.kind,
        halfW, halfH,
      });
    };

    // Kelp: anchored to the seabed, gentle sway, deepest parallax band.
    const kelp = a.byRole ? a.byRole('kelp')[0] : null;
    if (kelp) {
      const e = kelp.entry;
      for (let i = 0; i < (e.count ?? 4); i++) {
        const x = -halfW + (i + 0.5) * (this.worldW / (e.count ?? 4)) + (Math.random() - 0.5) * 1.5;
        spawn(kelp, {
          // Phase 5 player direction: kelp sits LOWER, rooted in the coral band
          x, y: this.cameraY - this.viewH / 2 + 3.2, z: -4.8, aspect: 0.4, scale: 1.1 + Math.random() * 0.5,
          opacity: 1.0, tint: 0xb4c2b4, kind: 'kelp', swayAmp: 0.18, renderOrder: -75,
        });
      }
    }

    // Phase 5 (5.8): BACKGROUND FISH — solid cartoon fish borrowed from the
    // wheel project (audit 5.7). Per fish: a PRIMARY direction assigned at
    // spawn (balanced ltr/rtl across the pool), the sprite FACES it (the art
    // faces right; rtl fish flip on x-scale), a vertical sin drift with random
    // phase/amplitude/period, and edge-exit WRAPS to the opposite side at a
    // random Y — a fish never turns around mid-screen. Pooled at build; the
    // update loop only moves meshes (zero allocation).
    let fi = 0;
    for (const rec of (a.byRole ? a.byRole('fish') : [])) {
      const e = rec.entry;
      for (let i = 0; i < (e.count ?? 2); i++) {
        const dir = fi % 2 === 0 ? 1 : -1; // balanced: half ltr, half rtl
        fi++;
        spawn(rec, {
          x: (Math.random() - 0.5) * this.worldW,
          y: this._fishY(),
          // player direction: background fish are SOLID — full opacity, no
          // desat tint (the vignette already guards the board's contrast)
          z: -3.8, aspect: 1.2, scale: 0.6 + Math.random() * 0.4,
          opacity: 1.0, tint: 0xffffff, kind: 'fish',
          vx: dir * (0.35 + Math.random() * 0.45),     // world units/s
          swayAmp: 0.2 + Math.random() * 0.2,          // 0.20..0.40 world units
          swayRate: (Math.PI * 2) / (2 + Math.random() * 2), // period 2..4 s
          renderOrder: -50,
        });
        const d = this.drifters[this.drifters.length - 1];
        if (dir < 0) d.mesh.scale.x = -1; // face the travel direction (art faces right)
      }
    }

    // Phase 5 (5.9): AMBIENT BUBBLES — small, semi-transparent, rising with a
    // slow horizontal sin drift; on top exit each returns to the pool spawn
    // point: a random X just below the visible bottom edge. Pooled, 10 alive.
    const bub = a.byRole ? a.byRole('bubble')[0] : null;
    if (bub) {
      const COUNT = 10; // brief window 8..12
      for (let i = 0; i < COUNT; i++) {
        spawn(bub, {
          x: (Math.random() - 0.5) * this.worldW,
          y: this.cameraY - this.viewH / 2 + Math.random() * this.viewH, // staggered start
          z: -3.5, aspect: 1,
          // target diameter 0.15..0.35 world units; spawn() multiplies by the
          // sprite's base unit (3.0) AND the manifest entry scale — divide out.
          scale: (0.15 + Math.random() * 0.2) / 3.0 / (bub.entry.scale ?? 1),
          opacity: 0.5 + Math.random() * 0.3,          // 0.5..0.8
          vy: 0.45 + Math.random() * 0.4,              // rise, world units/s
          kind: 'bubble',
          swayAmp: 0.05 + Math.random() * 0.07,        // 0.05..0.12 world units
          swayRate: (Math.PI * 2) / (1.5 + Math.random() * 1.5), // period 1.5..3 s
          renderOrder: -48,
        });
      }
    }
  }

  // Random Y for a fish entering the scene, anywhere in the visible band.
  _fishY() {
    return this.cameraY + (Math.random() - 0.5) * this.viewH * 0.8;
  }

  // Delta-timed drift + wrap + gentle sway. No allocation in the loop.
  update(dt) {
    const camTop = this.cameraY + this.viewH / 2;
    const camBottom = this.cameraY - this.viewH / 2;
    for (const d of this.drifters) {
      const m = d.mesh;
      if (d.kind === 'fish') {
        // Phase 5 (5.8): forward at the fish's own speed, vertical sin drift,
        // wrap to the opposite edge at a RANDOM Y (never turns mid-screen).
        m.position.x += d.vx * dt;
        d.swayPhase += dt * d.swayRate;
        m.position.y = d.baseY + Math.sin(d.swayPhase) * d.swayAmp;
        if (d.vx > 0 && m.position.x > d.halfW + 3) {
          m.position.x = -d.halfW - 3;
          d.baseY = this._fishY();
        } else if (d.vx < 0 && m.position.x < -d.halfW - 3) {
          m.position.x = d.halfW + 3;
          d.baseY = this._fishY();
        }
      } else if (d.kind === 'bubble') {
        // Phase 5 (5.9): constant rise + slow horizontal sin drift; exiting the
        // top returns it to the pool spawn: random X just below the bottom edge.
        m.position.y += d.vy * dt;
        d.swayPhase += dt * d.swayRate;
        m.position.x = d.baseX + Math.sin(d.swayPhase) * d.swayAmp;
        if (m.position.y > camTop + 1) {
          m.position.y = camBottom - 1;
          d.baseX = (Math.random() - 0.5) * d.halfW * 2;
        }
      } else if (d.kind === 'kelp') {
        d.swayPhase += dt * 0.9;
        m.rotation.z = Math.sin(d.swayPhase) * d.swayAmp * 0.25;
      }
    }
  }

  dispose() {
    for (const o of this._disposables) {
      if (o.dispose) o.dispose();
    }
    this._disposables.length = 0;
    this.scene.remove(this.group);
  }
}
