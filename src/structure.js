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

// Build a tiny procedural stone texture once at module load and reuse it on
// every wall / gate column / lintel. 128×128 is enough — the toon shader
// quantises into a couple of tone bands anyway, so the tex's role is just
// to break up the flat fill with subtle veining + crack streaks. Generated
// in a deterministic loop (no Math.random'd seeds, mulberry-style hash) so
// builds are stable. One texture, one material, no GC churn.
function _buildStoneTexture() {
  const W = 128, H = 128;
  const cnv = document.createElement('canvas');
  cnv.width = W; cnv.height = H;
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;
  // 2D value-noise lookup, deterministic from integer (x,y) hash. Produces
  // a soft mottle that the toon shader then steps into ~3 visible bands.
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
  };
  // Soft 4-tap bilinear of the integer hash so the noise looks like blobs,
  // not per-pixel salt. Cheap; runs once at module load.
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy)
         + (c * (1 - fx) + d * fx) * fy;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Big blobs (lighter / darker stone patches) + finer grain on top.
      const big = noise(x / 22, y / 22);
      const fine = noise(x / 5, y / 5);
      let v = 0.62 + (big - 0.5) * 0.18 + (fine - 0.5) * 0.06;
      // Crack streaks: a couple of thin diagonal lines that drop intensity
      // sharply, faked by sampling a low-octave noise as a hash-grid.
      const crack = noise((x + y * 0.4) / 17, (y - x * 0.3) / 19);
      if (crack < 0.18) v -= (0.18 - crack) * 1.2;
      // Subtle vignette toward edges so adjacent walls' textures don't all
      // average to the same shade — gives a faint blocky read.
      const ex = Math.abs(x - W * 0.5) / (W * 0.5);
      const ey = Math.abs(y - H * 0.5) / (H * 0.5);
      const edge = Math.max(ex, ey);
      v -= Math.max(0, edge - 0.85) * 0.6;
      v = Math.max(0.20, Math.min(1.0, v));
      const r = Math.round(v * 168);
      const g = Math.round(v * 172);
      const b = Math.round(v * 184);     // cool tint, slightly bluer than r/g
      const idx = (y * W + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Pixelated min/mag keeps the chunky low-poly read instead of blurring
  // crack lines into a gray smear at distance.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// Procedural materials cached and shared across all structures of a kind so
// long sessions don't accumulate THREE.Material allocations.
let MATERIALS = null;
function ensureMaterials() {
  if (MATERIALS) return;
  const stoneTex = _buildStoneTexture();
  MATERIALS = {
    wood: new THREE.MeshToonMaterial({ color: 0x8c5a2c, gradientMap: TOON_GRADIENT }),
    woodDark: new THREE.MeshToonMaterial({ color: 0x6b4023, gradientMap: TOON_GRADIENT }),
    // White colour multiplied by the texture map so the toon banding picks
    // up the texture's noise + cracks instead of flattening a single hex.
    stone: new THREE.MeshToonMaterial({
      color: 0xffffff, map: stoneTex, gradientMap: TOON_GRADIENT,
    }),
    stoneDark: new THREE.MeshToonMaterial({
      color: 0xb8b8c0, map: stoneTex, gradientMap: TOON_GRADIENT,
    }),
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

// Build a fence-style gate mesh: same post + arm layout as a fence, plus
// a stone lintel cap so a player can pick the gate out of a fence run at
// a glance. When `isOpen` is true, the rail arms are omitted entirely —
// the gate's "open" state IS the absence of rails, so the player can
// walk through the cell without bumping a barrier (the matching collider
// shrink lives in game.js). Connections come from the same neighbour
// scan fences use, so a gate dropped into a fence run extends its arms
// toward both neighbours and hides them mid-toggle.
export function buildGateMesh(connections, isOpen) {
  ensureMaterials();
  const g = new THREE.Group();
  // Post — slightly taller than a fence post (1.10m vs 1.00m) so the
  // stone cap floats just above the fence's top rail and the gate reads
  // as a distinct object from a far-away camera angle.
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.20, 1.10, 0.20),
    MATERIALS.woodDark,
  );
  post.position.set(0, 0.55, 0);
  post.castShadow = true; post.receiveShadow = true;
  g.add(post);
  // Stone cap — visual marker that this cell is openable. Wider than the
  // post so it reads from the ground silhouette too, not just from above.
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.10, 0.32),
    MATERIALS.stoneDark,
  );
  cap.position.set(0, 1.16, 0);
  cap.castShadow = true; cap.receiveShadow = true;
  g.add(cap);
  // Closed gate gets the fence-style arms; open gate omits them so the
  // cell is walkable. The collider radius is toggled in game.js to match.
  if (!isOpen) {
    _addFenceArms(g, connections);
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
    // Default gate preview: closed, no neighbour connections. Live gates
    // get arms attached by `buildGateMesh()` once neighbour scan runs in
    // game.js. Open/closed toggle is handled there via the `open` field
    // on the descriptor; preview always renders the closed silhouette so
    // the player sees what they're committing to.
    return buildGateMesh({ N: false, E: false, S: false, W: false }, false);
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
