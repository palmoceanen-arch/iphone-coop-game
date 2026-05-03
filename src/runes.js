// Rune pickups: a glowing crystal in the world that a player picks up to
// either stack a passive item or replace their active ability.
//
// - kind = 'item'   : auto-pickup on touch, stacks player.items[id].
// - kind = 'ability': interact-pickup (E/J), replaces player.ability.
//
// We don't load any external models — the crystal is built from primitives
// so it works in every environment.

import * as THREE from 'three';
import { ITEM_BY_ID, RARITY } from './items.js';
import { ABILITY_BY_ID } from './abilities.js';
import { vdist } from './utils.js';

const ITEM_MAGNET_RADIUS = 2.4;
const ITEM_PICKUP_RADIUS = 0.8;
const ABILITY_PROMPT_RADIUS = 2.0;
const ABILITY_PICKUP_RADIUS = 1.4;

export class Rune {
  constructor(scene, x, z, kind, payloadId) {
    this.scene = scene;
    this.pos = { x, z };
    this.kind = kind;          // 'item' | 'ability'
    this.payloadId = payloadId; // item id or ability id
    this.alive = true;
    this.life = 60;            // seconds before despawn (long, since rare)
    this._pickupCooldown = 0.5; // prevents instant pickup on same frame as chest open
    this.bobT = Math.random() * Math.PI * 2;
    this.color = this._pickColor();
    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }

  _pickColor() {
    if (this.kind === 'item') {
      const def = ITEM_BY_ID[this.payloadId];
      const r = def && RARITY[def.rarity];
      return r ? r.color : 0xffffff;
    }
    const a = ABILITY_BY_ID[this.payloadId];
    return a ? a.color : 0xc9a3ff;
  }

  _buildMesh() {
    const grp = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(0.32, 0);
    const mat = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.92 });
    const crystal = new THREE.Mesh(geo, mat);
    grp.add(crystal);
    // Halo ring on the floor for visibility.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.95, 24),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    grp.add(ring);
    grp.position.set(this.pos.x, 0.95, this.pos.z);
    this._crystal = crystal;
    this._ring = ring;
    return grp;
  }

  update(dt, players, sound, effects, onPickup) {
    if (!this.alive) return;
    this.life -= dt;
    if (this._pickupCooldown > 0) this._pickupCooldown -= dt;
    this.bobT += dt * 3;
    if (this._crystal) {
      this._crystal.rotation.y += dt * 1.5;
      this._crystal.position.y = Math.sin(this.bobT) * 0.15;
    }
    if (this._ring) this._ring.rotation.z += dt * 0.6;
    if (this.life <= 0) { this._destroy(); return; }

    let near = null, nd = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = vdist(this.pos, p.pos);
      if (d < nd) { nd = d; near = p; }
    }
    if (!near) return;

    if (this.kind === 'item') {
      // Magnet then auto-pickup.
      if (nd < ITEM_MAGNET_RADIUS) {
        const dx = near.pos.x - this.pos.x, dz = near.pos.z - this.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        this.pos.x += (dx / len) * 5 * dt;
        this.pos.z += (dz / len) * 5 * dt;
        this.mesh.position.x = this.pos.x;
        this.mesh.position.z = this.pos.z;
      }
      if (nd < ITEM_PICKUP_RADIUS) {
        near.addItem?.(this.payloadId);
        const def = ITEM_BY_ID[this.payloadId];
        if (def) effects.toast?.(`+ ${def.name}: ${def.desc || ''}`, '#' + this.color.toString(16).padStart(6, '0'));
        sound.pickupGold?.();
        if (effects.ring) effects.ring(near.pos.x, 0.05, near.pos.z, this.color, 1.4, 0.3);
        onPickup?.(this, near);
        this._destroy();
      }
      return;
    }

    if (this.kind === 'ability') {
      const promptEl = (near.index === 0 ? this._prompt1 : this._prompt2);
      if (nd < ABILITY_PROMPT_RADIUS) {
        // Show a small floating prompt above the rune.
        const def = ABILITY_BY_ID[this.payloadId];
        const key = near.index === 0 ? 'E' : 'J';
        if (!this._promptOnce) {
          effects.toast?.(`Нажми ${key} чтобы взять «${def?.name || this.payloadId}»`, '#' + this.color.toString(16).padStart(6, '0'));
          this._promptOnce = true;
        }
        // Pickup-trigger only on the player who pressed interact.
        // Game wires this by passing `intentInteract` per player.
        const intent = near._lastIntent;
        if (intent && intent.interact && nd < ABILITY_PICKUP_RADIUS && this._pickupCooldown <= 0) {
          near.setAbility?.(this.payloadId);
          if (def) effects.toast?.(`Способность: ${def.name}`, '#' + this.color.toString(16).padStart(6, '0'));
          sound.bell?.();
          if (effects.ring) effects.ring(near.pos.x, 0.05, near.pos.z, this.color, 1.6, 0.4);
          onPickup?.(this, near);
          this._destroy();
        }
      }
      void promptEl;
    }
  }

  _destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
  }
}
