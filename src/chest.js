// World chests. Spawned by chunk generation in world.js, opened on
// interact (E for P1, J for P2). On open the chest spawns a Rune (item or
// ability) on the floor next to it and disables itself.
//
// The chest body is built from primitives so it works without external
// assets.

import * as THREE from 'three';
import { TOON_GRADIENT } from './shading.js';
import { Rune } from './runes.js';
import { pickRandomItemId } from './items.js';
import { pickRandomAbilityId } from './abilities.js';
import { vdist, defaultRandom, rand } from './utils.js';
import { spawnHarvestDrops } from './pickups.js';
import { promptLabelFor } from './inputPrompts.js';

// Probability a chest also drops a small seed pouch when opened. Chests
// are the only renewable seed source until players have an established
// farm, so we want most chests to contribute a few — but not all of them,
// so the rune is still the main reward.
const SEED_DROP_CHANCE = 0.6;
// Inclusive seed pouch range. 1-3 keeps the early game feeling generous
// without dumping enough seeds to skip combat in favour of harvesting.
const SEED_DROP_RANGE = [1, 3];

const PROMPT_RADIUS = 2.2;
const OPEN_RADIUS = 1.6;

export class Chest {
  constructor(scene, x, z) {
    this.scene = scene;
    this.pos = { x, z };
    this.alive = true;
    this.opened = false;
    this.bobT = defaultRandom() * Math.PI * 2;
    this.mesh = this._buildMesh();
    scene.add(this.mesh);
    this._promptShown = false;
  }

  _buildMesh() {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.6, 0.6),
      new THREE.MeshToonMaterial({ color: 0x8a5a2c, gradientMap: TOON_GRADIENT })
    );
    body.castShadow = true;
    body.position.y = 0.32;
    grp.add(body);
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.18, 0.62),
      new THREE.MeshToonMaterial({ color: 0xa07040, gradientMap: TOON_GRADIENT })
    );
    lid.castShadow = true;
    lid.position.y = 0.7;
    grp.add(lid);
    this._lid = lid;
    const lock = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.18, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffd166 })
    );
    lock.position.set(0, 0.55, 0.32);
    grp.add(lock);
    grp.position.set(this.pos.x, 0, this.pos.z);
    return grp;
  }

  update(dt, players, sound, effects, onSpawnRune, onSpawnPickup, onOpened) {
    if (!this.alive) return;
    this.bobT += dt * 2;
    if (this.opened) {
      // Fade out the chest a bit after opening, then despawn.
      this._fade = (this._fade || 0) + dt;
      if (this._fade > 1.8) this._destroy();
      return;
    }
    let promptPlayer = null, promptD = Infinity;
    let opener = null, openD = OPEN_RADIUS;
    for (const p of players) {
      if (!p.alive) continue;
      const d = vdist(this.pos, p.pos);
      if (d < promptD) { promptD = d; promptPlayer = p; }
      if (d < openD && p._lastIntent?.interact) { openD = d; opener = p; }
    }
    if (!promptPlayer) {
      // Every player walked out of prompt range — reset the latch so the
      // next approach re-emits a fresh toast. Without this the toast
      // shows once per chest forever, even if the player wandered off
      // and came back later. Mirrors the latch reset in altar.js.
      this._promptShown = false;
      return;
    }
    if (promptD < PROMPT_RADIUS && !this._promptShown) {
      const key = promptLabelFor(promptPlayer.index, 'interact');
      effects.toast?.(`Нажми ${key} чтобы открыть сундук`, '#ffd166');
      this._promptShown = true;
    } else if (promptD >= PROMPT_RADIUS) {
      this._promptShown = false;
    }
    if (opener) {
      opener._lastIntent.interact = false;
      this._open(sound, effects, onSpawnRune, onSpawnPickup);
      onOpened?.(this);
    }
  }

  _open(sound, effects, onSpawnRune, onSpawnPickup) {
    this.opened = true;
    if (this._lid) {
      this._lid.rotation.x = -0.6; // hinge open
      this._lid.position.y = 0.78;
      this._lid.position.z = -0.18;
    }
    // 70% item, 30% ability
    const isAbility = defaultRandom() < 0.3;
    const id = isAbility ? pickRandomAbilityId() : pickRandomItemId();
    const rune = new Rune(this.scene, this.pos.x + 0.8, this.pos.z + 0.2, isAbility ? 'ability' : 'item', id);
    onSpawnRune?.(rune);
    sound.pickupGold?.();
    if (effects.ring) effects.ring(this.pos.x, 0.05, this.pos.z, 0xffd166, 1.2, 0.35);
    // Seed pouch — funnels into the shared world.resources.seeds counter
    // via the existing 'seed' pickup path. We push them slightly to the
    // opposite side of the rune so the player visually sees a small fan
    // of green tetras alongside the gold-coloured rune.
    if (onSpawnPickup && defaultRandom() < SEED_DROP_CHANCE) {
      const lo = SEED_DROP_RANGE[0], hi = SEED_DROP_RANGE[1];
      const amt = Math.max(lo, Math.floor(rand(lo, hi + 1)));
      const drops = spawnHarvestDrops(
        this.scene,
        this.pos.x - 0.7, this.pos.z - 0.1,
        'seed', amt,
      );
      for (const d of drops) onSpawnPickup(d);
    }
  }

  _destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
  }
}
