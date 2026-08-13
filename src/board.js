// board.js — the block board. Each authored CELL is a big block = a 2x2 of FOUR
// individually-destroyable SMALL blocks of the same color (per the reference video).
// The board is an 18x18 grid of small blocks (9x9 cells x 2). A shot removes only the
// FIRST (closest) small block in the pig's inward sub-line.
//
// v3 reskin (look only): when assets are present each small block draws the cell's
// color SVG (a small reef tile); a big block reads as a 2x2 of tiles. Positions,
// grid, firing are identical to v1.
//
// Coordinate convention (small-block grid): scol/srow in [0, SUB_*-1]; srow 0 =
// bottom; world x increases with scol, y with srow.

import * as THREE from 'three';
import { COLORS, expandPattern, GRID_COLS, GRID_ROWS } from './level.js';

export const CELL = 1.0;
// GAPLESS mosaic (spec re-lock #3): blocks tile edge-to-edge — the big-block
// footprint IS the cell and the 4 small blocks have no gutter between them.
const CUBE_SIZE = CELL;
const SUB_GAP = 0;
const SUB_SIZE = (CUBE_SIZE - SUB_GAP) / 2;
export const QOFF = (SUB_SIZE + SUB_GAP) / 2;

export const SUB_COLS = GRID_COLS * 2;
export const SUB_ROWS = GRID_ROWS * 2;

const QUADS = [
  { sx: 0, sy: 0 }, { sx: 1, sy: 0 }, { sx: 0, sy: 1 }, { sx: 1, sy: 1 },
];

export class Board {
  // assets (optional): the v3 sprite registry. Present -> each block draws its
  // color's SVG; absent (or missing) -> flat color quad. Reskin is LOOK ONLY.
  // level: one entry of LEVELS (level.js) — its pattern is the board's DATA.
  // Cells the pattern authors EMPTY ('.') simply have no blocks (the firing
  // scans see through them; level 5's treasure pocket).
  constructor(scene, assets = null, level) {
    this.scene = scene;
    this.assets = assets;
    this.level = level;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.originX = -(GRID_COLS - 1) * CELL * 0.5;
    this.originY = -(GRID_ROWS - 1) * CELL * 0.5;

    this.blocks = [];
    this.grid = new Map();

    this._subGeo = new THREE.PlaneGeometry(SUB_SIZE, SUB_SIZE);
    this._materials = new Map();

    // Sprites carry transparent padding -> scale the tile up to ~fill its small-block
    // cell. The flat-color fallback keeps the exact small-block footprint.
    const SPRITE_FILL = this.assets ? 1.18 : 1.0;
    for (const c of expandPattern(level)) {
      const colorKey = c.color;
      const mat = this._materialFor(colorKey);
      for (const q of QUADS) {
        const scol = 2 * c.col + q.sx;
        const srow = 2 * c.row + q.sy;
        const mesh = new THREE.Mesh(this._subGeo, mat);
        mesh.position.set(
          this.originX + c.col * CELL + (q.sx ? QOFF : -QOFF),
          this.originY + c.row * CELL + (q.sy ? QOFF : -QOFF),
          0
        );
        mesh.scale.setScalar(SPRITE_FILL);
        this.group.add(mesh);
        // Phase 4 SEAWEED WRAPS: `wrapped` is the armor state (spec: Seaweed-
        // wrapped blocks). Default false; the dewrap flip happens in pigs.update.
        const block = { scol, srow, cellCol: c.col, cellRow: c.row, colorKey, alive: true, wrapped: c.wrapped === true, mesh };
        this.blocks.push(block);
        this.grid.set(this._key(scol, srow), block);
      }
    }
  }

  _materialFor(colorKey) {
    if (!this._materials.has(colorKey)) {
      const rec = this.assets ? this.assets.byColor('cube', colorKey) : null;
      const mat = rec
        ? new THREE.MeshBasicMaterial({ map: rec.texture, transparent: true })
        : new THREE.MeshBasicMaterial({ color: COLORS[colorKey] });
      this._materials.set(colorKey, mat);
    }
    return this._materials.get(colorKey);
  }

  _key(scol, srow) {
    return scol + ',' + srow;
  }

  cellToWorld(col, row) {
    return { x: this.originX + col * CELL, y: this.originY + row * CELL };
  }

  get bounds() {
    return {
      minX: this.originX,
      maxX: this.originX + (GRID_COLS - 1) * CELL,
      minY: this.originY,
      maxY: this.originY + (GRID_ROWS - 1) * CELL,
      cols: GRID_COLS,
      rows: GRID_ROWS,
    };
  }

  aliveCount() {
    let n = 0;
    for (const b of this.blocks) if (b.alive) n++;
    return n;
  }

  // --- FIRING QUERIES (BLOCKING, small-block resolution) --------------------
  // First alive block in the inward sub-line, returned only if it matches; a
  // wrong-color front returns null (HOLD). Arg is a SUB index from the conveyor.
  // Phase 4 WILD + MINE rule (the ONLY firing change): a 'W' or 'M' front
  // matches ANY pig color. The BLOCKING rule is otherwise untouched — a wild/
  // mine BEHIND another block is still blocked normally, and hasExposedColor()
  // (lockup reachability + queue weighting) inherits the rule through these
  // same queries — an exposed mine is reachable by every color (spec: Mine
  // blocks, lockup reachability).

  // Phase 4 GOLDEN PIG (spec: Golden pig): colorKey 'G' is the golden PIG's key
  // (never a block's) — it matches EVERY front block, so the same queries give
  // the pierce its first target and hasExposedColor('G') its lockup answer (a
  // returning golden pig can spend while ANY block is alive).
  _matches(b, colorKey) {
    return colorKey === 'G' || b.colorKey === colorKey || b.colorKey === 'W' || b.colorKey === 'M';
  }

  nearestDownColumn(scol, colorKey) {
    for (let srow = SUB_ROWS - 1; srow >= 0; srow--) {
      const b = this.grid.get(this._key(scol, srow));
      if (b && b.alive) return this._matches(b, colorKey) ? b : null;
    }
    return null;
  }

  nearestUpColumn(scol, colorKey) {
    for (let srow = 0; srow < SUB_ROWS; srow++) {
      const b = this.grid.get(this._key(scol, srow));
      if (b && b.alive) return this._matches(b, colorKey) ? b : null;
    }
    return null;
  }

  nearestRightRow(srow, colorKey) {
    for (let scol = 0; scol < SUB_COLS; scol++) {
      const b = this.grid.get(this._key(scol, srow));
      if (b && b.alive) return this._matches(b, colorKey) ? b : null;
    }
    return null;
  }

  nearestLeftRow(srow, colorKey) {
    for (let scol = SUB_COLS - 1; scol >= 0; scol--) {
      const b = this.grid.get(this._key(scol, srow));
      if (b && b.alive) return this._matches(b, colorKey) ? b : null;
    }
    return null;
  }

  hasExposedColor(colorKey) {
    for (let scol = 0; scol < SUB_COLS; scol++) {
      if (this.nearestDownColumn(scol, colorKey)) return true;
      if (this.nearestUpColumn(scol, colorKey)) return true;
    }
    for (let srow = 0; srow < SUB_ROWS; srow++) {
      if (this.nearestRightRow(srow, colorKey)) return true;
      if (this.nearestLeftRow(srow, colorKey)) return true;
    }
    return false;
  }

  destroy(block) {
    if (!block.alive) return;
    block.alive = false;
    this.group.remove(block.mesh);
    this.grid.delete(this._key(block.scol, block.srow));
  }

  // Phase 4 MINES (spec: Mine blocks, blast square). Called by pigs.update()
  // right after the trigger sub-block is destroyed. Clears every alive small
  // block within Chebyshev distance 2 of the mine's 2x2 footprint — a 6x6
  // small-block square = the mine cell's 3x3 BIG-block neighborhood, clipped
  // at the board edges. Color and blocking are ignored; no chain-triggering
  // (levels author max 1 mine). Returns { cx, cy, destroyed } — the mine's
  // world center + the blast-destroyed blocks — for VFX/coins/harnesses.
  explodeMine(mineBlock) {
    const baseCol = 2 * Math.floor(mineBlock.scol / 2); // footprint min sub col
    const baseRow = 2 * Math.floor(mineBlock.srow / 2);
    const destroyed = [];
    for (let scol = baseCol - 2; scol <= baseCol + 3; scol++) {
      for (let srow = baseRow - 2; srow <= baseRow + 3; srow++) {
        const b = this.grid.get(this._key(scol, srow));
        if (b && b.alive) { this.destroy(b); destroyed.push(b); }
      }
    }
    return {
      cx: this.originX + Math.floor(mineBlock.scol / 2) * CELL,
      cy: this.originY + Math.floor(mineBlock.srow / 2) * CELL,
      destroyed,
    };
  }

  dispose() {
    this._subGeo.dispose();
    for (const m of this._materials.values()) m.dispose();
    this.scene.remove(this.group);
  }
}
