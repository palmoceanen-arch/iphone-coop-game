import * as THREE from 'three';
import { vdist, rand, defaultRandom } from './utils.js';
import { TOON_GRADIENT } from './shading.js';
import { HandlePool } from './pool.js';

const FOOD_TYPES = [
  { name: 'apple', color: 0xff4747, heal: 25, scale: 0.32 },
  { name: 'mushroom', color: 0xffb060, heal: 18, scale: 0.32 },
  { name: 'meat', color: 0xc9603a, heal: 35, scale: 0.32 },
  { name: 'berry', color: 0xc14ad8, heal: 14, scale: 0.26 },
];

const FOOD_BY_NAME = Object.fromEntries(FOOD_TYPES.map((f) => [f.name, f]));

// Resource pickup silhouettes: small log for wood, faceted boulder for stone.
// Both use plain primitives + ToonMaterial so we don't need new GLBs for the
// M1 gathering loop. Visually distinct enough from gold (yellow disc) and
// food (rounder coloured icosahedrons) at gameplay distance.
const WOOD_COLOR = 0x8c5a2c; // mid-saturation log brown, reads against grass
const STONE_COLOR = 0x8a8f99; // cool grey, readable against grass + dirt
const SEED_COLOR = 0x9ad36b; // light leafy green for the future seed drop
const WOOD_BASE_Y = 0.5;
const STONE_BASE_Y = 0.45;
const SEED_BASE_Y = 0.45;

// Spawning gold/food is hot during combat (every kill drops several piles).
// Build them once per silhouette and recycle on pickup/expiry instead of
// re-allocating Group + CylinderGeometry / IcosahedronGeometry + ToonMaterial
// on every spawn. Bucket cap is generous: a screen-clearing AoE can leave 30+
// piles on the floor at once, multiplied by 5 silhouettes (gold + 4 food
// kinds), and a fresh chunk stream usually drops 100+ piles into the world.
const PICKUP_POOL = new HandlePool(96);

function poolKey(kind, foodName) {
  if (kind === 'food') return `food:${foodName}`;
  // gold / wood / stone / seed each get their own bucket so an acquire
  // never returns a wrong-shaped silhouette.
  return kind;
}

const GOLD_BASE_Y = 0.7;
const FOOD_BASE_Y = 0.55;

// Dispatch table: per-kind base hover height. Centralised so the bob /
// gravitate code below doesn't grow a long if-else chain as new resource
// kinds (seed, food sub-kinds) come online.
const KIND_BASE_Y = {
  gold: GOLD_BASE_Y,
  food: FOOD_BASE_Y,
  wood: WOOD_BASE_Y,
  stone: STONE_BASE_Y,
  seed: SEED_BASE_Y,
};

// Which pickup kinds funnel into the shared resource pool (vs personal
// gold or per-pickup heal). Game wires its `world.resources` object as the
// destination; if it's missing we silently drop the value (useful for the
// rare case of a pickup outliving its scene during teardown).
const SHARED_RESOURCE_KINDS = new Set(['wood', 'stone', 'seed']);

export class Pickup {
  constructor(scene, x, z, kind, value) {
    this.scene = scene;
    this.pos = { x, z };
    this.kind = kind; // 'gold' | 'food' | 'wood' | 'stone' | 'seed'
    this.value = value;
    this.life = 18; // seconds before despawn
    this.alive = true;
    this.bobT = defaultRandom() * Math.PI * 2;
    if (this.kind === 'food') {
      // Pick the food sub-kind up front so the pool key is stable. The
      // heal value comes from the food table — the constructor's `value`
      // arg is ignored for food since the original code already overwrote
      // it inside _buildMesh.
      this.foodType = FOOD_TYPES[Math.floor(defaultRandom() * FOOD_TYPES.length)];
      this.value = this.foodType.heal;
    } else {
      this.foodType = null;
    }
    const key = poolKey(this.kind, this.foodType?.name);
    const reused = PICKUP_POOL.acquire(key);
    if (reused) {
      this.mesh = reused;
      this.mesh.visible = true;
    } else {
      this.mesh = this._buildMesh();
    }
    const baseY = KIND_BASE_Y[this.kind] ?? FOOD_BASE_Y;
    this.mesh.position.set(this.pos.x, baseY, this.pos.z);
    this.mesh.rotation.set(0, 0, 0);
    scene.add(this.mesh);
  }
  _buildMesh() {
    if (this.kind === 'gold') {
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.07, 16), new THREE.MeshToonMaterial({ color: 0xffd166, gradientMap: TOON_GRADIENT }));
      m.castShadow = true;
      grp.add(m);
      return grp;
    }
    if (this.kind === 'wood') {
      // Tiny log: a stubby cylinder rotated on its side so the cap circles
      // read like log ends. Cheap visual that's still distinct from a gold
      // disc at a glance.
      const grp = new THREE.Group();
      const log = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 0.45, 10),
        new THREE.MeshToonMaterial({ color: WOOD_COLOR, gradientMap: TOON_GRADIENT }),
      );
      log.castShadow = true;
      log.rotation.z = Math.PI / 2;
      grp.add(log);
      return grp;
    }
    if (this.kind === 'stone') {
      // Faceted pebble: low-poly icosahedron tinted grey, slightly scaled to
      // feel chunkier than the food orbs.
      const grp = new THREE.Group();
      const rock = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.30, 0),
        new THREE.MeshToonMaterial({ color: STONE_COLOR, gradientMap: TOON_GRADIENT }),
      );
      rock.castShadow = true;
      grp.add(rock);
      return grp;
    }
    if (this.kind === 'seed') {
      // Reserved for a later milestone (M3 farming). Build a small green
      // tetrahedron now so we don't need to revisit pool / mesh wiring
      // when the farming PR lands.
      const grp = new THREE.Group();
      const seed = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.22),
        new THREE.MeshToonMaterial({ color: SEED_COLOR, gradientMap: TOON_GRADIENT }),
      );
      seed.castShadow = true;
      grp.add(seed);
      return grp;
    }
    // Default: food.
    const food = this.foodType || (this.foodType = FOOD_BY_NAME.apple);
    const grp = new THREE.Group();
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(food.scale, 0), new THREE.MeshToonMaterial({ color: food.color, gradientMap: TOON_GRADIENT }));
    m.castShadow = true;
    grp.add(m);
    return grp;
  }
  // `resources` (optional) is the shared resource pool object passed by
  // Game ({ wood, stone, seeds }). Only used for wood / stone / seed kinds;
  // gold and food work as before so existing call sites that don't pass it
  // (e.g. tests, future external callers) keep their behaviour.
  update(dt, players, sound, effects, resources) {
    if (!this.alive) return;
    this.life -= dt;
    this.bobT += dt * 4;
    const baseY = KIND_BASE_Y[this.kind] ?? FOOD_BASE_Y;
    this.mesh.position.y = baseY + Math.sin(this.bobT) * 0.1;
    this.mesh.rotation.y += dt * 1.6;
    if (this.life <= 0) { this._destroy(); return; }
    // attract toward closest alive player when near
    let near = null, nd = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = vdist(this.pos, p.pos);
      if (d < nd) { nd = d; near = p; }
    }
    if (near) {
      if (nd < 2.2) {
        // gravitate
        const dx = near.pos.x - this.pos.x, dz = near.pos.z - this.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        this.pos.x += (dx / len) * 6 * dt;
        this.pos.z += (dz / len) * 6 * dt;
        this.mesh.position.x = this.pos.x;
        this.mesh.position.z = this.pos.z;
      }
      if (nd < near.radius + 0.4) {
        if (this.kind === 'gold') {
          // Shared gold pool — both players gain regardless of who picked up.
          for (const p of players) p.gold += this.value;
          sound.pickupGold?.();
          effects.damageNumber(this.mesh.position.clone(), this.value, '#ffd166');
        } else if (SHARED_RESOURCE_KINDS.has(this.kind)) {
          // Wood / stone / seed go into the shared world resource pool —
          // building consumes them, not personal upgrades. Sound + flying
          // damage-number echo gives the same picked-it-up feedback as gold.
          if (resources) {
            const field = (this.kind === 'seed') ? 'seeds' : this.kind;
            resources[field] = (resources[field] || 0) + this.value;
          }
          // Each kind gets its own sfx if one is wired up; fall back to
          // pickupGold so worst case is still audible.
          const sfx = (this.kind === 'wood') ? sound.pickupWood
            : (this.kind === 'stone') ? sound.pickupStone
            : (this.kind === 'seed') ? sound.pickupFood
            : sound.pickupGold;
          sfx?.call(sound);
          const colour = (this.kind === 'wood') ? '#c9a37a'
            : (this.kind === 'stone') ? '#bcc1cc'
            : '#9ad36b';
          effects.damageNumber(this.mesh.position.clone(), this.value, colour);
        } else {
          // Food heals only the picker; healing the partner from a distance
          // would be unintuitive.
          near.heal(this.value);
          sound.pickupFood?.();
          effects.damageNumber(this.mesh.position.clone(), this.value, '#7aff8a');
        }
        this._destroy();
      }
    }
  }
  _destroy() {
    if (!this.alive && !this.mesh) return;
    this.alive = false;
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.visible = false;
    PICKUP_POOL.release(poolKey(this.kind, this.foodType?.name), this.mesh);
    this.mesh = null;
  }
}

export function spawnDrops(scene, x, z, goldRange, dropFood) {
  const drops = [];
  const goldAmt = Math.floor(rand(goldRange[0], goldRange[1] + 1));
  for (let i = 0; i < Math.max(1, Math.ceil(goldAmt / 4)); i++) {
    const px = x + rand(-0.4, 0.4);
    const pz = z + rand(-0.4, 0.4);
    drops.push(new Pickup(scene, px, pz, 'gold', Math.max(1, Math.floor(goldAmt / Math.max(1, Math.ceil(goldAmt / 4))))));
  }
  if (dropFood) {
    drops.push(new Pickup(scene, x + rand(-0.5, 0.5), z + rand(-0.5, 0.5), 'food', 0));
  }
  return drops;
}

// Spawn one or more wood / stone / seed pickups around a point. Mirrors
// `spawnDrops` for gold/food: each unit becomes its own gravitating Pickup
// so a 4-wood drop reads as a small fan of logs the player walks through,
// not a single fat log. Game enqueues these on `this.pickups` so the
// existing pickup tick + cleanup code handles them with no special case.
export function spawnHarvestDrops(scene, x, z, kind, amount) {
  const drops = [];
  const total = Math.max(1, Math.floor(amount));
  // Bundle into 1-2 pickups so a tree giving 4 wood produces 2 piles of 2,
  // not 4 separate logs the player has to chase. Stones split similarly.
  // Bundling keeps the floor uncluttered after a long gather session.
  const piles = Math.min(total, 2);
  const perPile = Math.max(1, Math.floor(total / piles));
  let remaining = total;
  for (let i = 0; i < piles; i++) {
    const value = (i === piles - 1) ? remaining : perPile;
    remaining -= value;
    const px = x + rand(-0.5, 0.5);
    const pz = z + rand(-0.5, 0.5);
    drops.push(new Pickup(scene, px, pz, kind, value));
  }
  return drops;
}
