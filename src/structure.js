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
import { TOON_GRADIENT } from './shading.js';

// Procedural materials cached and shared across all structures of a kind so
// long sessions don't accumulate THREE.Material allocations.
let MATERIALS = null;
function ensureMaterials() {
  if (MATERIALS) return;
  MATERIALS = {
    wood: new THREE.MeshToonMaterial({ color: 0x8c5a2c, gradientMap: TOON_GRADIENT }),
    woodDark: new THREE.MeshToonMaterial({ color: 0x6b4023, gradientMap: TOON_GRADIENT }),
    stone: new THREE.MeshToonMaterial({ color: 0x9aa0a8, gradientMap: TOON_GRADIENT }),
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
    radius: 0.70,
    height: 1.6,
  },
  gate: {
    name: 'Ворота',
    cost: { wood: 4, stone: 1 },
    hp: 60,
    radius: 0.60,
    height: 1.7,
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

// Build a Minecraft-style fence mesh: a single centre post plus up to
// four short horizontal rail "arms" pointing N/S/E/W toward neighbouring
// fence cells. `connections` is `{ N, S, E, W }` booleans; missing keys
// default to false. Each arm is two stacked rails that meet flush with
// the cell boundary (x=±0.5 / z=±0.5), so two adjacent fences' arms
// touch at the seam without any visible gap. Without arms (an isolated
// fence) the silhouette is just the post — cleaner than the old plank
// strip and identical regardless of placement yaw.
export function buildFenceMesh(connections) {
  ensureMaterials();
  const g = new THREE.Group();
  const c = connections || { N: false, S: false, E: false, W: false };
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
  // Arm geometry — extends from the post's outer face (x=±0.10) to the
  // cell boundary (x=±0.5), so two arms from neighbouring fences meet
  // flush at the seam without overlap or z-fighting.
  const ARM_LEN = 0.40;
  const ARM_OFFSET = 0.30;        // centre of arm
  const RAIL_THICK = 0.06;
  const RAIL_HEIGHT = 0.08;
  const RAIL_HEIGHTS = [0.30, 0.75];
  for (const yOff of RAIL_HEIGHTS) {
    if (c.E) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(ARM_LEN, RAIL_HEIGHT, RAIL_THICK),
        MATERIALS.wood,
      );
      r.position.set(+ARM_OFFSET, yOff, 0);
      r.castShadow = true; r.receiveShadow = true;
      g.add(r);
    }
    if (c.W) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(ARM_LEN, RAIL_HEIGHT, RAIL_THICK),
        MATERIALS.wood,
      );
      r.position.set(-ARM_OFFSET, yOff, 0);
      r.castShadow = true; r.receiveShadow = true;
      g.add(r);
    }
    if (c.N) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(RAIL_THICK, RAIL_HEIGHT, ARM_LEN),
        MATERIALS.wood,
      );
      r.position.set(0, yOff, -ARM_OFFSET);
      r.castShadow = true; r.receiveShadow = true;
      g.add(r);
    }
    if (c.S) {
      const r = new THREE.Mesh(
        new THREE.BoxGeometry(RAIL_THICK, RAIL_HEIGHT, ARM_LEN),
        MATERIALS.wood,
      );
      r.position.set(0, yOff, +ARM_OFFSET);
      r.castShadow = true; r.receiveShadow = true;
      g.add(r);
    }
  }
  return g;
}

// Build a procedural mesh for one structure. Geometry is per-call so
// each instance gets its own (small) buffers — this is fine for the
// expected handful-of-structures-per-chunk usage. Materials are shared.
//
// Returns a THREE.Group positioned at the origin; caller positions the
// group at the world (x,z) and yaw, then parents into the chunk group.
export function buildStructureMesh(kind) {
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
    // Solid stone block that fills its 1m grid cell. Slightly inset so
    // adjacent walls don't z-fight at the seam.
    const main = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 1.6, 0.95),
      MATERIALS.stone,
    );
    main.position.set(0, 0.80, 0);
    main.castShadow = true; main.receiveShadow = true;
    g.add(main);
    // Cap on top in a darker stone — gives the silhouette more life from
    // a top-down camera without an extra GLB.
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(1.00, 0.10, 1.00),
      MATERIALS.stoneDark,
    );
    cap.position.set(0, 1.65, 0);
    cap.castShadow = true; cap.receiveShadow = true;
    g.add(cap);
    return g;
  }
  if (kind === 'gate') {
    // A doorway-shaped frame with a wooden door panel. Currently solid
    // (walks like a wall); M2 follow-up will add an open/close interaction
    // so players can pass through. Frame is two stone columns + lintel.
    const colGeo = new THREE.BoxGeometry(0.18, 1.7, 0.22);
    for (const xOff of [-0.42, 0.42]) {
      const col = new THREE.Mesh(colGeo, MATERIALS.stone);
      col.position.set(xOff, 0.85, 0);
      col.castShadow = true; col.receiveShadow = true;
      g.add(col);
    }
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(1.00, 0.18, 0.30),
      MATERIALS.stoneDark,
    );
    lintel.position.set(0, 1.60, 0);
    lintel.castShadow = true; lintel.receiveShadow = true;
    g.add(lintel);
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 1.45, 0.10),
      MATERIALS.wood,
    );
    door.position.set(0, 0.75, 0);
    door.castShadow = true; door.receiveShadow = true;
    g.add(door);
    return g;
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
