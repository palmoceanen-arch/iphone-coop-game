// Breakable world props (clay pots and wooden crates).
//
// Scattered into non-origin chunks by world.js, they fall in 1 hit from any
// damage source (sword swing, ability projectile, ability AoE), and on break
// drop a small pile of gold and — for crates only — sometimes an item rune.
//
// They are intentionally designed to look enemy-shaped to the rest of the
// combat code (pos / radius / alive / takeDamage / maxHP / xp / elite) so
// the game's existing damageables loop can hit them without special casing.
// `isBreakable=true` is the marker the game's swing callback uses to route
// the destruction path to its own loot spawn instead of the enemy-death path.

import * as THREE from 'three';
import { TOON_GRADIENT } from './shading.js';

const POT_GOLD = [2, 5];
const CRATE_GOLD = [3, 7];
const CRATE_ITEM_CHANCE = 0.10;

export class Breakable {
  constructor(scene, x, z, kind /* 'pot' | 'crate' */) {
    this.scene = scene;
    this.kind = kind;
    this.pos = { x, z };
    this.alive = true;
    // Duck-typed enemy-ish fields so combat code can iterate breakables in
    // the same lists as enemies without crashing on missing properties.
    this.radius = kind === 'pot' ? 0.42 : 0.55;
    this.maxHP = 1;
    this.hp = 1;
    this.xp = 0;
    this.elite = false;
    this.gold = kind === 'pot' ? POT_GOLD : CRATE_GOLD;
    this.itemDropChance = kind === 'pot' ? 0 : CRATE_ITEM_CHANCE;
    this.foodChance = kind === 'pot' ? 0.06 : 0.10;
    this.isBreakable = true;
    this._wobbleT = Math.random() * Math.PI * 2;
    this.mesh = (kind === 'pot') ? this._buildPotMesh() : this._buildCrateMesh();
    this.scene.add(this.mesh);
  }

  _buildPotMesh() {
    const grp = new THREE.Group();
    const clay = new THREE.MeshToonMaterial({ color: 0xa66a3a, gradientMap: TOON_GRADIENT });
    const dark = new THREE.MeshToonMaterial({ color: 0x6e3a1a, gradientMap: TOON_GRADIENT });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.22, 0.55, 12), clay);
    body.castShadow = true; body.position.y = 0.28;
    grp.add(body);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.05, 6, 16), dark);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.55;
    grp.add(rim);
    grp.position.set(this.pos.x, 0, this.pos.z);
    grp.rotation.y = ((this.pos.x * 17 + this.pos.z * 31) | 0) % 360 * Math.PI / 180;
    return grp;
  }

  _buildCrateMesh() {
    const grp = new THREE.Group();
    const wood = new THREE.MeshToonMaterial({ color: 0x8a5a2c, gradientMap: TOON_GRADIENT });
    const dark = new THREE.MeshToonMaterial({ color: 0x4d2f17, gradientMap: TOON_GRADIENT });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.65, 0.7), wood);
    body.castShadow = true; body.position.y = 0.33;
    grp.add(body);
    // Edge rails to read as a wooden crate from any angle.
    const railGeoX = new THREE.BoxGeometry(0.74, 0.08, 0.08);
    const railGeoZ = new THREE.BoxGeometry(0.08, 0.08, 0.74);
    for (const y of [0.07, 0.59]) {
      for (const z of [-0.34, 0.34]) {
        const r = new THREE.Mesh(railGeoX, dark);
        r.position.set(0, y, z);
        grp.add(r);
      }
      for (const x of [-0.34, 0.34]) {
        const r = new THREE.Mesh(railGeoZ, dark);
        r.position.set(x, y, 0);
        grp.add(r);
      }
    }
    grp.position.set(this.pos.x, 0, this.pos.z);
    grp.rotation.y = ((this.pos.x * 13 + this.pos.z * 29) | 0) % 360 * Math.PI / 180;
    return grp;
  }

  takeDamage(_amount, _fromX, _fromZ, _knockback) {
    if (!this.alive) return false;
    this.alive = false;
    return true;
  }

  // Subtle idle wobble so destructibles read as interactive on screen.
  update(dt) {
    if (!this.alive || !this.mesh) return;
    this._wobbleT += dt;
    if (this.kind === 'pot') {
      this.mesh.position.y = Math.sin(this._wobbleT * 1.5) * 0.02;
    }
  }

  destroyMesh() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) o.material.dispose?.();
    });
    this.mesh = null;
  }

  // Color used for the destruction particle burst. Matches the body tint.
  burstColor() {
    return this.kind === 'pot' ? 0xa66a3a : 0x8a5a2c;
  }
}
