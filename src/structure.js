// Player-placed structures: fences, walls, gates, planters.
//
// Structures are placed via build-mode (see src/buildMode.js) and consume
// from the shared `world.resources` pool. They live inside the chunk's
// THREE.Group like trees and rocks, so chunk unload disposes their meshes
// cleanly. Their *state* (kind, yaw, hp) is mirrored in
// `world.placedStructures` (a Map keyed by chunkKey) so that on chunk
// reload the structures are re-instantiated rather than regenerated from
// the world seed — this is what makes a player-built fortress survive
// being walked away from and back to.
//
// Structures are damageables (HP, takeDamage contract) so enemies can
// eventually break them — that's the M4 wall-blocks-enemies milestone. For
// now, they only take damage from players (a friendly-fire side-effect of
// being in the swing damageables list).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TOON_GRADIENT } from './shading.js';

// Procedural materials cached and shared across all structures of a kind so
// long sessions don't accumulate THREE.Material allocations.
let MATERIALS = null;
function ensureMaterials() {
  if (MATERIALS) return;
  MATERIALS = {
    wood: new THREE.MeshToonMaterial({ color: 0x8c5a2c, gradientMap: TOON_GRADIENT }),
    woodDark: new THREE.MeshToonMaterial({ color: 0x6b4023, gradientMap: TOON_GRADIENT }),
    stone: new THREE.MeshToonMaterial({ color: 0xa6acb6, gradientMap: TOON_GRADIENT }),
    stoneDark: new THREE.MeshToonMaterial({ color: 0x6e7280, gradientMap: TOON_GRADIENT }),
    soil: new THREE.MeshToonMaterial({ color: 0x4b3522, gradientMap: TOON_GRADIENT }),
  };
}

// Recipe table — what each structure costs to place and how durable it is.
// Cost is read from `world.resources` and decremented atomically; HP is the
// structure's starting hit-points (currently only matters when the player
// hits their own structure with a sword, but reserved for M4 enemies).
//
// `radius` is the collision radius added to the chunk's collider list. We
// keep it under 0.5m for fences (so two fences placed adjacent at 1m
// spacing don't overlap) and ~0.7m for walls (denser, harder to push past).
//
// `name` is the user-facing label shown in the build catalog HUD.
export const RECIPES = {
  fence: {
    name: 'Забор',
    cost: { wood: 1 },
    hp: 30,
    radius: 0.45,
    height: 1.0,
  },
  wall: {
    name: 'Стена',
    cost: { stone: 4 },
    hp: 100,
    // Inscribed-circle radius for a 1m square block. With player
    // radius 0.55 this leaves a small clearance at cell edges so two
    // walls flanking a 1m gate gap don't pinch the player out of the
    // gap — the gate cell at x=0 between walls at x=±1 has 0.10m of
    // breathing room (sum of radii 0.95 vs centre-to-centre distance
    // 1.0). Visually the player still touches the wall surface.
    radius: 0.40,
    height: 1.6,
  },
  gate: {
    name: 'Калитка',
    cost: { wood: 2, stone: 1 },
    hp: 40,
    // Fence-style form factor — matches fence's collider so a gate
    // dropped into a fence run aligns visually + spatially. Open/closed
    // toggling shrinks this to GATE_OPEN_RADIUS (0.12) at runtime so the
    // player can walk through without hitting an invisible wall.
    radius: 0.45,
    height: 1.10,
  },
  planter: {
    name: 'Грядка',
    cost: { wood: 3 },
    hp: 20,
    radius: 0.0,                  // walk-through; M3 farming uses E to till / plant
    height: 0.35,
  },
};

// Catalog ordering controls the recipe-cycling order in build mode and the
// number-key bindings (1..4 for P1, 7..0 for P2). Keep the cheapest /
// quickest builds first so a new player can spam fences immediately.
export const RECIPE_ORDER = ['fence', 'wall', 'gate', 'planter'];

// Burst colour shown when a structure is destroyed — matches its primary
// material. Reused by Game._onStructureDestroyed for the death VFX.
const BURST_COLOR = {
  fence: 0x8c5a2c,
  wall: 0x9aa0a8,
  gate: 0x6b4023,
  planter: 0x4b3522,
};

// True if `world.resources` currently has enough of every ingredient to
// afford the given recipe. Pure read — does NOT mutate the pool.
export function canAfford(resources, recipeKind) {
  const recipe = RECIPES[recipeKind];
  if (!recipe || !resources) return false;
  for (const [k, v] of Object.entries(recipe.cost)) {
    if ((resources[k] || 0) < v) return false;
  }
  return true;
}

// Subtract the recipe's cost from `world.resources`. Caller must check
// `canAfford` first; this routine clamps each field at 0 just to be defensive.
export function spendCost(resources, recipeKind) {
  const recipe = RECIPES[recipeKind];
  if (!recipe || !resources) return;
  for (const [k, v] of Object.entries(recipe.cost)) {
    resources[k] = Math.max(0, (resources[k] || 0) - v);
  }
}

// Collider radius used by an *open* gate. Just thick enough that a player
// can't pass through the post itself, but thin enough that the rest of
// the cell is freely walkable. Closed gates use the recipe's radius.
export const GATE_OPEN_RADIUS = 0.12;

// Shared rail-arm geometry constants used by both fence and gate meshes.
// Arm extends from the post's outer face (x=±0.10) to the cell boundary
// (x=±0.5), so two arms from neighbouring fence-connectables meet flush
// at the seam without overlap or z-fighting. Two stacked rails per arm
// at 0.30m / 0.75m gives a "Minecraft fence" silhouette.
const _ARM_LEN = 0.40;
const _ARM_OFFSET = 0.30;        // centre of arm
const _RAIL_THICK = 0.06;
const _RAIL_HEIGHT = 0.08;
const _RAIL_HEIGHTS = [0.30, 0.75];

// Append the four cardinal connection arms to a fence-style group based
// on the {N,S,E,W} mask. Pulled out so `buildFenceMesh` and
// `buildGateMesh` share one rail layout — ensures gate arms meet
// neighbour-fence arms at exactly the same seam coordinates.
function _addFenceArms(group, connections) {
  const c = connections || { N: false, S: false, E: false, W: false };
  for (const yOff of _RAIL_HEIGHTS) {
    if (c.E) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(_ARM_LEN, _RAIL_HEIGHT, _RAIL_THICK),
        MATERIALS.wood,
      );
      r.position.set(+_ARM_OFFSET, yOff, 0);
      r.castShadow = true; r.receiveShadow = true;
      group.add(r);
    }
    if (c.W) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(_ARM_LEN, _RAIL_HEIGHT, _RAIL_THICK),
        MATERIALS.wood,
      );
      r.position.set(-_ARM_OFFSET, yOff, 0);
      r.castShadow = true; r.receiveShadow = true;
      group.add(r);
    }
    if (c.N) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(_RAIL_THICK, _RAIL_HEIGHT, _ARM_LEN),
        MATERIALS.wood,
      );
      r.position.set(0, yOff, -_ARM_OFFSET);
      r.castShadow = true; r.receiveShadow = true;
      group.add(r);
    }
    if (c.S) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(_RAIL_THICK, _RAIL_HEIGHT, _ARM_LEN),
        MATERIALS.wood,
      );
      r.position.set(0, yOff, +_ARM_OFFSET);
      r.castShadow = true; r.receiveShadow = true;
      group.add(r);
    }
  }
}

// Build a Minecraft-style fence mesh: a single centre post plus up to
// four short horizontal rail "arms" pointing N/S/E/W toward neighbouring
// fence-connectable cells (fences, walls, gates). `connections` is
// `{ N, S, E, W }` booleans; missing keys default to false. Each arm is
// two stacked rails that meet flush with the cell boundary, so two
// adjacent fence/gate arms touch at the seam without any visible gap.
// Without arms (an isolated fence) the silhouette is just the post.
export function buildFenceMesh(connections) {
  ensureMaterials();
  const g = new THREE.Group();
  // Centre post — chunkier than the old plank's posts (0.20×0.20 vs
  // 0.10×0.10) so it actually reads as a fence post rather than a
  // splinter. Sits in the cell centre, height 1.0m to match the recipe.
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.20, 1.0, 0.20),
    MATERIALS.woodDark,
  );
  post.position.set(0, 0.50, 0);
  post.castShadow = true; post.receiveShadow = true;
  g.add(post);
  _addFenceArms(g, connections);
  return g;
}

// Build a Minecraft-style fence gate mesh. The gate has NO posts of its
// own — the player puts fences/walls in the adjacent cells, and those
// neighbour structures provide the visible end-caps that the gate's
// door appears to hang between. The gate cell itself contains only the
// door panel: 2 horizontal rails + a centre vertical bridge + slim
// hinge / latch pins at each end. The whole gate is later rotated by
// `yaw` from the calling code, so a yaw=π/2 gate has its door axis
// flipped 90° and swings perpendicular.
//
// `openDir`:
//   0  → closed (door spans the full cell width)
//   +1 → open, door swings toward gate-local +Z
//   -1 → open, door swings toward gate-local -Z
//
// The caller (game.js's gate-interact handler) picks the sign so the
// door always opens AWAY from the player who pressed E, exactly like
// Minecraft. Collider radius is shrunk to GATE_OPEN_RADIUS in game.js
// when openDir != 0 so the player can walk through.
export function buildGateMesh(openDir) {
  ensureMaterials();
  const g = new THREE.Group();
  // Door panel hinged on the gate cell's west boundary. The hinge sits
  // exactly at gate-local x=-0.50 so a fence arm coming in from the
  // west cell meets it flush. Children of `door` use door-local
  // coordinates: x=0 at the hinge, x=1 at the latch end.
  const door = new THREE.Group();
  door.position.set(-0.50, 0, 0);
  // Two horizontal rails span the full cell width when closed.
  const railGeo = new THREE.BoxGeometry(1.00, 0.10, 0.06);
  const topRail = new THREE.Mesh(railGeo, MATERIALS.wood);
  topRail.position.set(0.50, 0.85, 0);
  topRail.castShadow = true; topRail.receiveShadow = true;
  door.add(topRail);
  const botRail = new THREE.Mesh(railGeo, MATERIALS.wood);
  botRail.position.set(0.50, 0.30, 0);
  botRail.castShadow = true; botRail.receiveShadow = true;
  door.add(botRail);
  // Centre vertical bar bridges the rails — Minecraft's gate has it.
  const centerBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.50, 0.06),
    MATERIALS.wood,
  );
  centerBar.position.set(0.50, 0.575, 0);
  centerBar.castShadow = true; centerBar.receiveShadow = true;
  door.add(centerBar);
  // Slim hinge pin at the door's west edge — sits flush with the cell
  // boundary so a neighbouring fence's east arm meets it without a
  // gap. Slimmer than a fence post (0.06 vs 0.20) so it reads as part
  // of the door panel, not a standalone post. Same wood material as
  // the rails / latch so the gate reads as one uniform piece.
  const hingePin = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.85, 0.06),
    MATERIALS.wood,
  );
  hingePin.position.set(0.03, 0.575, 0);
  hingePin.castShadow = true; hingePin.receiveShadow = true;
  door.add(hingePin);
  // Slim latch pin at the door's east edge — same role on the other
  // side. Slightly lighter wood so the latch silhouette is readable.
  const latchPin = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.85, 0.06),
    MATERIALS.wood,
  );
  latchPin.position.set(0.97, 0.575, 0);
  latchPin.castShadow = true; latchPin.receiveShadow = true;
  door.add(latchPin);
  if (openDir > 0) door.rotation.y = -Math.PI / 2;
  else if (openDir < 0) door.rotation.y = +Math.PI / 2;
  g.add(door);
  return g;
}

// Deterministic uint32 hash from integer (x,z). Used to seed the
// per-wall vertex displacement on the stone geometry below so two
// walls at different cells don't look identical but each individual
// wall is stable across chunk reloads (no Math.random churn).
function _stoneHash(x, z) {
  let h = ((x | 0) * 374761393 + (z | 0) * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0);
}

// Per-cell stone variation params keyed off (x,z) — gives each wall
// slightly different proportions and yaw so a row of walls doesn't
// look like clones, while staying stable across reloads. Returns
// { sx, sy, sz, yaw } where the scales sit in [~0.92..0.98] and yaw
// is one of 0 / π/2 / π / 3π/2 (so the chamfer corners read as
// straight edges, not diagonals).
function _stoneVariation(x, z) {
  let seed = _stoneHash(x | 0, z | 0) || 1;
  const rand = () => {
    seed = ((seed * 1664525) + 1013904223) | 0;
    return ((seed >>> 0) / 0x100000000);
  };
  const sx = 0.97 + rand() * 0.03;   // 0.97..1.00
  const sy = 0.95 + rand() * 0.05;
  const sz = 0.97 + rand() * 0.03;
  const yaw = (Math.floor(rand() * 4) | 0) * (Math.PI / 2);
  return { sx, sy, sz, yaw };
}

// Build a procedural mesh for one structure. Geometry is per-call so
// each instance gets its own (small) buffers — this is fine for the
// expected handful-of-structures-per-chunk usage. Materials are shared.
//
// `x` and `z` are the world-space cell centre (optional); when present,
// kinds that vary per-instance (currently only `wall`'s crack pattern)
// hash them for deterministic variation. Ghost previews call without
// (x,z) so they don't show cracks.
//
// Returns a THREE.Group positioned at the origin; caller positions the
// group at the world (x,z) and yaw, then parents into the chunk group.
export function buildStructureMesh(kind, x, z) {
  ensureMaterials();
  const g = new THREE.Group();
  if (kind === 'fence') {
    // Default fence preview: just the centre post (no connector arms).
    // Live fences in the world get arms attached by `buildFenceMesh()`
    // below, called from game.js once neighbour fences are known. The
    // ghost preview keeps this minimal silhouette so the player can
    // see where the post will land before committing.
    return buildFenceMesh({ N: false, E: false, S: false, W: false });
  }
  if (kind === 'wall') {
    // One chunky stone block per cell. Reads as a cube with clearly
    // visible chamfered edges (RoundedBoxGeometry r=0.10 — still
    // cube-shaped, but the bevel reads at any camera distance).
    // Geometry fills the full 1m grid cell so a row of walls leaves
    // only a thin shadow gap between blocks. Per-cell deterministic
    // variation in scale + yaw keeps a row from looking cloned;
    // ghost preview falls back to (0,0).
    const wx = (typeof x === 'number') ? x : 0;
    const wz = (typeof z === 'number') ? z : 0;
    const v = _stoneVariation(wx, wz);
    const stone = new THREE.Mesh(
      new RoundedBoxGeometry(1.00, 1.05, 1.00, 2, 0.10),
      MATERIALS.stone,
    );
    stone.scale.set(v.sx, v.sy, v.sz);
    stone.rotation.y = v.yaw;
    // Lift so the stone bottom sits at the ground. Half-height ≈
    // 0.525 × sy; setting y=0.525 lets the slight `sy<1` keep the
    // bbox a hair above ground (avoids z-fighting on the ground
    // plane).
    stone.position.set(0, 0.525, 0);
    stone.castShadow = true; stone.receiveShadow = true;
    g.add(stone);
    return g;
  }
  if (kind === 'gate') {
    // Default gate preview: closed. Live gates get rebuilt by
    // `buildGateMesh()` from game.js when their open state is toggled.
    return buildGateMesh(0);
  }
  if (kind === 'planter') {
    // Low rectangular wooden frame around a square of dark soil. Empty
    // for M2 — M3 farming will swap in crop meshes per growth stage.
    const frameGeo = new THREE.BoxGeometry(1.00, 0.20, 0.10);
    for (const [pos, rot] of [
      [{ x: 0, z: -0.45 }, 0],
      [{ x: 0, z:  0.45 }, 0],
      [{ x: -0.45, z: 0 }, Math.PI / 2],
      [{ x:  0.45, z: 0 }, Math.PI / 2],
    ]) {
      const side = new THREE.Mesh(frameGeo, MATERIALS.wood);
      side.position.set(pos.x, 0.10, pos.z);
      side.rotation.y = rot;
      side.castShadow = true; side.receiveShadow = true;
      g.add(side);
    }
    const soil = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.10, 0.85),
      MATERIALS.soil,
    );
    soil.position.set(0, 0.05, 0);
    soil.receiveShadow = true;
    g.add(soil);
    return g;
  }
  // Unknown kind — return an empty group so caller's parenting logic still
  // works without conditional null-checks.
  return g;
}

// Lightweight ghost-preview material: the same procedural mesh, but with
// every child material swapped to a translucent variant. The recipient is
// the build controller; once placed, the actual structure mesh is built
// fresh (so material sharing isn't broken by the per-ghost transparency).
export function makeGhostMesh(kind, affordable = true) {
  const real = buildStructureMesh(kind);
  const tint = affordable ? 0x6cf28a : 0xff5b5b;
  real.traverse((child) => {
    if (child.isMesh) {
      child.material = new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });
  return real;
}

export class Structure {
  // `mesh` is the pre-built procedural group, already positioned + rotated
  // and parented into the chunk's group by the placement code. We keep a
  // reference so we can hide/destroy it on death.
  // `collider` is the chunk-level {x,z,r} entry; spliced out on death.
  // `hp` allows reload from persisted state to skip back to mid-damage.
  constructor(scene, x, z, kind, yaw, hp, mesh, chunkKey, collider, colliderArray, group) {
    this.scene = scene;
    this.kind = kind;
    this.pos = { x, z };
    this.yaw = yaw;
    this.alive = true;
    this.isStructure = true;
    this.maxHP = RECIPES[kind]?.hp || 30;
    this.hp = (typeof hp === 'number' && hp > 0) ? Math.min(hp, this.maxHP) : this.maxHP;
    this.radius = RECIPES[kind]?.radius || 0.5;
    this.mesh = mesh || null;
    this.chunkKey = chunkKey || null;
    this.collider = collider || null;
    this.colliderArray = colliderArray || null;
    this.group = group || null;
    // Damage feedback: subtle wobble, decays over ~0.3s.
    this._shake = 0;
    this._shakeT = Math.random() * Math.PI * 2;
    if (this.mesh) {
      this._restRotZ = this.mesh.rotation.z;
    } else {
      this._restRotZ = 0;
    }
  }

  // Standard damageable contract — same shape as Enemy / Breakable / Resource.
  takeDamage(amount /* number */, _fromX, _fromZ, _knockback) {
    if (!this.alive) return false;
    const dmg = Math.max(1, Math.floor(amount || 1));
    this.hp = Math.max(0, this.hp - dmg);
    this._shake = Math.min(0.10, this._shake + 0.03 + dmg * 0.001);
    if (this.hp <= 0) this.alive = false;
    return true;
  }

  update(dt) {
    if (!this.mesh || this._shake <= 0.0001) return;
    this._shakeT += dt * 22;
    const offset = Math.sin(this._shakeT) * this._shake;
    this.mesh.rotation.z = this._restRotZ + offset;
    this._shake *= Math.pow(0.001, dt);
    if (this._shake < 0.001) {
      this._shake = 0;
      this.mesh.rotation.z = this._restRotZ;
    }
  }

  // Splice the chunk-level collider so the broken structure stops blocking
  // movement. World.colliders is rebuilt every frame from chunk.colliders so
  // by next tick it's gone from collision queries.
  removeCollider() {
    if (!this.colliderArray || !this.collider) return;
    const idx = this.colliderArray.indexOf(this.collider);
    if (idx >= 0) this.colliderArray.splice(idx, 1);
  }

  // Detach the procedural mesh from the chunk group. Doesn't dispose the
  // geometry — the chunk's normal teardown will handle it on chunk unload,
  // and per-structure disposal would risk freeing geometry shared with
  // ghost previews.
  destroyMesh() {
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.mesh = null;
  }

  burstColor() {
    return BURST_COLOR[this.kind] || 0xffffff;
  }
}
