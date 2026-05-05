// Harvestable world resources — trees and rocks.
//
// Trees and rocks are normally part of the chunk's static scenery (placed by
// world.js, mounted into the chunk's THREE.Group). This module wraps each
// one in a lightweight entity so the existing damageables pipeline (sword
// swings, ability projectiles, AoE pulses) can hit them and route the kill
// to a wood / stone drop instead of the enemy-death path.
//
// The visual mesh stays parented to the chunk group so chunk unload / reload
// disposes / regenerates the mesh exactly like before. The Resource entity
// is just a damage adapter:
//   - duck-typed enemy-ish fields (pos, radius, alive, hp, maxHP, xp, elite)
//     so combat code can iterate Resources alongside Enemies / Breakables.
//   - `isResource = true` is the marker the swing callback / loot path uses
//     to route to the harvest-drop spawn instead of the enemy XP / gold path.
//   - on death we hide the mesh (visible=false) so the tree visually pops out
//     without having to detach it from the chunk group; on chunk reload the
//     world regenerates the chunk and the tree is back ("natural regrowth").
//
// HP values are deliberately higher than breakables (which fall in 1 hit) so
// chopping a tree feels like a small commitment rather than a stray hit.

import { defaultRandom } from './utils.js';

// Per-kind hit points. Tuned so a starter axe (~10 dmg) chops a tree in 4-5
// swings and breaks a rock in 6-8. Higher-damage / late-game weapons should
// tear through them faster, which is fine — the gathering loop scales with
// the rest of the player's combat power.
export const TREE_HP = 40;
export const ROCK_HP = 60;

// Yield ranges (inclusive, integer) per harvest. Axe-equipped players get a
// +25% wood multiplier — see the resolver in `harvestYield()`.
export const TREE_WOOD = [2, 4];
export const ROCK_STONE = [1, 3];

// Visual collision radius — used by enemy navigation / spotClear queries to
// avoid clipping into the trunk / boulder. Matches the rough silhouette of
// the existing nature-kit GLBs at their default scale.
const TREE_RADIUS = 0.85;
const ROCK_RADIUS = 0.80;

// Particle / damage-number colour that matches the resource. Tree gets a
// leafy green; rock gets a cool grey.
const TREE_BURST_COLOR = 0x6fbf5b;
const ROCK_BURST_COLOR = 0x8a8f99;

export class Resource {
  // `mesh` is the existing THREE.Object3D already mounted inside the chunk
  // group by world.js. We keep the reference so we can hide it on death and
  // bob it on hit reactions, but we never re-parent it — the chunk owns its
  // lifecycle. `chunkKey` is used by Game._despawnChunkEntities so this
  // entity is dropped in lockstep with the chunk that owns its mesh.
  constructor(x, z, kind /* 'tree' | 'rock' */, mesh, chunkKey) {
    this.kind = kind;
    this.pos = { x, z };
    this.alive = true;
    this.mesh = mesh || null;
    this.chunkKey = chunkKey || null;
    this.maxHP = (kind === 'tree') ? TREE_HP : ROCK_HP;
    this.hp = this.maxHP;
    this.radius = (kind === 'tree') ? TREE_RADIUS : ROCK_RADIUS;
    this.xp = 0;
    this.elite = false;
    this.isResource = true;
    // Hit-reaction wobble: shaken on takeDamage, decays back to rest.
    this._shake = 0;
    this._shakeT = defaultRandom() * Math.PI * 2;
    if (this.mesh) {
      // Cache the rest position once so the shake offset lives in mesh-space
      // without leaking into the world transform on chunk recompute.
      this._restRotZ = this.mesh.rotation.z;
    } else {
      this._restRotZ = 0;
    }
  }

  // Standard damageable contract — same shape as Enemy / Breakable. Returns
  // true when the hit lands (alive → still alive, or alive → dead). The
  // game's compactInPlace pass picks up the death and routes to harvest
  // drops; we don't spawn drops here so the resolver has access to whoever
  // dealt the killing blow (axe wielder gets +25% wood).
  takeDamage(amount /* number */, _fromX, _fromZ, _knockback) {
    if (!this.alive) return false;
    const dmg = Math.max(1, Math.floor(amount || 1));
    this.hp = Math.max(0, this.hp - dmg);
    // Stronger shake for bigger hits; capped so a critical doesn't fling the
    // mesh outside its silhouette.
    this._shake = Math.min(0.18, this._shake + 0.04 + dmg * 0.002);
    if (this.hp <= 0) {
      this.alive = false;
    }
    return true;
  }

  // Per-frame idle / hit-reaction wobble. Trees lean slightly when chopped;
  // rocks barely register. Hidden meshes (post-death) skip the work.
  update(dt) {
    if (!this.mesh || !this.alive) return;
    if (this._shake <= 0.0001) return;
    this._shakeT += dt * 22;
    const offset = Math.sin(this._shakeT) * this._shake;
    this.mesh.rotation.z = this._restRotZ + offset;
    // Decay shake exponentially so the mesh settles within ~0.4s.
    this._shake *= Math.pow(0.001, dt);
    if (this._shake < 0.001) {
      this._shake = 0;
      this.mesh.rotation.z = this._restRotZ;
    }
  }

  // Called when a Resource dies (from any source). Hides the mesh in place;
  // the chunk still owns it, so chunk unload disposes it via the chunk's
  // group-removal path. On chunk reload the world regenerates the tree /
  // rock from the deterministic chunk seed → natural regrowth.
  hideMesh() {
    if (!this.mesh) return;
    this.mesh.visible = false;
    // Reset rotation so a later regen / pool-reuse path doesn't see stale
    // wobble offsets if the engine ever shares meshes across resources
    // (it doesn't today, but cheap insurance).
    this.mesh.rotation.z = this._restRotZ;
  }

  burstColor() {
    return (this.kind === 'tree') ? TREE_BURST_COLOR : ROCK_BURST_COLOR;
  }

  // Approximate centre of the destruction VFX in world space. Trees burst
  // higher up the trunk so the leafy splash reads against the canopy.
  burstY() {
    return (this.kind === 'tree') ? 1.6 : 0.5;
  }
}

// Compute wood / stone yield for a resource break. Kept here so the kind →
// resource-type mapping lives next to the entity definition, and so axe
// bonuses are applied in one place. `weaponKind` may be undefined for AoE
// kills (no weapon credit) — we treat that as no bonus.
//
// Returns an object { kind: 'wood'|'stone', amount: number } or null if the
// resource doesn't drop anything (currently unreachable, but future kinds
// like decorative bushes might).
export function harvestYield(resourceKind, weaponKind, rng = defaultRandom) {
  const roll = (range) => Math.floor(range[0] + rng() * (range[1] - range[0] + 1));
  if (resourceKind === 'tree') {
    let amt = roll(TREE_WOOD);
    // Axes are designed for chopping wood — reward axe wielders with +25%
    // yield (rounded up so a 2-wood roll becomes 3, not 2). Other weapons
    // still chop trees, just without the bonus.
    if (weaponKind === 'axe_1h' || weaponKind === 'axe_2h') {
      amt = Math.ceil(amt * 1.25);
    }
    return { kind: 'wood', amount: amt };
  }
  if (resourceKind === 'rock') {
    return { kind: 'stone', amount: roll(ROCK_STONE) };
  }
  return null;
}

