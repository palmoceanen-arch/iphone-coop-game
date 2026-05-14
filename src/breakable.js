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
//
// Visuals are sourced from CC0 GLBs preloaded by `models.js`:
//   pot   — Quaternius "Survival Pack" (terracotta cauldron)
//   crate — Kenney "Survival Kit" (wooden box)
// If the asset isn't loaded yet (first-frame race during world streaming) we
// fall back to a procedural primitive so the breakable still renders.

import * as THREE from 'three';
import { TOON_GRADIENT } from './shading.js';
import { spawnBreakable } from './models.js';
import { defaultRandom } from './utils.js';
import { HandlePool } from './pool.js';

// Recycle the (relatively expensive) `spawnBreakable()` clones across
// chunk-streaming churn. KayKit GLBs are deep-cloned on every spawn — that's
// fine when one or two per chunk pop in, but a stress test that walks the
// player back and forth across the map ends up cloning hundreds of trees.
// We keep the cloned subgraph fully intact in the pool: the player visibly
// re-encounters the same crate after we leave + re-enter a chunk, but every
// breakable of a kind is visually identical (same atlas, same geometry, same
// per-kind tint baked into the GLB) so reuse is safe.
const BREAKABLE_POOL = new HandlePool(48);

const POT_GOLD = [2, 5];
const CRATE_GOLD = [3, 7];
const CRATE_ITEM_CHANCE = 0.10;

// Per-kind visual scales applied on top of the model's auto-fitted base size.
// Tweaking these is the cheap way to make a kind read bigger/smaller without
// re-exporting the source GLB.
const POT_SCALE = 1.0;
const CRATE_SCALE = 1.0;

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
    this._wobbleT = defaultRandom() * Math.PI * 2;
    const reused = BREAKABLE_POOL.acquire(this._poolKey());
    if (reused) {
      reused.position.x = this.pos.x;
      reused.position.z = this.pos.z;
      // Pots have an idle bob applied to mesh.position.y in update();
      // make sure we start grounded so the first-frame y isn't wherever
      // the previous instance was paused.
      reused.position.y = 0;
      // _seededRotation is per-(x,z,kind) so re-applying on pool reuse
      // restores the deterministic orientation we'd get from a fresh
      // spawn — chunks revisiting the same spot keep their familiar
      // silhouette across pool round-trips.
      reused.rotation.y = this._seededRotation(kind === 'pot' ? 0 : 1);
      reused.visible = true;
      this.mesh = reused;
    } else {
      this.mesh = this._buildMesh();
    }
    this.scene.add(this.mesh);
  }

  // Pool bucket key — splits by kind so a pot acquire never returns a crate
  // and vice-versa (they have different geometries baked into their GLBs).
  _poolKey() {
    return this.kind;
  }

  // Pick a deterministic Y rotation per spot so identical chunks regenerate
  // with the same orientation, keeping the world stable across players.
  _seededRotation(salt = 0) {
    const seed = (this.pos.x * 17 + this.pos.z * 31 + salt * 7) | 0;
    return ((seed % 360) + 360) % 360 * Math.PI / 180;
  }

  _buildMesh() {
    const scale = (this.kind === 'pot') ? POT_SCALE : CRATE_SCALE;
    const rotationY = this._seededRotation(this.kind === 'pot' ? 0 : 1);
    const imported = spawnBreakable(this.kind, { scale, rotationY });
    if (imported) {
      // The imported scene already has Y=baseY*scale. Translate XZ to the
      // world position; world.js queues the prop with the spot already
      // resolved so we just plant it.
      imported.position.x = this.pos.x;
      imported.position.z = this.pos.z;
      return imported;
    }
    // Fallback path — only hit if the GLB hasn't finished preloading yet
    // (e.g. first-frame breakables during initial chunk stream). Visually
    // close enough to the imported model that swap-in is unnoticeable.
    return (this.kind === 'pot') ? this._buildPotFallback() : this._buildCrateFallback();
  }

  _buildPotFallback() {
    const grp = new THREE.Group();
    const clay = new THREE.MeshToonMaterial({ color: 0xb4753a, gradientMap: TOON_GRADIENT });
    const dark = new THREE.MeshToonMaterial({ color: 0x6b3a1a, gradientMap: TOON_GRADIENT });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.22, 0.55, 12), clay);
    body.castShadow = true; body.position.y = 0.28;
    grp.add(body);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.05, 6, 16), dark);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.55;
    grp.add(rim);
    grp.position.set(this.pos.x, 0, this.pos.z);
    grp.rotation.y = this._seededRotation(0);
    return grp;
  }

  _buildCrateFallback() {
    const grp = new THREE.Group();
    const wood = new THREE.MeshToonMaterial({ color: 0xc99a6a, gradientMap: TOON_GRADIENT });
    const dark = new THREE.MeshToonMaterial({ color: 0x6b4023, gradientMap: TOON_GRADIENT });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.65, 0.7), wood);
    body.castShadow = true; body.position.y = 0.33;
    grp.add(body);
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
    grp.rotation.y = this._seededRotation(1);
    return grp;
  }

  takeDamage(_amount, _fromX, _fromZ, _knockback) {
    if (!this.alive) return false;
    this.alive = false;
    return true;
  }

  // Subtle idle wobble so destructibles read as interactive on screen. Pots
  // bob slightly; crates stay put (heavy wood doesn't read as floaty).
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
    this.mesh.visible = false;
    // Hand the mesh tree to the pool so the next pot/crate spawn can reuse
    // it. If the bucket is full we just drop the reference and let GC collect
    // it — disposing geometries/materials would force a costly upload on the
    // next fresh spawn, so we deliberately leak a bit of GPU memory here in
    // exchange for a smoother hot path.
    const accepted = BREAKABLE_POOL.release(this._poolKey(), this.mesh);
    if (!accepted) {
      this.mesh.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) o.material.dispose?.();
      });
    }
    this.mesh = null;
  }

  // Color used for the destruction particle burst. Matches the body tint
  // applied in models.js (`remapBreakableColor`).
  burstColor() {
    return this.kind === 'pot' ? 0xb4753a : 0xc99a6a;
  }
}
