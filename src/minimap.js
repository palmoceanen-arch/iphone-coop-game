// Top-down explored-terrain minimap.
//
// Strategy ("as other open-world games do"):
//   1. Each chunk is rasterised once into a small offscreen tile
//      (TILE_PX × TILE_PX, currently 64×64 for a 32m chunk @ 2 px/m).
//   2. The tile is cached by `chunkKey` and stays alive even after the
//      chunk itself unloads from `world.chunks`, so explored regions
//      remain visible on the minimap as the player wanders.
//   3. Trees / rocks are pixel-painted directly into the same ImageData
//      as the terrain — they never move, never repaint after first bake.
//   4. Player-built structures live on a separate offscreen overlay per
//      chunk that we re-paint only when `invalidate(chunkKey)` is called
//      (placeStructure / forgetStructure / harvest tree-or-rock).
//   5. Per frame we just `drawImage` the cached tile + overlay for each
//      visible chunk and stamp player markers on top — no per-pixel work
//      in the hot path.
//
// Per-frame cost on a fully-explored display:
//   - 9–16 drawImage calls (one per visible cached tile)
//   - 1 drawImage per visible chunk's overlay (skipped if empty)
//   - 2 small arc()s for player markers
// Per-bake cost (amortised; only first frame the player visits a chunk):
//   - TILE_PX² noise + isWaterAt samples (~4096 calls @ 64²) → ~1–3 ms on CPU
//   - <30 fillRect calls for resource dots
// Memory: ~16 KB / chunk in the terrain cache + ~4 KB / chunk overlay.

import { CHUNK_SIZE } from './world.js';

// Pixels per metre on the cached chunk tiles AND the on-screen display.
// 2 px/m → 64 px per chunk, ~100 m visible window in a 200×200 minimap.
// Doubling this would quadruple bake cost; halving makes single-tile
// landmarks (a tree, a torch) sub-pixel.
const PX_PER_M = 2;
const TILE_PX = CHUNK_SIZE * PX_PER_M;

// Colour palette. RGB triplets are used by the per-pixel terrain bake;
// CSS strings are used by the structure overlay (which goes through the
// 2D context's fillStyle).
const COL = {
  unvisited: '#000000',
  water:      [29, 58, 82],
  sand:       [196, 169, 106],
  grassLight: [88, 122, 70],
  grassDark:  [60, 90, 50],
  tree:       [42, 74, 32],
  rock:       [138, 142, 149],
};
// Structures need to read clearly against the dark-green grass and the
// gray rocks. Walls go a notch lighter than the rock colour so a wall
// next to a natural boulder is still distinguishable; fences/gates pick
// a saturated wood-brown rather than the muted planter colour.
const STRUCTURE_COL = {
  wall:     '#b8bdc8',
  fence:    '#c47032',
  gate:     '#e0a050',
  planter:  '#6b4a2c',
  campfire: '#ff8a3a',
  torch:    '#ffd060',
};
// Bright accent so player blips read against any terrain colour.
// P1 = cyan (matches `.hud.left .name`), P2 = pink (`.hud.right .name`).
const PLAYER_COL = ['#6ad0ff', '#ff8a8a'];

function makeOffscreen(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export class Minimap {
  constructor(world, players, displayCanvas) {
    this.world = world;
    this.players = players;
    this.display = displayCanvas;
    this.dctx = displayCanvas.getContext('2d');
    // Texture filtering off: we want the pixel-art look, not blur, when
    // the browser stretches the offscreen tiles to fill the display.
    this.dctx.imageSmoothingEnabled = false;

    // Per-chunk caches. Survive `world.chunks` eviction so unloaded
    // explored terrain still renders.
    this._terrain = new Map(); // key → ImageData (TILE_PX×TILE_PX)
    this._overlay = new Map(); // key → OffscreenCanvas
    this._tile    = new Map(); // key → composed OffscreenCanvas (terrain+overlay)
    this._dirty   = new Set(); // keys whose overlay needs re-paint
    this._visited = new Set(); // keys the player has been near
    // Frame budget: at most this many full chunk bakes happen per render
    // call so a fresh game start (~16 visible chunks at once) doesn't
    // burn the whole frame on map paint. 4×~2ms ≈ 8ms on a low-end
    // laptop, leaving plenty of room for the rest of the frame; on
    // mobile even 1 per frame keeps up with the 1-chunk-per-frame
    // streaming budget in `processChunkQueue`.
    this._bakeBudget = 4;
  }

  // Invalidate a chunk's structure overlay. The terrain cache is kept;
  // only the overlay is re-painted on the next render. Cheap.
  invalidate(chunkKey) {
    if (chunkKey) this._dirty.add(chunkKey);
  }

  // Drop a tree / rock from a chunk: its dot is baked into the *terrain*
  // ImageData, so the entire terrain has to be re-baked to remove it.
  // Triggered when a resource is fully harvested (state==='gone' / stump).
  invalidateTerrain(chunkKey) {
    if (!chunkKey) return;
    this._terrain.delete(chunkKey);
    this._tile.delete(chunkKey);
    this._dirty.add(chunkKey);
  }

  _bakeTerrain(chunkKey) {
    const [cx, cz] = chunkKey.split(',').map(Number);
    const minX = cx * CHUNK_SIZE;
    const minZ = cz * CHUNK_SIZE;
    const id = new ImageData(TILE_PX, TILE_PX);
    const data = id.data;
    const noise = this.world.noise;
    const isWaterAt = (x, z) => this.world.isWaterAt(x, z);

    // Per-pixel terrain: water → blue, low noise → sandy edges, mid →
    // light grass, high → dark forest grass. The same noise drives tree
    // density during chunk gen, so dark grass roughly correlates with
    // "more trees" — cheap visual continuity.
    for (let py = 0; py < TILE_PX; py++) {
      const wz = minZ + (py + 0.5) / PX_PER_M;
      const rowBase = py * TILE_PX * 4;
      for (let px = 0; px < TILE_PX; px++) {
        const wx = minX + (px + 0.5) / PX_PER_M;
        let r, g, b;
        if (isWaterAt(wx, wz)) {
          r = COL.water[0]; g = COL.water[1]; b = COL.water[2];
        } else {
          const n = noise(wx, wz);
          if (n < 0.32) { r = COL.sand[0]; g = COL.sand[1]; b = COL.sand[2]; }
          else if (n < 0.55) { r = COL.grassLight[0]; g = COL.grassLight[1]; b = COL.grassLight[2]; }
          else { r = COL.grassDark[0]; g = COL.grassDark[1]; b = COL.grassDark[2]; }
        }
        const i = rowBase + px * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }

    // Trees (dark green) and rocks (gray) as 3×3 px dots. Drawn directly
    // into the ImageData so we stay in one pass.
    const stamp = (lx, ly, c) => {
      for (let dy = -1; dy <= 1; dy++) {
        const y = ly + dy;
        if (y < 0 || y >= TILE_PX) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = lx + dx;
          if (x < 0 || x >= TILE_PX) continue;
          const i = (y * TILE_PX + x) * 4;
          data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
      }
    };
    const chunk = this.world.chunks.get(chunkKey);
    if (chunk && chunk.resourceSpawns) {
      for (const r of chunk.resourceSpawns) {
        const lx = Math.round((r.x - minX) * PX_PER_M);
        const ly = Math.round((r.z - minZ) * PX_PER_M);
        stamp(lx, ly, r.kind === 'tree' ? COL.tree : COL.rock);
      }
    }

    this._terrain.set(chunkKey, id);
  }

  _bakeOverlay(chunkKey) {
    let canvas = this._overlay.get(chunkKey);
    if (!canvas) {
      canvas = makeOffscreen(TILE_PX, TILE_PX);
      this._overlay.set(chunkKey, canvas);
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, TILE_PX, TILE_PX);
    const placed = this.world.placedStructures && this.world.placedStructures.get(chunkKey);
    if (placed && placed.length > 0) {
      const [cx, cz] = chunkKey.split(',').map(Number);
      const minX = cx * CHUNK_SIZE;
      const minZ = cz * CHUNK_SIZE;
      for (const s of placed) {
        const c = STRUCTURE_COL[s.kind];
        if (!c) continue;
        const lx = Math.round((s.x - minX) * PX_PER_M) - 1;
        const ly = Math.round((s.z - minZ) * PX_PER_M) - 1;
        ctx.fillStyle = c;
        ctx.fillRect(lx, ly, 3, 3);
      }
    }
  }

  _composeTile(chunkKey) {
    let tile = this._tile.get(chunkKey);
    if (!tile) {
      tile = makeOffscreen(TILE_PX, TILE_PX);
      this._tile.set(chunkKey, tile);
    }
    const ctx = tile.getContext('2d');
    const t = this._terrain.get(chunkKey);
    if (t) {
      ctx.putImageData(t, 0, 0);
    } else {
      ctx.fillStyle = COL.unvisited;
      ctx.fillRect(0, 0, TILE_PX, TILE_PX);
    }
    const o = this._overlay.get(chunkKey);
    if (o) ctx.drawImage(o, 0, 0);
    return tile;
  }

  render() {
    const W = this.display.width, H = this.display.height;
    const dctx = this.dctx;
    dctx.fillStyle = COL.unvisited;
    dctx.fillRect(0, 0, W, H);

    // Centre on the players' midpoint (or the surviving player if one is dead).
    const [p0, p1] = this.players;
    let cx = 0, cz = 0, n = 0;
    if (p0 && p0.alive) { cx += p0.pos.x; cz += p0.pos.z; n++; }
    if (p1 && p1.alive) { cx += p1.pos.x; cz += p1.pos.z; n++; }
    if (n === 0) return; // both dead — nothing useful to display
    cx /= n; cz /= n;

    const halfM = (W / 2) / PX_PER_M;
    const minWX = cx - halfM;
    const minWZ = cz - (H / 2) / PX_PER_M;

    // Mark every currently-loaded chunk as visited. The set is otherwise
    // additive — once visited, a chunk's terrain stays drawn even after
    // the chunk unloads from world.chunks (which is what the player wants
    // when wandering back to find an old camp).
    for (const key of this.world.chunks.keys()) this._visited.add(key);

    const cMinX = Math.floor((cx - halfM) / CHUNK_SIZE);
    const cMaxX = Math.floor((cx + halfM) / CHUNK_SIZE);
    const cMinZ = Math.floor((cz - (H / 2) / PX_PER_M) / CHUNK_SIZE);
    const cMaxZ = Math.floor((cz + (H / 2) / PX_PER_M) / CHUNK_SIZE);
    let bakeBudget = this._bakeBudget;

    for (let ccz = cMinZ; ccz <= cMaxZ; ccz++) {
      for (let ccx = cMinX; ccx <= cMaxX; ccx++) {
        const key = `${ccx},${ccz}`;
        if (!this._visited.has(key)) continue; // unexplored stays black

        // Bake terrain on first visit. Skipped (left for next frame) if
        // we're out of frame budget OR if the chunk happens to not be
        // loaded right now (extremely rare — if it's in `_visited` it
        // was loaded at some point, but a re-cycle could remove it
        // before we baked). We try again next frame.
        if (!this._terrain.has(key)) {
          if (bakeBudget <= 0) continue;
          if (!this.world.chunks.has(key)) continue;
          this._bakeTerrain(key);
          this._dirty.add(key); // force overlay paint on first compose
          bakeBudget--;
        }
        if (this._dirty.has(key)) {
          this._bakeOverlay(key);
          this._tile.delete(key); // force re-compose with new overlay
          this._dirty.delete(key);
        }

        const tile = this._composeTile(key);
        const dx = (ccx * CHUNK_SIZE - minWX) * PX_PER_M;
        const dy = (ccz * CHUNK_SIZE - minWZ) * PX_PER_M;
        dctx.drawImage(tile, Math.round(dx), Math.round(dy));
      }
    }

    // Player markers — stamp last so terrain & structures don't cover
    // them. White halo + coloured fill = legible against any backdrop.
    const drawPlayer = (p, color) => {
      if (!p || !p.alive) return;
      const dx = (p.pos.x - minWX) * PX_PER_M;
      const dy = (p.pos.z - minWZ) * PX_PER_M;
      dctx.fillStyle = '#fff';
      dctx.beginPath();
      dctx.arc(dx, dy, 3.5, 0, Math.PI * 2);
      dctx.fill();
      dctx.fillStyle = color;
      dctx.beginPath();
      dctx.arc(dx, dy, 2.2, 0, Math.PI * 2);
      dctx.fill();
    };
    drawPlayer(p0, PLAYER_COL[0]);
    drawPlayer(p1, PLAYER_COL[1]);
  }
}
