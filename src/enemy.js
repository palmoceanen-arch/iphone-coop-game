import * as THREE from 'three';
import { vdist } from './utils.js';
import { spawnCharacter, crossFadeTo } from './models.js';

// Map each enemy archetype to a CC0 character model + per-kind tint, scale,
// vertical offset and which animation slot to use for its primary attack.
// Characters face +Z by default in the source GLBs, which matches our
// atan2(facing.x,facing.z) convention, so no yaw offset is needed.
const MODEL_YAW_OFFSET = 0;
const ENEMY_VISUALS = {
  slime:  { kind: 'skel_minion',  tint: 0x6cd25b, scale: 0.5, yOffset: 0,    attackAnim: 'attack_unarmed', transparent: 0.92 },
  archer: { kind: 'skel_rogue',   tint: 0xc9a3ff, scale: 0.55, yOffset: 0,    attackAnim: 'attack_ranged' },
  bomber: { kind: 'skel_mage',    tint: 0xff8a30, scale: 0.55,  yOffset: 0,    attackAnim: 'attack_throw' },
  wisp:   { kind: 'skel_minion',  tint: 0x9dfcff, scale: 0.45,  yOffset: 0.6,  attackAnim: 'attack_spell',   transparent: 0.55 },
  ogre:   { kind: 'skel_warrior', tint: 0xb98860, scale: 0.85, yOffset: 0,    attackAnim: 'attack_melee_heavy' },
};

// Base enemy class with 5 distinct subtypes.
export class Enemy {
  constructor(world, effects, sound, kind, x, z, level = 1, opts = {}) {
    this.world = world;
    this.effects = effects;
    this.sound = sound;
    this.kind = kind;
    this.pos = { x, z };
    this.home = { x: opts.homeX ?? x, z: opts.homeZ ?? z };
    this.vel = { x: 0, z: 0 };
    this.knockback = { x: 0, z: 0 };
    this.facing = { x: 0, z: -1 };
    this.alive = true;
    this.attackTimer = 0;
    this.windup = 0;
    this.dashing = 0;
    this.invuln = 0;
    this.flashTimer = 0;
    this.level = level;
    this.tint = null;
    // AI state: 'idle' (wander near home) | 'chase' (engage player) | 'return'
    this.state = 'idle';
    this.stateTimer = 0;
    this.wanderTarget = { x, z };
    this.wanderTimer = 0;
    this.chunkKey = opts.chunkKey ?? this.world.chunkKeyOf(x, z);
    this.asleep = false;
    this.elite = !!opts.elite;
    this._frozen = 0;
    this._slow = 0;
    this._poison = null;
    this.config(level);
    if (this.elite) this._applyEliteScaling();
    this.mesh = this._buildMesh();
    this.world.scene.add(this.mesh);
  }

  _applyEliteScaling() {
    this.maxHP = Math.round(this.maxHP * 1.7);
    this.hp = this.maxHP;
    if (this.touchDamage) this.touchDamage = Math.round(this.touchDamage * 1.4);
    if (this.projectileDmg) this.projectileDmg = Math.round(this.projectileDmg * 1.4);
    if (this.swingDmg) this.swingDmg = Math.round(this.swingDmg * 1.4);
    if (this.dashDmg) this.dashDmg = Math.round(this.dashDmg * 1.4);
    if (this.boomDamage) this.boomDamage = Math.round(this.boomDamage * 1.4);
    if (Array.isArray(this.gold)) this.gold = [this.gold[0] * 2, this.gold[1] * 2];
    if (typeof this.xp === 'number') this.xp = Math.round(this.xp * 1.6);
  }

  config(level) {
    const L = level - 1;
    // Common: aggro/disengage radii. Disengage is larger so enemies don't constantly flip-flop.
    switch (this.kind) {
      case 'slime':
        this.radius = 0.55; this.maxHP = 22 + L * 8; this.hp = this.maxHP; this.speed = 2.6;
        this.touchDamage = 8 + L * 2; this.gold = [2, 5]; this.xp = 5 + L * 2;
        this.attackRange = 0.9; this.attackCooldown = 0.8;
        this.aggroRange = 7; this.disengageRange = 14; this.leashRange = 14;
        break;
      case 'archer':
        this.radius = 0.5; this.maxHP = 16 + L * 6; this.hp = this.maxHP; this.speed = 3.2;
        this.touchDamage = 0; this.gold = [3, 7]; this.xp = 8 + L * 2;
        this.attackRange = 12; this.attackCooldown = 1.6; this.preferredDist = 8.5; this.projectileDmg = 8 + L * 2;
        this.aggroRange = 11; this.disengageRange = 18; this.leashRange = 16;
        break;
      case 'bomber':
        this.radius = 0.55; this.maxHP = 18 + L * 6; this.hp = this.maxHP; this.speed = 3.6;
        this.touchDamage = 0; this.gold = [3, 6]; this.xp = 8 + L * 2;
        this.fuse = 1.0; this.boomRadius = 2.6; this.boomDamage = 24 + L * 4;
        this.aggroRange = 7; this.disengageRange = 13; this.leashRange = 14;
        break;
      case 'wisp':
        this.radius = 0.45; this.maxHP = 14 + L * 5; this.hp = this.maxHP; this.speed = 4.2;
        this.touchDamage = 0; this.gold = [2, 6]; this.xp = 7 + L * 2;
        this.dashWindup = 0.4; this.dashSpeed = 22; this.dashDmg = 10 + L * 3; this.dashCooldown = 2.4;
        this.aggroRange = 8; this.disengageRange = 16; this.leashRange = 16;
        break;
      case 'ogre':
        this.radius = 0.95; this.maxHP = 60 + L * 18; this.hp = this.maxHP; this.speed = 1.7;
        this.touchDamage = 0; this.gold = [10, 18]; this.xp = 18 + L * 4;
        this.attackRange = 2.4; this.attackCooldown = 1.8; this.swingDmg = 18 + L * 4;
        this.aggroRange = 6; this.disengageRange = 14; this.leashRange = 12;
        break;
    }
  }

  _buildMesh() {
    const grp = new THREE.Group();
    const visual = ENEMY_VISUALS[this.kind] || ENEMY_VISUALS.slime;
    const character = spawnCharacter(visual.kind, { tint: visual.tint, scale: visual.scale });
    character.root.position.y = visual.yOffset || 0;
    if (visual.transparent !== undefined) {
      character.root.traverse((obj) => {
        if (obj.isMesh && obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (m.isMaterial) {
              m.transparent = true;
              m.opacity = visual.transparent;
            }
          }
        }
      });
    }
    grp.add(character.root);

    // Cache materials for hit-flash / blink later
    const materials = [];
    character.root.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (m.isMaterial) materials.push(m);
      }
    });

    this._character = character;
    this._materials = materials;
    this._animState = 'idle';
    this._attackAnimKey = visual.attackAnim;
    this.body = null; // legacy field; effects code references `body.material` for hit flash but we now use _materials.

    // Elite enemies get a golden ring under their feet + emissive tint that
    // makes them readable from a distance. The ring is added to the parent
    // group so it stays at world-y=0 even when the character bobs.
    if (this.elite) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.75, 1.05, 24),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      grp.add(ring);
      this._eliteRing = ring;
      for (const m of materials) {
        if (m.emissive) {
          m.emissive.setHex(0xffaa30);
          m.emissiveIntensity = 0.3;
        }
      }
      // Slight upscale via root.
      character.root.scale.multiplyScalar(1.15);
    }

    grp.position.set(this.pos.x, 0, this.pos.z);
    return grp;
  }

  _playAttackAnim() {
    const action = this._character?.actions?.[this._attackAnimKey];
    if (!action) return;
    action.reset();
    action.fadeIn(0.05).play();
  }

  _aimTarget(players) {
    let best = null, bestD = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = vdist(this.pos, p.pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return { target: best, dist: bestD };
  }

  takeDamage(amount, fromX, fromZ, knockback) {
    if (!this.alive) return false;
    this.hp -= amount;
    // No post-hit i-frame on enemies: a 0.08s window was enough to make
    // multi-projectile abilities and high attack-speed weapons drop most
    // of their hits in the same frame and feel useless. The hit visual
    // (`flashTimer`) still tells the player something connected even if
    // multiple sources land simultaneously.
    this.flashTimer = 0.12;
    // Aggro on hit
    if (this.state !== 'chase') { this.state = 'chase'; this.stateTimer = 0; }
    const dx = this.pos.x - fromX, dz = this.pos.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.knockback.x += (dx / len) * knockback;
    this.knockback.z += (dz / len) * knockback;
    this.effects.burst(this.pos.x, 1.0, this.pos.z, 0xfff7a0, 6, 4, 0.3);
    this.effects.damageNumber(new THREE.Vector3(this.pos.x, 1.8 + this.radius, this.pos.z), amount, '#fff7a0');
    this.sound.enemyHit();
    if (this.hp <= 0) this.die();
    return true;
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    // Kills are the only place we still pay the freeze tax — a short
    // 0.10s pause makes the moment land without choking high-DPS play
    // (it's the natural rhythm break between targets, not added
    // friction inside a single fight).
    this.effects.doHitStop(0.10);
    this.effects.burst(this.pos.x, 0.7, this.pos.z, this._dieColor(), 18, 7, 0.6);
    this.effects.ring(this.pos.x, 0.05, this.pos.z, 0xffffff, 1.4, 0.35);
    this.sound.enemyDie();
    this.world.scene.remove(this.mesh);
    if (this.kind === 'bomber') this._explode();
  }

  _dieColor() {
    return ({ slime: 0x6cd25b, archer: 0xc9a3ff, bomber: 0xff8a30, wisp: 0x9dfcff, ogre: 0xb98860 })[this.kind] || 0xffffff;
  }

  _explode(playersForDamage = null) {
    this.effects.flashSphere(this.pos.x, 0.8, this.pos.z, 0xff8a30, this.boomRadius, 0.3);
    this.effects.ring(this.pos.x, 0.05, this.pos.z, 0xff8a30, this.boomRadius, 0.4);
    this.effects.shakeCamera(0.5);
    this.effects.doHitStop(0.06);
    this.sound.bomb();
    if (playersForDamage) {
      for (const p of playersForDamage) {
        if (vdist(this.pos, p.pos) < this.boomRadius + p.radius) {
          p.takeDamage(this.boomDamage, this.pos.x, this.pos.z);
        }
      }
    }
  }

  update(dt, players, ctx) {
    if (!this.alive) return;
    // Chunk-level culling: if this enemy's chunk is outside the simulation
    // radius, freeze it entirely — no AI, no animation, no collisions. The
    // mesh is hidden as well (the parent chunk group is hidden by World, but
    // belt-and-braces). When players walk back into range, the enemy resumes
    // exactly where it left off.
    const cx = Math.floor(this.pos.x / 32);
    const cz = Math.floor(this.pos.z / 32);
    const sleeping = !this.world.isChunkSimulating(cx, cz);
    if (sleeping) {
      if (!this.asleep) {
        this.asleep = true;
        this.mesh.visible = false;
      }
      return;
    }
    if (this.asleep) {
      this.asleep = false;
      this.mesh.visible = true;
    }
    this.invuln = Math.max(0, this.invuln - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    const statusMult = this._slow > 0 ? 0.35 : 1;
    this.attackTimer = Math.max(0, this.attackTimer - dt * statusMult);
    this.stateTimer += dt;
    this.wanderTimer = Math.max(0, this.wanderTimer - dt);

    // Status effects ------------------------------------------------
    this._frozen = Math.max(0, (this._frozen || 0) - dt);
    this._slow = Math.max(0, (this._slow || 0) - dt);
    if (this._poison && this._poison.dur > 0) {
      this._poison.dur -= dt;
      this.hp -= this._poison.dps * dt;
      if (this.hp <= 0) {
        this._deathCredit = this._poison.src || null;
        this.die();
        return;
      }
    } else if (this._poison) {
      this._poison = null;
    }
    if (this._frozen > 0) {
      this._isMoving = false;
      this._updateVisualEffects(dt);
      return;
    }
    const speedMult = this._slow > 0 ? 0.35 : 1;

    const slowDt = dt * speedMult;
    const prevWindup = this.windup;
    if (this.windup > 0) this.windup = Math.max(0, this.windup - slowDt);
    const windupFired = prevWindup > 0 && this.windup === 0;

    const { target, dist } = this._aimTarget(players);
    const distFromHome = Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z);

    // -----------------------------------------------------------------
    // AI state machine: idle <-> chase, with a 'return' state when leashed
    // -----------------------------------------------------------------
    if (this.state === 'idle' || this.state === 'return') {
      // Become aggressive only if a player gets close enough.
      if (target && dist < this.aggroRange) {
        this.state = 'chase';
        this.stateTimer = 0;
      }
    } else if (this.state === 'chase') {
      // Lose aggro when no target in range, or pulled too far from home, or already taking damage repeatedly.
      const tooFar = !target || dist > this.disengageRange;
      const leashed = distFromHome > this.leashRange;
      if (tooFar || leashed) {
        this.state = 'return';
        this.stateTimer = 0;
        // bombers shouldn't fizzle their fuse — but if not yet started, abort and walk home
        if (this.kind === 'bomber' && !this.fuseStarted) {
          // ok, just walk home
        }
      }
    }

    // ------ MOVEMENT INTENT ------
    let move = { x: 0, z: 0 };
    const idleSpeed = this.speed * 0.35 * speedMult;

    if (this.state === 'idle' || this.state === 'return') {
      // Wander around home: pick a new wander target when reached or timer elapsed.
      const dxw = this.wanderTarget.x - this.pos.x;
      const dzw = this.wanderTarget.z - this.pos.z;
      const dw = Math.hypot(dxw, dzw);
      if (dw < 0.6 || this.wanderTimer <= 0 || this.state === 'return') {
        // Pick a new wander point near home (or directly home if returning)
        if (this.state === 'return') {
          this.wanderTarget.x = this.home.x;
          this.wanderTarget.z = this.home.z;
          this.wanderTimer = 6;
          if (distFromHome < 1.5) {
            this.state = 'idle';
            this.stateTimer = 0;
          }
        } else {
          const ang = Math.random() * Math.PI * 2;
          const rad = 1.5 + Math.random() * 3.5;
          this.wanderTarget.x = this.home.x + Math.cos(ang) * rad;
          this.wanderTarget.z = this.home.z + Math.sin(ang) * rad;
          this.wanderTimer = 2 + Math.random() * 3;
        }
      }
      if (dw > 0.05) {
        move.x = dxw / dw; move.z = dzw / dw;
      }
      // pause occasionally during wander
      if (this.state === 'idle' && (this.wanderTimer % 1.0) > 0.7) {
        move.x = 0; move.z = 0;
      }
      // Move in idle/return slowly
      const oldX = this.pos.x, oldZ = this.pos.z;
      this.pos.x += move.x * idleSpeed * dt + this.knockback.x * dt;
      this.pos.z += move.z * idleSpeed * dt + this.knockback.z * dt;
      const kfac = Math.exp(-7 * dt);
      this.knockback.x *= kfac;
      this.knockback.z *= kfac;

      const movingNow = Math.abs(move.x) > 0.01 || Math.abs(move.z) > 0.01;
      if (movingNow) {
        this.facing.x = move.x; this.facing.z = move.z;
      }
      this._isMoving = movingNow;
      this.world.moveAndCollide(this.pos, oldX, oldZ, this.radius);
      this.mesh.position.set(this.pos.x, 0, this.pos.z);
      const yawIdle = Math.atan2(this.facing.x, this.facing.z);
      this.mesh.rotation.y = yawIdle + MODEL_YAW_OFFSET;
      this._updateVisualEffects(dt);
      return;
    }

    // ------ CHASE state: original engage behavior ------
    if (target) {
      const dx = target.pos.x - this.pos.x, dz = target.pos.z - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = dx / len, nz = dz / len;

      switch (this.kind) {
        case 'slime': {
          // walks toward player and bumps for damage
          move.x = nx; move.z = nz;
          if (dist < this.radius + target.radius + 0.05 && this.attackTimer <= 0) {
            target.takeDamage(this.touchDamage, this.pos.x, this.pos.z);
            this.attackTimer = this.attackCooldown;
            this._playAttackAnim();
          }
          break;
        }
        case 'archer': {
          // keep distance; if too close, back away; shoot from preferredDist
          if (dist < this.preferredDist - 1) { move.x = -nx; move.z = -nz; }
          else if (dist > this.preferredDist + 1) { move.x = nx; move.z = nz; }
          if (dist < this.attackRange && this.attackTimer <= 0 && this.windup <= 0) {
            this.windup = 0.45;
            this._aimAt = { x: target.pos.x, z: target.pos.z };
          }
          if (windupFired) {
            // fire
            this.attackTimer = this.attackCooldown;
            const tx = this._aimAt.x - this.pos.x;
            const tz = this._aimAt.z - this.pos.z;
            const tl = Math.hypot(tx, tz) || 1;
            ctx.spawnProjectile({
              fromX: this.pos.x, fromZ: this.pos.z,
              dirX: tx / tl, dirZ: tz / tl,
              speed: 14, damage: this.projectileDmg, life: 1.6, ownerEnemy: this,
              color: 0xc9a3ff,
            });
            this.sound.arrow();
            this._playAttackAnim();
          }
          break;
        }
        case 'bomber': {
          move.x = nx; move.z = nz;
          if (dist < this.radius + target.radius + 0.6) {
            // begin fuse if not started
            if (!this.fuseStarted) { this.fuseStarted = true; this.fuseTimer = this.fuse; this.sound.tone({ freq: 880, type: 'square', dur: 0.05, gain: 0.08 }); }
          }
          if (this.fuseStarted) {
            this.fuseTimer -= slowDt;
            // pulse — scale character root and tint emissive to telegraph fuse.
            const root = this._character?.root;
            if (root) {
              const baseScale = ENEMY_VISUALS[this.kind].scale;
              const p = baseScale * (1 + Math.sin(performance.now() * 0.04) * 0.12);
              root.scale.setScalar(p);
              const flash = Math.floor(performance.now() / 120) % 2 === 0;
              for (const m of this._materials || []) {
                if (!m.emissive) continue;
                m.emissive.setHex(flash ? 0xff8a30 : 0x000000);
                m.emissiveIntensity = flash ? 0.6 : 0;
              }
            }
            if (this.fuseTimer <= 0) {
              this._explode(players);
              this.alive = false;
              this.world.scene.remove(this.mesh);
              this.killedBy = 'self';
            }
          }
          break;
        }
        case 'wisp': {
          if (this.dashing > 0) {
            this.dashing -= dt;
            const sp = this.dashSpeed * speedMult;
            move.x = this._dashDir.x; move.z = this._dashDir.z;
            // Inflict damage on contact
            if (dist < this.radius + target.radius + 0.1) {
              target.takeDamage(this.dashDmg, this.pos.x, this.pos.z);
              this.dashing = 0;
              this.attackTimer = this.dashCooldown;
            }
            // override speed by direct position
            const dashOldX = this.pos.x, dashOldZ = this.pos.z;
            this.pos.x += this._dashDir.x * sp * dt;
            this.pos.z += this._dashDir.z * sp * dt;
            this.world.moveAndCollide(this.pos, dashOldX, dashOldZ, this.radius);
            this.mesh.position.set(this.pos.x, 0, this.pos.z);
            this._updateVisualEffects(dt);
            return;
          } else if (this.attackTimer <= 0 && dist < 9 && this.windup <= 0) {
            this.windup = this.dashWindup;
            this._dashDir = { x: nx, z: nz };
          } else if (this.windup <= 0) {
            move.x = nx * 0.3; move.z = nz * 0.3;
          }
          if (windupFired) {
            this.dashing = 0.35;
            this.sound.dash();
            this._playAttackAnim();
          }
          break;
        }
        case 'ogre': {
          if (dist > this.attackRange - 0.2) { move.x = nx; move.z = nz; }
          if (dist < this.attackRange && this.attackTimer <= 0 && this.windup <= 0) {
            this.windup = 0.55;
            this.sound.tone({ freq: 130, type: 'sawtooth', dur: 0.4, gain: 0.18, slide: -50 });
          }
          if (windupFired) {
            // swing!
            this.attackTimer = this.attackCooldown;
            for (const p of players) {
              if (!p.alive) continue;
              if (vdist(this.pos, p.pos) < this.attackRange + p.radius) {
                p.takeDamage(this.swingDmg, this.pos.x, this.pos.z);
                p.applyKnockback((p.pos.x - this.pos.x) || 1, (p.pos.z - this.pos.z) || 1, 16);
              }
            }
            this.effects.ring(this.pos.x, 0.1, this.pos.z, 0xff8a30, this.attackRange, 0.32);
            this.effects.shakeCamera(0.35);
            this.sound.bomb();
            this._playAttackAnim();
          }
          break;
        }
      }
    }

    // Apply movement (skip wisp dash which already moved)
    const chaseOldX = this.pos.x, chaseOldZ = this.pos.z;
    if (this.kind !== 'wisp' || (this.dashing <= 0 && this.windup <= 0)) {
      this.pos.x += move.x * this.speed * speedMult * dt;
      this.pos.z += move.z * this.speed * speedMult * dt;
    }
    // knockback
    this.pos.x += this.knockback.x * dt;
    this.pos.z += this.knockback.z * dt;
    const kfac = Math.exp(-7 * dt);
    this.knockback.x *= kfac;
    this.knockback.z *= kfac;

    const movingChase = Math.abs(move.x) > 0.01 || Math.abs(move.z) > 0.01;
    if (movingChase) {
      this.facing.x = move.x; this.facing.z = move.z;
    }
    this._isMoving = movingChase || (this.kind === 'wisp' && this.dashing > 0);

    this.world.moveAndCollide(this.pos, chaseOldX, chaseOldZ, this.radius);
    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    const yaw = Math.atan2(this.facing.x, this.facing.z);
    this.mesh.rotation.y = yaw + MODEL_YAW_OFFSET;

    this._updateVisualEffects(dt);
  }

  _updateVisualEffects(dt) {
    // Hit flash + status effect visuals via cached materials' emissive channel.
    const isFrozen = this._frozen > 0;
    const isSlowed = this._slow > 0;
    const isPoisoned = this._poison && this._poison.dur > 0;
    for (const m of this._materials || []) {
      if (this.flashTimer > 0) {
        if (!m.emissive) m.emissive = new THREE.Color(0xffffff);
        m.emissive.setHex(0xffffff);
        m.emissiveIntensity = this.flashTimer / 0.12;
      } else if (isFrozen && m.emissive) {
        m.emissive.setHex(0x9dfcff);
        m.emissiveIntensity = 0.4;
      } else if (isPoisoned && m.emissive) {
        m.emissive.setHex(0x6cd25b);
        m.emissiveIntensity = 0.25 + Math.sin(performance.now() * 0.01) * 0.1;
      } else if (isSlowed && m.emissive) {
        m.emissive.setHex(0xc9a3ff);
        m.emissiveIntensity = 0.3;
      } else if (m.emissive) {
        if (this.elite) {
          m.emissive.setHex(0xffaa30);
          m.emissiveIntensity = 0.3;
        } else {
          m.emissiveIntensity = 0;
        }
      }
    }
    if (this._eliteRing) this._eliteRing.rotation.z += dt * 0.6;
    // Bobbing motion for floaty enemies — applied to the character root so
    // the model itself rises, not the parent group (parent y is fixed at 0).
    const root = this._character?.root;
    if (root) {
      const base = ENEMY_VISUALS[this.kind]?.yOffset || 0;
      if (this.kind === 'wisp') {
        root.position.y = base + Math.sin(performance.now() * 0.004) * 0.18;
      } else if (this.kind === 'slime') {
        root.position.y = base + Math.abs(Math.sin(performance.now() * 0.006)) * 0.08;
      } else {
        root.position.y = base;
      }
    }
    // Drive locomotion animation: walk when wandering (idle/return state),
    // run when chasing, idle when truly stopped.
    const speed2 = this.knockback.x * this.knockback.x + this.knockback.z * this.knockback.z;
    const isMoving = this._isMoving || speed2 > 0.5;
    let desired;
    if (!isMoving) {
      desired = 'idle';
    } else if (this.state === 'chase') {
      desired = 'run';
    } else {
      // Wandering / returning home — slower walk anim if available.
      desired = (this._character?.actions?.walk) ? 'walk' : 'run';
    }
    if (desired !== this._animState) {
      crossFadeTo(this._character?.actions, desired, 0.18);
      this._animState = desired;
    }
    if (this._animState === 'walk' && this._character?.actions?.walk) {
      this._character.actions.walk.timeScale = 0.85;
    }
    this._character?.mixer?.update(dt);
  }
}
