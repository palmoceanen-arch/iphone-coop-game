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
import { vdist, defaultRandom } from './utils.js';

const PROMPT_RADIUS = 2.2;
const OPEN_RADIUS = 1.2;

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

  update(dt, players, sound, effects, onSpawnRune) {
    if (!this.alive) return;
    this.bobT += dt * 2;
    if (this.opened) {
      // Fade out the chest a bit after opening, then despawn.
      this._fade = (this._fade || 0) + dt;
      if (this._fade > 1.8) this._destroy();
      return;
    }
    let near = null, nd = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = vdist(this.pos, p.pos);
      if (d < nd) { nd = d; near = p; }
    }
    if (!near) return;
    if (nd < PROMPT_RADIUS && !this._promptShown) {
      const key = near.index === 0 ? 'E' : 'J';
      effects.toast?.(`Нажми ${key} чтобы открыть сундук`, '#ffd166');
      this._promptShown = true;
    }
    if (nd < OPEN_RADIUS) {
      const intent = near._lastIntent;
      if (intent && intent.interact) {
        this._open(sound, effects, onSpawnRune);
      }
    }
  }

  _open(sound, effects, onSpawnRune) {
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
  }

  _destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
  }
}
