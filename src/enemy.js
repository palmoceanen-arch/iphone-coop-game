import * as THREE from 'three';
import { vdist, defaultRandom } from './utils.js';
import { spawnCharacter, crossFadeTo } from './models.js';
import { HandlePool } from './pool.js';

// Recycle the (heavy) skeleton clone + AnimationMixer + cloned MeshToon
// materials produced by `spawnCharacter`. Killing 5 slimes a second is
// realistic late-game; without pooling each kill drops ~60 ToonMaterial
// clones + a fresh AnimationMixer with ~30 ClipActions onto the GC.
//
// Pool key bundles every visual axis a single instance pre-bakes — the
// kind drives the source GLB + tint + transparent opacity (e.g. wisps render
// at 0.55 alpha), and elite-ness drives the +15% scale + 0.3 emissive boost.
// Two acquired handles for the same key are visually interchangeable.
const ENEMY_POOL = new HandlePool(24);

function enemyPoolKey(kind, elite) {
  return `${kind}|${elite ? 'elite' : 'normal'}`;
}

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
    // Night-walker enemies spawn far from the player at night and
    // wander with a soft bias toward the nearest player instead of
    // staying tied to their `home` point. The wander code in
    // `update()` consults this flag for the bias logic. The aggro
    // range bump happens after `config()` runs (below) — otherwise
    // it'd be overwritten when the per-kind defaults are applied.
    this._nightWalker = !!opts.nightWalker;
    this._frozen = 0;
    // _stunned is the immobilize-only counterpart to _frozen — it
    // also prevents movement and resets the attack windup, but it
    // tints the model gold instead of icy blue. Used by the Knight's
    // shield-bash charge so a stunned enemy doesn't read as
    // "frozen" (the icy tint is reserved for actual ice damage).
    this._stunned = 0;
    this._slow = 0;
    this._poison = null;
    this.config(level);
    if (this.elite) this._applyEliteScaling();
    if (this._nightWalker) {
      this.aggroRange = Math.max(this.aggroRange || 0, 14);
      this.disengageRange = Math.max(this.disengageRange || 0, 22);
      this.leashRange = Math.max(this.leashRange || 0, 30);
    }
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
        this.touchDamage = 5 + L * 2; this.gold = [2, 5]; this.xp = 5 + L * 2;
        this.attackRange = 0.9; this.attackCooldown = 0.8;
        this.aggroRange = 7; this.disengageRange = 14; this.leashRange = 14;
        break;
      case 'archer':
        this.radius = 0.5; this.maxHP = 16 + L * 6; this.hp = this.maxHP; this.speed = 3.2;
        this.touchDamage = 0; this.gold = [3, 7]; this.xp = 8 + L * 2;
        this.attackRange = 12; this.attackCooldown = 1.6; this.preferredDist = 8.5; this.projectileDmg = 5 + L * 2;
        this.aggroRange = 11; this.disengageRange = 18; this.leashRange = 16;
        break;
      case 'bomber':
        this.radius = 0.55; this.maxHP = 18 + L * 6; this.hp = this.maxHP; this.speed = 3.6;
        this.touchDamage = 0; this.gold = [3, 6]; this.xp = 8 + L * 2;
        this.fuse = 1.0; this.boomRadius = 2.6; this.boomDamage = 16 + L * 4;
        this.aggroRange = 7; this.disengageRange = 13; this.leashRange = 14;
        break;
      case 'wisp':
        // Wisps were too punishing — fast dash + low telegraph + high damage
        // even at level 1. Bumped windup so the dash is more readable, slowed
        // the dash itself, dropped damage and HP, and made the cooldown
        // longer so they don't spam-jump on the player.
        this.radius = 0.45; this.maxHP = 10 + L * 4; this.hp = this.maxHP; this.speed = 4.0;
        this.touchDamage = 0; this.gold = [2, 6]; this.xp = 7 + L * 2;
        this.dashWindup = 0.7; this.dashSpeed = 16; this.dashDmg = 5 + L * 2; this.dashCooldown = 3.5;
        this.aggroRange = 8; this.disengageRange = 16; this.leashRange = 16;
        break;
      case 'ogre':
        this.radius = 0.95; this.maxHP = 60 + L * 18; this.hp = this.maxHP; this.speed = 1.7;
        this.touchDamage = 0; this.gold = [10, 18]; this.xp = 18 + L * 4;
        this.attackRange = 2.4; this.attackCooldown = 1.8; this.swingDmg = 12 + L * 4;
        this.aggroRange = 6; this.disengageRange = 14; this.leashRange = 12;
        break;
    }
  }

  _buildMesh() {
    const visual = ENEMY_VISUALS[this.kind] || ENEMY_VISUALS.slime;
    const reused = ENEMY_POOL.acquire(enemyPoolKey(this.kind, this.elite));
    if (reused) {
      this._adoptHandle(reused, visual);
      this._resetVisualState(visual);
      return reused.grp;
    }

    const grp = new THREE.Group();
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
    this._eliteRing = null;

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

  // Re-bind handles from a pooled bundle onto `this`. The `grp`/`character`
  // /`materials`/`eliteRing` references are kept so all gameplay code that
  // pokes `this._character` / `this._materials` / etc. just keeps working.
  _adoptHandle(handle, visual) {
    this._character = handle.character;
    this._materials = handle.materials;
    this._eliteRing = handle.eliteRing;
    this._attackAnimKey = visual.attackAnim;
    this._animState = 'idle';
    this.body = null;
  }

  // Bring a pooled enemy back to a clean visual state. Must reverse anything
  // the live update loop mutates between `acquire` and `release`:
  //   • bomber pulses character.root.scale during fuse — reset to base
  //   • _updateVisualEffects sets emissive flash / freeze / poison tint —
  //     clear so the first re-spawn frame doesn't show a frozen-blue slime
  //   • mixer plays attack / hit / death actions on top of idle/run — stop
  //     all of them so the new instance crossfades cleanly into idle
  //   • elite ring rotates over time — leave rotation as-is (no gameplay
  //     impact) but make sure the ring is parented to grp (it is, just by
  //     virtue of being a child of `grp`)
  _resetVisualState(visual) {
    const grp = this._character?.root?.parent || null;
    if (grp) {
      grp.position.set(this.pos.x, 0, this.pos.z);
      grp.rotation.set(0, 0, 0);
      grp.visible = true;
    }
    const root = this._character?.root;
    if (root) {
      const eliteScale = this.elite ? 1.15 : 1.0;
      root.scale.setScalar(visual.scale * eliteScale);
      root.position.y = visual.yOffset || 0;
    }
    // Animation reset: force every action off the mixer, then re-arm idle
    // as the locomotion baseline. Three.js's `action.stop()` deactivates
    // the action and clears its internal time tracking; `action.reset()`
    // alone leaves it scheduled, which would let the previous death/hit/
    // attack pose bleed into the new spawn (most visibly as a stuck
    // T-pose when no locomotion clip ends up with weight > 0).
    //
    // We restore each action's `weight` to 1 (Three.js's factory default)
    // rather than zero. A future play()/fadeIn() of any of these slots
    // (locomotion via crossFadeTo, attacks via _playAttackAnim) computes
    // `_effectiveWeight = weight * fadeInterpolant`, so leaving weight at
    // 0 here would cause every action played later to contribute zero —
    // the bones would fall back to bind pose mid-locomotion (T-pose) and
    // attack swings would be invisible on pool-recycled enemies.
    if (this._character?.actions) {
      const actions = this._character.actions;
      for (const a of Object.values(actions)) {
        if (!a) continue;
        a.stop();
        a.setEffectiveWeight(1.0);
      }
      if (actions.idle) {
        actions.idle.reset();
        actions.idle.enabled = true;
        actions.idle.play();
      }
    }
    // Park _animState in an impossible value so the locomotion machine's
    // `desired !== _animState` check fires unconditionally on the first
    // post-spawn tick — that way crossFadeTo runs through its normal
    // path and we never ship an enemy whose action weights all sum to 0.
    this._animState = null;
    for (const m of this._materials || []) {
      if (m.emissive) {
        if (this.elite) {
          m.emissive.setHex(0xffaa30);
          m.emissiveIntensity = 0.3;
        } else {
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        }
      }
    }
  }

  // Tear-down counterpart of `_buildMesh`. Removes the mesh from the scene
  // and either parks the visual handle in the pool for the next spawn or —
  // if the bucket is full — drops the reference for GC. Called from die(),
  // bomber self-explode, and the chunk-unload despawn path in game.js.
  _releaseMesh() {
    if (!this.mesh) return;
    try { this.world.scene.remove(this.mesh); } catch { /* ignore */ }
    this.mesh.visible = false;
    if (!this._character) {
      this.mesh = null;
      return;
    }
    const handle = {
      grp: this.mesh,
      character: this._character,
      materials: this._materials,
      eliteRing: this._eliteRing || null,
    };
    ENEMY_POOL.release(enemyPoolKey(this.kind, this.elite), handle);
    this.mesh = null;
    this._character = null;
    this._materials = null;
    this._eliteRing = null;
  }

  _playAttackAnim() {
    const action = this._character?.actions?.[this._attackAnimKey];
    if (!action) return;
    // setEffectiveWeight(1) defends against a pool acquire that just zeroed
    // every action's weight: without it `_effectiveWeight = 0 * fadeIn` and
    // the swing animation would be invisible on a recycled enemy.
    action.reset().setEffectiveWeight(1.0);
    action.fadeIn(0.05).play();
  }

  _aimTarget(players) {
    let best = null, bestD = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      // Solo-mode phantom partner is glued to the live player and is
      // invulnerable — skip it so enemies don't waste hits on a ghost.
      if (p._phantom) continue;
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
    // Kills get the lightest possible micro-pause — barely perceptible
    // (~1.5 sim frames of slow-mo) so high-DPS / multi-kill swings
    // don't feel sluggish but the moment still registers as an
    // "impact". The rising-edge guard in Effects.doHitStop prevents a
    // 3-kill swing from triggering this three times in a row.
    this.effects.doHitStop(0.025);
    this.effects.burst(this.pos.x, 0.7, this.pos.z, this._dieColor(), 18, 7, 0.6);
    this.effects.ring(this.pos.x, 0.05, this.pos.z, 0xffffff, 1.4, 0.35);
    this.sound.enemyDie();
    this._releaseMesh();
    if (this.kind === 'bomber') this._explode();
  }

  _dieColor() {
    return ({ slime: 0x6cd25b, archer: 0xc9a3ff, bomber: 0xff8a30, wisp: 0x9dfcff, ogre: 0xb98860 })[this.kind] || 0xffffff;
  }

  // JSON-clean snapshot for persistence. Captures everything the
  // chunk-streaming reload path needs to bring this enemy back at the
  // same HP / pos / aggro state. Returns null when the enemy is dead so
  // callers can drop the entry instead of saving a tombstone.
  toOverride() {
    if (!this.alive) return null;
    const ov = {
      kind: this.kind,
      x: this.pos.x,
      z: this.pos.z,
      level: this.level,
      hp: this.hp,
      maxHP: this.maxHP,
      elite: !!this.elite,
      asleep: !!this.asleep,
      state: this.state || 'idle',
      homeX: this.home ? this.home.x : this.pos.x,
      homeZ: this.home ? this.home.z : this.pos.z,
    };
    // Only store status effects when present so a save with a thousand
    // idle slimes doesn't carry a thousand `_frozen: 0` entries.
    if (this._frozen && this._frozen > 0) ov._frozen = this._frozen;
    if (this._stunned && this._stunned > 0) ov._stunned = this._stunned;
    if (this._slow && this._slow > 0) ov._slow = this._slow;
    if (this._poison && this._poison.dur > 0) {
      ov._poison = { dps: this._poison.dps, dur: this._poison.dur };
    }
    return ov;
  }

  // Re-apply a saved snapshot. Constructor has already run config() to
  // produce baseline level-scaled stats; we patch hp / state / status
  // effects on top so the enemy resumes at exactly the captured state.
  applyOverride(ov) {
    if (!ov) return;
    if (typeof ov.maxHP === 'number') this.maxHP = ov.maxHP;
    if (typeof ov.hp === 'number') {
      this.hp = Math.max(0, Math.min(this.maxHP, ov.hp));
      if (this.hp <= 0) this.alive = false;
    }
    if (typeof ov.state === 'string') {
      this.state = ov.state;
      this.stateTimer = 0;
    }
    if (typeof ov.asleep === 'boolean') {
      this.asleep = ov.asleep;
      if (this.mesh) this.mesh.visible = !ov.asleep;
    }
    if (typeof ov._frozen === 'number') this._frozen = ov._frozen;
    if (typeof ov._stunned === 'number') this._stunned = ov._stunned;
    if (typeof ov._slow === 'number') this._slow = ov._slow;
    if (ov._poison && typeof ov._poison.dur === 'number') {
      this._poison = { dps: ov._poison.dps || 0, dur: ov._poison.dur, src: null };
    }
    if (ov.homeX !== undefined && ov.homeZ !== undefined) {
      this.home = { x: ov.homeX, z: ov.homeZ };
    }
  }

  _explode(playersForDamage = null) {
    this.effects.flashSphere(this.pos.x, 0.8, this.pos.z, 0xff8a30, this.boomRadius, 0.3);
    this.effects.ring(this.pos.x, 0.05, this.pos.z, 0xff8a30, this.boomRadius, 0.4);
    this.effects.shakeCamera(0.5);
    this.effects.doHitStop(0.02);
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
    // Distance-based culling with hysteresis. The previous implementation
    // sleep-gated on `world.isChunkSimulating(currentChunk)`, which has
    // two flaws:
    //   1. Granularity is one full chunk (32u). An enemy that walks
    //      *across* a chunk boundary right at the sim-radius edge would
    //      flip asleep on the very next tick — even if the player is
    //      still 30 units away — and then flip back as the player
    //      advances by another half-chunk. Visible to the user as
    //      a "stuck twitching" enemy that can't leave its chunk.
    //   2. The sleep check used `this.pos`, but `chunkKey` (set at
    //      construction) was never recomputed. So the despawn-on-
    //      chunk-unload path could free the wrong enemy (the one whose
    //      *home* was in the unloaded chunk, even if the enemy itself
    //      had since wandered out).
    // Now: sleep when far from every alive player, with separate
    // wake/sleep thresholds so brief boundary crossings don't flicker.
    // Use every player's position, alive or downed — during the death
    // screen we still want enemies in view to stay visible (they
    // shouldn't pop out of existence the moment the player goes down).
    let nearestPlayerD2 = Infinity;
    for (const p of players) {
      if (!p) continue;
      const dx = this.pos.x - p.pos.x;
      const dz = this.pos.z - p.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestPlayerD2) nearestPlayerD2 = d2;
    }
    // Wake within ~70u (just over 2 chunks at 32u/chunk), sleep beyond
    // ~85u so there's a 15u dead-zone between the two states.
    const SLEEP_FAR_2 = 85 * 85;
    const WAKE_NEAR_2 = 70 * 70;
    const shouldSleep = this.asleep
      ? nearestPlayerD2 > WAKE_NEAR_2
      : nearestPlayerD2 > SLEEP_FAR_2;
    if (shouldSleep) {
      if (!this.asleep) {
        this.asleep = true;
        if (this.mesh) this.mesh.visible = false;
      }
      return;
    }
    if (this.asleep) {
      this.asleep = false;
      if (this.mesh) this.mesh.visible = true;
    }
    // Refresh chunkKey from current position so chunk-unload despawn
    // operates on a wandering enemy's *current* chunk, not the chunk
    // they spawned in. Cheap (one floor + string format) and avoids
    // a class of "enemy disappears when player walks back through
    // their old chunk" bugs.
    this.chunkKey = this.world.chunkKeyOf(this.pos.x, this.pos.z);
    this.invuln = Math.max(0, this.invuln - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    const statusMult = this._slow > 0 ? 0.35 : 1;
    this.attackTimer = Math.max(0, this.attackTimer - dt * statusMult);
    this.stateTimer += dt;
    this.wanderTimer = Math.max(0, this.wanderTimer - dt);

    // Status effects ------------------------------------------------
    this._frozen = Math.max(0, (this._frozen || 0) - dt);
    this._stunned = Math.max(0, (this._stunned || 0) - dt);
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
    if (this._frozen > 0 || this._stunned > 0) {
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
      // Lose aggro only when the target is genuinely out of reach
      // (dist > disengageRange) — drop the old leash check that
      // tethered each enemy to its spawn point. The leash made
      // mid-chase enemies "pop" back to a slow walk-home as soon
      // as the player crossed an arbitrary radius from spawn,
      // which the user reads as "twitches and slows down when far
      // from spawn". Now they keep chasing as long as they can
      // see a player; if the player escapes, the enemy stops in
      // place and re-roots its home to that spot (below) so it
      // wanders locally instead of trekking all the way back.
      const tooFar = !target || dist > this.disengageRange;
      if (tooFar) {
        // Skip the legacy 'return' state — re-anchor home to the
        // enemy's current position and drop straight into 'idle'.
        // The old code routed through 'return', which marched the
        // enemy back to its spawn point at idleSpeed (35% of run
        // speed); that was exactly the "lag" the user saw whenever
        // they walked far from a spawn cluster and aggroed enemies
        // had to slowly trudge home afterwards.
        this.state = 'idle';
        this.stateTimer = 0;
        this.home.x = this.pos.x;
        this.home.z = this.pos.z;
        this.wanderTarget.x = this.pos.x;
        this.wanderTarget.z = this.pos.z;
        this.wanderTimer = 0;
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
        } else if (this._nightWalker && target) {
          // Night walker: drift around the current position, biased
          // toward the nearest player. 60% of picks point roughly at
          // the player (±60° spread) so the herd slowly closes in
          // without ever guaranteeing a chase line. 40% are fully
          // random so the movement still reads as wandering.
          const baseAng = Math.atan2(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
          const biased = defaultRandom() < 0.6;
          const ang = biased
            ? baseAng + (defaultRandom() - 0.5) * (Math.PI / 1.5)
            : defaultRandom() * Math.PI * 2;
          const rad = 3 + defaultRandom() * 5;
          this.wanderTarget.x = this.pos.x + Math.sin(ang) * rad;
          this.wanderTarget.z = this.pos.z + Math.cos(ang) * rad;
          this.wanderTimer = 2 + defaultRandom() * 2;
        } else {
          const ang = defaultRandom() * Math.PI * 2;
          const rad = 1.5 + defaultRandom() * 3.5;
          this.wanderTarget.x = this.home.x + Math.cos(ang) * rad;
          this.wanderTarget.z = this.home.z + Math.sin(ang) * rad;
          this.wanderTimer = 2 + defaultRandom() * 3;
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
              this._releaseMesh();
              this.killedBy = 'self';
              // Bail out of the rest of update() — _releaseMesh nulled
              // this.mesh, so the position-set / yaw / visual-effect tail
              // of the function would otherwise dereference null.
              return;
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
    const isStunned = this._stunned > 0;
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
      } else if (isStunned && m.emissive) {
        // Stun tint — gold, distinct from the icy blue of _frozen so
        // the player can read "Knight bashed it" vs "Mage froze it".
        m.emissive.setHex(0xffe066);
        m.emissiveIntensity = 0.35;
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
    // T-pose safety net. After every locomotion-machine pass, the sum of
    // locomotion action weights *should* be ~1 (either solo idle, solo
    // run, solo walk, or one of those mid-crossfade with another). If
    // the total is near zero — for any reason: a pool-reuse reset that
    // didn't take, a stale interpolant, an aborted fadeIn — the skinned
    // mesh falls back to bind pose (T-pose) and the user sees an enemy
    // sliding around with arms straight out. This guard force-rearms
    // idle so the worst case is "stationary idle anim" not "T-pose".
    const acts = this._character?.actions;
    if (acts) {
      const wSum = (acts.idle?.weight || 0) + (acts.run?.weight || 0) + (acts.walk?.weight || 0);
      if (wSum < 0.05 && acts.idle) {
        acts.idle.stop();
        acts.idle.reset();
        acts.idle.weight = 1;
        acts.idle.enabled = true;
        acts.idle.play();
        this._animState = 'idle';
      }
    }
    this._character?.mixer?.update(dt);
  }
}
