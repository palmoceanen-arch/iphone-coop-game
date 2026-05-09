// Altar of the Ancients — a rare interactable that lets players manage
// their item inventory mid-run. Spawned by chunk generation in world.js,
// scattered sparsely across the map (much rarer than chests).
//
// On interact (E for P1 / J for P2) the game opens the altar UI panel
// which presents three actions:
//
//   • Перековать — spend gold to reroll one item into a random different
//     item of the same rarity. Costs 1 charge.
//   • Сжечь      — delete one stack of an item, gain gold based on its
//     rarity (30/80/200/500). Costs 1 charge.
//   • Слить      — fuse 3 stacks of the same item into 1 random item of
//     the next rarity tier (common→uncommon→rare→legendary). Free, but
//     still costs 1 charge.
//
// Each altar starts with `MAX_CHARGES` charges shared between both
// players. When the charges are exhausted the altar visually dims and
// can no longer be interacted with.

import * as THREE from 'three';
import { TOON_GRADIENT } from './shading.js';
import { vdist, defaultRandom } from './utils.js';

export const ALTAR_PROMPT_RADIUS = 2.4;
export const ALTAR_USE_RADIUS = 1.6;
export const MAX_CHARGES = 3;
export const REROLL_COST = 80;

export class Altar {
  constructor(scene, x, z) {
    this.scene = scene;
    this.pos = { x, z };
    this.alive = true;
    this.charges = MAX_CHARGES;
    this.bobT = defaultRandom() * Math.PI * 2;
    this._promptShown = false;
    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }

  get isActive() { return this.alive && this.charges > 0; }

  _buildMesh() {
    const grp = new THREE.Group();

    // Stone base — three stacked stone tiers that read as a dolmen / altar.
    const stoneMat = new THREE.MeshToonMaterial({ color: 0x6e6862, gradientMap: TOON_GRADIENT });
    const darkMat = new THREE.MeshToonMaterial({ color: 0x4a4641, gradientMap: TOON_GRADIENT });

    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 0.35, 12), stoneMat);
    base.castShadow = true; base.position.y = 0.18;
    grp.add(base);

    const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.55, 10), darkMat);
    mid.castShadow = true; mid.position.y = 0.55;
    grp.add(mid);

    const top = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.85, 0.18, 12), stoneMat);
    top.castShadow = true; top.position.y = 0.92;
    grp.add(top);

    // Rune-bowl (a slightly recessed stone disc lit by a glow ring).
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.06, 16), darkMat);
    bowl.position.y = 1.005;
    grp.add(bowl);

    // Glowing rune ring, tinted gold while active and grey when spent.
    const ringColor = 0xffd166;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.78, 24),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 1.04;
    grp.add(ring);
    this._ring = ring;

    // Hovering crystal that bobs above the bowl (changes colour with charges).
    const crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.28, 0),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.95 })
    );
    crystal.position.y = 1.55;
    grp.add(crystal);
    this._crystal = crystal;

    // Floor halo — same idea as runes/chests, makes the altar visible from a
    // distance even when partly occluded by trees. Bigger / more opaque than
    // a chest halo because altars are rare and you should be able to spot
    // one from across a clearing.
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 2.6, 28),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.02;
    grp.add(halo);
    this._halo = halo;

    // Vertical light beam shooting up from the bowl. A semi-transparent thin
    // cylinder scaled tall — same trick used for puzzle markers in plenty of
    // arcade-style games. Helps players spot altars from far away even when
    // trees occlude the ground halo.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.05, 6.0, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.position.y = 4.0;
    grp.add(beam);
    this._beam = beam;

    grp.position.set(this.pos.x, 0, this.pos.z);
    return grp;
  }

  // Visually dim the altar to "spent" state once charges run out.
  _refreshGlow() {
    const active = this.isActive;
    const color = active ? 0xffd166 : 0x6a6660;
    if (this._ring) {
      this._ring.material.color.setHex(color);
      this._ring.material.opacity = active ? 0.85 : 0.35;
    }
    if (this._crystal) {
      this._crystal.material.color.setHex(color);
      this._crystal.material.opacity = active ? 0.95 : 0.4;
    }
    if (this._halo) {
      this._halo.material.color.setHex(color);
      this._halo.material.opacity = active ? 0.4 : 0.12;
    }
    if (this._beam) {
      this._beam.material.color.setHex(color);
      this._beam.material.opacity = active ? 0.18 : 0.04;
    }
  }

  update(dt, players, sound, effects) {
    if (!this.alive) return;
    this.bobT += dt * 2;
    if (this._crystal) {
      this._crystal.rotation.y += dt * 1.2;
      this._crystal.position.y = 1.55 + Math.sin(this.bobT) * 0.08;
    }
    if (this._halo) this._halo.rotation.z += dt * 0.4;

    if (!this.isActive) return;
    let near = null, nd = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = vdist(this.pos, p.pos);
      if (d < nd) { nd = d; near = p; }
    }
    if (!near) return;
    if (nd < ALTAR_PROMPT_RADIUS && !this._promptShown) {
      const key = near.index === 0 ? 'E' : 'J';
      effects.toast?.(`Нажми ${key} чтобы открыть алтарь (${this.charges}/${MAX_CHARGES} зарядов)`, '#ffd166');
      this._promptShown = true;
    }
    if (nd > ALTAR_PROMPT_RADIUS) this._promptShown = false;

    void sound; // sounds are played by the UI on action commit
  }

  // Spend one charge. Returns true if successful, false when the altar is
  // already depleted (UI guards this but we double-check for safety).
  spendCharge() {
    if (this.charges <= 0) return false;
    this.charges -= 1;
    if (this.charges <= 0) this._refreshGlow();
    return true;
  }

  destroyMesh() {
    this.alive = false;
    this.scene.remove(this.mesh);
  }

  // JSON-clean snapshot of altar state. Returns null for altars that
  // are still at full charges so the saved blob doesn't carry no-op
  // entries for every altar the player has merely walked past.
  toOverride() {
    if (this.charges >= MAX_CHARGES) return null;
    return { charges: Math.max(0, this.charges) };
  }

  // Re-apply a saved charge count after construction. Refreshes the
  // glow state immediately so a depleted altar reads as spent on the
  // first frame instead of the next gameplay tick.
  applyOverride(ov) {
    if (!ov) return;
    if (typeof ov.charges === 'number') {
      this.charges = Math.max(0, Math.min(MAX_CHARGES, ov.charges));
      this._refreshGlow();
    }
  }
}
