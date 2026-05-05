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

// Spawning gold/food is hot during combat (every kill drops several piles).
// Build them once per silhouette and recycle on pickup/expiry instead of
// re-allocating Group + CylinderGeometry / IcosahedronGeometry + ToonMaterial
// on every spawn. Bucket cap is generous: a screen-clearing AoE can leave 30+
// piles on the floor at once, multiplied by 5 silhouettes (gold + 4 food
// kinds), and a fresh chunk stream usually drops 100+ piles into the world.
const PICKUP_POOL = new HandlePool(96);

function poolKey(kind, foodName) {
  return kind === 'gold' ? 'gold' : `food:${foodName}`;
}

const GOLD_BASE_Y = 0.7;
const FOOD_BASE_Y = 0.55;

export class Pickup {
  constructor(scene, x, z, kind, value) {
    this.scene = scene;
    this.pos = { x, z };
    this.kind = kind; // 'gold' | 'food'
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
    const baseY = this.kind === 'gold' ? GOLD_BASE_Y : FOOD_BASE_Y;
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
    } else {
      const food = this.foodType || (this.foodType = FOOD_BY_NAME.apple);
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(food.scale, 0), new THREE.MeshToonMaterial({ color: food.color, gradientMap: TOON_GRADIENT }));
      m.castShadow = true;
      grp.add(m);
      return grp;
    }
  }
  update(dt, players, sound, effects) {
    if (!this.alive) return;
    this.life -= dt;
    this.bobT += dt * 4;
    this.mesh.position.y = (this.kind === 'gold' ? GOLD_BASE_Y : FOOD_BASE_Y) + Math.sin(this.bobT) * 0.1;
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
          sound.pickupGold();
          effects.damageNumber(this.mesh.position.clone(), this.value, '#ffd166');
        } else {
          // Food heals only the picker; healing the partner from a distance
          // would be unintuitive.
          near.heal(this.value);
          sound.pickupFood();
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
