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
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff4d8, 1.1);
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
      // Sun shadow camera follows the centroid so we always have crisp
      // shadows around the action.
      const sunDir = new THREE.Vector3(0.6, 1, 0.4).normalize();
      this.sun.target.position.set(cxAvg, 0, czAvg);
      this.sun.position.set(
        cxAvg + sunDir.x * 80,
        sunDir.y * 80,
        czAvg + sunDir.z * 80
      );
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

    // 2. Water — ~25% of non-origin chunks, placed in the noise-low spot.
    if (!isOrigin && r.chance(0.25)) {
      let bestX = 0, bestZ = 0, bestN = 1;
      for (let i = 0; i < 16; i++) {
        const px = minX + r.range(4, CHUNK_SIZE - 4);
        const pz = minZ + r.range(4, CHUNK_SIZE - 4);
        const n = sampleN(px, pz);
        if (n < bestN) { bestN = n; bestX = px; bestZ = pz; }
      }
      const rad = r.range(3, 6);
      const pondGeo = new THREE.CircleGeometry(rad, 24);
      pondGeo.rotateX(-Math.PI / 2);
      const pondMat = new THREE.MeshToonMaterial({
        color: 0x3a86ff,
        gradientMap: TOON_GRADIENT,
        transparent: true,
        opacity: 0.92,
      });
      const pond = new THREE.Mesh(pondGeo, pondMat);
      // Sit slightly above ground so the water plane never z-fights with the
      // ground when both are flat at y=0.
      pond.position.set(bestX, 0.04, bestZ);
      group.add(pond);
      colliders.push({ x: bestX, z: bestZ, r: rad * 0.85 });
    }

    // 3. Trees — density modulated by noise.
    const treeAttempts = 14;
    for (let i = 0; i < treeAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
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

    // 4. Rocks — rocky cells (high noise) get more large/medium gray rocks.
    const rockAttempts = 8;
    for (let i = 0; i < rockAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
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

    // 5. Bushes / clutter
    const bushAttempts = 6;
    for (let i = 0; i < bushAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
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
          if (this._spotClear(x, z, 2.2, colliders)) { cxw = x; czw = z; ok = true; break; }
        }
        if (ok) {
          const tpl = ENEMY_CAMP_TEMPLATES[r.int(0, ENEMY_CAMP_TEMPLATES.length - 1)];
          const lvl = 1 + tpl.levelBoost + Math.floor(Math.hypot(cxw, czw) / 30);
          for (const k of tpl.kinds) {
            const ox = r.range(-2.5, 2.5);
            const oz = r.range(-2.5, 2.5);
            const ex = cxw + ox, ez = czw + oz;
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
    const a = (this.dayTime - 0.25) * Math.PI * 2;
    const sunY = Math.cos(a);
    this.sun.intensity = Math.max(0, sunY) * 1.15;

    const t = (Math.sin(this.dayTime * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    const dayCol = new THREE.Color(0x6cb6ff);
    const nightCol = new THREE.Color(0x0a1126);
    const sunset = new THREE.Color(0xff9a55);
    const tt = Math.max(0, Math.min(1, t));
    const sunsetMix = Math.max(0, 1 - Math.abs((this.dayTime - 0.78) * 6)) + Math.max(0, 1 - Math.abs((this.dayTime - 0.22) * 6));
    const skyCol = new THREE.Color().copy(nightCol).lerp(dayCol, tt).lerp(sunset, Math.min(0.5, sunsetMix * 0.5));
    this.scene.background.copy(skyCol);
    this.scene.fog.color.copy(skyCol);
    this.ambient.intensity = 0.25 + tt * 0.4;
    this.moonHelper.intensity = (1 - tt) * 0.45;

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
