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

// Cel-shaded water shader. Cheap (no displacement, no extra geometry,
// no render targets): a single ShaderMaterial driven by a `uTime`
// uniform. The fragment shader runs a 2D Voronoi over world XZ to get
// a stationary network of irregular cells; the BORDERS between cells
// are drawn as thin light-teal outlines (so the lake reads as a
// connected web of bright lines on a base teal fill, like the
// stylised 2D-water reference). Cells are flat-filled in two close
// teal tones — most cells stay 'shallow', a clustered subset selected
// by low-frequency noise + per-cell hash flips to 'deep'. Both the
// dark/light boundary and the bright outline ride the SAME Voronoi
// cell edge, so the dark fill reads as the same noisy pattern as the
// light lines, just filled in solid. Per-cell pulses still breathe
// the bright line thickness so the network doesn't sit static. Only
// one material exists per Game (cached in `world._waterMaterial`);
// the per-chunk geometry just references it. `uTime` is advanced
// once per frame from `World.update(dt)`.
// Three quality buckets driven by the player's video settings:
//   0 = low    — flat shallow fill + thin shoreline outline
//   1 = medium — Voronoi network + shoreline, no animation, no dark patches
//   2 = high   — full pattern as authored (animated breathing + dark patches)
// The shader compiles each tier with #if WATER_QUALITY blocks so the unused
// work is dropped at compile time, not branched at runtime.
//
// The water material is a MeshToonMaterial, NOT a raw ShaderMaterial. This
// is what wires the water into the scene's lighting pipeline: ambient,
// directional sun, hemisphere moon, and the shared TOON_GRADIENT 3-band
// ramp all apply automatically — exactly as they do for the ground and
// props. Our cellular pattern is injected via onBeforeCompile by replacing
// the diffuseColor in <color_fragment>; everything after that (the toon
// lighting passes) runs unchanged. Without this routing the water would
// stay at full brightness through the night while every other surface
// darkens under low sun + ambient.
const WATER_PATTERN_FN_GLSL = /* glsl */`
  // 2D hashes used to scatter Voronoi feature points + give each
  // cell a stable scalar id (drives per-cell pulse phase).
  float waterHash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  vec2 waterHash22(vec2 p) {
    vec2 q = vec2(dot(p, vec2(127.1, 311.7)),
                  dot(p, vec2(269.5, 183.3)));
    return fract(sin(q) * 43758.5453);
  }
  // Voronoi over a 3×3 neighbourhood. Returns:
  //   .xy = lattice coords of the nearest feature point's grid cell
  //         (constant within a Voronoi cell — used to derive a stable
  //         per-cell id and to sample low-freq noise at the cell)
  //   .z  = distance to the nearest feature point
  //   .w  = distance to the second-nearest feature point
  // (.w - .z) is small near a cell border and large at cell centres,
  // so we drive the bright outline width off it directly.
  vec4 waterVoronoi(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    vec2 nearest = vec2(0.0);
    for (int yi = -1; yi <= 1; yi++) {
      for (int xi = -1; xi <= 1; xi++) {
        vec2 g = vec2(float(xi), float(yi));
        vec2 o = waterHash22(i + g);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; nearest = i + g; }
        else if (d < d2) { d2 = d; }
      }
    }
    return vec4(nearest, sqrt(d1), sqrt(d2));
  }
  // 2D value noise used as a domain-warp source — bends the input
  // to the Voronoi by a small noise field so cell borders curve
  // organically instead of meeting at sharp polygonal seams.
  float waterVnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = waterHash21(i);
    float b = waterHash21(i + vec2(1.0, 0.0));
    float c = waterHash21(i + vec2(0.0, 1.0));
    float d = waterHash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

export function buildWaterMaterial(quality = 'high') {
  const Q = quality === 'low' ? 0 : quality === 'medium' ? 1 : 2;
  // White base colour: the pattern overrides diffuseColor.rgb wholesale
  // in <color_fragment>, so the material's `color` doesn't actually tint
  // the water. Keeping it at white avoids any chance of double-multiply
  // confusion if a future edit only patches part of the chain.
  const mat = new THREE.MeshToonMaterial({
    color: 0xffffff,
    gradientMap: TOON_GRADIENT,
    transparent: true,
  });
  // The shoreline uses `fwidth(vShore)` which requires the standard
  // derivatives extension on WebGL1. three.js auto-enables it for
  // ShaderMaterial when the source contains fwidth, but for a
  // MeshToonMaterial patched via onBeforeCompile we have to flag it
  // explicitly so the program prelude inserts
  // `#extension GL_OES_standard_derivatives : enable`.
  mat.extensions = { ...(mat.extensions || {}), derivatives: true };
  // Three close-tone teal steps with deliberately gentle contrast so the
  // cellular network reads as a single body of water rather than three
  // sharply tinted patches. 'Shallow' is the base cell fill, 'deep' is
  // the flat fill of the clustered dark cells, 'highlight' is the bright
  // cell border / shoreline outline. uTime is advanced once per frame
  // from World.update.
  mat.userData.waterUniforms = {
    uTime:      { value: 0 },
    uDeep:      { value: new THREE.Color(0x44afca) },
    uShallow:   { value: new THREE.Color(0x48b1cb) },
    uHighlight: { value: new THREE.Color(0x80b1c6) },
  };
  // Stash the active quality on userData so setWaterQuality (and the
  // program cache key below) can read the current bucket without
  // closing over a snapshot.
  mat.userData.waterQ = Q;
  mat.defines = { WATER_QUALITY: Q };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.waterUniforms);
    // ---- Vertex: forward world XZ and the per-vertex shoreDist ---------
    // shoreDist is a custom attribute set by the marching-squares mesher
    // (geometry.setAttribute('shoreDist', ...)). We expose vWorldXZ /
    // vShore varyings to the fragment so the pattern can sample world
    // space (chunk-independent) and the shoreline edge can use fwidth.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float shoreDist;
varying vec2 vWorldXZ;
varying float vShore;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _waterWp = modelMatrix * vec4(transformed, 1.0);
vWorldXZ = _waterWp.xz;
vShore = shoreDist;`,
      );
    // ---- Fragment: declare uniforms + helpers, override diffuseColor ---
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uHighlight;
varying vec2 vWorldXZ;
varying float vShore;
${WATER_PATTERN_FN_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 _waterCol;
#if WATER_QUALITY >= 1
// Domain-warped Voronoi network — see WATER_PATTERN_FN_GLSL for the
// individual helpers. The warp breaks integer-grid alignment so cell
// seams curve organically.
vec2 _waterWarp = vec2(
  waterVnoise(vWorldXZ * 1.10 + 11.0),
  waterVnoise(vWorldXZ * 1.10 + 41.7)
) - 0.5;
vec2 _waterP = (vWorldXZ + _waterWarp * 1.0) * 1.10;
vec4 _waterV = waterVoronoi(_waterP);
float _waterBorderDist = _waterV.w - _waterV.z;
float _waterCellId = waterHash21(_waterV.xy + 0.13);
#if WATER_QUALITY >= 2
// Per-cell pulse phase so the network breathes asynchronously — wide
// amplitude (0.020-0.155) and a ~4s period read clearly at a glance.
float _waterPulse = 0.5 + 0.5 * sin(uTime * 1.55 + _waterCellId * 6.2832);
float _waterThickness = 0.020 + 0.135 * _waterPulse;
#else
// Medium tier pins thickness at the time-averaged value so the visual
// weight matches the high tier's mean.
float _waterThickness = 0.020 + 0.135 * 0.5;
#endif
float _waterLine = 1.0 - smoothstep(0.0, _waterThickness, _waterBorderDist);
#if WATER_QUALITY >= 2
// Dark patches: same Voronoi noise sampled at 1/1.3 the frequency and
// shifted so dark cell boundaries don't align with the bright network.
vec2 _waterPBig = (vWorldXZ + _waterWarp * 1.0) * (1.10 / 1.3) + vec2(5.7, 9.3);
vec4 _waterVBig = waterVoronoi(_waterPBig);
float _waterDarkPick = waterHash21(_waterVBig.xy + 3.7);
float _waterDarkAmt = smoothstep(0.59, 0.61, _waterDarkPick);
_waterCol = mix(uShallow, uDeep, _waterDarkAmt);
#else
_waterCol = uShallow;
#endif
_waterCol = mix(_waterCol, uHighlight, _waterLine);
#else
// Low tier: flat shallow fill, skips both Voronoi voices entirely.
_waterCol = uShallow;
#endif
// Shoreline outline kept on every tier — costs one fwidth + one
// smoothstep and is the visual seam between water and shore.
float _waterWShore = fwidth(vShore);
float _waterShoreLine = 1.0 - smoothstep(0.0, max(_waterWShore * 2.0, 0.004), vShore);
_waterCol = mix(_waterCol, uHighlight, _waterShoreLine);
diffuseColor.rgb = _waterCol;`,
      );
  };
  // Pin the program cache key to the quality tier so swapping tiers
  // recompiles cleanly. Without this, three.js could share a compiled
  // program across tiers and ignore the WATER_QUALITY change.
  mat.customProgramCacheKey = () => `water-pattern-toon-q${mat.userData.waterQ}`;
  return mat;
}

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
// `ACTIVE_RADIUS` is the visible / generated chunk ring around each
// player. Was 3 (7×7 = 49 chunks) and dropped to 2 (5×5 = 25 chunks)
// for ~49% less terrain CPU + GPU steady-state load — the previous
// outermost ring was past the typical fade / fog distance anyway, so
// the visible difference is small while the perf saving is real.
// Anything outside is unloaded after a short hysteresis (KEEP_RADIUS).
export const ACTIVE_RADIUS = 2;     // chunks generated/visible around each player (5×5)
// SIM_RADIUS is capped at ACTIVE_RADIUS — there's no point simulating
// enemies inside chunks that aren't loaded. Keeping the export so
// external callers (camp spawners, AI ticking) keep working.
export const SIM_RADIUS    = ACTIVE_RADIUS;     // chunks within which enemies actively simulate
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

// Noise thresholds for the sand and dark-forest biome bands. Identical
// to the values the minimap baker uses, so the 3D world's biome edges
// land on the same iso-contour the player sees on the map.
const SAND_NOISE_MAX = 0.32;   // n < 0.32 → sand
const FOREST_NOISE_MIN = 0.55; // n ≥ 0.55 → dark forest
// Toon-friendly biome colours (also match the minimap palette).
//
// FOREST_COLOR_HEX sits intentionally close to the grass tier — only
// slightly darker (~7 pts L) and a touch less saturated, so deep-noise
// pockets read as "shaded grove" rather than the near-black it used to
// be (HSL 126°/29%/33%). Current tone is HSL 109°/29%/43%: hue warmed
// just past the grass band so the biome edge feels like the same plant
// in shadow rather than a different (cooler) species, and saturation
// kept close to grass (~38%) so the patch doesn't go grey.
const SAND_COLOR_HEX   = 0xc4a96a;
const GRASS_COLOR_HEX  = 0x6db050;
const FOREST_COLOR_HEX = 0x5b8e4f;
// How many queued chunks to materialise per `processChunkQueue` call.
// Each chunk gen runs the marching-squares water mesh + dozens of
// model clones, costing roughly 1-3ms on a low-end laptop, so 1 per
// frame keeps the worst case under ~3ms while still draining the queue
// fast enough that the visible 7×7 ring fills in within ~1s of walking
// into a fresh region.
const CHUNKS_PER_FRAME = 1;

// Lake mesh resolution. Per chunk we sample noise on a (WATER_GRID+1)×
// (WATER_GRID+1) grid of corners, then build a marching-squares mesh.
// Both WATER_GRID and WATER_CELL are `let` instead of `const` because
// `setTerrainQuality()` swaps the resolution at runtime (low=16/medium=24/
// high=32) when the player picks a different terrain bucket in the
// pause menu. ESM live bindings forward the new value to any importer
// reading the symbol; nothing else stores a snapshot. Default is 32
// (high) — 1 m cells, smooth biome / shoreline edges. Lower buckets
// trade smoothness for a 4× (low) / 1.78× (medium) reduction in noise
// samples + marching-squares cells per chunk — the water bake is the
// most expensive single per-chunk op (each `_waterMaskAt` does 3 fbm
// calls for domain warping) so this is the biggest absolute lever.
// `_buildIsoBandMesh` (sand / forest biome edges) reads the same
// values, so biome curves stay 1:1 with the water shoreline at every
// quality level.
// Where the noise crosses WATER_THRESHOLD on a cell edge we interpolate the
// crossing point, giving smooth curved shorelines instead of axis-aligned
// blocks. WATER_NOISE_FREQ scales the noise input so lakes form large
// connected basins rather than tiny specks.
export let WATER_GRID = 32;
export let WATER_CELL = CHUNK_SIZE / WATER_GRID;
// Fixed-resolution mask used for *gameplay* queries — `isWaterAt` for
// player / enemy collision and the per-prop "is this point on water?"
// skip used by every spawn loop in `_generateChunk` (trees, rocks,
// bushes, enemy camps, chests, altars, breakables). This is intentionally
// decoupled from the visual `WATER_GRID`: when the player switches
// terrain quality, only the rendered mesh resolution changes — the
// underlying "which world points are wet" decision stays at the
// canonical 1 m grid so prop placement, save / load determinism and
// player collision are bit-identical across all three quality tiers.
// (The visible water boundary at low quality may drift up to ~1 m
// from the gameplay boundary, but that's a cosmetic mismatch the
// player won't feel — they'd only notice if props moved.)
const MASK_GRID = 32;
const MASK_CELL = CHUNK_SIZE / MASK_GRID;
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

// Point-in-triangle test for the marching-squares-driven water collision
// path. Triangle vertices are passed as [x, z] pairs in world space. Uses
// the standard half-plane sign test; treats edges as inside (any zero
// half-plane is OK) so points landing exactly on a shared triangle edge
// register as wet rather than slipping into a sub-pixel gap.
function _ptInTri(px, pz, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (pz - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (pz - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (pz - a[1]);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
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
    // Per-chunk overrides for natural (procedurally-spawned) entities.
    // Keyed by chunkKey — value is an object that may contain:
    //   { resources: { [posKey]: { hp, state, regrowT } },
    //     altars:    { [posKey]: { charges } },
    //     enemies:   [{ kind, x, z, hp, maxHP, level, elite, asleep, ... }] }
    // Populated by Game on chunk unload (capture phase) and by SaveSystem
    // when a save is restored. Read by `_loadChunkSync` so a re-streamed
    // chunk surfaces with the same enemy / resource / altar state the
    // player left it in. The dedicated Map (rather than a property bolted
    // on the chunk record) lives across unload→reload cycles for free
    // because chunks are dropped from `this.chunks` but the override
    // entry stays put.
    this.chunkOverrides = new Map();
    // Callback invoked when a chunk is unloaded; Game wires this up to
    // despawn entities tied to that chunk (enemies, chests, etc.) so
    // their THREE meshes are released alongside the chunk's group.
    // _onCaptureChunkState fires *before* _onChunkUnload so Game has a
    // chance to snapshot live enemy / resource / altar state into
    // chunkOverrides while the entities are still healthy. Splitting
    // the two hooks keeps the capture path side-effect-free with respect
    // to the despawn path: capture reads `pos`/`hp`/`state`, then despawn
    // releases pool meshes — the order matters because pool release
    // can flip `alive` to false on the live entity.
    this._onCaptureChunkState = null;
    this._onChunkUnload = null;
    // Optional listener that fires whenever a persistence-affecting
    // mutation lands on the World (e.g. a structure HP update, a chest
    // marked consumed, an enemy snapshot stored). SaveSystem hooks this
    // to debounce writes; left as null when no save system is wired.
    this._onPersistDirty = null;
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
    // Water shader quality bucket: 'low' | 'medium' | 'high'. Driven by
    // the player's video settings (settings.applyVideo →
    // world.setWaterQuality). Held here so the lazy-built water material
    // picks up the right tier on first use.
    this._waterQuality = 'high';
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildCampfire();
    this.ensureChunksAround(0, 0);
    this.dayTime = 0.25;
    this.dayLength = 1920;
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
    // Default 4096² over the ~100m frustum = ~0.024 m/texel (on par with
    // the old 8192²/160m at ¼ GPU cost). Settings can override via
    // SHADOW_SIZE[quality] in settings.js.
    this.sun.shadow.mapSize.set(4096, 4096);
    // Shadow camera covers a tighter area around the players than the full
    // active-chunk ring. The camera sees ~50-70m at max zoom; d=50 gives
    // ~15m margin for off-screen trees that still cast shadows onto the
    // visible ground. With 4096² over 100m this gives ~0.024 m/texel — on
    // par with the old 8192² over 160m (0.020 m/texel) at ¼ the GPU cost.
    const d = 50;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 250;
    this.sun.shadow.bias = -0.0008;
    // normalBias pushes the shadow lookup along the surface normal, which
    // eliminates self-shadow artifacts (shadow acne) on tree canopies and
    // rocks without disabling receiveShadow entirely. 0.12 is aggressive
    // enough to fix the acne while the cel-shading gradient hides any
    // minor shadow leaking at contact edges.
    this.sun.shadow.normalBias = 0.12;
    // Hard-ish shadows: a 1-texel PCF radius gives a crisp edge that still
    // anti-aliases (no jagged staircase), and stays stable frame-to-frame
    // (PCFShadowMap kernel, see game.js).
    this.sun.shadow.radius = 1;
    // Throttle shadow map updates — re-render the depth pass every other
    // frame instead of every frame. At 60fps the shadows update at 30fps
    // which is invisible to the eye, but halves the shadow rendering cost.
    this.sun.shadow.autoUpdate = false;
    this._shadowFrameCounter = 0;
    this.sun.target = new THREE.Object3D();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.moonHelper = new THREE.HemisphereLight(0x7aa6ff, 0x202830, 0.0);
    this.scene.add(this.moonHelper);
  }

  // Ground = a single large flat plane (toon-shaded grass) that follows
  // the centroid of the players. This is the *grass* tier of the biome
  // map — sand and dark-forest patches are added per-chunk as marching-
  // squares meshes (`_buildIsoBandMesh`) sitting at the same y=0 with
  // polygonOffset, so the biome boundary line is true geometry (same
  // sub-pixel AA as the water shoreline) instead of a texel-aligned
  // texture edge. With a flat colour and no displacement there are no
  // self-shadowing artifacts.
  _buildGround() {
    const size = (ACTIVE_RADIUS * 2 + 4) * CHUNK_SIZE; // ~320m
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshToonMaterial({
      color: GRASS_COLOR_HEX,
      gradientMap: TOON_GRADIENT,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  // Marching-squares mesh over the same 1 m lattice the water mesh uses
  // (`WATER_GRID` / `WATER_CELL`). Returns a flat THREE.Mesh whose
  // boundary traces the noise iso-contour where `n == threshold`. With
  // `insideBelow=true` the mesh fills cells where the noise is BELOW
  // the threshold (sand band); with `insideBelow=false` it fills cells
  // where the noise is AT or ABOVE the threshold (dark-forest band).
  // Returns null when the band doesn't intersect this chunk.
  //
  // This is a direct twin of `_buildSmoothWaterMesh`'s topology pass —
  // same edge-crossing interpolation, same saddle disambiguation —
  // minus the per-vertex shore-distance attribute the water shader
  // needs. Because corner samples are taken at exact 1 m world
  // coordinates, adjacent chunks see identical samples on their shared
  // boundary and the resulting polygons join seamlessly. The biome
  // boundary therefore has the same level of edge smoothing as the
  // water shoreline (true vector geometry rasterised with sub-pixel AA
  // by the GPU), and no more.
  // `noiseGrid` is an optional precomputed (G+1)² Float32Array of
  // `this.noise(minX + i*STEP, minZ + j*STEP)` samples laid out in
  // row-major order. Sand and forest bands share the same noise field,
  // so `_generateChunk` builds the grid once and passes it to both
  // calls — saving one full (G+1)² fbm sweep per chunk.
  _buildIsoBandMesh(minX, minZ, threshold, insideBelow, material, y, noiseGrid = null) {
    const G = WATER_GRID;
    const STEP = WATER_CELL;
    let N = noiseGrid;
    if (!N) {
      N = new Float32Array((G + 1) * (G + 1));
      for (let j = 0; j <= G; j++) {
        for (let i = 0; i <= G; i++) {
          N[j * (G + 1) + i] = this.noise(minX + i * STEP, minZ + j * STEP);
        }
      }
    }
    const inside = insideBelow
      ? (n) => n < threshold
      : (n) => n >= threshold;

    const positions = [];
    const indices = [];
    let nextIdx = 0;
    const pushVert = (x, z) => {
      positions.push(x, y, z);
      return nextIdx++;
    };
    const pushTri = (a, b, c) => { indices.push(a, b, c); };

    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const x0 = minX + i * STEP, z0 = minZ + j * STEP;
        const x1 = x0 + STEP,        z1 = z0 + STEP;
        const nBL = N[j*(G+1) + i],         nTL = N[(j+1)*(G+1) + i];
        const nTR = N[(j+1)*(G+1) + i + 1], nBR = N[j*(G+1) + i + 1];
        const wBL = inside(nBL) ? 1 : 0;
        const wTL = inside(nTL) ? 1 : 0;
        const wTR = inside(nTR) ? 1 : 0;
        const wBR = inside(nBR) ? 1 : 0;
        const cmask = (wBL) | (wTL << 1) | (wTR << 2) | (wBR << 3);
        if (cmask === 0) continue;          // entirely outside the band
        if (cmask === 15) {                  // entirely inside — full quad
          const a = pushVert(x0, z0);
          const b = pushVert(x0, z1);
          const cc = pushVert(x1, z1);
          const d = pushVert(x1, z0);
          pushTri(a, b, cc);
          pushTri(a, cc, d);
          continue;
        }
        // CCW from BL: BL→TL→TR→BR. For each edge with one wet and one
        // dry corner, linearly interpolate the noise to the threshold so
        // the boundary cuts the cell at sub-cell precision (= sub-metre
        // sub-pixel curve once rasterised).
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
            const t = (threshold - a.n) / (b.n - a.n);
            const px = a.x + (b.x - a.x) * t;
            const pz = a.z + (b.z - a.z) * t;
            poly.push([px, pz]);
          }
        }
        // Saddle disambiguation — same as the water mesh.
        if ((cmask === 5 || cmask === 10) && poly.length === 6) {
          const cxw = (x0 + x1) * 0.5, czw = (z0 + z1) * 0.5;
          const nC = this.noise(cxw, czw);
          const centerInside = inside(nC);
          if (!centerInside) {
            const baseIdx = nextIdx;
            for (const p of poly) pushVert(p[0], p[1]);
            if (cmask === 5) {
              pushTri(baseIdx + 0, baseIdx + 1, baseIdx + 5);
              pushTri(baseIdx + 3, baseIdx + 4, baseIdx + 2);
            } else {
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
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    return mesh;
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
    // Persistent chunk overrides — enemy snapshots replace the
    // procedural spawn list entirely (so a chunk that had its enemies
    // killed stays empty until they regenerate via some other rule),
    // while resource / altar overrides ride into the spawn descriptor
    // and are applied by Game on entity construction.
    const ov = this.chunkOverrides.get(key);
    if (chunk.enemySpawns) {
      if (ov && Array.isArray(ov.enemies)) {
        for (const persisted of ov.enemies) {
          // Stamp chunkKey/group references so Game's drainer can
          // route the spawn through `_isSpawnLive`.
          this.enemySpawns.push({
            ...persisted,
            chunkKey: key,
            _persisted: true,
          });
        }
      } else {
        for (const e of chunk.enemySpawns) this.enemySpawns.push(e);
      }
    }
    if (chunk.chestSpawns) for (const c of chunk.chestSpawns) this.chestSpawns.push(c);
    if (chunk.breakableSpawns) for (const b of chunk.breakableSpawns) this.breakableSpawns.push(b);
    if (chunk.altarSpawns) {
      const altarOv = ov && ov.altars;
      for (const a of chunk.altarSpawns) {
        const pk = `${a.x.toFixed(1)},${a.z.toFixed(1)}`;
        if (altarOv && altarOv[pk]) {
          this.altarSpawns.push({ ...a, override: altarOv[pk] });
        } else {
          this.altarSpawns.push(a);
        }
      }
    }
    if (chunk.resourceSpawns) {
      const resOv = ov && ov.resources;
      for (const r of chunk.resourceSpawns) {
        const pk = `${r.x.toFixed(1)},${r.z.toFixed(1)}`;
        if (resOv && resOv[pk]) {
          this.resourceSpawns.push({ ...r, override: resOv[pk] });
        } else {
          this.resourceSpawns.push(r);
        }
      }
    }
    // Re-emit any persisted player-placed structures for this chunk so the
    // game-side drainer can re-instantiate them on top of the regenerated
    // chunk geometry. Non-empty only after the player has built things in
    // this region during the current session.
    const persisted = this.placedStructures.get(key);
    if (persisted && persisted.length > 0) {
      for (const s of persisted) {
        // Spread the descriptor first so kind-specific extras
        // (`roof_pitched` rectangle bounds + roofColor, gate/door
        // openDir, hidden roof_corner flag, etc.) survive a chunk
        // reload. Then override the runtime-only fields so a stale
        // chunk reference from an earlier life doesn't leak through.
        this.structureSpawns.push({
          ...s,
          // Stack height for tower-style stone walls. Defaults to 0 for
          // legacy descriptors that predate the stacking feature so an
          // older save still slots its walls onto the ground correctly.
          y: s.y || 0,
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
      // Capture before despawn — entities are still alive here, so we
      // can read hp / pos / state cleanly. _onChunkUnload then releases
      // the meshes back to their pools.
      if (typeof this._onCaptureChunkState === 'function') {
        try { this._onCaptureChunkState(key); } catch { /* ignore listener errors */ }
      }
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

  // Local (chunk-scoped) position key matching the format used in
  // chunkOverrides — must stay in sync with the lookup in _loadChunkSync
  // and saveSystem.posKey().
  _posKey(x, z) {
    return `${x.toFixed(1)},${z.toFixed(1)}`;
  }

  // Lazily get-or-create the override entry for a chunk. Returns the
  // override object for in-place mutation; callers should also call
  // `_markPersistDirty` after the mutation lands.
  _ensureChunkOverride(chunkKey) {
    let ov = this.chunkOverrides.get(chunkKey);
    if (!ov) {
      ov = {};
      this.chunkOverrides.set(chunkKey, ov);
    }
    return ov;
  }

  // Trim empty branches off a chunk override and drop the entry
  // entirely if nothing's left, so the saved blob doesn't accumulate
  // dead keys for chunks the player just visited and walked away from
  // without changing anything.
  _pruneChunkOverride(chunkKey) {
    const ov = this.chunkOverrides.get(chunkKey);
    if (!ov) return;
    if (ov.resources && Object.keys(ov.resources).length === 0) delete ov.resources;
    if (ov.altars && Object.keys(ov.altars).length === 0) delete ov.altars;
    if (ov.enemies && ov.enemies.length === 0 && !ov._enemiesPersisted) delete ov.enemies;
    if (Object.keys(ov).length === 0) this.chunkOverrides.delete(chunkKey);
  }

  // Notify the wired SaveSystem (if any) that something persistence-
  // affecting just changed. Cheap when no save system is attached.
  _markPersistDirty() {
    if (typeof this._onPersistDirty === 'function') {
      try { this._onPersistDirty(); } catch { /* ignore listener errors */ }
    }
  }

  // ---- public chunk-override mutators ----------------------------------
  // Used by Game when a per-chunk natural entity changes state (resource
  // damaged / harvested / regrowing, altar charge spent, etc.) and on
  // chunk unload via the capture path. Each helper mutates the override
  // structure in place and fires the persist-dirty hook. Pass `null` /
  // `undefined` for the value to clear the slot.
  recordResourceOverride(chunkKey, x, z, override) {
    const pk = this._posKey(x, z);
    if (!override) {
      const ov = this.chunkOverrides.get(chunkKey);
      if (!ov || !ov.resources) return;
      delete ov.resources[pk];
      this._pruneChunkOverride(chunkKey);
      this._markPersistDirty();
      return;
    }
    const ov = this._ensureChunkOverride(chunkKey);
    if (!ov.resources) ov.resources = {};
    ov.resources[pk] = { ...override };
    this._markPersistDirty();
  }

  recordAltarOverride(chunkKey, x, z, override) {
    const pk = this._posKey(x, z);
    if (!override) {
      const ov = this.chunkOverrides.get(chunkKey);
      if (!ov || !ov.altars) return;
      delete ov.altars[pk];
      this._pruneChunkOverride(chunkKey);
      this._markPersistDirty();
      return;
    }
    const ov = this._ensureChunkOverride(chunkKey);
    if (!ov.altars) ov.altars = {};
    ov.altars[pk] = { ...override };
    this._markPersistDirty();
  }

  // Replace the persisted enemy snapshot list for a chunk. Pass an
  // empty array to keep the chunk explicitly empty (no procedural
  // respawn) — pass `null` to forget the override entirely so the next
  // load falls back to procedural spawn.
  recordEnemyOverride(chunkKey, enemies) {
    if (enemies === null || enemies === undefined) {
      const ov = this.chunkOverrides.get(chunkKey);
      if (!ov) return;
      delete ov.enemies;
      delete ov._enemiesPersisted;
      this._pruneChunkOverride(chunkKey);
      this._markPersistDirty();
      return;
    }
    const ov = this._ensureChunkOverride(chunkKey);
    ov.enemies = Array.isArray(enemies) ? enemies.map(e => ({ ...e })) : [];
    ov._enemiesPersisted = true;
    this._markPersistDirty();
  }

  markChestConsumed(chunkKey, x, z) {
    this._consumedChests.add(this.spawnKey(chunkKey, x, z));
    // Drop the chest's gold dot from the minimap overlay on the next
    // render. Same hook the structure-mutation paths use; the minimap
    // listens via `_onChunkChanged` -> `Minimap.invalidate(key)`.
    if (this._onChunkChanged) this._onChunkChanged(chunkKey);
    this._markPersistDirty();
  }
  markBreakableConsumed(chunkKey, x, z) {
    this._consumedBreakables.add(this.spawnKey(chunkKey, x, z));
    this._markPersistDirty();
  }
  markAltarConsumed(chunkKey, x, z) {
    this._consumedAltars.add(this.spawnKey(chunkKey, x, z));
    if (this._onChunkChanged) this._onChunkChanged(chunkKey);
    this._markPersistDirty();
  }

  // Player just placed a structure at (x,z) with the given kind / yaw / hp.
  // Records it in `placedStructures[chunkKey]` so chunk reload can rehydrate
  // the structure, and (if the chunk is currently loaded) also queues a
  // `structureSpawn` so Game._drainStructureSpawns can mount it this frame.
  // Returns the descriptor object for caller convenience.
  placeStructure(x, z, kind, yaw = 0, hp = null, y = 0, extra = null) {
    const chunkKey = this.chunkKeyOf(x, z);
    // `y` is the stack height (m) above the base tile. Only walls (the
    // single stackable kind) ever pass a non-zero value; everything else
    // sits flush on the ground. Stored on the descriptor so chunk reload
    // re-instantiates a stacked tower at the correct heights.
    const desc = { x, z, kind, yaw, hp };
    if (y && y > 0) desc.y = y;
    // Optional extra fields (e.g. `roof_pitched` carries the rectangle
    // bounds of the roof_corners that spawned it). Merged into both the
    // persisted descriptor and the structureSpawn entry so the load
    // path sees the same geometry-driving data on first build and on
    // chunk reload.
    if (extra) Object.assign(desc, extra);
    let arr = this.placedStructures.get(chunkKey);
    if (!arr) { arr = []; this.placedStructures.set(chunkKey, arr); }
    arr.push(desc);
    const chunk = this.chunks.get(chunkKey);
    if (chunk) {
      const spawn = {
        x, z, kind, yaw, hp, y: desc.y || 0,
        chunkKey,
        group: chunk.group,
        colliderArray: chunk.colliders,
      };
      if (extra) Object.assign(spawn, extra);
      this.structureSpawns.push(spawn);
    }
    if (this._onChunkChanged) this._onChunkChanged(chunkKey);
    this._markPersistDirty();
    return desc;
  }

  // Drop a destroyed structure from `placedStructures`, matched by approx
  // position so we don't leak descriptors after a wall is broken. Uses the
  // same 0.1m rounding as the consumed-set helpers so floating-point drift
  // doesn't prevent the match.
  forgetStructure(chunkKey, x, z, y = null) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    // Stacked walls share an (x,z) tile, so when `y` is supplied prefer
    // the descriptor with the matching stack height; falling back to the
    // generic any-match path keeps legacy callers (which omit y because
    // their structure type can't stack) working unchanged.
    const yEps = 0.20;
    if (y !== null) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const d = arr[i];
        if (Math.abs(d.x - x) >= eps || Math.abs(d.z - z) >= eps) continue;
        const dy = d.y || 0;
        if (Math.abs(dy - y) < yEps) {
          arr.splice(i, 1);
          if (arr.length === 0) this.placedStructures.delete(chunkKey);
          if (this._onChunkChanged) this._onChunkChanged(chunkKey);
          this._markPersistDirty();
          return;
        }
      }
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      const d = arr[i];
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        arr.splice(i, 1);
        break;
      }
    }
    if (arr.length === 0) this.placedStructures.delete(chunkKey);
    if (this._onChunkChanged) this._onChunkChanged(chunkKey);
    this._markPersistDirty();
  }

  // Update the persisted HP value for an in-place structure so a reload
  // later in the session continues from mid-damage rather than full health.
  // Caller passes the current chunkKey + position; we tolerate small float
  // drift the same way as `forgetStructure`.
  updateStructureHP(chunkKey, x, z, hp, y = null) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    const yEps = 0.20;
    // Same y-disambiguation as forgetStructure so a stacked wall tower
    // doesn't keep writing all its tower mates' HPs onto descriptor[0].
    if (y !== null) {
      for (const d of arr) {
        if (Math.abs(d.x - x) >= eps || Math.abs(d.z - z) >= eps) continue;
        const dy = d.y || 0;
        if (Math.abs(dy - y) < yEps) { d.hp = hp; this._markPersistDirty(); return; }
      }
    }
    for (const d of arr) {
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        d.hp = hp;
        this._markPersistDirty();
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
        this._markPersistDirty();
        return;
      }
    }
  }

  // Persist a gate's open state on its descriptor so a chunk reload
  // after the player walked away leaves it exactly as they last
  // toggled it. `openDir` is 0 (closed) / +1 / -1 (open, with direction
  // = which side the door swung toward). Storing as a number lets the
  // gate remember which way it was open after a reload.
  updateStructureOpen(chunkKey, x, z, openDir) {
    const arr = this.placedStructures.get(chunkKey);
    if (!arr) return;
    const eps = 0.15;
    const dir = openDir | 0;
    for (const d of arr) {
      if (Math.abs(d.x - x) < eps && Math.abs(d.z - z) < eps) {
        if (dir !== 0) d.openDir = dir;
        else delete d.openDir;
        // Also clear any legacy boolean `open` written by the previous
        // gate version so reload sees the new descriptor cleanly.
        delete d.open;
        this._markPersistDirty();
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
        // Chunk-snap only translates X/Z; Y stays at the grass level
        // (sand and forest meshes use polygonOffset to sit on top).
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
    // Decorative landmarks (currently just cliff-cluster boulders) that
    // aren't harvestable but should still appear on the minimap.
    // `_placeCliffCluster` pushes one entry per rock so the cluster
    // reads as a chunky pile of dots rather than a single point.
    const naturalProps = [];
    // BufferGeometries / Materials / Textures we own (fresh-allocated
    // for this chunk and not returned to a shared cache). The water
    // mesh's BufferGeometry is one entry; the per-chunk ground patch
    // contributes another three (geometry, material, baked texture).
    // `_disposeChunk` walks this list on unload and calls .dispose() on
    // anything that has one — so any future per-chunk GPU resource can
    // just be pushed here without touching the unload path.
    const ownedGeos = [];

    const isOrigin = (cx === 0 && cz === 0);
    const clearingR = isOrigin ? 9 : 0;
    const localCenter = (x, z) => Math.hypot(x, z);

    const sampleN = (x, z) => this.noise(x, z);

    // 1. Biome bands. The global ground plane (`_buildGround`) is the
    // grass tier. Per-chunk we add up to two marching-squares meshes
    // tracing the sand band (n < SAND_NOISE_MAX) and the dark-forest
    // band (n ≥ FOREST_NOISE_MIN) over the same 1 m lattice the water
    // mesh uses — so the biome boundaries are true vector geometry
    // with the same sub-pixel AA the water shoreline gets, and no
    // hand-baked texture edges. Both bands sit at y=0 and use
    // polygonOffset to win the depth test over the grass plane.
    if (!this._sandMaterial) {
      this._sandMaterial = new THREE.MeshToonMaterial({
        color: SAND_COLOR_HEX,
        gradientMap: TOON_GRADIENT,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
      this._forestMaterial = new THREE.MeshToonMaterial({
        color: FOREST_COLOR_HEX,
        gradientMap: TOON_GRADIENT,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
    }
    // Sand and forest bands sample the SAME `this.noise(x, z)` field on
    // the SAME (WATER_GRID+1)² lattice — only the threshold differs.
    // Build the corner grid once and feed both calls so we only pay the
    // noise sweep once per chunk.
    const G_BIOME = WATER_GRID;
    const STEP_BIOME = WATER_CELL;
    const biomeNoise = new Float32Array((G_BIOME + 1) * (G_BIOME + 1));
    for (let j = 0; j <= G_BIOME; j++) {
      for (let i = 0; i <= G_BIOME; i++) {
        biomeNoise[j * (G_BIOME + 1) + i] =
          this.noise(minX + i * STEP_BIOME, minZ + j * STEP_BIOME);
      }
    }
    const sandMesh = this._buildIsoBandMesh(
      minX, minZ, SAND_NOISE_MAX, true, this._sandMaterial, 0, biomeNoise
    );
    if (sandMesh) {
      group.add(sandMesh);
      if (sandMesh.geometry) ownedGeos.push(sandMesh.geometry);
    }
    const forestMesh = this._buildIsoBandMesh(
      minX, minZ, FOREST_NOISE_MIN, false, this._forestMaterial, 0, biomeNoise
    );
    if (forestMesh) {
      group.add(forestMesh);
      if (forestMesh.geometry) ownedGeos.push(forestMesh.geometry);
    }

    // 2. Water — marching-squares lake mesh. Sample noise at corners of a
    // (WATER_GRID+1)² grid covering this chunk; build a smooth curved
    // shoreline by interpolating where the noise crosses WATER_THRESHOLD on
    // each cell edge. The origin chunk also gets a mesh — `_waterMaskAt`
    // applies a radial bias around (0, 0) so the campfire / starting area
    // ends up dry naturally, and any lake that crosses into origin fades
    // smoothly instead of being chopped off at the chunk boundary.
    const waterMesh = this._buildSmoothWaterMesh(minX, minZ);
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
      // Trunk-tight collider. The tree mesh's foliage canopy reaches
      // out ~1m but the wood stem itself is only ~0.4m wide — players
      // were complaining that they bumped into "thin air" around big
      // pines. 0.5 is half the previous radius and matches what your
      // sword can reach against the trunk.
      const collider = { x, z, r: 0.5 };
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
        this._placeCliffCluster(group, colliders, r, x, z, isOnWater, naturalProps);
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
      naturalProps,
      cx,
      cz,
      _ownedGeos: ownedGeos,
    };
  }

  // True if the world position (x, z) is currently under water. Mirrors the
  // marching-squares classification used by `_buildSmoothWaterMesh` exactly
  // (same per-chunk skip, same per-cell corner test, same edge-crossing
  // interpolation, same saddle disambiguation) so collision can never
  // disagree with what the player sees. Without this the fbm noise has
  // sub-cell variation the mesh's straight-line interpolation can't
  // capture, producing visible holes (collision wet, mesh dry — player
  // gets stuck on grass) and phantom water (mesh wet, collision dry —
  // player walks on rendered water).
  // Water-mask noise sample at world position (x, z). Two pieces:
  // 1. Domain warping of the underlying value-fbm so the threshold contour
  //    no longer aligns with the integer noise grid (without it the lake
  //    shores show weak axis-alignment).
  // 2. A radial "campfire clearing" bias near (0, 0) that pushes the noise
  //    above threshold inside SPAWN_CLEAR_R so the spawn area is reliably
  //    dry. We apply this in the mask itself (rather than skipping the
  //    origin chunk's mesh entirely) so any lake that naturally extends
  //    toward origin fades out smoothly through partial cells instead of
  //    being chopped at the origin chunk's hard cell boundary — which
  //    used to leave a hard 90° corner in the shoreline at x = ±32 / z = ±32.
  _waterMaskAt(x, z) {
    const f = WATER_NOISE_FREQ;
    const wx = (this.noise(x * f + 11.7, z * f + 5.3) - 0.5);
    const wz = (this.noise(x * f + 41.1, z * f + 27.9) - 0.5);
    const A = 1.5;
    let n = this.noise((x + wx * A) * f, (z + wz * A) * f);
    // Spawn clearing — full bias at distance 0, fades smoothly to zero at
    // SPAWN_CLEAR_R. Smoothstep keeps the radial fade C¹-continuous so the
    // threshold contour stays a smooth curve where the bias trails off
    // (a linear fade would introduce a small kink right at the radius).
    // 0.5 is large enough to push any cell above the 0.30 threshold from
    // any underlying noise value in [0, 1].
    const SPAWN_CLEAR_R = 14;
    const d = Math.hypot(x, z);
    if (d < SPAWN_CLEAR_R) {
      const t = 1 - d / SPAWN_CLEAR_R;
      const ts = t * t * (3 - 2 * t);
      n += ts * 0.5;
    }
    return n;
  }

  isWaterAt(x, z) {
    // Always queried at the fixed gameplay-canonical 1 m grid (MASK_CELL),
    // independent of the visual WATER_GRID set by terrain quality. Keeps
    // prop spawn / collision deterministic across quality switches.
    const STEP = MASK_CELL;
    const i = Math.floor(x / STEP);
    const j = Math.floor(z / STEP);
    const x0 = i * STEP, z0 = j * STEP;
    const x1 = x0 + STEP, z1 = z0 + STEP;
    const nBL = this._waterMaskAt(x0, z0);
    const nTL = this._waterMaskAt(x0, z1);
    const nTR = this._waterMaskAt(x1, z1);
    const nBR = this._waterMaskAt(x1, z0);
    const wBL = nBL < WATER_THRESHOLD;
    const wTL = nTL < WATER_THRESHOLD;
    const wTR = nTR < WATER_THRESHOLD;
    const wBR = nBR < WATER_THRESHOLD;
    const c = (wBL ? 1 : 0) | (wTL ? 2 : 0) | (wTR ? 4 : 0) | (wBR ? 8 : 0);
    if (c === 0) return false;
    if (c === 15) return true;
    // Same CCW corner walk as the mesh builder — produces a 3- to 6-vert
    // polygon whose interior is the wet portion of the cell.
    const corners = [
      { wet: wBL, x: x0, z: z0, n: nBL },
      { wet: wTL, x: x0, z: z1, n: nTL },
      { wet: wTR, x: x1, z: z1, n: nTR },
      { wet: wBR, x: x1, z: z0, n: nBR },
    ];
    const poly = [];
    for (let k = 0; k < 4; k++) {
      const a = corners[k], b = corners[(k + 1) % 4];
      if (a.wet) poly.push([a.x, a.z]);
      if (a.wet !== b.wet) {
        const t = (WATER_THRESHOLD - a.n) / (b.n - a.n);
        poly.push([a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t]);
      }
    }
    if ((c === 5 || c === 10) && poly.length === 6) {
      const cxw = (x0 + x1) * 0.5, czw = (z0 + z1) * 0.5;
      const centerWet = this._waterMaskAt(cxw, czw) < WATER_THRESHOLD;
      if (!centerWet) {
        // Two disjoint corner triangles — same indexing as the mesh.
        if (c === 5) {
          return _ptInTri(x, z, poly[0], poly[1], poly[5])
              || _ptInTri(x, z, poly[3], poly[4], poly[2]);
        }
        return _ptInTri(x, z, poly[1], poly[2], poly[0])
            || _ptInTri(x, z, poly[4], poly[5], poly[3]);
      }
    }
    if (poly.length < 3) return false;
    // Fan-triangulate from poly[0] — matches the mesh's fan emission, so
    // any point covered by a mesh triangle is reported as wet here too.
    for (let k = 1; k < poly.length - 1; k++) {
      if (_ptInTri(x, z, poly[0], poly[k], poly[k + 1])) return true;
    }
    return false;
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
        N[j * (G + 1) + i] = this._waterMaskAt(wx, wz);
      }
    }

    const positions = [];
    const indices = [];
    // Per-vertex 'shore distance' — sampled from the same noise field
    // that defines the water mask. 0 = right on the shoreline (where
    // the noise crosses WATER_THRESHOLD), 1 = the deepest part of
    // the lake. Drives the matching shoreline outline in the water
    // shader so the lake silhouette is rimmed in the same colour as
    // the cell borders.
    const shoreDists = [];
    let nextIdx = 0;
    const sampleShoreDist = (x, z) => {
      // Use the same domain-warped mask as the corner classifier so the
      // per-vertex shoreline outline lines up with the actual mesh edge.
      const n = this._waterMaskAt(x, z);
      const d = (WATER_THRESHOLD - n) / WATER_THRESHOLD;
      return d > 0 ? d : 0;
    };
    const pushVert = (x, z) => {
      positions.push(x, 0.04, z);
      shoreDists.push(sampleShoreDist(x, z));
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
          const nC = this._waterMaskAt(cxw, czw);
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
    geo.setAttribute('shoreDist', new THREE.BufferAttribute(new Float32Array(shoreDists), 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geo.computeVertexNormals();
    if (!this._waterMaterial) this._waterMaterial = buildWaterMaterial(this._waterQuality);
    const mesh = new THREE.Mesh(geo, this._waterMaterial);
    mesh.receiveShadow = true;
    return mesh;
  }

  // Drop a tight cluster of oversized gray rocks at (x, z), reading as a
  // cliff outcrop / boulder pile. 4-6 rocks in a small radius, sized 2.6-4×
  // larger than the regular scattered rocks. The optional `mapDots` array
  // collects per-rock positions so the minimap can stamp the whole pile
  // (these rocks aren't in `resourceSpawns` because they aren't
  // harvestable — without this hook the cluster is invisible on the map).
  _placeCliffCluster(group, colliders, r, x, z, isOnWater, mapDots) {
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
      if (mapDots) mapDots.push({ x: px, z: pz, kind: 'rock' });
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

  // Force-unload every loaded chunk regardless of distance to the players.
  // Used by `setTerrainQuality()` so a resolution change takes effect on
  // already-loaded chunks: the chunk's owned BufferGeometries are disposed
  // (`_disposeChunk`), the unload listener fires so Game can despawn the
  // chunk's entities, and the chunks Map is cleared. The next call to
  // `ensureChunksAround` (driven by Game's per-frame loop) regenerates
  // each chunk deterministically from `chunkSeed(seed, cx, cz)` at the
  // new resolution, with player-placed structures rehydrated from
  // `placedStructures` and consumed chests / altars / breakables stripped
  // by the existing spawn-skip logic.
  _unloadAllChunks() {
    if (this.chunks.size === 0) return;
    const keys = [...this.chunks.keys()];
    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      // Mirror the per-chunk path: capture entity state, then despawn.
      // This matters when a terrain-quality change forces a full
      // reload — without capture, enemies / damaged resources around
      // the player would silently reset to fresh state on reload.
      if (typeof this._onCaptureChunkState === 'function') {
        try { this._onCaptureChunkState(key); } catch { /* ignore listener errors */ }
      }
      if (typeof this._onChunkUnload === 'function') {
        try { this._onChunkUnload(key); } catch { /* ignore listener errors */ }
      }
      this._disposeChunk(chunk);
      this.chunks.delete(key);
    }
    // Drop pending async-load entries too — they were enqueued under the
    // old resolution's coordinate system (still valid, just stale because
    // we want a clean reload pass) and would otherwise race against the
    // sync regeneration path.
    this._pendingLoads.length = 0;
    this._pendingSet.clear();
    // Clear world-level spawn queues so Game's drainers don't try to
    // instantiate stale descriptors against now-disposed chunk groups.
    // Re-population happens in the next `_loadChunkSync` pass.
    this.enemySpawns.length = 0;
    this.chestSpawns.length = 0;
    this.breakableSpawns.length = 0;
    this.altarSpawns.length = 0;
    this.resourceSpawns.length = 0;
    this.structureSpawns.length = 0;
  }

  // Switch the terrain mesh resolution. `level` is one of 'low' / 'medium' /
  // 'high'. Maps to a WATER_GRID value: low=16 (2 m cells), medium=24
  // (~1.33 m cells), high=32 (1 m cells, default). The same grid drives
  // the water marching-squares mesh AND the sand / forest biome iso-band
  // meshes, so all three boundary curves coarsen / sharpen together (the
  // property the user asked us to preserve when biomes were first added).
  // Changing the value triggers a full chunk reload because the cached
  // BufferGeometries were baked at the previous resolution.
  setTerrainQuality(level) {
    const grid = level === 'high' ? 32 : level === 'medium' ? 24 : 16;
    if (grid === WATER_GRID) return;
    WATER_GRID = grid;
    WATER_CELL = CHUNK_SIZE / grid;
    this._unloadAllChunks();
    // Regeneration happens on the next tick: Game's per-frame loop calls
    // `ensureChunksAround` for each player, which sync-loads the
    // immediate 3×3 ring (SYNC_LOAD_RADIUS=1) and enqueues the rest.
    // `processChunkQueue` (also per-frame) drains 1 chunk per frame, so
    // the full new-resolution streaming ring fills in within ~25 frames
    // (~0.4 s at 60 Hz). The pause menu is open during this transition,
    // so the player sees their immediate surroundings update instantly
    // and the outer ring fill in by the time they resume.
  }

  // Switch the water shader's quality bucket. Called by Settings.applyVideo
  // whenever the player picks a different water tier in the pause menu. If
  // the material has already been built, we patch its `defines` and force a
  // recompile; otherwise the new value is just stored and picked up on the
  // first lazy build inside `_buildSmoothWaterMesh`.
  setWaterQuality(quality) {
    const q = quality === 'low' || quality === 'medium' || quality === 'high'
      ? quality
      : 'high';
    if (this._waterQuality === q) return;
    this._waterQuality = q;
    if (this._waterMaterial) {
      const Q = q === 'low' ? 0 : q === 'medium' ? 1 : 2;
      this._waterMaterial.userData.waterQ = Q;
      this._waterMaterial.defines = { ...this._waterMaterial.defines, WATER_QUALITY: Q };
      // needsUpdate=true forces three.js to recompile the program; the
      // customProgramCacheKey above keys on userData.waterQ so the new
      // tier picks up its own compiled program rather than reusing the
      // previous tier's.
      this._waterMaterial.needsUpdate = true;
    }
  }

  update(dt) {
    // Advance the water shader's time uniform — drives the per-cell
    // breathing pulse on the high tier. Always runs (even while the day
    // cycle is paused) so water keeps moving in menus. The water rides
    // on MeshToonMaterial via onBeforeCompile, and our custom uniforms
    // are stashed on userData; the shader.uniforms object holds the
    // same reference, so mutating .value here propagates straight
    // through on the GPU side.
    if (this._waterMaterial && this._waterMaterial.userData.waterUniforms) {
      this._waterMaterial.userData.waterUniforms.uTime.value += dt;
    }
    this.dayTime = 0.8; // TEMP: frozen for shadow testing
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
    // Even at the day's peak the sun is held off-zenith — straight-down
    // light flattens shadows under players, walls, and roofs and the
    // scene reads as washed out. We do this with two constant biases:
    //   - SUN_TILT_Z: a permanent +Z offset, so even when sunY hits 1
    //     the light still rakes across the scene from the south at a
    //     ~30° angle from vertical. Was 25, bumped to 55 so noon
    //     shadows are clearly readable rather than hairline stripes.
    //   - SUN_TILT_X: a small constant east-side bias added to the
    //     time-of-day sunX*60 sweep, so the noon sunX≈0 moment never
    //     lines the sun up dead-vertical with the player's silhouette.
    //     Sunrise / sunset stay broadly symmetric (offsetX swings from
    //     ~+72 to ~-48) — the asymmetry is small and only noticeable
    //     because shadows now point slightly off-axis at noon, which
    //     is the desired effect.
    // sunHeight ceiling lowered 70→60 to compound with the larger Z
    // bias: the resulting peak direction is closer to (12, 80, 55)
    // → ~33° from vertical, so a 2m wall casts roughly a 1.3m shadow
    // at noon instead of the previous ~0.55m sliver.
    const SUN_TILT_X = -55;
    const SUN_TILT_Z = 12;
    const sunHeight = Math.max(15, Math.abs(sunY) * 60 + 20);
    const offsetX = snap(sunX * 60 + SUN_TILT_X);
    const offsetY = snap(sunHeight);
    const offsetZ = snap(SUN_TILT_Z);
    this.sun.position.set(cx + offsetX, offsetY, cz + offsetZ);

    // Throttle shadow map re-render: only update every other frame.
    // At 60fps this gives 30fps shadow updates — imperceptible — while
    // halving the depth-pass cost (the single largest shadow expense).
    this._shadowFrameCounter = (this._shadowFrameCounter + 1) % 2;
    if (this._shadowFrameCounter === 0) {
      this.sun.shadow.needsUpdate = true;
    }

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
  // Colliders flagged `disabled` (currently used by open gates) are skipped
  // entirely so the player can walk through the cell without being pushed
  // out by an oversized radial response.
  resolveCollisions(pos, radius) {
    for (const c of this.colliders) {
      if (c.disabled) continue;
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
      if (c.disabled) continue;
      const dx = x - c.x, dz = z - c.z;
      const r = c.r + radius;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }
}
