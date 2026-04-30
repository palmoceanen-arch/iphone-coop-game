import * as THREE from 'three';
import { clamp } from './utils.js';

const COLORS = [
  { body: 0x6ad0ff, trim: 0x2a5d80, eye: 0xffffff },
  { body: 0xff8a8a, trim: 0x803f3f, eye: 0xffffff },
];

export class Player {
  constructor(index, world, effects, sound) {
    this.index = index;
    this.world = world;
    this.effects = effects;
    this.sound = sound;

    this.pos = { x: index === 0 ? -3 : 3, z: 4 };
    this.vel = { x: 0, z: 0 };
    this.facing = { x: 0, z: -1 };
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

    this.mesh = this._buildMesh();
    this.world.scene.add(this.mesh);
  }

  _buildMesh() {
    const palette = COLORS[this.index] || COLORS[0];
    const grp = new THREE.Group();
    // body
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.5, 0.8, 6, 12),
      new THREE.MeshLambertMaterial({ color: palette.body })
    );
    body.position.y = 0.9; body.castShadow = true;
    grp.add(body);
    // head
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 16, 16),
      new THREE.MeshLambertMaterial({ color: palette.body })
    );
    head.position.y = 1.85;
    head.castShadow = true;
    grp.add(head);
    // hat brim
    const hat = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 0.6, 8),
      new THREE.MeshLambertMaterial({ color: palette.trim })
    );
    hat.position.y = 2.35;
    hat.castShadow = true;
    grp.add(hat);
    // eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: palette.eye });
    const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), eyeMat);
    const e2 = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), eyeMat);
    e1.position.set(-0.15, 1.92, 0.36); e2.position.set(0.15, 1.92, 0.36);
    grp.add(e1); grp.add(e2);
    // sword (visible during swing)
    this.swordPivot = new THREE.Group();
    this.swordPivot.position.set(0, 1.05, 0);
    grp.add(this.swordPivot);
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 1.2),
      new THREE.MeshLambertMaterial({ color: 0xeeeeee })
    );
    blade.position.z = 0.7;
    blade.castShadow = true;
    this.swordPivot.add(blade);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.12), new THREE.MeshLambertMaterial({ color: 0xb8a050 }));
    guard.position.z = 0.1;
    this.swordPivot.add(guard);
    this.swordPivot.visible = false;
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
  }

  revive() {
    this.alive = true;
    this.hp = this.maxHP;
    this.invuln = 1.0;
  }

  update(dt, intent, otherPlayer, enemies, attackOnEnemyCallback) {
    if (!this.alive) {
      this.mesh.visible = false;
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
      this.swordPivot.visible = true;
      this.sound.swing();
    }

    // Apply movement intent (kinematic)
    const m = { x: intent.moveX, z: intent.moveZ };
    if (Math.abs(m.x) > 0.01 || Math.abs(m.z) > 0.01) {
      this.facing.x = m.x; this.facing.z = m.z;
      const fl = Math.hypot(this.facing.x, this.facing.z);
      this.facing.x /= fl; this.facing.z /= fl;
    }
    this.pos.x += m.x * speed * dt;
    this.pos.z += m.z * speed * dt;

    // Knockback contribution
    this.pos.x += this.knockback.x * dt;
    this.pos.z += this.knockback.z * dt;
    // damp knockback
    const kfac = Math.exp(-6 * dt);
    this.knockback.x *= kfac;
    this.knockback.z *= kfac;

    // Resolve world collisions (walls/trees/rocks)
    this.world.resolveCollisions(this.pos, this.radius);

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

    // Sword swing animation + hit detection
    if (this.swingActive) {
      this.attackAnim += dt / 0.2; // 0.2s swing
      if (this.attackAnim >= 1) {
        this.swingActive = false;
        this.attackAnim = 0;
        this.swordPivot.visible = false;
      } else {
        // hit window 0.05..0.25
        if (!this.swingProcessed && this.attackAnim > 0.15) {
          this.swingProcessed = true;
          this._processSwing(enemies, attackOnEnemyCallback);
        }
      }
    }

    // Update mesh transform
    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    const yaw = Math.atan2(this.facing.x, this.facing.z);
    this.mesh.rotation.y = yaw;

    // Sword anim: rotate around y from -arc/2 to +arc/2
    if (this.swingActive) {
      const a = this.stats.attackArc;
      const t = this.attackAnim;
      this.swordPivot.rotation.y = -a / 2 + a * t;
      this.swordPivot.rotation.x = -0.4 - 0.4 * Math.sin(t * Math.PI);
    }

    // I-frame blink
    const blinkOn = this.invuln > 0 && Math.floor(this.invuln * 18) % 2 === 0;
    this.mesh.traverse(obj => { if (obj.isMesh && obj.material && 'opacity' in obj.material) { obj.material.transparent = blinkOn; obj.material.opacity = blinkOn ? 0.45 : 1; } });
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
