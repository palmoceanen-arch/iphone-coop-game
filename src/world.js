import * as THREE from 'three';
import { makeRng } from './utils.js';
import { spawnProp } from './models.js';
import { TOON_GRADIENT } from './shading.js';

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

// Lake cell grid. Per chunk we sample WATER_GRID×WATER_GRID cells, each
// CHUNK_SIZE/WATER_GRID metres wide. Cells whose noise falls below the
// threshold become water; adjacent water cells visually merge into lakes.
// Threshold tuned so the average chunk has ~12-15% water coverage (well
// under the 20% cap; bumpy fbm noise tends to clump water cells together
// rather than scatter them, which keeps lake outlines connected).
export const WATER_GRID = 8;
export const WATER_CELL = CHUNK_SIZE / WATER_GRID;
export const WATER_THRESHOLD = 0.30;

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
    this.chunks = new Map();          // key="cx,cz" → { group, colliders, enemySpawns }
    this.activeKeys = new Set();      // chunk keys currently visible / receiving collision queries
    this.simKeys = new Set();         // chunk keys whose enemies actively simulate
    this.colliders = [];              // aggregated from active chunks only
    this.enemySpawns = [];            // queue read by Game on first frame after a chunk loads
    this._lastGroundCx = null;
    this._lastGroundCz = null;
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildCampfire();
    this.ensureChunksAround(0, 0);
    this.dayTime = 0.25;
    this.dayLength = 240;
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
    this.sun.shadow.mapSize.set(2048, 2048);
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

  // Ensure every chunk within ACTIVE_RADIUS of (worldX, worldZ) has been
  // generated. New chunks are added to scene immediately; their enemy spawn
  // descriptors are queued for Game to instantiate.
  ensureChunksAround(worldX, worldZ) {
    const cx0 = Math.floor(worldX / CHUNK_SIZE);
    const cz0 = Math.floor(worldZ / CHUNK_SIZE);
    for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
      for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        const key = `${cx},${cz}`;
        if (this.chunks.has(key)) continue;
        const chunk = this._generateChunk(cx, cz);
        this.chunks.set(key, chunk);
        this.scene.add(chunk.group);
        for (const e of chunk.enemySpawns) this.enemySpawns.push(e);
      }
    }
  }

  // Recompute which chunks are active (visible) and which actively simulate
  // their enemies, based on the centroid of all alive players. Cheap: just
  // walks the existing chunks Map and toggles group.visible.
  refreshActiveChunks(playerPositions) {
    if (!playerPositions || playerPositions.length === 0) return;
    // Union of active rectangles around each player.
    const wantActive = new Set();
    const wantSim = new Set();
    let cxSum = 0, czSum = 0, n = 0;
    for (const p of playerPositions) {
      const pcx = Math.floor(p.x / CHUNK_SIZE);
      const pcz = Math.floor(p.z / CHUNK_SIZE);
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
      // Cache centroid; the sun's actual position (which depends on the
      // time-of-day arc) is set every frame in update().
      this._sunCentroidX = cxAvg;
      this._sunCentroidZ = czAvg;
      this.sun.target.position.set(cxAvg, 0, czAvg);
      this.sun.target.updateMatrixWorld();
    }
  }

  isChunkActive(cx, cz) { return this.activeKeys.has(`${cx},${cz}`); }
  isChunkSimulating(cx, cz) { return this.simKeys.has(`${cx},${cz}`); }
  chunkKeyOf(x, z) {
    return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
  }

  _generateChunk(cx, cz) {
    const r = makeRng(chunkSeed(this.seed, cx, cz));
    const minX = cx * CHUNK_SIZE;
    const minZ = cz * CHUNK_SIZE;
    const group = new THREE.Group();
    group.name = `chunk_${cx}_${cz}`;
    const colliders = [];
    const enemySpawns = [];

    const isOrigin = (cx === 0 && cz === 0);
    const clearingR = isOrigin ? 9 : 0;
    const localCenter = (x, z) => Math.hypot(x, z);

    const sampleN = (x, z) => this.noise(x, z);

    // 2. Water — cell-based lake system. Sample WATER_GRID×WATER_GRID cells
    // across the chunk; cells whose noise dips below WATER_THRESHOLD become
    // water. Adjacent water cells naturally tile into a single visual lake
    // (cells along chunk borders connect because the noise is continuous
    // across chunks). The origin chunk is kept water-free so the campfire
    // / starting area stays usable.
    const waterMask = new Uint8Array(WATER_GRID * WATER_GRID);
    if (!isOrigin) {
      for (let cz2 = 0; cz2 < WATER_GRID; cz2++) {
        for (let cx2 = 0; cx2 < WATER_GRID; cx2++) {
          const wx = minX + (cx2 + 0.5) * WATER_CELL;
          const wz = minZ + (cz2 + 0.5) * WATER_CELL;
          // Use a low-frequency sample so lakes form smooth connected
          // basins, not isolated 4m specks.
          const n = sampleN(wx * 0.45, wz * 0.45);
          if (n < WATER_THRESHOLD) waterMask[cz2 * WATER_GRID + cx2] = 1;
        }
      }
    }
    const waterCells = [];
    for (let cz2 = 0; cz2 < WATER_GRID; cz2++) {
      for (let cx2 = 0; cx2 < WATER_GRID; cx2++) {
        if (!waterMask[cz2 * WATER_GRID + cx2]) continue;
        const wx = minX + (cx2 + 0.5) * WATER_CELL;
        const wz = minZ + (cz2 + 0.5) * WATER_CELL;
        waterCells.push({ x: wx, z: wz });
      }
    }
    const waterMesh = this._buildWaterMesh(waterCells);
    if (waterMesh) group.add(waterMesh);
    const isOnWater = (x, z) => {
      const cx2 = Math.floor((x - minX) / WATER_CELL);
      const cz2 = Math.floor((z - minZ) / WATER_CELL);
      if (cx2 < 0 || cx2 >= WATER_GRID || cz2 < 0 || cz2 >= WATER_GRID) return false;
      return waterMask[cz2 * WATER_GRID + cx2] === 1;
    };

    // 3. Trees — density modulated by noise; never on water cells.
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
      colliders.push({ x, z, r: 1.0 });
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
    // rocks elsewhere as ground clutter.
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
      if (big) colliders.push({ x, z, r: 0.9 });
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
            });
          }
        }
      }
    }

    return { group, colliders, enemySpawns, cx, cz };
  }

  // Build a single BufferGeometry mesh for all water cells in a chunk.
  // Each cell is a 4×4m flat quad sitting just above ground level. Adjacent
  // cells share their edges in space (verts are duplicated but coincide
  // exactly), so the lake reads as one continuous body of water.
  _buildWaterMesh(cells) {
    if (cells.length === 0) return null;
    const N = cells.length;
    const positions = new Float32Array(N * 4 * 3);
    const indices = new Uint32Array(N * 6);
    const half = WATER_CELL / 2;
    for (let i = 0; i < N; i++) {
      const c = cells[i];
      const x0 = c.x - half, z0 = c.z - half;
      const x1 = c.x + half, z1 = c.z + half;
      const v = i * 4;
      const p = v * 3;
      positions[p+0]=x0; positions[p+1]=0.04; positions[p+2]=z0;
      positions[p+3]=x1; positions[p+4]=0.04; positions[p+5]=z0;
      positions[p+6]=x1; positions[p+7]=0.04; positions[p+8]=z1;
      positions[p+9]=x0; positions[p+10]=0.04; positions[p+11]=z1;
      const idx = i * 6;
      indices[idx+0]=v; indices[idx+1]=v+2; indices[idx+2]=v+1;
      indices[idx+3]=v; indices[idx+4]=v+3; indices[idx+5]=v+2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
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

  isNight() { return this.dayTime < 0.22 || this.dayTime > 0.78; }

  update(dt) {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
    // Map dayTime ∈ [0,1] (clock = dayTime*24) to sun elevation:
    //   0.00 midnight → sunY = -1 (below horizon)
    //   0.25 dawn 6h  → sunY =  0 (just rising)
    //   0.50 noon 12h → sunY = +1 (peak)
    //   0.75 dusk 18h → sunY =  0 (setting)
    const a = (this.dayTime - 0.25) * Math.PI * 2;
    const sunY = Math.sin(a);
    const sunX = Math.cos(a);
    // Stay bright through most of the day, fade only around dusk/dawn.
    const dayBoost = Math.max(0, sunY);
    this.sun.intensity = (0.35 + dayBoost * 1.25);
    if (sunY <= 0) this.sun.intensity = Math.max(0, sunY + 1) * 0.05;
    // Animate sun position along its east→up→west arc, anchored to the
    // player centroid. Height is clamped so the shadow camera's near/far
    // planes still cover the active chunks even when the sun is low.
    const cx = this._sunCentroidX || 0;
    const cz = this._sunCentroidZ || 0;
    const sunHeight = Math.max(15, Math.abs(sunY) * 70 + 20);
    this.sun.position.set(cx + sunX * 60, sunHeight, cz + 25);

    const t = dayBoost; // 0 at sunset/sunrise, 1 at noon
    const dayCol = new THREE.Color(0x6cb6ff);
    const nightCol = new THREE.Color(0x0a1126);
    const sunset = new THREE.Color(0xff9a55);
    const tt = t;
    const sunsetMix = Math.max(0, 1 - Math.abs((this.dayTime - 0.78) * 6)) + Math.max(0, 1 - Math.abs((this.dayTime - 0.22) * 6));
    const skyCol = new THREE.Color().copy(nightCol).lerp(dayCol, tt).lerp(sunset, Math.min(0.5, sunsetMix * 0.5));
    this.scene.background.copy(skyCol);
    this.scene.fog.color.copy(skyCol);
    // Ambient stays low at all times so toon shading reads. Slight day/night dip.
    this.ambient.intensity = 0.10 + tt * 0.12;
    this.moonHelper.intensity = (1 - tt) * 0.25;

    if (this.fire) {
      this.fire.scale.setScalar(0.85 + Math.sin(performance.now() * 0.012) * 0.1 + Math.random() * 0.08);
      this.fireLight.intensity = 1.4 + Math.random() * 0.3;
    }
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
