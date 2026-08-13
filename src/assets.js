// assets.js — v3 styled sprite pipeline (PNG textures, manifest-driven).
//
// Contract (asset-pipeline skill): a manifest is the single source of truth; every
// sprite either loads from its file or falls back to a clearly-colored PLACEHOLDER,
// so the scene NEVER crashes on missing art. Real art drops in with no code change.
//
// ZERO-FETCH (Round 2, the playable-ad contract): the manifest is BUNDLED at
// build time (JSON import below) and every sprite is a PNG loaded through
// THREE.TextureLoader (an <img> element, not fetch) — the module contains no
// runtime fetch() at all, so the packaged single-file build provably makes no
// network request. The reference build's SVG-rasterize path (a fetch of the SVG
// text) was dead code here — every shipped sprite is PNG — and is removed.
//
// This module is LOOK ONLY. It builds textures/materials; it never touches gameplay
// state, timings, the conveyor path, the firing rule, or pig/slot positions.

import * as THREE from 'three';
import { COLORS } from './level.js';
// The manifest ships INSIDE the bundle (both builds — one source of truth, no
// runtime fetch). Vite inlines the JSON at build time.
import manifestJson from '../public/assets/manifest.json';

// Where the runtime sprites live (served by Vite from /public).
const ASSET_BASE = 'assets/';

// SINGLE-FILE PACKAGING (the playable-ad zero-network contract): the packager
// injects window.__RR_ASSETS = { files: { path -> data URI } } ahead of the
// bundle. When it exists, every sprite loads from its data URI — zero requests.
// The multi-file hosted build has no such global and loads its own PNGs by URL
// (the manifest itself is bundled either way, see the import above).
const INLINE = (typeof window !== 'undefined' && window.__RR_ASSETS) || null;

function assetUrl(path) {
  return (INLINE && INLINE.files && INLINE.files[path]) || ASSET_BASE + path;
}

// Fallback hexes for placeholders, keyed by gameplay color slot (final-ish hues so
// the color-matching logic is testable before/without art). Mirrors gameplayColors.
const PLACEHOLDER_HEX = {
  C1: 0xff6a3d, C2: 0x13c4c4,
};

// --- raster (PNG/JPG/...): load the file directly as a full-res texture ------
// (a data URI from the inlined single-file map loads through the same path;
// TextureLoader decodes via an <img> element — no fetch involved)
const _texLoader = new THREE.TextureLoader();

async function pathToTexture(path) {
  const url = assetUrl(path);
  let tex;
  try {
    tex = await _texLoader.loadAsync(url);  // rejects on 404 / decode error
  } catch (e) {
    throw new Error(`asset ${path}: ${e?.message || 'load failed'}`);
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// --- placeholder: a clearly-colored rounded tile with a role glyph ----------
// Never crashes; reads as "this slot has no art yet" while staying color-correct.
function placeholderTexture(entry) {
  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  const key = entry.colorKey;
  const hex = key != null
    ? (PLACEHOLDER_HEX[key] ?? COLORS[key] ?? 0xff00ff)
    : 0xff00ff; // magenta = "missing, no color" -> obvious in dev
  const css = '#' + hex.toString(16).padStart(6, '0');
  // rounded square
  const r = 22, m = 10, s = px - 2 * m;
  ctx.fillStyle = css;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 6;
  roundRect(ctx, m, m, s, s, r);
  ctx.fill(); ctx.stroke();
  // a diagonal hatch marks it as a placeholder (not final art)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(m, px - m); ctx.lineTo(px - m, m); ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- public: load the whole manifest ----------------------------------------
// Returns an Assets registry: { entry, texture, isPlaceholder } per sprite id,
// plus helpers byColor(role, colorKey) and a dispose().
export class Assets {
  constructor() {
    this.byId = new Map();        // id -> { entry, texture, isPlaceholder }
    this.colorMap = {};           // cN -> gameplay key
    this.gameplayColors = {};     // gameplay key -> hex string
    this._textures = new Set();   // for disposal
    this.manifest = null;
  }

  static async load() {
    const a = new Assets();
    // The manifest is bundled (JSON import) — same object in both builds, no
    // runtime fetch, and it can never be "missing" without the build failing.
    const manifest = manifestJson;
    a.manifest = manifest;
    a.colorMap = manifest.colorMap ?? {};
    a.gameplayColors = manifest.gameplayColors ?? {};

    const entries = manifest.sprites ?? [];
    await Promise.all(entries.map(async (entry) => {
      let texture, isPlaceholder = false;
      try {
        texture = await pathToTexture(entry.path);
      } catch (err) {
        console.warn(`[assets] ${entry.id} -> placeholder (${err.message})`);
        texture = placeholderTexture(entry);
        isPlaceholder = true;
      }
      a._textures.add(texture);
      a.byId.set(entry.id, { entry, texture, isPlaceholder });
    }));

    // Log which sprites loaded REAL vs fell back to a PLACEHOLDER (asset-pipeline
    // contract: missing art never crashes; the summary makes the state obvious).
    const recs = [...a.byId.values()];
    const real = recs.filter((r) => !r.isPlaceholder).map((r) => r.entry.id);
    const ph = recs.filter((r) => r.isPlaceholder).map((r) => r.entry.id);
    console.info(
      `[assets] ${recs.length} sprites — ${real.length} real, ${ph.length} placeholder` +
      (ph.length ? `\n  placeholders: ${ph.join(', ')}` : '') +
      (real.length ? `\n  real: ${real.join(', ')}` : '')
    );
    return a;
  }

  get(id) { return this.byId.get(id) ?? null; }

  // Find the sprite of a role matching a gameplay color key (C1/C2).
  byColor(role, colorKey) {
    for (const rec of this.byId.values()) {
      if (rec.entry.role === role && rec.entry.colorKey === colorKey) return rec;
    }
    return null;
  }

  // All sprite records of a role (e.g. every background 'fish').
  byRole(role) {
    const out = [];
    for (const rec of this.byId.values()) if (rec.entry.role === role) out.push(rec);
    return out;
  }

  dispose() {
    for (const t of this._textures) t.dispose();
    this._textures.clear();
    this.byId.clear();
  }
}
