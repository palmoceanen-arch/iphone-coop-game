import * as THREE from 'three';
import { makeRng } from './utils.js';
import { spawnProp } from './models.js';
import { TOON_GRADIENT } from './shading.js';

// Day cycle anchors (dayTime units, 1.0 = 24h). Day window 06:00 → 21:00
// (15h) and night window 21:00 → 06:00 (9h); deepest night sits at ~01:30.
const SUNRISE = 6 / 24;
const SUNSET  = 21 / 24;

// Sun intensity anchors (matches THREE.DirectionalLight.intensity). The
// horizon value is the "golden hour" brightness; the floor is the deep-night
// minimum (kept non-zero so silhouettes remain visible at midnight).
const SUN_PEAK    = 1.6;
const SUN_HORIZON = 0.18;
const SUN_FLOOR   = 0.005;

// Smooth bell centred on `centre` (in dayTime units), 1 at the peak and 0
// outside ±halfWidth, with a cosine taper. dayTime wraps mod 1 so the bell
// works near the 0/1 boundary too. Used to drive the sunset/sunrise tint
// without the kink the previous triangular max(0, 1 - |...|) had at its apex.
function sunsetBell(dayTime, centre, halfWidth = 1 / 6) {
  let d = dayTime - centre;
  d -= Math.round(d);
  if (Math.abs(d) >= halfWidth) return 0;
  const c = Math.cos((d / halfWidth) * Math.PI * 0.5);
  return c * c;
}

// Chunk-based deterministic world.
//
// Generation pipeline (per chunk, fully seeded):
//   1. Value noise sampled at chunk grid points → biome / density map
//   2. Water ponds placed in low-noise dips
//   3. Trees on land cells (Poisson-ish, density modulated by noise)
//   4. Rocks (large + medium gray rocks on rocky cells; small rocks scattered)
//   5. Bushes / clutter
//   6. Enemy camp picks (deterministic per chunk; fraction of chunks are camps)
//
// There is no fixed map boundary — chunks are streamed in around the players.
// Far chunks are kept in memory but their group is hidden and their entities
// are frozen until the players come back near.

export const CHUNK_SIZE = 32;
export const ACTIVE_RADIUS = 3;     // chunks generated/visible around each player (7×7)
export const SIM_RADIUS    = 2;     // chunks within which enemies actively simulate (5×5)
// Beyond ACTIVE_RADIUS we keep an extra ring of chunks loaded so the
// player can wobble across a chunk border without immediately re-paying
// the generation cost. Anything outside KEEP_RADIUS is unloaded — its
// THREE.Group is removed from the scene, owned BufferGeometries are
// disposed and the chunk record is dropped from the Map. Re-entering an
// unloaded chunk regenerates it deterministically from the world seed
// (chunkSeed(worldSeed, cx, cz)) so geometry / props / enemy camps
// reproduce identically.
export const KEEP_RADIUS = ACTIVE_RADIUS + 2;
// Cap on synchronous chunk generations per `ensureChunksAround` call.
// The first call (constructor) loads the immediate ring around the
// origin so the player doesn't spawn into the void; everything else is
// queued and amortised across subsequent frames in `processChunkQueue`.
const SYNC_LOAD_RADIUS = 1;
// How many queued chunks to materialise per `processChunkQueue` call.
// Each chunk gen runs the marching-squares water mesh + dozens of
// model clones, costing roughly 1-3ms on a low-end laptop, so 1 per
// frame keeps the worst case under ~3ms while still draining the queue
// fast enough that the visible 7×7 ring fills in within ~1s of walking
// into a fresh region.
const CHUNKS_PER_FRAME = 1;

// Lake mesh resolution. Per chunk we sample noise on a (WATER_GRID+1)×
// (WATER_GRID+1) grid of corners, then build a marching-squares mesh:
// where the noise crosses WATER_THRESHOLD on a cell edge we interpolate the
// crossing point, giving smooth curved shorelines instead of axis-aligned
// blocks. WATER_NOISE_FREQ scales the noise input so lakes form large
// connected basins rather than tiny specks.
export const WATER_GRID = 16;
export const WATER_CELL = CHUNK_SIZE / WATER_GRID;
export const WATER_THRESHOLD = 0.30;
export const WATER_NOISE_FREQ = 0.45;

// 32-bit integer hash mixing world seed with (cx, cz).
function chunkSeed(worldSeed, cx, cz) {
  let h = (worldSeed | 0) >>> 0;
  h ^= Math.imul((cx | 0) + 0x9e3779b1, 0x85ebca6b);
  h ^= Math.imul((cz | 0) + 0x27d4eb2d, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// 2D value noise — deterministic, derived from world seed.
function makeNoise(worldSeed) {
  function hash(ix, iz) {
    let h = worldSeed | 0;
    h ^= Math.imul((ix | 0), 0x27d4eb2d);
    h ^= Math.imul((iz | 0), 0x9e3779b1);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return ((h >>> 0) / 4294967296);
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise2(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const a = hash(ix, iz);
    const b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1);
    const d = hash(ix + 1, iz + 1);
    const ux = smooth(fx), uz = smooth(fz);
    return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
  }
  return function fbm(x, z) {
    let n = 0, amp = 0.55, freq = 0.04;
    for (let o = 0; o < 3; o++) {
      n += noise2(x * freq, z * freq) * amp;
      freq *= 2.1; amp *= 0.5;
    }
    return Math.min(1, Math.max(0, n));
  };
}

const TREE_KINDS = ['tree_pine_a', 'tree_pine_b', 'tree_pine_c', 'tree_default', 'tree_oak'];
const ROCK_LARGE_KINDS = ['rock_largeA', 'rock_largeB', 'rock_largeC'];
const ROCK_SMALL_KINDS = ['rock_smallA', 'rock_smallB'];
const BUSH_KINDS = ['bush', 'bush_large'];

const ENEMY_CAMP_TEMPLATES = [
  { kinds: ['slime', 'slime', 'slime'], levelBoost: 0 },
  { kinds: ['slime', 'slime'], levelBoost: 0 },
  { kinds: ['archer', 'slime', 'slime'], levelBoost: 0 },
  { kinds: ['archer', 'archer'], levelBoost: 0 },
  { kinds: ['bomber', 'slime'], levelBoost: 0 },
  { kinds: ['wisp', 'wisp'], levelBoost: 0 },
  { kinds: ['ogre'], levelBoost: 1 },
  { kinds: ['ogre', 'slime'], levelBoost: 1 },
];

export class World {
  constructor(scene, seed = 1) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.noise = makeNoise(this.seed);
    this.chunks = new Map();          // key="cx,cz" → { group, colliders, enemySpawns, _ownedGeos }
    this.activeKeys = new Set();      // chunk keys currently visible / receiving collision queries
    this.simKeys = new Set();         // chunk keys whose enemies actively simulate
    this.colliders = [];              // aggregated from active chunks only
    this.enemySpawns = [];            // queue read by Game on first frame after a chunk loads
    this.chestSpawns = [];            // same idea but for procedural chests
    this.breakableSpawns = [];        // ditto for clay pots / wooden crates
    this.altarSpawns = [];            // ditto for altars (rare item-management nodes)
    this.resourceSpawns = [];         // ditto for harvestable trees / rocks
    this.structureSpawns = [];        // ditto for player-placed structures
    // Persistent map of player-placed structures, keyed by chunkKey. Each
    // entry is an array of plain descriptors `{ x, z, kind, yaw, hp }` that
    // survive chunk unload — when the chunk reloads, we re-emit them as
    // structureSpawns so they get re-instantiated. This is what makes a
    // built fortress "stick" when the player wanders away. Designed to be
    // serialised wholesale by a future save-system (the descriptor shape
    // is intentionally JSON-clean).
    this.placedStructures = new Map();
    // ---- Chunk streaming (async load + safe unload) -------------------
    // Async load queue. ensureChunksAround() pushes "needed but not yet
    // generated" chunks here; processChunkQueue() drains a small budget
    // per RAF tick to amortise the generation cost so a single frame
    // never has to pay for the full 7×7 ring at once.
    this._pendingLoads = [];
    this._pendingSet = new Set();
    // Persistent per-chunk consumption registry. When a player opens a
    // chest / smashes a pot / depletes an altar the *position* of that
    // spawn is recorded here, keyed by chunkKey. If the same chunk is
    // unloaded and later regenerated (player wandering far and coming
    // back), `_generateChunk` consults these sets and skips the
    // already-consumed spawns. Enemies are intentionally NOT tracked
    // here — they respawn fresh on chunk reload so re-entering an old
    // region feels populated again. The save/load feature can persist
    // these three sets to disk and the rest of the world rebuilds from
    // the seed.
    this._consumedChests = new Set();
    this._consumedBreakables = new Set();
    this._consumedAltars = new Set();
    // Callback invoked when a chunk is unloaded; Game wires this up to
    // despawn entities tied to that chunk (enemies, chests, etc.) so
    // their THREE meshes are released alongside the chunk's group.
    this._onChunkUnload = null;
    this._lastGroundCx = null;
    this._lastGroundCz = null;
    // Pre-allocated colour temporaries for the per-frame sky tint blend.
    // Reusing them avoids spawning ~5 THREE.Color objects every frame for
    // the entire session (60fps × 5 colours × 600s ≈ 1.8M throwaway
    // allocations over a 10-min match).
    this._dayCol = new THREE.Color(0x6cb6ff);
    this._nightCol = new THREE.Color(0x070b15);
    this._sunsetCol = new THREE.Color(0xff9a55);
    this._tmpSkyCol = new THREE.Color();
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildCampfire();
    this.ensureChunksAround(0, 0);
    this.dayTime = 0.25;
    this.dayLength = 480;
    this.update(0);
  }

  _buildSky() {
    const sky = new THREE.Color(0x6cb6ff);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 60, 180);
  }

  _buildLights() {
    // Keep ambient low so the toon ramp on the directional sun can produce
    // crisp 3-band cel-shading. AmbientLight bypasses gradientMap; high values
    // wash out the bands.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff4d8, 1.4);
    this.sun.position.set(30, 50, 20);
    this.sun.castShadow = true;
    // 8192² over the ~224 m active area = ~0.027 m / texel. Combined with the
    // texel-snap logic below this gives crisp tree-shadow edges at typical
    // camera distances. ~64 MB GPU shadow texture — fine for desktop and iOS
    // (4096² is the spec minimum, 8192² is supported by every WebGL2 device
    // in practice).
    this.sun.shadow.mapSize.set(8192, 8192);
    // Shadow camera covers the active 7×7 chunk area (~224m). The light + its
    // shadow camera follow the centroid of the players each frame so shadows
    // are always sharp around the action.
    const d = (ACTIVE_RADIUS + 0.5) * CHUNK_SIZE;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 250;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    // Hard-ish shadows: a 1-texel PCF radius gives a crisp edge that still
    // anti-aliases (no jagged staircase), and stays stable frame-to-frame
    // (PCFShadowMap kernel, see game.js).
    this.sun.shadow.radius = 1;
    this.sun.target = new THREE.Object3D();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.moonHelper = new THREE.HemisphereLight(0x7aa6ff, 0x202830, 0.0);
    this.scene.add(this.moonHelper);
  }

  // Ground = a single large flat plane (toon-shaded grass) that follows the
  // centroid of the players. Snapped to a multiple of CHUNK_SIZE so its
  // texture does not visibly slide. With a flat colour and no displacement
  // there are no self-shadowing artifacts.
  _buildGround() {
    const size = (ACTIVE_RADIUS * 2 + 4) * CHUNK_SIZE; // ~320m
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshToonMaterial({
      color: 0x6db050,
      gradientMap: TOON_GRADIENT,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  _buildCampfire() {
    const stoneMat = new THREE.MeshToonMaterial({ color: 0x6e6862, gradientMap: TOON_GRADIENT });
    const ring = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3), stoneMat);
      s.position.set(Math.cos(a) * 0.9, 0.18, Math.sin(a) * 0.9);
      s.castShadow = true;
      ring.add(s);
    }
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8), new THREE.MeshToonMaterial({ color: 0x4d2f17, gradientMap: TOON_GRADIENT }));
    log.position.y = 0.3; log.rotation.z = Math.PI / 2;
    ring.add(log);
    const log2 = log.clone(); log2.rotation.z = Math.PI / 2; log2.rotation.y = Math.PI / 3;
    ring.add(log2);
    this.fire = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.0, 12), new THREE.MeshBasicMaterial({ color: 0xff8a30, transparent: true, opacity: 0.9 }));
    this.fire.position.y = 0.9;
    ring.add(this.fire);
    this.fireLight = new THREE.PointLight(0xff8a30, 1.5, 14, 1.6);
    this.fireLight.position.y = 1.1;
    ring.add(this.fireLight);
    ring.position.set(0, 0, 6);
    this.scene.add(ring);
    this.campfire = ring;
  }

  // Ensure every chunk within ACTIVE_RADIUS of (worldX, worldZ) is at
  // least *queued* for generation. The immediate ring around the
  // requested position (Chebyshev distance ≤ SYNC_LOAD_RADIUS) is
  // generated synchronously so the caller can stand on it without
  // falling through; everything further out is enqueued and drained by
  // `processChunkQueue` over subsequent frames. Already-loaded chunks
  // are skipped, already-queued chunks are not duplicated.
  ensureChunksAround(worldX, worldZ) {
    const cx0 = Math.floor(worldX / CHUNK_SIZE);
    const cz0 = Math.floor(worldZ / CHUNK_SIZE);
    for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
      for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        const key = `${cx},${cz}`;
        if (this.chunks.has(key)) continue;
        const cheb = Math.max(Math.abs(dx), Math.abs(dz));
        if (cheb <= SYNC_LOAD_RADIUS) {
          this._loadChunkSync(cx, cz);
        } else {
          this._enqueueChunk(cx, cz, cheb);
        }
      }
    }
  }

  // Append (cx,cz) to the async load queue (sorted nearest-first so
  // visible-but-not-yet-loaded chunks fill in toward the player). Cheap
  // O(n) insertion — the queue is bounded by the number of pending
  // chunks (≤ 49 per active player), so the linear scan is fine and
  // avoids pulling in a heap dep.
  _enqueueChunk(cx, cz, priority) {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key) || this._pendingSet.has(key)) return;
    this._pendingSet.add(key);
    const entry = { cx, cz, key, priority };
    let i = 0;
    while (i < this._pendingLoads.length && this._pendingLoads[i].priority <= priority) i++;
    this._pendingLoads.splice(i, 0, entry);
  }

  // Synchronously materialise the chunk, push its spawn descriptors
  // onto the world-level queues and add the group to the scene.
  _loadChunkSync(cx, cz) {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;
    this._pendingSet.delete(key);
    const chunk = this._generateChunk(cx, cz);
    this.chunks.set(key, chunk);
    this.scene.add(chunk.group);
    if (chunk.enemySpawns) for (const e of chunk.enemySpawns) this.enemySpawns.push(e);
    if (chunk.chestSpawns) for (const c of chunk.chestSpawns) this.chestSpawns.push(c);
    if (chunk.breakableSpawns) for (const b of chunk.breakableSpawns) this.breakableSpawns.push(b);
    if (chunk.altarSpawns) for (const a of chunk.altarSpawns) this.altarSpawns.push(a);
    if (chunk.resourceSpawns) for (const r of chunk.resourceSpawns) this.resourceSpawns.push(r);
    // Re-emit any persisted player-placed structures for this chunk so the
    // game-side drainer can re-instantiate them on top of the regenerated
    // chunk geometry. Non-empty only after the player has built things in
    // this region during the current session.
    const persisted = this.placedStructures.get(key);
    if (persisted && persisted.length > 0) {
      for (const s of persisted) {
        this.structureSpawns.push({
          x: s.x, z: s.z, kind: s.kind, yaw: s.yaw, hp: s.hp,
          // Forward the saved farming snapshot (planter only). The drainer
          // hands this to Crop.loadFromDescriptor() so a re-streamed chunk
          // resumes a half-grown crop at exactly the stage / progress it
          // left off — including post-harvest "harvested" state that
          // hasn't yet been reset.
          farm: s.farm || null,
          chunkKey: key,
          group: chunk.group,
          colliderArray: chunk.colliders,
        });
      }
    }
  }

  // Drain up to `budget` queued chunks. Called once per game tick;
  // `CHUNKS_PER_FRAME` keeps per-frame cost bounded so async streaming
  // doesn't itself become a freeze source.
  processChunkQueue(budget = CHUNKS_PER_FRAME) {
    let loaded = 0;
    while (loaded < budget && this._pendingLoads.length > 0) {
      const next = this._pendingLoads.shift();
      this._pendingSet.delete(next.key);
      // Skip stale queue entries: a chunk may have been re-queued
      // after the player walked away from it; if it's already loaded
      // (another path), we just continue to the next pending entry
      // without consuming budget.
      if (this.chunks.has(next.key)) continue;
      this._loadChunkSync(next.cx, next.cz);
      loaded += 1;
    }
    return loaded;
  }

  // Remove a chunk from the world and dispose its owned GPU resources.
  // Shared geometries / materials (cloned via `spawnProp` from the
  // models cache) are NOT touched — only the per-chunk water mesh
  // BufferGeometry, which is the one resource we allocate fresh per
  // chunk. The chunk's THREE.Group is removed from the scene; its
  // child Object3D nodes are eligible for GC once the group reference
  // drops with `this.chunks.delete(key)`.
  _disposeChunk(chunk) {
    if (!chunk) return;
    if (chunk.group) this.scene.remove(chunk.group);
    if (chunk._ownedGeos) {
      for (const g of chunk._ownedGeos) {
        if (g && typeof g.dispose === 'function') g.dispose();
      }
      chunk._ownedGeos.length = 0;
    }
  }

  // Walk every loaded chunk and unload anything outside KEEP_RADIUS of
  // every player. Called from refreshActiveChunks() once per tick. The
  // unload callback fires before the chunk record is dropped so Game
  // can despawn the chunk's entities in lockstep.
  _unloadFarChunks(playerCells) {
    if (this.chunks.size === 0) return;
    const toUnload = [];
    for (const [key, chunk] of this.chunks) {
      const cx = chunk.cx;
      const cz = chunk.cz;
      let minCheb = Infinity;
      for (const cell of playerCells) {
        const cheb = Math.max(Math.abs(cx - cell.cx), Math.abs(cz - cell.cz));
        if (cheb < minCheb) minCheb = cheb;
      }
      if (minCheb > KEEP_RADIUS) toUnload.push(key);
    }
    for (const key of toUnload) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      if (typeof this._onChunkUnload === 'function') {
        try { this._onChunkUnload(key); } catch { /* ignore listener errors */ }
      }
      this._disposeChunk(chunk);
      this.chunks.delete(key);
    }
  }

  // Stable string key for a per-chunk spawn position. The world rounds
  // (x, z) to one decimal so floating-point noise from the chunk RNG
  // can't accidentally produce two different keys for what is logically
  // the same spawn (the noise is deterministic but the rounded display
  // is what we serialize for save/load).
  spawnKey(chunkKey, x, z) {
    return `${chunkKey}@${x.toFixed(1)},${z.toFixed(1)}`;
  }

  markChestConsumed(chunkKey, x, z) {
    this._consumedChests.add(this.spawnKey(chunkKey, x, z));
  }
  markBreakableConsumed(chunkKey, x, z) {
    this._consumedBreakables.add(this.spawnKey(chunkKey, x, z));
  }
  markAltarConsumed(chunkKey, x, z) {
    this._consumedAltars.add(this.spawnKey(chunkKey, x, z));
  }

  // Player just placed a structure at (x,z) with the given kind / yaw / hp.
  // Records it in `placedStructures[chunkKey]` so chunk reload can rehydrate
  // the structure, and (if the chunk is currently loaded) also queues a
  // `structureSpawn` so Game._drainStructureSpawns can mount it this frame.
  // Returns the descriptor object for caller convenience.
  placeStructure(x, z, kind, yaw = 0, hp = null) {
    const chunkKey = this.chunkKeyOf(x, z);
    const desc = { x, z, kind, yaw, hp };
    let arr = this.placedStructures.get(chunkKey);
    if (!arr) { arr = []; this.placedStructures.set(chunkKey, arr); }
    arr.push(desc);
    const chunk = this.chunks.get(chunkKey);
    if (chunk) {
      this.structureSpawns.push({
        x, z, kind, yaw, hp,
        chunkKey,
        group: chunk.group,
        colliderArray: chunk.colliders,
      });
    }
    return desc;
  }

  // Drop a destroyed structure from `placedStructures`, matched by approx
  // position so we don't leak descriptors after a wall is broken. Uses the
  // same 0.1m rounding as the consumed-set helpers so floating-point drift
  // doesn't prevent the match.
  forgetStructure(chunkKey, x, z) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    for (let i = arr.length - 1; i >= 0; i--) {
      const d = arr[i];
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        arr.splice(i, 1);
        break;
      }
    }
    if (arr.length === 0) this.placedStructures.delete(chunkKey);
  }

  // Update the persisted HP value for an in-place structure so a reload
  // later in the session continues from mid-damage rather than full health.
  // Caller passes the current chunkKey + position; we tolerate small float
  // drift the same way as `forgetStructure`.
  updateStructureHP(chunkKey, x, z, hp) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    for (const d of arr) {
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        d.hp = hp;
        return;
      }
    }
  }

  // Persist the M3 farming snapshot on a planter's descriptor so a chunk
  // reload mid-grow (player walked away and back) preserves the in-progress
  // crop. `farm` is the JSON-clean object produced by Crop.toDescriptor()
  // — null wipes the slot. Lookup uses the same eps tolerance as
  // forgetStructure so float drift in (x,z) doesn't drop the match.
  updateStructureFarm(chunkKey, x, z, farm) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    for (const d of arr) {
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        if (farm) d.farm = farm;
        else delete d.farm;
        return;
      }
    }
  }

  // Persist a gate's open/closed state on its descriptor so a chunk
  // reload after the player walked away leaves it open or closed exactly
  // as they last toggled it. Uses the same eps lookup as the other
  // descriptor updaters above.
  updateStructureOpen(chunkKey, x, z, isOpen) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    for (const d of arr) {
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        if (isOpen) d.open = true;
        else delete d.open;
        return;
      }
    }
  }

  // Recompute which chunks are active (visible) and which actively simulate
  // their enemies, based on the centroid of all alive players. Cheap: just
  // walks the existing chunks Map and toggles group.visible. Also unloads
  // any chunk that has wandered outside KEEP_RADIUS of every player so
  // the chunks Map doesn't grow without bound.
  refreshActiveChunks(playerPositions) {
    if (!playerPositions || playerPositions.length === 0) return;
    // Union of active rectangles around each player.
    const wantActive = new Set();
    const wantSim = new Set();
    const playerCells = [];
    let cxSum = 0, czSum = 0, n = 0;
    for (const p of playerPositions) {
      const pcx = Math.floor(p.x / CHUNK_SIZE);
      const pcz = Math.floor(p.z / CHUNK_SIZE);
      playerCells.push({ cx: pcx, cz: pcz });
      cxSum += p.x; czSum += p.z; n++;
      for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
        for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
          wantActive.add(`${pcx + dx},${pcz + dz}`);
        }
      }
      for (let dz = -SIM_RADIUS; dz <= SIM_RADIUS; dz++) {
        for (let dx = -SIM_RADIUS; dx <= SIM_RADIUS; dx++) {
          wantSim.add(`${pcx + dx},${pcz + dz}`);
        }
      }
    }
    this.activeKeys = wantActive;
    this.simKeys = wantSim;
    // Drop chunks the players have left far behind. Done before the
    // visibility flip / collider rebuild so we don't waste a tick
    // touching about-to-be-deleted records.
    this._unloadFarChunks(playerCells);
    // Toggle visibility of every loaded chunk (cheap: bool flip).
    for (const [key, chunk] of this.chunks) {
      const vis = wantActive.has(key);
      if (chunk.group.visible !== vis) chunk.group.visible = vis;
    }
    // Rebuild aggregated colliders only from active chunks. This keeps the
    // per-frame collision loop bounded regardless of how many chunks exist.
    this.colliders.length = 0;
    for (const key of wantActive) {
      const c = this.chunks.get(key);
      if (!c) continue;
      for (const col of c.colliders) this.colliders.push(col);
    }
    // Move ground + sun shadow camera with the centroid (snapped to chunk
    // grid so vertex texture seams don't slide).
    if (n > 0) {
      const cxAvg = cxSum / n;
      const czAvg = czSum / n;
      const sx = Math.round(cxAvg / CHUNK_SIZE) * CHUNK_SIZE;
      const sz = Math.round(czAvg / CHUNK_SIZE) * CHUNK_SIZE;
      if (sx !== this._lastGroundCx || sz !== this._lastGroundCz) {
        this.ground.position.set(sx, 0, sz);
        this._lastGroundCx = sx;
        this._lastGroundCz = sz;
      }
      // Cache centroid; sun.target/position are written (snapped to shadow
      // texel grid) every frame in update() to keep shadows stable.
      this._sunCentroidX = cxAvg;
      this._sunCentroidZ = czAvg;
    }
  }

  isChunkActive(cx, cz) { return this.activeKeys.has(`${cx},${cz}`); }
  isChunkSimulating(cx, cz) { return this.simKeys.has(`${cx},${cz}`); }
  chunkKeyOf(x, z) {
    return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
  }

  _generateChunk(cx, cz) {
    const r = makeRng(chunkSeed(this.seed, cx, cz));
    const chunkKey = `${cx},${cz}`;
    const minX = cx * CHUNK_SIZE;
    const minZ = cz * CHUNK_SIZE;
    const group = new THREE.Group();
    group.name = `chunk_${cx}_${cz}`;
    const colliders = [];
    const enemySpawns = [];
    const chestSpawns = [];
    const breakableSpawns = [];
    const altarSpawns = [];
    // Harvestable resource nodes (trees, rocks). Pushed alongside the visual
    // mesh — the entity created by Game._drainResourceSpawns wraps the mesh
    // for damage but doesn't reparent it, so the chunk group still owns the
    // mesh's lifecycle. Only the *large* trees / rocks are harvestable; tiny
    // ground-clutter rocks and bushes stay non-interactive.
    const resourceSpawns = [];
    // BufferGeometries we own (fresh-allocated for this chunk and not
    // returned to a shared cache). Currently just the marching-squares
    // water mesh, but the array is generic so future per-chunk meshes
    // can hook in. `_disposeChunk` walks this list on unload.
    const ownedGeos = [];

    const isOrigin = (cx === 0 && cz === 0);
    const clearingR = isOrigin ? 9 : 0;
    const localCenter = (x, z) => Math.hypot(x, z);

    const sampleN = (x, z) => this.noise(x, z);

    // 2. Water — marching-squares lake mesh. Sample noise at corners of a
    // (WATER_GRID+1)² grid covering this chunk; build a smooth curved
    // shoreline by interpolating where the noise crosses WATER_THRESHOLD on
    // each cell edge. The origin chunk stays water-free so the campfire /
    // starting area is always usable on land.
    const waterMesh = isOrigin ? null : this._buildSmoothWaterMesh(minX, minZ);
    if (waterMesh) {
      group.add(waterMesh);
      // The water BufferGeometry is uniquely allocated for this chunk
      // (the material is shared in `this._waterMaterial`), so register
      // it for disposal when the chunk unloads.
      if (waterMesh.geometry) ownedGeos.push(waterMesh.geometry);
    }
    const isOnWater = (x, z) => {
      if (isOrigin && Math.hypot(x, z) < 12) return false; // protect spawn
      return this.isWaterAt(x, z);
    };

    // 3. Trees — density modulated by noise; never on water cells.
    // Trees are harvestable: in addition to the visual placement we push a
    // resourceSpawn descriptor with the mesh reference so Game can wrap it
    // in a Resource entity hooked into the damageables pipeline.
    const treeAttempts = 14;
    for (let i = 0; i < treeAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
      if (isOnWater(x, z)) continue;
      const n = sampleN(x, z);
      if (r.next() > n * 1.1) continue;
      if (!this._spotClear(x, z, 1.4, colliders)) continue;
      const id = TREE_KINDS[r.int(0, TREE_KINDS.length - 1)];
      const scale = r.range(2.4, 3.6);
      const yaw = r.range(0, Math.PI * 2);
      const mesh = spawnProp(id, { scale, rotationY: yaw });
      mesh.position.set(x, 0, z);
      group.add(mesh);
      const collider = { x, z, r: 1.0 };
      colliders.push(collider);
      resourceSpawns.push({ x, z, kind: 'tree', mesh, chunkKey, collider, colliderArray: colliders, group });
    }

    // 4a. Cliff clusters — on rocky outcrops (high noise), drop a tight
    // group of oversized gray rocks that read as a cliff/boulder pile.
    if (!isOrigin) {
      const cliffAttempts = 3;
      for (let i = 0; i < cliffAttempts; i++) {
        const x = minX + r.range(4, CHUNK_SIZE - 4);
        const z = minZ + r.range(4, CHUNK_SIZE - 4);
        if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
        if (isOnWater(x, z)) continue;
        const n = sampleN(x, z);
        if (n < 0.62) continue; // only on rocky terrain
        if (!this._spotClear(x, z, 3.0, colliders)) continue;
        this._placeCliffCluster(group, colliders, r, x, z, isOnWater);
      }
    }

    // 4b. Scattered rocks — large/medium gray rocks on rocky cells, small
    // rocks elsewhere as ground clutter. Only the *big* rocks become
    // harvestable resource nodes; the small ground-clutter rocks stay
    // decorative (otherwise the world would be carpeted in tiny pickable
    // nodes that aren't worth a swing).
    const rockAttempts = 10;
    for (let i = 0; i < rockAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
      if (isOnWater(x, z)) continue;
      const n = sampleN(x, z);
      const isRocky = n > 0.55;
      if (!isRocky && !r.chance(0.35)) continue;
      if (!this._spotClear(x, z, 1.0, colliders)) continue;
      const big = isRocky ? r.chance(0.7) : r.chance(0.25);
      const id = (big ? ROCK_LARGE_KINDS : ROCK_SMALL_KINDS)[r.int(0, (big ? ROCK_LARGE_KINDS : ROCK_SMALL_KINDS).length - 1)];
      const scale = big ? r.range(1.6, 2.4) : r.range(0.8, 1.3);
      const yaw = r.range(0, Math.PI * 2);
      const mesh = spawnProp(id, { scale, rotationY: yaw });
      mesh.position.set(x, 0, z);
      group.add(mesh);
      if (big) {
        const collider = { x, z, r: 0.9 };
        colliders.push(collider);
        resourceSpawns.push({ x, z, kind: 'rock', mesh, chunkKey, collider, colliderArray: colliders, group });
      }
    }

    // 5. Bushes / clutter (skip water).
    const bushAttempts = 6;
    for (let i = 0; i < bushAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
      if (isOnWater(x, z)) continue;
      if (!r.chance(0.5)) continue;
      if (!this._spotClear(x, z, 0.8, colliders)) continue;
      const id = BUSH_KINDS[r.int(0, BUSH_KINDS.length - 1)];
      const scale = r.range(1.1, 1.8);
      const yaw = r.range(0, Math.PI * 2);
      const mesh = spawnProp(id, { scale, rotationY: yaw });
      mesh.position.set(x, 0, z);
      group.add(mesh);
    }

    // 6. Enemy camps — origin chunk excluded. Camp probability grows with
    // distance from origin so the world stays interesting as players explore.
    // Camp centers (`campCenters`) are remembered so chests and breakables
    // below can cluster around them as "points of interest" for the player.
    const campCenters = [];
    if (!isOrigin) {
      const dist = Math.hypot(cx, cz);
      const pCamp = Math.min(0.65, 0.18 + dist * 0.08);
      if (r.chance(pCamp)) {
        let cxw = 0, czw = 0, ok = false;
        for (let i = 0; i < 12; i++) {
          const x = minX + r.range(4, CHUNK_SIZE - 4);
          const z = minZ + r.range(4, CHUNK_SIZE - 4);
          if (isOnWater(x, z)) continue;
          if (this._spotClear(x, z, 2.2, colliders)) { cxw = x; czw = z; ok = true; break; }
        }
        if (ok) {
          const tpl = ENEMY_CAMP_TEMPLATES[r.int(0, ENEMY_CAMP_TEMPLATES.length - 1)];
          const lvl = 1 + tpl.levelBoost + Math.floor(Math.hypot(cxw, czw) / 30);
          for (const k of tpl.kinds) {
            const ox = r.range(-2.5, 2.5);
            const oz = r.range(-2.5, 2.5);
            const ex = cxw + ox, ez = czw + oz;
            if (isOnWater(ex, ez)) continue;
            if (!this._spotClear(ex, ez, 0.8, colliders)) continue;
            enemySpawns.push({
              kind: k,
              x: ex, z: ez,
              level: lvl,
              homeX: cxw, homeZ: czw,
              chunkKey: `${cx},${cz}`,
              elite: r.chance(0.15),
            });
          }
          campCenters.push({ x: cxw, z: czw });
        }
      }
    }

    // Helper: try a few seeded jitter offsets around (cx0, cz0) until we find
    // a clear spot, push it into `out` if successful. Returns true on a
    // successful placement.
    const tryClusterPlace = (out, kind, cx0, cz0, range, radius, attempts) => {
      for (let i = 0; i < attempts; i++) {
        const x = cx0 + r.range(-range, range);
        const z = cz0 + r.range(-range, range);
        if (x < minX + 1 || x > minX + CHUNK_SIZE - 1) continue;
        if (z < minZ + 1 || z > minZ + CHUNK_SIZE - 1) continue;
        if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
        if (isOnWater(x, z)) continue;
        if (!this._spotClear(x, z, radius, colliders)) continue;
        // Skip spawn if the player previously consumed this point
        // (chest opened, pot smashed). The chunk's RNG still advances
        // identically — we just don't push the descriptor — so all
        // later random rolls in this chunk stay deterministic.
        const sk = this.spawnKey(chunkKey, x, z);
        if (kind === 'chest') {
          if (this._consumedChests.has(sk)) return true;
          out.push({ x, z, chunkKey });
        } else {
          if (this._consumedBreakables.has(sk)) return true;
          out.push({ x, z, kind, chunkKey });
        }
        return true;
      }
      return false;
    };

    // 7. Chests — tend to spawn next to enemy camps so the player gets a
    // visible "points of interest" cluster. A small fraction of chunks with
    // no camp also have a stray chest, so empty regions still hide rewards.
    if (!isOrigin) {
      let placed = false;
      for (const cc of campCenters) {
        if (!r.chance(0.55)) continue;
        if (tryClusterPlace(chestSpawns, 'chest', cc.x, cc.z, 5.5, 1.0, 12)) {
          placed = true;
        }
      }
      if (!placed && r.chance(0.06)) {
        for (let i = 0; i < 12; i++) {
          const x = minX + r.range(4, CHUNK_SIZE - 4);
          const z = minZ + r.range(4, CHUNK_SIZE - 4);
          if (isOnWater(x, z)) continue;
          if (!this._spotClear(x, z, 1.0, colliders)) continue;
          if (!this._consumedChests.has(this.spawnKey(chunkKey, x, z))) {
            chestSpawns.push({ x, z, chunkKey });
          }
          break;
        }
      }
    }

    // 8. Breakable props — clay pots and wooden crates. Strongly biased to
    // sit around enemy camps (dense little clusters of 3-5 pots + 1-2 crates
    // per camp), with a smaller scatter elsewhere so the world isn't empty
    // between camps. Origin chunk stays uncluttered.
    if (!isOrigin) {
      // Cluster around each enemy camp.
      for (const cc of campCenters) {
        const potCount = 2 + r.int(0, 2); // 2..4 pots per camp
        for (let i = 0; i < potCount; i++) {
          tryClusterPlace(breakableSpawns, 'pot', cc.x, cc.z, 3.5, 0.7, 6);
        }
        const crateCount = r.chance(0.7) ? 1 + r.int(0, 1) : 0; // 0..2 crates
        for (let i = 0; i < crateCount; i++) {
          tryClusterPlace(breakableSpawns, 'crate', cc.x, cc.z, 4.0, 0.85, 6);
        }
      }
      // Free-floating scatter: lower frequency so map isn't empty between
      // camps but camps remain the visual focal point.
      const freePotAttempts = 2;
      for (let i = 0; i < freePotAttempts; i++) {
        if (!r.chance(0.30)) continue;
        const x = minX + r.range(2, CHUNK_SIZE - 2);
        const z = minZ + r.range(2, CHUNK_SIZE - 2);
        if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
        if (isOnWater(x, z)) continue;
        if (!this._spotClear(x, z, 0.7, colliders)) continue;
        if (this._consumedBreakables.has(this.spawnKey(chunkKey, x, z))) continue;
        breakableSpawns.push({ x, z, kind: 'pot', chunkKey });
      }
      const freeCrateAttempts = 1;
      for (let i = 0; i < freeCrateAttempts; i++) {
        if (!r.chance(0.20)) continue;
        const x = minX + r.range(2, CHUNK_SIZE - 2);
        const z = minZ + r.range(2, CHUNK_SIZE - 2);
        if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
        if (isOnWater(x, z)) continue;
        if (!this._spotClear(x, z, 0.85, colliders)) continue;
        if (this._consumedBreakables.has(this.spawnKey(chunkKey, x, z))) continue;
        breakableSpawns.push({ x, z, kind: 'crate', chunkKey });
      }
    }

    // 9. Altar of the Ancients — fully deterministic per-chunk roll. We
    // hash (worldSeed, cx, cz) with a salt so altar locations are stable
    // for a given seed (same seed → same altars) and independent from
    // the value-noise field (which is too smooth at chunk scale to give
    // a reliable spawn distribution near the origin). 10% of non-origin
    // chunks roll an altar candidate (≈ 1 per 10 chunks ≈ 4-5 visible
    // across a 7×7 area) so they read as a rare landmark, not a
    // ubiquitous one. The inner loop then makes sure the exact spot is
    // clear of water / colliders / chest clusters.
    if (!isOrigin) {
      const altarRoll = chunkSeed(this.seed ^ 0xA17A8B, cx, cz) % 100;
      if (altarRoll < 10) {
        for (let i = 0; i < 24; i++) {
          const x = minX + r.range(4, CHUNK_SIZE - 4);
          const z = minZ + r.range(4, CHUNK_SIZE - 4);
          if (isOnWater(x, z)) continue;
          if (!this._spotClear(x, z, 1.6, colliders)) continue;
          let nearChest = false;
          for (const c of chestSpawns) {
            if (Math.hypot(c.x - x, c.z - z) < 3) { nearChest = true; break; }
          }
          if (nearChest) continue;
          if (!this._consumedAltars.has(this.spawnKey(chunkKey, x, z))) {
            altarSpawns.push({ x, z, chunkKey });
          }
          break;
        }
      }
    }

    return {
      group,
      colliders,
      enemySpawns,
      chestSpawns,
      breakableSpawns,
      altarSpawns,
      resourceSpawns,
      cx,
      cz,
      _ownedGeos: ownedGeos,
    };
  }

  // True if the world position (x, z) is currently under water. Sampled
  // directly from the same low-frequency noise used to build lake meshes,
  // so the lookup is exact (no per-chunk cache needed) and continuous —
  // fine for sliding the player along curved shores.
  isWaterAt(x, z) {
    return this.noise(x * WATER_NOISE_FREQ, z * WATER_NOISE_FREQ) < WATER_THRESHOLD;
  }

  // Build a smooth-shoreline lake mesh for a single chunk via marching
  // squares. For each cell of the WATER_GRID×WATER_GRID grid, classify the
  // four corners (water / land), then emit triangles for the water portion
  // of the cell — using linearly-interpolated edge crossings so curved
  // boundaries follow the noise contour instead of snapping to cell edges.
  _buildSmoothWaterMesh(minX, minZ) {
    const G = WATER_GRID;
    const STEP = WATER_CELL;
    // Sample noise at every corner once.
    const N = new Float32Array((G + 1) * (G + 1));
    for (let j = 0; j <= G; j++) {
      for (let i = 0; i <= G; i++) {
        const wx = minX + i * STEP;
        const wz = minZ + j * STEP;
        N[j * (G + 1) + i] = this.noise(wx * WATER_NOISE_FREQ, wz * WATER_NOISE_FREQ);
      }
    }

    const positions = [];
    const indices = [];
    let nextIdx = 0;
    const pushVert = (x, z) => {
      positions.push(x, 0.04, z);
      return nextIdx++;
    };
    const pushTri = (a, b, c) => {
      // Wind CCW from above (+Y) so the water face renders front-up.
      indices.push(a, b, c);
    };

    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        // Corner positions (CCW from above): BL, TL, TR, BR.
        const x0 = minX + i * STEP, z0 = minZ + j * STEP;
        const x1 = x0 + STEP,        z1 = z0 + STEP;
        const nBL = N[j*(G+1) + i],         nTL = N[(j+1)*(G+1) + i];
        const nTR = N[(j+1)*(G+1) + i + 1], nBR = N[j*(G+1) + i + 1];
        const wBL = nBL < WATER_THRESHOLD ? 1 : 0;
        const wTL = nTL < WATER_THRESHOLD ? 1 : 0;
        const wTR = nTR < WATER_THRESHOLD ? 1 : 0;
        const wBR = nBR < WATER_THRESHOLD ? 1 : 0;
        const c = (wBL) | (wTL << 1) | (wTR << 2) | (wBR << 3);
        if (c === 0) continue;          // entirely dry
        if (c === 15) {                  // entirely under water — full quad
          const a = pushVert(x0, z0);
          const b = pushVert(x0, z1);
          const cc = pushVert(x1, z1);
          const d = pushVert(x1, z0);
          pushTri(a, b, cc);
          pushTri(a, cc, d);
          continue;
        }

        // Walk the cell perimeter in CCW order (BL → TL → TR → BR → BL).
        // Push wet corners and edge-crossing points as we go; the result
        // is a convex polygon (3-5 verts) that we fan-triangulate.
        const corners = [
          { wet: wBL, x: x0, z: z0, n: nBL },
          { wet: wTL, x: x0, z: z1, n: nTL },
          { wet: wTR, x: x1, z: z1, n: nTR },
          { wet: wBR, x: x1, z: z0, n: nBR },
        ];
        const poly = [];
        for (let k = 0; k < 4; k++) {
          const a = corners[k];
          const b = corners[(k + 1) % 4];
          if (a.wet) poly.push([a.x, a.z]);
          if (a.wet !== b.wet) {
            const t = (WATER_THRESHOLD - a.n) / (b.n - a.n);
            const px = a.x + (b.x - a.x) * t;
            const pz = a.z + (b.z - a.z) * t;
            poly.push([px, pz]);
          }
        }
        // Saddle cases (5, 10): two opposite corners are wet, two dry.
        // The cell centre disambiguates whether water connects diagonally
        // across the cell (single hexagonal patch — fan-triangulate fine)
        // or splits into two disjoint corner-triangles (must emit
        // separately to avoid bridging across the dry middle).
        if ((c === 5 || c === 10) && poly.length === 6) {
          const cxw = (x0 + x1) * 0.5, czw = (z0 + z1) * 0.5;
          const nC = this.noise(cxw * WATER_NOISE_FREQ, czw * WATER_NOISE_FREQ);
          const centerWet = nC < WATER_THRESHOLD;
          if (!centerWet) {
            const baseIdx = nextIdx;
            for (const p of poly) pushVert(p[0], p[1]);
            if (c === 5) {
              // poly = [BL, leftCross, topCross, TR, rightCross, bottomCross]
              pushTri(baseIdx + 0, baseIdx + 1, baseIdx + 5);
              pushTri(baseIdx + 3, baseIdx + 4, baseIdx + 2);
            } else {
              // poly = [leftCross, TL, topCross, rightCross, BR, bottomCross]
              pushTri(baseIdx + 1, baseIdx + 2, baseIdx + 0);
              pushTri(baseIdx + 4, baseIdx + 5, baseIdx + 3);
            }
            continue;
          }
        }

        if (poly.length < 3) continue;
        const baseIdx = nextIdx;
        for (const p of poly) pushVert(p[0], p[1]);
        for (let k = 1; k < poly.length - 1; k++) {
          pushTri(baseIdx, baseIdx + k, baseIdx + k + 1);
        }
      }
    }

    if (indices.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geo.computeVertexNormals();
    if (!this._waterMaterial) {
      this._waterMaterial = new THREE.MeshToonMaterial({
        color: 0x3a86ff,
        gradientMap: TOON_GRADIENT,
        transparent: true,
        opacity: 0.88,
      });
    }
    const mesh = new THREE.Mesh(geo, this._waterMaterial);
    mesh.receiveShadow = true;
    return mesh;
  }

  // Drop a tight cluster of oversized gray rocks at (x, z), reading as a
  // cliff outcrop / boulder pile. 4-6 rocks in a small radius, sized 2.6-4×
  // larger than the regular scattered rocks.
  _placeCliffCluster(group, colliders, r, x, z, isOnWater) {
    const count = r.int(4, 6);
    const placed = [];
    for (let i = 0; i < count; i++) {
      const ang = r.range(0, Math.PI * 2);
      const rad = r.range(0, 1.6);
      const px = x + Math.cos(ang) * rad;
      const pz = z + Math.sin(ang) * rad;
      if (isOnWater && isOnWater(px, pz)) continue;
      const tooClose = placed.some(p => (p.x - px) ** 2 + (p.z - pz) ** 2 < 0.7 * 0.7);
      if (tooClose) continue;
      const id = ROCK_LARGE_KINDS[r.int(0, ROCK_LARGE_KINDS.length - 1)];
      const scale = r.range(2.6, 4.0);
      const yaw = r.range(0, Math.PI * 2);
      const mesh = spawnProp(id, { scale, rotationY: yaw });
      // Slight Y variance so rocks don't all sit flush on the same plane.
      mesh.position.set(px, r.range(-0.1, 0.4), pz);
      // Random tilt for a more natural pile look.
      mesh.rotation.z = r.range(-0.15, 0.15);
      mesh.rotation.x = r.range(-0.1, 0.1);
      group.add(mesh);
      placed.push({ x: px, z: pz });
    }
    if (placed.length > 0) {
      // One big collider for the whole cluster — cheaper than per-rock.
      colliders.push({ x, z, r: 2.4 });
    }
  }

  _spotClear(x, z, radius, localColliders) {
    for (const c of localColliders) {
      const dx = x - c.x, dz = z - c.z;
      const r2 = (c.r + radius);
      if (dx * dx + dz * dz < r2 * r2) return false;
    }
    for (const c of this.colliders) {
      const dx = x - c.x, dz = z - c.z;
      const r2 = (c.r + radius);
      if (dx * dx + dz * dz < r2 * r2) return false;
    }
    return true;
  }

  isNight() { return this.dayTime < SUNRISE || this.dayTime >= SUNSET; }

  update(dt) {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
    // Asymmetric day cycle:
    //   06:00 sunrise (dayTime 0.25)   → sunY = 0,  sunX = +1 (east horizon)
    //   13:30 peak    (dayTime 0.5625) → sunY = +1, sunX =  0 (zenith)
    //   21:00 sunset  (dayTime 0.875)  → sunY = 0,  sunX = -1 (west horizon)
    //   01:30 deep nt (dayTime 0.0625) → sunY = -1
    // Day window = 15h, night window = 9h. Pushing the sunset to 21:00 means
    // 18:00 is mid-afternoon (sunY ≈ 0.59) and the brightness ramp through
    // dusk plays out over ~3 in-game hours instead of compressing around 18:00.
    const tNow = this.dayTime;
    let sunY, sunX;
    if (tNow >= SUNRISE && tNow < SUNSET) {
      const phase = (tNow - SUNRISE) / (SUNSET - SUNRISE);
      sunY = Math.sin(phase * Math.PI);
      sunX = Math.cos(phase * Math.PI);
    } else {
      const tNight = tNow < SUNRISE ? tNow + 1 : tNow;
      const phase = (tNight - SUNSET) / (1 + SUNRISE - SUNSET);
      sunY = -Math.sin(phase * Math.PI);
      sunX = -Math.cos(phase * Math.PI);
    }
    // Sun intensity: two C¹-smooth ramps meeting at the horizon.
    //   sunY in [0, 0.5]  → SUN_HORIZON (0.18, "golden hour") → SUN_PEAK (1.6)
    //   sunY in [-0.5, 0] → SUN_FLOOR (0.005, deep-night minimum) → SUN_HORIZON
    // Both ramps have zero slope at sunY = 0 so the join is kink-free. Lower
    // SUN_FLOOR drops night much darker than before while keeping silhouettes
    // visible thanks to ambient + moon hemisphere fill.
    if (sunY >= 0) {
      const s = THREE.MathUtils.smoothstep(sunY, 0, 0.5);
      this.sun.intensity = THREE.MathUtils.lerp(SUN_HORIZON, SUN_PEAK, s);
    } else {
      const s = THREE.MathUtils.smoothstep(sunY, -0.5, 0);
      this.sun.intensity = THREE.MathUtils.lerp(SUN_FLOOR, SUN_HORIZON, s);
    }
    // Stabilise the sun's shadow-camera so shadow edges don't shimmer as
    // players walk or as the sun arc advances. Two changes vs. a naïve
    // setup are critical here:
    //   1. Snap the centroid (target.x/z) to whole shadow-texel multiples
    //      in world space.
    //   2. Snap the sun's offset from the target (offset.x/y/z) to the same
    //      texel grid. This keeps the light direction (= position − target)
    //      pinned across many consecutive frames; only when the offset
    //      crosses a texel boundary does direction step. Without snapping
    //      the offset's y-component, the per-frame drift of sunHeight
    //      (~0.024 m/frame) rotates the light view matrix sub-texel each
    //      frame and PCF samples crawl across shadow edges.
    // PCF shadows sample several texels, so any sub-texel motion of the
    // projection makes edges slosh visibly; texel-aligning everything in
    // world space replaces the slosh with discrete texel-sized jumps that
    // read as stable.
    const sm = this.sun.shadow.mapSize.x;
    const halfSpan = this.sun.shadow.camera.right;
    const texelSize = (halfSpan * 2) / sm;
    const snap = (v) => Math.round(v / texelSize) * texelSize;
    const cx = snap(this._sunCentroidX || 0);
    const cz = snap(this._sunCentroidZ || 0);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();
    const sunHeight = Math.max(15, Math.abs(sunY) * 70 + 20);
    const offsetX = snap(sunX * 60);
    const offsetY = snap(sunHeight);
    const offsetZ = snap(25);
    this.sun.position.set(cx + offsetX, offsetY, cz + offsetZ);

    // Cosine-bell sunset/sunrise tint window centred on the actual horizon
    // crossings. Half-width 1h so the orange glow swells from ~05:00→07:00
    // and ~20:00→22:00.
    const sunsetMix = sunsetBell(this.dayTime, SUNRISE, 1 / 24) + sunsetBell(this.dayTime, SUNSET, 1 / 24);
    // Day weight: 0 deep night, 1 full day, lerped across the full ±0.5
    // sunY band so sky / ambient / moon all fade gradually over several
    // in-game hours either side of the horizon. Also exposed on `this`
    // so the audio layer (cricket / bird chorus, wind level) can read
    // the same phase without recomputing the day-cycle math.
    const dayWeight = THREE.MathUtils.smoothstep(sunY, -0.5, 0.5);
    this.dayWeight = dayWeight;
    // Reuse the pre-allocated colour temporaries (see constructor) instead
    // of `new THREE.Color()` per frame; the resulting blend is copied into
    // scene.background which itself is a single persistent Color.
    const skyCol = this._tmpSkyCol.copy(this._nightCol)
      .lerp(this._dayCol, dayWeight)
      .lerp(this._sunsetCol, Math.min(0.5, sunsetMix * 0.5));
    this.scene.background.copy(skyCol);
    if (this.scene.fog) this.scene.fog.color.copy(skyCol);
    // Lower ambient + moon floors so midnight is visibly darker than noon
    // without going pitch-black (silhouettes still readable).
    this.ambient.intensity = THREE.MathUtils.lerp(0.06, 0.22, dayWeight);
    this.moonHelper.intensity = THREE.MathUtils.lerp(0.18, 0.0, dayWeight);

    if (this.fire) {
      this.fire.scale.setScalar(0.85 + Math.sin(performance.now() * 0.012) * 0.1 + Math.random() * 0.08);
      this.fireLight.intensity = 1.4 + Math.random() * 0.3;
    }
  }

  // Apply a movement step from (oldX, oldZ) to the current `pos`, resolve
  // prop collisions, and slide along water shores axis-by-axis (so a
  // diagonal move into a curved bay still lets the entity skim along the
  // bank instead of stopping cold). Mutates `pos`.
  moveAndCollide(pos, oldX, oldZ, radius) {
    const targetX = pos.x, targetZ = pos.z;
    this.resolveCollisions(pos, radius);
    if (!this.isWaterAt(pos.x, pos.z)) return;
    pos.x = targetX; pos.z = oldZ;
    this.resolveCollisions(pos, radius);
    if (!this.isWaterAt(pos.x, pos.z)) return;
    pos.x = oldX; pos.z = targetZ;
    this.resolveCollisions(pos, radius);
    if (!this.isWaterAt(pos.x, pos.z)) return;
    pos.x = oldX; pos.z = oldZ;
  }

  // No map-edge wall — only resolve overlap with active-chunk prop colliders.
  resolveCollisions(pos, radius) {
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d2 = dx * dx + dz * dz;
      const r = c.r + radius;
      if (d2 < r * r && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const f = (r - d) / d;
        pos.x += dx * f;
        pos.z += dz * f;
      }
    }
  }

  isClear(x, z, radius) {
    for (const c of this.colliders) {
      const dx = x - c.x, dz = z - c.z;
      const r = c.r + radius;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }
}
