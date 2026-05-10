// Harvestable world resources — trees and rocks.
//
// Trees and rocks are normally part of the chunk's static scenery (placed by
// world.js, mounted into the chunk's THREE.Group). This module wraps each
// one in a lightweight entity so the existing damageables pipeline (sword
// swings, ability projectiles, AoE pulses) can hit them and route the kill
// to a wood / stone drop instead of the enemy-death path.
//
// Lifecycle states:
//   'alive'  — full tree / rock with HP and a registered collider in the
//              chunk's `colliders` array. Hit detection works, props block
//              movement.
//   'stump'  — tree only. After being chopped, the leafy mesh is hidden and
//              a small procedural stump cylinder takes its place. Collider
//              is removed so players and enemies can walk through. Stays
//              for ~10 game days, then regrows back to 'alive'.
//   'gone'   — rock only (and trees never enter this). The entity is
//              compacted out of the resources list at the next cleanup
//              pass; the chunk's mesh is hidden but stays in the chunk
//              group until the chunk unloads.
//
// On chunk unload the entity is dropped from the resources list (chunk
// owns its mesh + stump as group children), and on chunk reload the world
// regenerates a fresh tree / rock — no consumed-set entry needed, even for
// stumped trees, because regrowth via chunk regen is fast-path.

import * as THREE from 'three';
import { defaultRandom } from './utils.js';
import { TOON_GRADIENT } from './shading.js';

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

// Regrowth window for chopped trees, expressed in *game* days (the world
// runs on a 1920s day cycle; 10 game days ≈ 320 minutes of real-time play).
// Stored as a constant here so the design tuning lives next to the entity.
// Rocks never regrow — once smashed, that ore vein is gone for the chunk's
// lifetime; chunk reload regenerates the world normally.
export const TREE_REGROW_GAME_DAYS = 10;

// Cached stump material. The chunk owns the stump mesh, but reusing the
// same material across thousands of stumps avoids material allocations
// during long sessions.
let STUMP_MATERIAL = null;
let STUMP_GEOMETRY = null;
function ensureStumpAssets() {
  if (!STUMP_MATERIAL) {
    STUMP_MATERIAL = new THREE.MeshToonMaterial({
      color: 0x6b4226,
      gradientMap: TOON_GRADIENT,
    });
  }
  if (!STUMP_GEOMETRY) {
    // Tiny pentagonal stub left where the tree used to stand. Original
    // chunky 8-sided cylinder was scaled down ~3.3× and dropped to 5 radial
    // segments — reads as a low-poly chopped-flush remnant rather than a
    // squat barrel. The 5-sided silhouette also visually distinguishes
    // stumps from rocks / pebbles which are 8-sided.
    STUMP_GEOMETRY = new THREE.CylinderGeometry(0.135, 0.165, 0.105, 5);
  }
}

export class Resource {
  // `mesh` is the existing THREE.Object3D already mounted inside the chunk
  // group by world.js. We keep the reference so we can hide it on death and
  // bob it on hit reactions, but we never re-parent it — the chunk owns its
  // lifecycle. `chunkKey` is used by Game._despawnChunkEntities so this
  // entity is dropped in lockstep with the chunk that owns its mesh.
  // `collider` and `colliderArray` are the {x,z,r} object inside the chunk's
  // `colliders` array; we splice it out on death so players / enemies can
  // walk through stumps and rubble, and re-insert it on regrow.
  // `group` is the chunk's THREE.Group, used to parent the procedural stump
  // mesh so it goes away cleanly when the chunk unloads.
  constructor(x, z, kind /* 'tree' | 'rock' */, mesh, chunkKey, collider, colliderArray, group) {
    this.kind = kind;
    this.pos = { x, z };
    this.alive = true;
    this.state = 'alive';                 // 'alive' | 'stump' | 'gone'
    this.mesh = mesh || null;
    this.chunkKey = chunkKey || null;
    this.collider = collider || null;
    this.colliderArray = colliderArray || null;
    this.group = group || null;
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
    // Stump regrowth state. `regrowT` advances by dt when state==='stump';
    // `regrowSecs` is computed lazily from the world's day-length the first
    // time it's needed (the world's `dayLength` value can theoretically
    // change at runtime in a future debug menu, so we re-read it).
    this.regrowT = 0;
    this.stumpMesh = null;
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

  // Per-frame idle / hit-reaction wobble + stump regrow timer.
  // `dayLength` is `world.dayLength` (in real-time seconds) so the regrow
  // threshold tracks game-time, not wall-clock.
  update(dt, dayLength = 1920) {
    if (this.state === 'stump') {
      this.regrowT += dt;
      const threshold = TREE_REGROW_GAME_DAYS * dayLength;
      if (this.regrowT >= threshold) {
        this._regrow();
      }
      return;
    }
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

  // Transition from alive → stump (trees) or alive → gone (rocks).
  // Hides the chunk-owned mesh, removes the collider from the chunk's
  // collision list (so players walk through), and — for trees — spawns a
  // small procedural stump that lives inside the chunk's group.
  enterDeathState() {
    if (this.mesh) {
      this.mesh.visible = false;
      this.mesh.rotation.z = this._restRotZ;
    }
    this._removeCollider();
    if (this.kind === 'tree') {
      this.state = 'stump';
      this._spawnStump();
    } else {
      this.state = 'gone';
    }
  }

  // Spawn the procedural stump mesh and parent it into the chunk's group
  // so chunk unload disposes it as part of the chunk's normal teardown.
  _spawnStump() {
    if (this.stumpMesh || !this.group) return;
    ensureStumpAssets();
    const stump = new THREE.Mesh(STUMP_GEOMETRY, STUMP_MATERIAL);
    stump.castShadow = true;
    stump.receiveShadow = false;
    // Cylinder is centred on its midpoint, so y = half-height to sit flush
    // on the ground. Matches the small pentagonal stump geometry above
    // (height ≈ 0.105 → y = 0.0525).
    stump.position.set(this.pos.x, 0.0525, this.pos.z);
    // Slight random rotation so a forest of stumps doesn't read as a grid.
    stump.rotation.y = defaultRandom() * Math.PI * 2;
    this.group.add(stump);
    this.stumpMesh = stump;
  }

  // Splice the chunk-level collider entry. World.colliders is rebuilt every
  // frame from chunk.colliders, so by next tick the dead resource is no
  // longer part of any collision query.
  _removeCollider() {
    if (!this.colliderArray || !this.collider) return;
    const idx = this.colliderArray.indexOf(this.collider);
    if (idx >= 0) this.colliderArray.splice(idx, 1);
  }

  // Push the original collider object back so movement / pathfinding starts
  // bouncing off the regrown tree again.
  _restoreCollider() {
    if (!this.colliderArray || !this.collider) return;
    if (this.colliderArray.indexOf(this.collider) >= 0) return;
    this.colliderArray.push(this.collider);
  }

  // Stump → alive. Hide stump, show the original tree mesh, restore HP and
  // re-add the collider. Players / enemies standing on the spot get a small
  // shove from the next collision-resolve pass; that's fine — a regrowing
  // tree pushing a wandering enemy aside reads as natural world behaviour.
  _regrow() {
    if (this.kind !== 'tree') return;
    this.state = 'alive';
    this.alive = true;
    this.hp = this.maxHP;
    this.regrowT = 0;
    if (this.mesh) this.mesh.visible = true;
    if (this.stumpMesh) {
      // Drop the stump from the chunk group; we don't pool stump meshes
      // because each one is a tiny ~16-tri geometry sharing one material.
      // GC happens when the chunk eventually unloads.
      if (this.stumpMesh.parent) this.stumpMesh.parent.remove(this.stumpMesh);
      this.stumpMesh = null;
    }
    this._restoreCollider();
  }

  burstColor() {
    return (this.kind === 'tree') ? TREE_BURST_COLOR : ROCK_BURST_COLOR;
  }

  // Approximate centre of the destruction VFX in world space. Trees burst
  // higher up the trunk so the leafy splash reads against the canopy.
  burstY() {
    return (this.kind === 'tree') ? 1.6 : 0.5;
  }

  // JSON-clean snapshot of mutable state for persistence. Returns null
  // for resources that haven't deviated from the initial chunk-spawn
  // state — the caller can drop the override entry when this is null
  // and let chunk regen re-emit the resource at full HP. Saves bytes.
  toOverride() {
    if (this.state === 'alive' && this.hp >= this.maxHP) return null;
    const out = { hp: this.hp, state: this.state };
    if (this.state === 'stump') out.regrowT = this.regrowT;
    return out;
  }

  // Re-apply a previously-saved snapshot in-place. Called by the game's
  // resource drainer right after constructing the Resource against a
  // freshly-streamed mesh, so a chunk that reloads picks the resource
  // back up exactly where the player left it.
  applyOverride(ov) {
    if (!ov) return;
    if (typeof ov.hp === 'number') {
      this.hp = Math.max(0, Math.min(this.maxHP, ov.hp));
      if (this.hp <= 0) this.alive = false;
    }
    const targetState = ov.state || 'alive';
    if (targetState === 'stump' || targetState === 'gone') {
      // Run through the normal death path so the chunk's collider and
      // visual mesh end up in the same configuration they would have
      // taken naturally — modulo the regrowT carry-over below.
      this.alive = false;
      this.enterDeathState();
      if (typeof ov.regrowT === 'number') this.regrowT = ov.regrowT;
    } else {
      this.alive = true;
      this.state = 'alive';
    }
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
