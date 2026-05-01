import * as THREE from 'three';
import { makeRng } from './utils.js';
import { spawnProp } from './models.js';

// Chunk-based deterministic world.
//
// Generation pipeline (per chunk, fully seeded):
//   1. Value noise sampled at chunk grid points → height/biome map
//   2. Water ponds placed in low-noise dips
//   3. Trees on land cells (Poisson-ish, density modulated by noise)
//   4. Rocks (large + medium gray rocks on rocky cells; small rocks scattered)
//   5. Bushes / clutter
//   6. Enemy camp picks (deterministic per chunk; a fraction of chunks are camps)
//
// There's no fixed map boundary — chunks are streamed in around the players.

export const CHUNK_SIZE = 32;
export const ACTIVE_RADIUS = 3; // load 7×7 chunks around the centroid

// 32-bit integer hash mixing world seed with (cx, cz). Same input → same seed.
function chunkSeed(worldSeed, cx, cz) {
  let h = (worldSeed | 0) >>> 0;
  h ^= Math.imul((cx | 0) + 0x9e3779b1, 0x85ebca6b);
  h ^= Math.imul((cz | 0) + 0x27d4eb2d, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// Lightweight 2D value noise — deterministic, derived from world seed.
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
  // 3-octave fractal sum, output ~[0,1]
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
    this.chunks = new Map();      // key="cx,cz" → { group, colliders, enemySpawns }
    this.colliders = [];          // aggregated from all loaded chunks
    this.enemySpawns = [];        // queue read by Game on first frame after a chunk loads
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildCampfire();
    // Origin chunk and immediate neighbors guaranteed at start so the players
    // have a clearing and some content visible without waiting.
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
    this.sun.shadow.mapSize.set(1024, 1024);
    const d = 80;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 200;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.moonHelper = new THREE.HemisphereLight(0x7aa6ff, 0x202830, 0.0);
    this.scene.add(this.moonHelper);
  }

  // One large flat ground plane sitting under all chunks. Vertex colours are
  // computed from the same noise so the terrain reads as varied without
  // needing per-chunk geometry. Plenty large enough to never run out.
  _buildGround() {
    const size = 800;
    const seg = 160;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x6db050);
    const grassDark = new THREE.Color(0x4a8a3a);
    const grassBright = new THREE.Color(0x88c562);
    const dirt = new THREE.Color(0x8c7a52);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const n = this.noise(x, z);
      // micro-bump from noise so the ground doesn't look mathematical-flat
      pos.setY(i, (n - 0.5) * 0.5);
      let c;
      if (n > 0.72) c = tmp.copy(dirt).lerp(grassBright, 0.25);
      else if (n > 0.5) c = grassBright;
      else if (n > 0.3) c = grass;
      else c = grassDark;
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  _buildCampfire() {
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x6e6862 });
    const ring = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3), stoneMat);
      s.position.set(Math.cos(a) * 0.9, 0.18, Math.sin(a) * 0.9);
      s.castShadow = true;
      ring.add(s);
    }
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8), new THREE.MeshLambertMaterial({ color: 0x4d2f17 }));
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

  // Make sure every chunk within ACTIVE_RADIUS of (worldX, worldZ) is
  // generated. Returns the list of newly-spawned enemy descriptors so
  // Game can instantiate them. Does not unload distant chunks (cheap and
  // keeps the world consistent).
  ensureChunksAround(worldX, worldZ) {
    const cx0 = Math.floor(worldX / CHUNK_SIZE);
    const cz0 = Math.floor(worldZ / CHUNK_SIZE);
    const newEnemies = [];
    for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
      for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        const key = `${cx},${cz}`;
        if (this.chunks.has(key)) continue;
        const chunk = this._generateChunk(cx, cz);
        this.chunks.set(key, chunk);
        this.scene.add(chunk.group);
        for (const c of chunk.colliders) this.colliders.push(c);
        for (const e of chunk.enemySpawns) newEnemies.push(e);
      }
    }
    if (newEnemies.length > 0) {
      this.enemySpawns.push(...newEnemies);
    }
    return newEnemies;
  }

  _generateChunk(cx, cz) {
    const r = makeRng(chunkSeed(this.seed, cx, cz));
    const minX = cx * CHUNK_SIZE;
    const minZ = cz * CHUNK_SIZE;
    const group = new THREE.Group();
    group.name = `chunk_${cx}_${cz}`;
    const colliders = [];
    const enemySpawns = [];

    // Origin chunk has a guaranteed clearing around the campfire.
    const isOrigin = (cx === 0 && cz === 0);
    const clearingR = isOrigin ? 9 : 0;
    const localCenter = (x, z) => Math.hypot(x, z);

    // 1. Average-noise sample for biome flavor (helps decide density).
    const sampleN = (x, z) => this.noise(x, z);

    // 2. Water — ~25% of non-origin chunks get a pond in a noise-low spot.
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
      const pondMat = new THREE.MeshPhongMaterial({ color: 0x3aa6ff, shininess: 80, transparent: true, opacity: 0.85 });
      const pond = new THREE.Mesh(pondGeo, pondMat);
      pond.position.set(bestX, 0.06, bestZ);
      group.add(pond);
      colliders.push({ x: bestX, z: bestZ, r: rad * 0.85 });
    }

    // 3. Trees — density modulated by noise. Up to ~14 attempts per chunk;
    //    higher noise = more vegetation. Skip near other colliders.
    const treeAttempts = 14;
    for (let i = 0; i < treeAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
      const n = sampleN(x, z);
      if (r.next() > n * 1.1) continue;          // density grows with noise
      if (!this._spotClear(x, z, 1.4, colliders)) continue;
      const id = TREE_KINDS[r.int(0, TREE_KINDS.length - 1)];
      const scale = r.range(2.4, 3.6);
      const yaw = r.range(0, Math.PI * 2);
      const mesh = spawnProp(id, { scale, rotationY: yaw });
      mesh.position.set(x, 0, z);
      group.add(mesh);
      colliders.push({ x, z, r: 1.0 });
    }

    // 4. Rocks — rocky cells (high noise) get more large/medium rocks; the
    //    rest get small ones for clutter.
    const rockAttempts = 8;
    for (let i = 0; i < rockAttempts; i++) {
      const x = minX + r.range(2, CHUNK_SIZE - 2);
      const z = minZ + r.range(2, CHUNK_SIZE - 2);
      if (clearingR > 0 && localCenter(x, z) < clearingR) continue;
      const n = sampleN(x, z);
      // bias: noise>0.55 → rocky, otherwise softer ground with fewer rocks
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

    // 5. Bushes / small clutter
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

    // 6. Enemy camps — origin chunk has none, immediate neighbors low odds,
    //    further chunks higher odds. Pick a free spot in the chunk; if found,
    //    instantiate an enemy camp template.
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
            enemySpawns.push({ kind: k, x: ex, z: ez, level: lvl, homeX: cxw, homeZ: czw });
          }
        }
      }
    }

    return { group, colliders, enemySpawns };
  }

  // Cheap clearance check using only colliders pushed so far (chunk-local +
  // already-aggregated). Avoids quadratic behaviour by only scanning nearby
  // entries.
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
    const sunX = Math.sin(a);
    this.sun.position.set(sunX * 50, Math.max(-10, sunY * 50 + 5), 25);
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

  // Resolve circle-vs-circle overlaps with prop colliders only — no
  // map-edge wall, the world is open.
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
