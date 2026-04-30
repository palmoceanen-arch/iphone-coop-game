import * as THREE from 'three';
import { vdist, rand } from './utils.js';

const FOOD_TYPES = [
  { name: 'apple', color: 0xff4747, heal: 25, scale: 0.32 },
  { name: 'mushroom', color: 0xffb060, heal: 18, scale: 0.32 },
  { name: 'meat', color: 0xc9603a, heal: 35, scale: 0.32 },
  { name: 'berry', color: 0xc14ad8, heal: 14, scale: 0.26 },
];

export class Pickup {
  constructor(scene, x, z, kind, value) {
    this.scene = scene;
    this.pos = { x, z };
    this.kind = kind; // 'gold' | 'food'
    this.value = value;
    this.life = 18; // seconds before despawn
    this.alive = true;
    this.bobT = Math.random() * Math.PI * 2;
    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }
  _buildMesh() {
    if (this.kind === 'gold') {
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.07, 16), new THREE.MeshLambertMaterial({ color: 0xffd166, emissive: 0x4d3f00, emissiveIntensity: 0.2 }));
      m.castShadow = true;
      grp.add(m);
      grp.position.set(this.pos.x, 0.7, this.pos.z);
      return grp;
    } else {
      const food = this.foodType || (this.foodType = FOOD_TYPES[Math.floor(Math.random() * FOOD_TYPES.length)]);
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(food.scale, 0), new THREE.MeshLambertMaterial({ color: food.color }));
      m.castShadow = true;
      grp.add(m);
      grp.position.set(this.pos.x, 0.55, this.pos.z);
      this.value = food.heal;
      return grp;
    }
  }
  update(dt, players, sound, effects) {
    if (!this.alive) return;
    this.life -= dt;
    this.bobT += dt * 4;
    this.mesh.position.y = (this.kind === 'gold' ? 0.7 : 0.55) + Math.sin(this.bobT) * 0.1;
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
          near.gold += this.value;
          sound.pickupGold();
          effects.damageNumber(this.mesh.position.clone(), this.value, '#ffd166');
        } else {
          near.heal(this.value);
          sound.pickupFood();
          effects.damageNumber(this.mesh.position.clone(), this.value, '#7aff8a');
        }
        this._destroy();
      }
    }
  }
  _destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
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
