// assets.js — v3 styled sprite pipeline (SVG -> CanvasTexture, manifest-driven).
//
// Contract (asset-pipeline skill): a manifest is the single source of truth; every
// sprite either loads from its file or falls back to a clearly-colored PLACEHOLDER,
// so the scene NEVER crashes on missing art. Real art drops in with no code change.
//
// SVG is rasterized in-browser: fetch text -> data URL -> <img> -> draw to a
// 2D canvas -> THREE.CanvasTexture. Flat sprite materials (layered-2D, not lit 3D).
//
// This module is LOOK ONLY. It builds textures/materials; it never touches gameplay
// state, timings, the conveyor path, the firing rule, or pig/slot positions.

import * as THREE from 'three';
import { COLORS } from './level.js';

// Where the runtime manifest + sprites live (served by Vite from /public).
const ASSET_BASE = 'assets/';
const RASTER_PX = 256; // raster size for cube/pig sprites; crisp at gameplay scale

// SINGLE-FILE PACKAGING (the playable-ad zero-network contract): the packager
// injects window.__RR_ASSETS = { manifest, files: { path -> data URI } } ahead
// of the bundle. When it exists, the manifest is read inline and every sprite
// loads from its data URI — no fetch, no network. The multi-file hosted build
// has no such global and keeps the normal runtime fetch path.
const INLINE = (typeof window !== 'undefined' && window.__RR_ASSETS) || null;

function assetUrl(path) {
  return (INLINE && INLINE.files && INLINE.files[path]) || ASSET_BASE + path;
}

// Fallback hexes for placeholders, keyed by gameplay color slot (final-ish hues so
// the color-matching logic is testable before/without art). Mirrors gameplayColors.
const PLACEHOLDER_HEX = {
  C1: 0xff6a3d, C2: 0x13c4c4,
};

// --- format dispatch: pick the right loader by file extension ----------------
// SVG must be fetched-as-text and rasterized to a fixed canvas; raster formats
// (PNG/JPG/WEBP/GIF) load directly at full resolution. This is what lets authored
// PNG art drop in over the SVG placeholders with no other code change.
const _texLoader = new THREE.TextureLoader();

async function pathToTexture(path, px = RASTER_PX) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'svg') return svgToTexture(path, px);
  return rasterToTexture(path);
}

// --- raster (PNG/JPG/...): load the file directly as a full-res texture ------
// (a data URI from the inlined single-file map loads through the same path)
async function rasterToTexture(path) {
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

// --- low-level: rasterize one SVG file to a CanvasTexture --------------------
async function svgToTexture(path, px = RASTER_PX) {
  const res = await fetch(ASSET_BASE + path);
  if (!res.ok) throw new Error(`asset ${path}: HTTP ${res.status}`);
  const svgText = await res.text();
  if (!svgText.includes('<svg')) throw new Error(`asset ${path}: not an SVG`);
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`asset ${path}: image decode failed`));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(img, 0, 0, px, px);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  } finally {
    URL.revokeObjectURL(url);
  }
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
    let manifest;
    try {
      if (INLINE && INLINE.manifest) {
        manifest = INLINE.manifest; // single-file build: zero network
      } else {
        const res = await fetch(ASSET_BASE + 'manifest.json');
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        manifest = await res.json();
      }
    } catch (e) {
      // No manifest at all -> still don't crash: empty registry, callers fall back.
      console.warn('[assets] manifest missing, running on placeholders only:', e.message);
      manifest = { sprites: [] };
    }
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
