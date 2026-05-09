// Farming — the M3 layer on top of M2 planters.
//
// Each player-built planter (see src/structure.js, kind === 'planter') gets
// at most one Crop instance. The Crop owns a small THREE.Group mounted into
// the planter's mesh group at the soil's surface, swaps visible meshes per
// growth stage, and exposes the contract the game-side interaction code
// uses (till / plant / harvest) plus the persisted descriptor used to
// rehydrate a half-grown crop after a chunk reload.
//
// State machine
// -------------
//   empty     — fresh planter, soil is not yet workable.
//   tilled    — soil dragged with a hoe / weapon swing once; ready to receive
//               a seed. Shows freshly-turned dark soil (a small darker patch
//               on top of the planter's existing soil block).
//   growing   — seed planted; growProgressMs accrues only while the chunk is
//               in SIM_RADIUS so off-screen farms don't tick at full rate.
//               Crosses 5 visual stages (sprout → small → medium → large)
//               before transitioning to mature.
//   mature    — full stage rendered, ready to harvest. Time stops here.
//   harvested — brief visual stub (cleared soil) so a freshly-cleared
//               planter reads as "yep that just got picked" before the
//               player taps interact again to reset to empty.
//
// Persistence
// -----------
// Game records the live state into the placedStructures descriptor's `farm`
// field every time it changes. On chunk unload the structure is despawned
// and the descriptor stays in world.placedStructures; on chunk reload the
// drainer instantiates a fresh Crop and calls `loadFromDescriptor()` to
// restore the in-progress timer + visible stage.
//
// All state values are JSON-clean (numbers + short strings) so the same
// descriptor shape can later be lifted into localStorage by walking
// world.placedStructures and stringifying.

import * as THREE from 'three';
import { TOON_GRADIENT } from './shading.js';
import { defaultRandom, rand } from './utils.js';

// Per-crop tuning. Times in milliseconds; yields are inclusive integer
// ranges. Seeds returned per harvest are tuned so a productive farm slowly
// compounds (50% chance to break even) rather than hand the player a
// runaway feedback loop.
//
// `mature` slot stores the crop's signature colour for damage-numbers and
// mature-stage tinting; `food` array picks one entry at random for each
// food drop so a single harvest yields a small variety of healing pickups.
export const CROPS = {
  wheat: {
    name: 'Пшеница',
    growMs: 90_000,
    foodAmount: [2, 3],
    seedReturn: [0, 2],          // 0..2 inclusive; expectation ≈ 1.0
    mature: 0xe8c25a,
    food: ['mushroom'],
  },
  carrot: {
    name: 'Морковь',
    growMs: 75_000,
    foodAmount: [1, 2],
    seedReturn: [0, 1],          // expectation ≈ 0.5 — fastest crop, cheapest yield
    mature: 0xff8a3a,
    food: ['apple', 'mushroom'],
  },
  pumpkin: {
    name: 'Тыква',
    growMs: 150_000,
    foodAmount: [3, 4],
    seedReturn: [0, 2],          // expectation ≈ 1.0 — slowest but best food return
    mature: 0xe46b1f,
    food: ['meat', 'mushroom'],
  },
  cabbage: {
    name: 'Капуста',
    growMs: 120_000,
    foodAmount: [2, 4],
    seedReturn: [0, 1],          // expectation ≈ 0.5 — middling crop
    mature: 0x6db94e,
    food: ['apple', 'berry'],
  },
};

// Order used by the per-player crop selector cycle (Q for P1, U for P2).
// Stable order so the cycle wraps predictably.
export const CROP_ORDER = ['wheat', 'carrot', 'pumpkin', 'cabbage'];

// Localised label for a crop kind. Falls back to the english id so a
// future-added crop without a Russian name still renders.
export function cropLabel(kind) {
  return CROPS[kind]?.name || kind;
}

// Hold-time before a single weapon swing on grass tills the soil. Short
// enough that "press and release E" feels instant; long enough that
// brushing past a planter while running doesn't accidentally till.
export const TILL_HOLD_SECONDS = 0;       // single press, no charge for v1

// How many visual sub-stages between sprout and mature. The growMs is split
// equally: at progress < (i+1)/STAGES the (i)-th stage shows.
const GROWTH_STAGES = 4;            // sprout / small / medium / large / mature

// Visual offset above the planter's soil. Planter geometry sits with the
// soil top at y ≈ 0.10, so crop meshes sit just above that.
const SOIL_TOP_Y = 0.11;

// Cached materials so a forest of crops doesn't blow up the material count.
// One stem + leaf material is plenty for procedural distinction; stage
// differences come from per-instance scale + visibility flips.
let MATERIALS = null;
function ensureMaterials() {
  if (MATERIALS) return;
  MATERIALS = {
    soilWet: new THREE.MeshToonMaterial({ color: 0x2c1c11, gradientMap: TOON_GRADIENT }),
    sprout: new THREE.MeshToonMaterial({ color: 0x74b04a, gradientMap: TOON_GRADIENT }),
    leafLight: new THREE.MeshToonMaterial({ color: 0x8fc960, gradientMap: TOON_GRADIENT }),
    leafDark: new THREE.MeshToonMaterial({ color: 0x4f8a3a, gradientMap: TOON_GRADIENT }),
    wheatStalk: new THREE.MeshToonMaterial({ color: 0xc8a44b, gradientMap: TOON_GRADIENT }),
    wheatHead: new THREE.MeshToonMaterial({ color: 0xe8c25a, gradientMap: TOON_GRADIENT }),
    carrotRoot: new THREE.MeshToonMaterial({ color: 0xff8a3a, gradientMap: TOON_GRADIENT }),
    pumpkinFlesh: new THREE.MeshToonMaterial({ color: 0xe46b1f, gradientMap: TOON_GRADIENT }),
    pumpkinStem: new THREE.MeshToonMaterial({ color: 0x4a7a2a, gradientMap: TOON_GRADIENT }),
    cabbageOuter: new THREE.MeshToonMaterial({ color: 0x6db94e, gradientMap: TOON_GRADIENT }),
    cabbageInner: new THREE.MeshToonMaterial({ color: 0xa4d680, gradientMap: TOON_GRADIENT }),
  };
}

// Build the tilled-soil overlay — a thin dark patch that sits above the
// planter's existing soil block when the soil has been worked. Reused
// across stages (always visible while not 'empty').
function buildTilledOverlay() {
  ensureMaterials();
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.02, 0.78),
    MATERIALS.soilWet,
  );
  m.position.set(0, SOIL_TOP_Y + 0.005, 0);
  m.receiveShadow = true;
  return m;
}

// Build the sprout silhouette — same for all crops, just a tiny green nub.
// Visible during the first growth quarter so even a seconds-old plant has
// something on it.
function buildSproutMesh() {
  ensureMaterials();
  const g = new THREE.Group();
  const blade = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.10, 5),
    MATERIALS.sprout,
  );
  blade.position.set(0, SOIL_TOP_Y + 0.05, 0);
  blade.castShadow = true;
  g.add(blade);
  return g;
}

// Per-crop mature mesh. Built procedurally — the plan §2 calls out the
// Quaternius pack as nice-to-have but the atlas mismatch makes a procedural
// look acceptable for v1. Each crop's silhouette must be distinguishable
// at gameplay distance (top-down ~6m camera).
function buildCropMesh(kind) {
  ensureMaterials();
  const g = new THREE.Group();
  if (kind === 'wheat') {
    // Five tall yellow stalks splayed outward. Reads as a small wheat
    // bush; the tip "head" mesh thickens at the top for a barley-ish
    // silhouette.
    const stalkGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.45, 5);
    const headGeo = new THREE.CylinderGeometry(0.038, 0.018, 0.14, 6);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const r = 0.10;
      const stalk = new THREE.Mesh(stalkGeo, MATERIALS.wheatStalk);
      stalk.position.set(Math.cos(a) * r, SOIL_TOP_Y + 0.225, Math.sin(a) * r);
      stalk.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.08;
      stalk.castShadow = true;
      g.add(stalk);
      const head = new THREE.Mesh(headGeo, MATERIALS.wheatHead);
      head.position.set(Math.cos(a) * r, SOIL_TOP_Y + 0.50, Math.sin(a) * r);
      head.castShadow = true;
      g.add(head);
    }
    return g;
  }
  if (kind === 'carrot') {
    // Visible orange root tip poking up out of the soil + a fan of green
    // leaves above. The signature "carrot" silhouette is mostly the leaves
    // since the root would be underground in real life — we cheat the root
    // up so it reads from a top-down angle.
    const root = new THREE.Mesh(
      new THREE.ConeGeometry(0.10, 0.20, 6),
      MATERIALS.carrotRoot,
    );
    root.position.set(0, SOIL_TOP_Y + 0.05, 0);
    root.rotation.x = Math.PI;
    root.castShadow = true;
    g.add(root);
    // Leaves — three crossed planes give a fan look without a leaf texture.
    const leafGeo = new THREE.BoxGeometry(0.06, 0.30, 0.014);
    for (let i = 0; i < 3; i++) {
      const leaf = new THREE.Mesh(leafGeo, i === 1 ? MATERIALS.leafDark : MATERIALS.leafLight);
      leaf.position.set(0, SOIL_TOP_Y + 0.22, 0);
      leaf.rotation.y = (i / 3) * Math.PI;
      leaf.rotation.z = 0.18 * (i - 1);
      leaf.castShadow = true;
      g.add(leaf);
    }
    return g;
  }
  if (kind === 'pumpkin') {
    // Single squashed orange sphere with a stubby stem. Slight rotation
    // gives the body the recognisable ribbed look at gameplay distance.
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.30, 12, 8),
      MATERIALS.pumpkinFlesh,
    );
    body.scale.set(1, 0.72, 1);
    body.position.set(0, SOIL_TOP_Y + 0.18, 0);
    body.castShadow = true;
    g.add(body);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.06, 0.12, 5),
      MATERIALS.pumpkinStem,
    );
    stem.position.set(0, SOIL_TOP_Y + 0.40, 0);
    stem.castShadow = true;
    g.add(stem);
    return g;
  }
  if (kind === 'cabbage') {
    // Three nested green spheres scaled tighter inward — crude but reads
    // as a cabbage head from above. Outer sphere is the loose leaves.
    const outer = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.28, 0),
      MATERIALS.cabbageOuter,
    );
    outer.scale.set(1, 0.78, 1);
    outer.position.set(0, SOIL_TOP_Y + 0.18, 0);
    outer.castShadow = true;
    g.add(outer);
    const mid = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.21, 0),
      MATERIALS.cabbageOuter,
    );
    mid.scale.set(1, 0.72, 1);
    mid.position.set(0, SOIL_TOP_Y + 0.20, 0);
    mid.castShadow = true;
    g.add(mid);
    const inner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.13, 0),
      MATERIALS.cabbageInner,
    );
    inner.scale.set(1, 0.7, 1);
    inner.position.set(0, SOIL_TOP_Y + 0.22, 0);
    inner.castShadow = true;
    g.add(inner);
    return g;
  }
  return g;
}

// Inclusive integer roll using the seeded utils RNG so the same world seed
// produces the same harvest yields if the future save/replay system needs
// determinism. Caller-supplied lo/hi are clamped to >=0.
function intRoll(range) {
  const lo = Math.max(0, Math.floor(range[0] || 0));
  const hi = Math.max(lo, Math.floor(range[1] || 0));
  if (hi === lo) return lo;
  return lo + Math.floor(defaultRandom() * (hi - lo + 1));
}

export class Crop {
  // `planterMesh` is the structure mesh built by buildStructureMesh('planter')
  // — we mount our crop sub-meshes into a child Group so chunk unload
  // disposes them automatically with the planter.
  // `planterPos` is the world (x,z) of the planter centre (used for harvest
  // drops).
  // `chunkKey` mirrors the structure's chunkKey so Game can sim-gate
  // growth via world.simKeys.
  constructor(planterMesh, planterPos, chunkKey) {
    this.planterMesh = planterMesh || null;
    this.pos = { x: planterPos.x, z: planterPos.z };
    this.chunkKey = chunkKey || null;
    // Lifecycle.
    this.state = 'empty';                  // 'empty' | 'tilled' | 'growing' | 'mature' | 'harvested'
    this.cropKind = null;                  // 'wheat' | 'carrot' | 'pumpkin' | 'cabbage'
    this.growProgressMs = 0;
    this.growMs = 0;
    // Visual children — kept around so a state change is a visibility flip
    // not a rebuild.
    this._mountGroup = null;
    this._tilledOverlay = null;
    this._sproutMesh = null;
    this._cropMesh = null;
    this._cropMeshKind = null;
    if (this.planterMesh) this._buildMount();
  }

  // Create the soil-mount group as a child of the planter's mesh. Returns
  // early if no planter mesh — used in tests that exercise lifecycle in
  // isolation.
  _buildMount() {
    this._mountGroup = new THREE.Group();
    this.planterMesh.add(this._mountGroup);
    this._tilledOverlay = buildTilledOverlay();
    this._tilledOverlay.visible = false;
    this._mountGroup.add(this._tilledOverlay);
  }

  // Clean up any per-crop mesh + material references. Called by Game when
  // the planter is destroyed (player swung it down) — the planter's group
  // gets removed by the chunk teardown anyway, but this drops our refs
  // proactively so a long session doesn't leak.
  destroy() {
    this._cropMesh = null;
    this._sproutMesh = null;
    this._tilledOverlay = null;
    this._mountGroup = null;
    this.planterMesh = null;
  }

  // True if the planter currently expects a player-driven action (till,
  // plant, harvest, reset). Used by Game._nearbyInteractFor to surface
  // a context-sensitive prompt.
  hasPendingAction() {
    return this.state === 'empty' || this.state === 'tilled' || this.state === 'mature' || this.state === 'harvested';
  }

  // User-facing label for the prompt next to the planter, matching the
  // chest "Open chest" UX. Different from the verbose Russian inspect
  // label so the toast stays terse.
  promptLabel() {
    switch (this.state) {
      case 'empty':    return 'Вспахать землю';
      case 'tilled':   return 'Посадить';
      case 'growing':  return null;   // no prompt while growing
      case 'mature':   return 'Собрать урожай';
      case 'harvested':return 'Очистить грядку';
      default:         return null;
    }
  }

  // Player just pressed E/J on this planter. `selectedKind` is the crop
  // kind they have selected to plant (used only when transitioning from
  // tilled → growing). Returns an outcome object the caller routes:
  //
  //   { kind: 'till',    sound: 'till' }
  //   { kind: 'plant',   sound: 'plant',  cropKind }
  //   { kind: 'noseed',  sound: null,     toast: '...' }
  //   { kind: 'harvest', sound: 'harvest', cropKind, food, seeds }
  //   { kind: 'reset',   sound: null }
  //   { kind: null }   — no transition (e.g. interact while growing)
  //
  // World-side state (resources pool, food drops) is mutated by Game per
  // outcome so the Crop class stays free of cross-system imports.
  interact(selectedKind, resources) {
    if (this.state === 'empty') {
      this.state = 'tilled';
      if (this._tilledOverlay) this._tilledOverlay.visible = true;
      return { kind: 'till' };
    }
    if (this.state === 'tilled') {
      const seedCount = (resources?.seeds || 0);
      if (seedCount <= 0) {
        return { kind: 'noseed', toast: 'Нет семян — открой сундуки.' };
      }
      const cropKind = (selectedKind && CROPS[selectedKind]) ? selectedKind : 'wheat';
      // Consume one fungible seed from the shared pool.
      resources.seeds = Math.max(0, seedCount - 1);
      this.cropKind = cropKind;
      this.growMs = CROPS[cropKind].growMs;
      this.growProgressMs = 0;
      this.state = 'growing';
      this._showSprout();
      return { kind: 'plant', cropKind };
    }
    if (this.state === 'mature') {
      const cropKind = this.cropKind;
      const def = CROPS[cropKind] || CROPS.wheat;
      const food = intRoll(def.foodAmount);
      const seeds = intRoll(def.seedReturn);
      this.state = 'harvested';
      this._hideStageMeshes();
      // Tilled overlay stays — soil is still freshly turned, just empty.
      if (this._tilledOverlay) this._tilledOverlay.visible = true;
      return { kind: 'harvest', cropKind, food, seeds };
    }
    if (this.state === 'harvested') {
      this.state = 'empty';
      this.cropKind = null;
      this.growProgressMs = 0;
      this.growMs = 0;
      if (this._tilledOverlay) this._tilledOverlay.visible = false;
      this._hideStageMeshes();
      return { kind: 'reset' };
    }
    return { kind: null };
  }

  // Per-frame growth update. `dt` is in seconds (game-time, post-pause); the
  // caller should only invoke us when the planter's chunk is in
  // world.simKeys so off-screen farms don't tick at full rate. Re-renders
  // the visible mesh at integer stage transitions so we don't rebuild
  // every frame.
  update(dt) {
    if (this.state !== 'growing') return;
    this.growProgressMs += dt * 1000;
    const progress = Math.min(1, this.growProgressMs / Math.max(1, this.growMs));
    this._refreshGrowingStage(progress);
    if (progress >= 1) {
      this.state = 'mature';
      this._showMature();
    }
  }

  // Snapshot of the crop's persistable state — written into the placedStructures
  // descriptor every time interact() flips state, and on every growth-stage
  // transition. The shape is intentionally JSON-clean.
  toDescriptor() {
    return {
      state: this.state,
      cropKind: this.cropKind,
      growProgressMs: this.growProgressMs,
      growMs: this.growMs,
    };
  }

  // Restore visible state after a chunk reload from the descriptor saved
  // by toDescriptor(). Caller passes the planter's mesh (newly built);
  // we re-hydrate visible meshes lazily.
  loadFromDescriptor(desc) {
    if (!desc) return;
    this.state = desc.state || 'empty';
    this.cropKind = desc.cropKind || null;
    this.growProgressMs = desc.growProgressMs || 0;
    this.growMs = desc.growMs || 0;
    if (this.state === 'empty') {
      if (this._tilledOverlay) this._tilledOverlay.visible = false;
      this._hideStageMeshes();
      return;
    }
    if (this._tilledOverlay) this._tilledOverlay.visible = true;
    this._hideStageMeshes();
    if (this.state === 'growing') {
      const progress = Math.min(1, this.growProgressMs / Math.max(1, this.growMs));
      this._refreshGrowingStage(progress);
    } else if (this.state === 'mature') {
      this._showMature();
    }
  }

  // ---- Visual helpers --------------------------------------------------

  _hideStageMeshes() {
    if (this._sproutMesh) this._sproutMesh.visible = false;
    if (this._cropMesh) this._cropMesh.visible = false;
  }

  _showSprout() {
    if (!this._mountGroup) return;
    if (!this._sproutMesh) {
      this._sproutMesh = buildSproutMesh();
      this._mountGroup.add(this._sproutMesh);
    }
    this._sproutMesh.visible = true;
    this._sproutMesh.scale.setScalar(0.5);          // tiny on first reveal
    if (this._cropMesh) this._cropMesh.visible = false;
    if (this._tilledOverlay) this._tilledOverlay.visible = true;
  }

  // Pick the appropriate visible mesh for the given normalised growth
  // progress (0..1). The first quarter shows a sprout; later stages show a
  // scaled-down version of the mature crop mesh, growing into full size.
  _refreshGrowingStage(progress) {
    if (!this._mountGroup) return;
    const stageIdx = Math.min(GROWTH_STAGES, Math.floor(progress * (GROWTH_STAGES + 1)));
    if (stageIdx <= 0) {
      this._showSprout();
      return;
    }
    if (stageIdx < GROWTH_STAGES) {
      // Mid-growth: show crop mesh scaled by stage fraction.
      this._ensureCropMesh();
      if (this._sproutMesh) this._sproutMesh.visible = false;
      this._cropMesh.visible = true;
      const fraction = 0.4 + (stageIdx / GROWTH_STAGES) * 0.55;
      this._cropMesh.scale.setScalar(fraction);
    } else {
      this._showMature();
    }
  }

  _showMature() {
    this._ensureCropMesh();
    if (this._sproutMesh) this._sproutMesh.visible = false;
    if (this._cropMesh) {
      this._cropMesh.visible = true;
      this._cropMesh.scale.setScalar(1);
    }
  }

  _ensureCropMesh() {
    if (!this._mountGroup || !this.cropKind) return;
    if (this._cropMesh && this._cropMeshKind === this.cropKind) return;
    if (this._cropMesh && this._cropMeshKind !== this.cropKind) {
      // Crop kind changed (rare — only via descriptor load). Drop old mesh.
      this._mountGroup.remove(this._cropMesh);
      this._cropMesh = null;
    }
    this._cropMesh = buildCropMesh(this.cropKind);
    this._cropMesh.scale.setScalar(0.5);
    // Slight random yaw so a row of identical crops doesn't read as a
    // perfectly aligned grid.
    this._cropMesh.rotation.y = rand(0, Math.PI * 2);
    this._mountGroup.add(this._cropMesh);
    this._cropMeshKind = this.cropKind;
  }
}
