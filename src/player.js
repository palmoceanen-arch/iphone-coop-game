import * as THREE from 'three';
import { clamp } from './utils.js';
import { spawnCharacter, crossFadeTo } from './models.js';

const COLORS = [
  { body: 0x6ad0ff, trim: 0x2a5d80, eye: 0xffffff },
  { body: 0xff8a8a, trim: 0x803f3f, eye: 0xffffff },
];

// KayKit characters face +Z by default in the GLB; our atan2(facing.x,facing.z)
// convention already maps facing direction to mesh.rotation.y when forward is
// +Z, so no additional offset is required.
const MODEL_YAW_OFFSET = 0;
const MODEL_SCALE = 0.6;

export class Player {
  constructor(index, world, effects, sound) {
    this.index = index;
    this.world = world;
    this.effects = effects;
    this.sound = sound;

    this.pos = { x: index === 0 ? -3 : 3, z: 4 };
    this.vel = { x: 0, z: 0 };
    this.facing = { x: 0, z: -1 };
    this.yaw = 0;        // smoothed render yaw (shortest-arc to target)
    this.smoothPos = { x: this.pos.x, z: this.pos.z };
    this.radius = 0.55;
    this.maxHP = 100;
    this.hp = this.maxHP;
    this.gold = 0;
    this.level = 1;
    this.xp = 0;
    this.alive = true;

    // Stats (modifiable by upgrades)
    this.stats = {
      damage: 12,
      speed: 6.0,
      attackCooldown: 0.45,
      attackRange: 1.7,
      attackArc: Math.PI * 0.7, // ~125°
      hpRegen: 0.4, // hp/sec
      goldFind: 1.0,
    };
    this.upgradeLevels = { damage: 0, hp: 0, speed: 0, attackSpeed: 0 };

    this.attackTimer = 0;
    this.attackAnim = 0; // 0..1 swing anim progress
    this.swingActive = false;
    this.swingProcessed = false;
    this.invuln = 0; // i-frames
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.knockback = { x: 0, z: 0 };
    // Revive progress (filled by partner holding dash near a downed body).
    this.reviveProgress = 0;

    this.mesh = this._buildMesh();
    this.world.scene.add(this.mesh);
  }

  _buildMesh() {
    const palette = COLORS[this.index] || COLORS[0];
    const grp = new THREE.Group();

    // Animated CC0 character model from KayKit (Knight) — clone of the shared
    // skeleton + materials so each player can tint differently without leaking.
    const character = spawnCharacter('knight', { tint: palette.body, scale: MODEL_SCALE });
    this._character = character;
    grp.add(character.root);

    // Cache material refs so we can do hit-flash / i-frame blink without
    // re-traversing the hierarchy every frame.
    const materials = [];
    character.root.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.isMaterial) materials.push(m);
        }
      }
    });
    this._materials = materials;

    // Initial animation state
    this._animState = 'idle';
    this._attackActionKey = 'attack_melee';
    return grp;
  }

  applyKnockback(dirX, dirZ, force) {
    this.knockback.x += dirX * force;
    this.knockback.z += dirZ * force;
  }

  takeDamage(amount, fromX, fromZ) {
    if (!this.alive || this.invuln > 0) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.invuln = 0.6;
    const dx = this.pos.x - fromX, dz = this.pos.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.applyKnockback(dx / len, dz / len, 9);
    this.effects.shakeCamera(0.18);
    this.effects.doHitStop(0.04);
    this.effects.burst(this.pos.x, 1.2, this.pos.z, 0xff5050, 8, 4, 0.35);
    this.effects.damageNumber(new THREE.Vector3(this.pos.x, 2.0, this.pos.z), amount, '#ff7a7a');
    this.sound.hurt();
    if (this.hp <= 0) this.die();
    return true;
  }

  heal(amount) {
    if (!this.alive) return;
    const before = this.hp;
    this.hp = Math.min(this.maxHP, this.hp + amount);
    if (this.hp - before > 0.5) this.effects.damageNumber(new THREE.Vector3(this.pos.x, 2.0, this.pos.z), this.hp - before, '#7aff8a');
  }

  die() {
    this.alive = false;
    this.invuln = 999;
    this.effects.burst(this.pos.x, 1.0, this.pos.z, 0xff8080, 24, 6, 0.7);
    this.sound.death();
    const death = this._character?.actions?.death;
    if (death) { death.reset(); death.fadeIn(0.1).play(); }
  }

  revive(hpFraction = 1.0) {
    this.alive = true;
    this.hp = Math.max(1, Math.round(this.maxHP * hpFraction));
    this.invuln = 1.5;
    this.reviveProgress = 0;
    if (this._character?.actions) {
      // stop death pose, return to idle
      this._character.actions.death?.stop();
      crossFadeTo(this._character.actions, 'idle', 0.0);
      this._animState = 'idle';
    }
    if (this._reviveBar) this._reviveBar.visible = false;
  }

  update(dt, intent, otherPlayer, enemies, attackOnEnemyCallback) {
    if (!this.alive) {
      // Keep mesh visible to show death pose; just freeze physics & animation.
      this._character?.mixer?.update(dt);
      return;
    }
    this.mesh.visible = true;

    // Movement
    const dashing = this.dashTimer > 0;
    let speed = this.stats.speed;
    if (dashing) speed *= 2.6;

    // Cooldowns
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt);

    // Dash trigger
    if (intent.dash && this.dashCooldown <= 0) {
      // dash in current move direction or facing
      let dx = intent.moveX, dz = intent.moveZ;
      if (Math.hypot(dx, dz) < 0.1) { dx = this.facing.x; dz = this.facing.z; }
      const len = Math.hypot(dx, dz) || 1;
      this.dashTimer = 0.18;
      this.dashCooldown = 0.9;
      this.invuln = Math.max(this.invuln, 0.22);
      this.applyKnockback(dx / len, dz / len, 14);
      this.sound.dash();
      this.effects.burst(this.pos.x, 0.6, this.pos.z, 0xffffff, 8, 5, 0.25);
    }

    // Attack trigger
    if (intent.attack && this.attackTimer <= 0) {
      this.attackTimer = this.stats.attackCooldown;
      this.attackAnim = 0;
      this.swingActive = true;
      this.swingProcessed = false;
      this.sound.swing();
      const action = this._character?.actions?.[this._attackActionKey];
      if (action) {
        action.reset();
        action.timeScale = Math.max(1.2, 0.2 / Math.max(action.getClip().duration, 0.05));
        action.fadeIn(0.05).play();
      }
    }

    // Apply movement intent (kinematic)
    const m = { x: intent.moveX, z: intent.moveZ };
    if (Math.abs(m.x) > 0.01 || Math.abs(m.z) > 0.01) {
      this.facing.x = m.x; this.facing.z = m.z;
      const fl = Math.hypot(this.facing.x, this.facing.z);
      this.facing.x /= fl; this.facing.z /= fl;
    }
    const oldX = this.pos.x, oldZ = this.pos.z;
    this.pos.x += m.x * speed * dt + this.knockback.x * dt;
    this.pos.z += m.z * speed * dt + this.knockback.z * dt;
    // damp knockback
    const kfac = Math.exp(-6 * dt);
    this.knockback.x *= kfac;
    this.knockback.z *= kfac;

    this.world.moveAndCollide(this.pos, oldX, oldZ, this.radius);

    // Soft player-vs-player overlap resolution
    if (otherPlayer && otherPlayer.alive) {
      const dx = this.pos.x - otherPlayer.pos.x;
      const dz = this.pos.z - otherPlayer.pos.z;
      const r = this.radius + otherPlayer.radius;
      const d2 = dx*dx + dz*dz;
      if (d2 < r*r && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const overlap = (r - d) / d;
        this.pos.x += dx * overlap * 0.5;
        this.pos.z += dz * overlap * 0.5;
        otherPlayer.pos.x -= dx * overlap * 0.5;
        otherPlayer.pos.z -= dz * overlap * 0.5;
      }
    }

    // HP regen (out of combat)
    if (this.hp < this.maxHP) this.hp = Math.min(this.maxHP, this.hp + this.stats.hpRegen * dt);

    // Swing hit detection — animation playback is driven by AnimationMixer,
    // but the gameplay damage window is still timer-based for predictability.
    if (this.swingActive) {
      this.attackAnim += dt / 0.25;
      if (this.attackAnim >= 1) {
        this.swingActive = false;
        this.attackAnim = 0;
      } else if (!this.swingProcessed && this.attackAnim > 0.25) {
        this.swingProcessed = true;
        this._processSwing(enemies, attackOnEnemyCallback);
      }
    }

    // Smoothed render transform — lerp position by exponential smoothing and
    // yaw by shortest-arc to avoid 180° flip on direction reversal.
    const posLerp = 1 - Math.exp(-30 * dt);
    this.smoothPos.x += (this.pos.x - this.smoothPos.x) * posLerp;
    this.smoothPos.z += (this.pos.z - this.smoothPos.z) * posLerp;
    this.mesh.position.set(this.smoothPos.x, 0, this.smoothPos.z);
    const targetYaw = Math.atan2(this.facing.x, this.facing.z);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * (1 - Math.exp(-18 * dt));
    this.mesh.rotation.y = this.yaw + MODEL_YAW_OFFSET;

    // Drive locomotion animation (idle <-> run)
    const moving = Math.hypot(m.x, m.z) > 0.05;
    const desiredAnim = moving ? 'run' : 'idle';
    if (desiredAnim !== this._animState && !this.swingActive) {
      crossFadeTo(this._character.actions, desiredAnim, 0.18);
      this._animState = desiredAnim;
    }
    // Speed up run animation slightly when dashing for visual punch.
    if (this._character?.actions?.run) {
      this._character.actions.run.timeScale = dashing ? 1.8 : 1.0;
    }
    this._character?.mixer?.update(dt);

    // I-frame blink — pre-cached materials.
    const blinkOn = this.invuln > 0 && Math.floor(this.invuln * 18) % 2 === 0;
    for (const m of this._materials) {
      m.transparent = blinkOn;
      m.opacity = blinkOn ? 0.45 : 1;
    }
  }

  _processSwing(enemies, callback) {
    const cx = this.pos.x, cz = this.pos.z;
    const fx = this.facing.x, fz = this.facing.z;
    const range = this.stats.attackRange;
    const halfArc = this.stats.attackArc / 2;
    let hits = 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - cx, dz = e.pos.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > range + e.radius) continue;
      const ndx = dx / (d || 1), ndz = dz / (d || 1);
      const dot = ndx * fx + ndz * fz;
      const ang = Math.acos(clamp(dot, -1, 1));
      if (ang <= halfArc) {
        callback(this, e);
        hits++;
      }
    }
    if (hits > 0) {
      this.effects.shakeCamera(0.15);
      this.effects.doHitStop(0.04);
    }
  }

  applyUpgrade(kind) {
    const lvl = this.upgradeLevels[kind] || 0;
    this.upgradeLevels[kind] = lvl + 1;
    if (kind === 'damage') this.stats.damage = Math.round((12 + (lvl + 1) * 6) * 100) / 100;
    if (kind === 'hp') {
      const before = this.maxHP;
      this.maxHP = 100 + (lvl + 1) * 30;
      this.hp += (this.maxHP - before);
    }
    if (kind === 'speed') this.stats.speed = 6.0 + (lvl + 1) * 0.6;
    if (kind === 'attackSpeed') this.stats.attackCooldown = Math.max(0.12, 0.45 - (lvl + 1) * 0.06);
  }
}
