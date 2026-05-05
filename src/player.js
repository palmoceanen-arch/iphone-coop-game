import * as THREE from 'three';
import { clamp } from './utils.js';
import {
  spawnCharacter,
  crossFadeTo,
  setEquippedWeapon,
  preloadWeapons,
  WEAPONS,
} from './models.js';
import { runItemHook, ITEM_BY_ID, MAX_STACKS, healMultiplier } from './items.js';
import { ABILITY_BY_ID } from './abilities.js';

// Default starter loadout per player slot. The framework supports any weapon
// in `WEAPONS`; an upgrade tree can call `Player.setWeapon(kind)` later to
// swap to heavier / magic / dual-wield variants and the swing animation,
// reach and cooldown all retune automatically.
const DEFAULT_WEAPON_BY_INDEX = ['sword_1h', 'axe_1h'];

// Default colour palette per slot (P1 cyan, P2 coral). The start menu lets
// either player override these via `opts.color` in the constructor.
const COLORS = [
  { body: 0x6ad0ff, trim: 0x2a5d80, eye: 0xffffff },
  { body: 0xff8a8a, trim: 0x803f3f, eye: 0xffffff },
];

// Selectable colour palette shown in the start-menu character picker. The
// `body` value is a 24-bit RGB hex int matching what `spawnCharacter()`
// expects for its `tint` argument; `name` is the Russian label shown under
// each swatch. The first two entries match the historical P1/P2 defaults.
export const PLAYER_COLOR_PRESETS = [
  { id: 'cyan',     name: 'Голубой',   body: 0x6ad0ff },
  { id: 'coral',    name: 'Коралл',    body: 0xff8a8a },
  { id: 'mint',     name: 'Мятный',    body: 0x6affb5 },
  { id: 'lavender', name: 'Лаванда',   body: 0xc08aff },
  { id: 'amber',    name: 'Янтарь',    body: 0xffc56a },
  { id: 'rose',     name: 'Розовый',   body: 0xff6ac4 },
  { id: 'azure',    name: 'Синий',     body: 0x5a8aff },
  { id: 'lime',     name: 'Лайм',      body: 0xc8ff5a },
];

// Cape palette — richer, more saturated tones so the cape reads as a
// contrasting accent against the body even when the body uses one of the
// pastel presets above. Reused IDs/names where it makes sense; the values
// are deliberately deeper.
export const CAPE_COLOR_PRESETS = [
  { id: 'crimson', name: 'Багровый',  body: 0x8a1a1a },
  { id: 'royal',   name: 'Королевский', body: 0x2a3aa0 },
  { id: 'forest',  name: 'Лесной',    body: 0x1d6b2e },
  { id: 'gold',    name: 'Золотой',   body: 0xc8a23a },
  { id: 'plum',    name: 'Сливовый',  body: 0x6a2a8a },
  { id: 'charcoal',name: 'Уголь',     body: 0x2a2f36 },
  { id: 'silver',  name: 'Серебро',   body: 0xc0c8d0 },
  { id: 'teal',    name: 'Бирюзовый', body: 0x1a8a8a },
];

// KayKit characters face +Z by default in the GLB; our atan2(facing.x,facing.z)
// convention already maps facing direction to mesh.rotation.y when forward is
// +Z, so no additional offset is required.
const MODEL_YAW_OFFSET = 0;
const MODEL_SCALE = 0.6;

// Hold-to-charge threshold for 2H super attacks. Tapping under this many
// seconds fires the normal slice; holding past it (or releasing after a
// hold longer than this) triggers the charge attack defined in
// `weaponProfile.superAttack`. 0.30s is short enough that a deliberate
// tap never accidentally charges, but long enough that a held button
// reads as "I'm holding for the spin".
const CHARGE_THRESHOLD = 0.30;

export class Player {
  constructor(index, world, effects, sound, opts = {}) {
    this.index = index;
    this.world = world;
    this.effects = effects;
    this.sound = sound;
    // Optional cosmetic / loadout overrides from the start menu. `colorHex`
    // tints the character body + helmet; `capeColorHex` independently tints
    // the cape; `weaponKind` picks the starter weapon instead of the
    // per-slot default.
    this._colorHex = (typeof opts.color === 'number') ? opts.color : null;
    this._capeColorHex = (typeof opts.capeColor === 'number') ? opts.capeColor : null;
    this._startWeapon = (typeof opts.weapon === 'string') ? opts.weapon : null;

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

    // Stats (modifiable by upgrades). The combat-window stats live in
    // `weaponProfile` and are refreshed every time the player equips a new
    // weapon; `attackSpeed` upgrades shorten cooldown via a multiplier so
    // it stacks with whatever weapon is held.
    this.stats = {
      damage: 12,
      speed: 6.0,
      hpRegen: 0.4, // hp/sec
      goldFind: 1.0,
      attackSpeedMult: 1.0,   // < 1 = faster
    };
    this.upgradeLevels = { damage: 0, hp: 0, speed: 0, attackSpeed: 0 };

    this.attackTimer = 0;
    this.attackAnim = 0; // 0..1 swing anim progress
    this.swingActive = false;
    // Damage window now spans `fxAt`…`impactAt` instead of firing on a
    // single tick at `impactAt`. We track which enemies have already been
    // hit this swing so each one takes damage at most once per swing even
    // though `_processSwing` may run for several frames.
    this._swingHitSet = new Set();
    this._swingShookCam = false;
    this.swingFxFired = false;
    // Per-swing parameter snapshot (taken at the moment the swing fires).
    // Lets the tap and the charge-to-super attack share the same swing tick
    // / damage window code while using different timings, range, arc, and
    // damage multipliers. `null` between swings.
    this._activeSwing = null;
    // Charge tracking for the hold-to-spin super attack on 2H weapons.
    // `_chargeTime` accumulates while the attack button is held; the super
    // fires when it crosses `CHARGE_THRESHOLD` (or on release if the hold
    // was long enough). `_chargeFired` prevents firing twice per hold.
    this._chargeTime = 0;
    this._chargeFired = false;
    this._wasAttackHeld = false;
    this.invuln = 0; // i-frames
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.knockback = { x: 0, z: 0 };
    // Revive progress (filled by partner holding dash near a downed body).
    this.reviveProgress = 0;

    // Items + ability state -------------------------------------------
    this.items = {};        // { itemId: stackCount }
    this.ability = null;    // ability id
    this.abilityCd = 0;     // remaining cooldown in seconds
    this._itemSpeedMult = 1;
    this._lastIntent = null;

    this.mesh = this._buildMesh();
    this.world.scene.add(this.mesh);
  }

  _buildMesh() {
    const palette = COLORS[this.index] || COLORS[0];
    // Start-menu colour override: keep the rest of the palette (trim, eye)
    // intact and only swap the body tint, since that's the only field
    // `spawnCharacter()` actually consumes.
    const tint = (this._colorHex !== null) ? this._colorHex : palette.body;
    const capeTint = (this._capeColorHex !== null) ? this._capeColorHex : null;
    const grp = new THREE.Group();

    // Animated CC0 character model from KayKit (Knight) — clone of the shared
    // skeleton + materials so each player can tint differently without leaking.
    const character = spawnCharacter('knight', { tint, capeTint, scale: MODEL_SCALE });
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

    // Equip the starter weapon. For sword_1h this is a no-op visibility-wise
    // (matches the Knight's default sword + shield loadout) but it also
    // initialises `weaponProfile` so the swing logic below has range/arc
    // values to use.
    const startWeapon = this._startWeapon
      || DEFAULT_WEAPON_BY_INDEX[this.index]
      || 'sword_1h';
    this.setWeapon(startWeapon);

    return grp;
  }

  // Equip a weapon by id (`'sword_1h'`, `'axe_2h'`, `'staff'`, ...). Updates
  // the character mesh (toggles built-in sword/shield, attaches external
  // mesh if needed) and caches the weapon's combat profile so swing logic
  // picks it up next frame. External weapons are loaded lazily; the swap
  // becomes visible as soon as the load resolves.
  setWeapon(weaponKind) {
    const profile = WEAPONS[weaponKind];
    if (!profile) return;
    this._weaponKind = weaponKind;
    this.weaponProfile = profile;
    this._attackActionKey = profile.attackAnim;
    if (profile.attach) {
      // Kick off the lazy weapon-mesh load and re-equip once it resolves so
      // the visible mesh updates without blocking the equip call.
      preloadWeapons().then(() => setEquippedWeapon(this._character, weaponKind));
    } else {
      setEquippedWeapon(this._character, weaponKind);
    }
  }

  applyKnockback(dirX, dirZ, force) {
    this.knockback.x += dirX * force;
    this.knockback.z += dirZ * force;
  }

  takeDamage(amount, fromX, fromZ, attacker = null) {
    if (!this.alive || this.invuln > 0) return false;

    // Item hook: dodge / pre-mitigation. Hooks may set ctx.dodged or
    // adjust ctx.amount.
    const tdCtx = { amount, attacker, dodged: false };
    runItemHook(this, 'onTakeDamage', tdCtx);
    if (tdCtx.dodged) {
      // Dodge is an active mechanic so it still grants a brief recovery
      // window — without it, a back-to-back hit on the same frame
      // would cancel the dodge entirely.
      this.invuln = 0.3;
      this.effects.damageNumber(new THREE.Vector3(this.pos.x, 2.0, this.pos.z), 'miss', '#9dfcff');
      return false;
    }
    let amt = tdCtx.amount;

    // Active shield orb absorbs damage before HP is touched.
    if (this._shield && this._shield.hp > 0) {
      const absorbed = Math.min(this._shield.hp, amt);
      this._shield.hp -= absorbed;
      amt -= absorbed;
      this.effects.flashSphere(this.pos.x, 1.0, this.pos.z, 0x6aa6ff, 1.0, 0.18);
    }

    if (amt <= 0) {
      // Shield ate the whole hit — no HP change, no i-frame either,
      // because the user wants attack-speed pressure to keep mattering.
      return true;
    }
    this.hp = Math.max(0, this.hp - amt);
    // No post-hit i-frames: enemies are already cooldown-gated per
    // attack, and granting 0.6s of invuln per damage event made fast
    // weapons / multi-shot abilities feel pointless. Shake + knockback
    // is the feedback; hit-stop is reserved for kills now.
    const dx = this.pos.x - fromX, dz = this.pos.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.applyKnockback(dx / len, dz / len, 9);
    this.effects.shakeCamera(0.18);
    this.effects.burst(this.pos.x, 1.2, this.pos.z, 0xff5050, 8, 4, 0.35);
    this.effects.damageNumber(new THREE.Vector3(this.pos.x, 2.0, this.pos.z), amt, '#ff7a7a');
    this.sound.hurt();
    if (this.hp <= 0) this.die();
    return true;
  }

  heal(amount) {
    if (!this.alive) return;
    // Lifebloom (legendary heal-synergy item) scales every heal source so
    // food, the Серебряное ожерелье regen item, leech and the regen aura
    // all benefit at higher stack tiers.
    amount = amount * healMultiplier(this);
    const before = this.hp;
    this.hp = Math.min(this.maxHP, this.hp + amount);
    if (this.hp - before > 0.5) this.effects.damageNumber(new THREE.Vector3(this.pos.x, 2.0, this.pos.z), this.hp - before, '#7aff8a');
  }

  die() {
    this.alive = false;
    this.invuln = 999;
    // Player death is the heaviest event in the loop — a chunky freeze
    // sells the moment without messing with the regular hit feel.
    this.effects.doHitStop(0.12);
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
    this._lastIntent = intent;
    if (!this.alive) {
      // Keep mesh visible to show death pose; just freeze physics & animation.
      this._character?.mixer?.update(dt);
      return;
    }
    this.mesh.visible = true;

    // Per-frame item hooks (regen, speed multiplier setup, etc).
    runItemHook(this, 'onTick', { dt, partner: otherPlayer });

    // Buff timers + visuals -------------------------------------------
    this._buffVfxT = (this._buffVfxT || 0) + dt;
    if (this._shield) {
      this._shield.ttl -= dt;
      if (this._shield.ttl <= 0 || this._shield.hp <= 0) this._shield = null;
      else if (this._buffVfxT % 0.8 < dt) {
        this.effects.ring(this.pos.x, 0.05, this.pos.z, 0x6aa6ff, 1.2 + Math.sin(this._buffVfxT * 3) * 0.2, 0.25);
      }
    }
    if (this._berserk) {
      this._berserk.ttl -= dt;
      if (this._berserk.ttl <= 0) this._berserk = null;
      else if (this._buffVfxT % 0.6 < dt) {
        this.effects.burst(this.pos.x, 0.5, this.pos.z, 0xff5050, 2, 3, 0.18);
      }
    }
    if (this._healAura) {
      this._healAura.ttl -= dt;
      // _healAura supports either a flat HP/s rate (legacy) or a percent
      // of max HP per second (`pct`). RegenAura uses the percent form so
      // it scales sensibly across runs (30% of maxHP over the buff).
      const rate = this._healAura.pct
        ? this.maxHP * this._healAura.pct
        : (this._healAura.rate || 0);
      this.heal(rate * dt);
      if (this._healAura.ttl <= 0) this._healAura = null;
      else if (this._buffVfxT % 0.7 < dt) {
        this.effects.ring(this.pos.x, 0.05, this.pos.z, 0x7aff8a, 1.0, 0.2);
      }
    }

    // Movement
    const dashing = this.dashTimer > 0;
    let speed = this.stats.speed * (this._itemSpeedMult || 1);
    if (dashing) speed *= 2.6;

    // Cooldowns
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.abilityCd = Math.max(0, this.abilityCd - dt);
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
      runItemHook(this, 'onDash', { enemyList: enemies, partner: otherPlayer });
    }

    // Attack trigger — split into "tap" and "charge" paths. Weapons with
    // a `superAttack` profile (Greatsword, Battle Axe) defer their tap
    // attack to release-time so the same button can either tap-swing or
    // charge into the spin super; weapons without one fire instantly on
    // the press edge for snappy combat.
    const wp = this.weaponProfile;
    const wpHasSuper = !!wp.superAttack;
    const isHeld = !!intent.attackHeld;
    const wasHeld = this._wasAttackHeld;
    this._wasAttackHeld = isHeld;

    if (wpHasSuper) {
      if (isHeld) {
        if (!wasHeld) {
          // Press edge: start charging. Don't fire normal attack yet —
          // we don't know if this will turn out to be a tap or a hold.
          this._chargeTime = 0;
          this._chargeFired = false;
        } else {
          this._chargeTime += dt;
          // Auto-fire the spin super the moment the hold crosses the
          // threshold (don't make the player release to trigger it).
          if (!this._chargeFired && this._chargeTime >= CHARGE_THRESHOLD && this.attackTimer <= 0) {
            this._triggerAttack(true);
            this._chargeFired = true;
          }
        }
      } else if (wasHeld) {
        // Release edge. If the super already auto-fired, do nothing —
        // we already swung. Otherwise this was a short tap, fire the
        // normal slice (deferred from the press edge).
        if (!this._chargeFired && this.attackTimer <= 0) {
          this._triggerAttack(false);
        }
        this._chargeTime = 0;
        this._chargeFired = false;
      }
    } else if (intent.attack && this.attackTimer <= 0) {
      // Weapons without a charge attack — instant tap.
      this._triggerAttack(false);
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
    // We tick `attackAnim` from 0..1 over `as.swing` seconds and fire damage
    // exactly once when it crosses `as.impactAt` — this is what keeps the
    // visual impact frame and the gameplay damage frame on the same tick,
    // so heavier weapons feel like the hit lands on the follow-through and
    // light weapons feel like they connect early. `as` is the per-swing
    // parameter snapshot taken in `_triggerAttack` so a tap and a charge
    // super can use different timings, ranges, arcs, and clips while
    // sharing this tick code.
    if (this.swingActive && this._activeSwing) {
      const as = this._activeSwing;
      this.attackAnim += dt / Math.max(as.swing, 0.1);
      const fxAt = Math.min(as.impactAt, Math.max(0.10, as.impactAt - 0.25));
      if (!this.swingFxFired && this.attackAnim >= fxAt) {
        this.swingFxFired = true;
        this.sound.swing();
        if (as.slash) {
          // Same slashArc strip for both tap and the spin super — the super
          // just passes its full-circle `arc` (2π) so the strip sweeps the
          // whole way around. Parented to the character mesh so the strip
          // tracks the player if they keep moving / rotating during the
          // followthrough.
          this.effects.slashArc(
            this.smoothPos.x, 0, this.smoothPos.z, this.yaw,
            {
              parent: this.mesh,
              range: as.range,
              arc: as.arc,
              duration: Math.min(as.swing * (1 - fxAt) * 0.55, 0.28),
              color: as.ringColor ?? as.slash.color,
              height: as.slash.height,
            }
          );
        }
      }
      if (this.attackAnim >= 1) {
        this.swingActive = false;
        this.attackAnim = 0;
        // Hand the upper body back to whatever locomotion is playing.
        // Without this fade-out the LoopOnce action would clamp on its
        // last frame and freeze the arms in the followthrough pose.
        const a = this._character?.actions?.[as.animKey];
        if (a) a.fadeOut(0.18);
        this._activeSwing = null;
      } else if (this.swingFxFired && this.attackAnim <= as.impactAt) {
        // Damage window is open: from the FX trigger up to (and
        // including) the canonical impact tick. Re-running every frame
        // means an enemy that walks into the arc mid-swing still gets
        // hit, and the player doesn't have to predict where the impact
        // tick will land relative to the actual blade pose. Per-enemy
        // de-dupe lives in `_processSwing` via `_swingHitSet`.
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

    // Drive locomotion animation (idle <-> run). Locomotion runs on the
    // *full* skeleton; attack clips are filtered to upper-body bones only
    // so the legs continue stepping through this state machine even while
    // a swing is in flight. Crucially we only fade between locomotion
    // slots here — using crossFadeTo would also fade out the attack
    // action mid-swing.
    const moving = Math.hypot(m.x, m.z) > 0.05;
    const desiredAnim = moving ? 'run' : 'idle';
    if (desiredAnim !== this._animState) {
      const acts = this._character?.actions;
      if (acts) {
        for (const slot of ['idle', 'run', 'walk']) {
          const a = acts[slot];
          if (!a || slot === desiredAnim) continue;
          if (a.isRunning() && a.weight > 0.001) a.fadeOut(0.18);
        }
        const next = acts[desiredAnim];
        if (next) {
          next.reset().setEffectiveWeight(1.0).fadeIn(0.18).play();
        }
      }
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

  // Start a new swing — either the weapon's tap attack or its charge-up
  // super (when `isSuper` is true and a `superAttack` profile exists).
  // Snapshots all parameters that the swing tick will need into
  // `this._activeSwing` so the same tick code can drive both.
  _triggerAttack(isSuper) {
    const wp = this.weaponProfile;
    const sp = isSuper ? wp.superAttack : null;
    if (isSuper && !sp) return;
    const swing      = sp?.swing      ?? wp.swing;
    const impactAt   = sp?.impactAt   ?? wp.impactAt;
    const range      = sp?.range      ?? wp.range;
    const arc        = sp?.arc        ?? wp.arc;
    const slash      = sp?.slash      ?? wp.slash;
    const damageMult = sp?.damageMult ?? wp.damageMult;
    const cooldown   = sp?.cooldown   ?? wp.cooldown;
    const animKey    = sp?.attackAnim ?? this._attackActionKey;
    const ringColor  = sp?.ringColor  ?? null;

    const attackCdMult = (this._berserk ? (1 / this._berserk.atk) : 1) * this.stats.attackSpeedMult;
    this.attackTimer = cooldown * attackCdMult;
    this.attackAnim = 0;
    this.swingActive = true;
    this._swingHitSet.clear();
    this._swingShookCam = false;
    this.swingFxFired = false;
    this._activeSwing = {
      swing, impactAt, range, arc, slash, damageMult,
      isSuper: !!isSuper, animKey, ringColor,
    };

    // Whoosh sound + slash VFX both fire just before the impact frame
    // (see swingActive branch below) so the trail is mid-paint when the
    // visible blade reaches its strike pose. We deliberately do *not*
    // fade out idle/run here — attack clips are pre-filtered to upper
    // body bones only (see models.js), so the legs keep stepping
    // through whatever locomotion state was active when the attack
    // started. The spin super opts out of the upper-body filter
    // (FULL_BODY_SLOTS) so the whole rig rotates.
    const action = this._character?.actions?.[animKey];
    if (action) {
      action.reset();
      const srcDur = Math.max(action.getClip().duration, 0.05);
      action.timeScale = srcDur / Math.max(swing, 0.1);
      action.setEffectiveWeight(10.0);
      action.fadeIn(0.05).play();
    }
  }

  _processSwing(enemies, callback) {
    const as = this._activeSwing || this.weaponProfile;
    // Sweep is performed against the player's *current* position and
    // facing, not the position/facing at the start of the swing. Combined
    // with the multi-tick damage window, this means the hitbox follows
    // the player if they're moving or turning during the swing — same
    // semantics as the slash VFX, which is parented to the character
    // group.
    const cx = this.pos.x, cz = this.pos.z;
    const fx = this.facing.x, fz = this.facing.z;
    const range = as.range;
    const halfArc = as.arc / 2;
    // Full-circle swings (the spin super) skip the angular check entirely
    // — `acos` only returns values in [0, π] so even a halfArc of π still
    // accepts every direction, but spelling it out makes the intent
    // explicit and saves a few `acos` calls per frame.
    const omni = as.arc >= Math.PI * 1.99;
    let newHits = 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      // De-dupe: each enemy can only be hit once per swing, even if the
      // damage window overlaps the enemy for several frames.
      if (this._swingHitSet.has(e)) continue;
      const dx = e.pos.x - cx, dz = e.pos.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > range + e.radius) continue;
      if (!omni) {
        const ndx = dx / (d || 1), ndz = dz / (d || 1);
        const dot = ndx * fx + ndz * fz;
        const ang = Math.acos(clamp(dot, -1, 1));
        if (ang > halfArc) continue;
      }
      callback(this, e);
      this._swingHitSet.add(e);
      newHits++;
    }
    // Heavier weapons still get more screen-shake — this is what makes a
    // greatsword swing read as physically heavier than a dagger jab.
    // Hit-stop on regular landings was removed: it stacked with high
    // attack-speed builds and made every connect feel like the game was
    // hitching. Kills still trigger a freeze (in enemy.die / player.die)
    // so the satisfying weight is there for the moments that matter.
    // Only fire the camera shake on the *first* connecting frame of the
    // swing, otherwise multi-frame windows would re-trigger it as more
    // enemies enter the arc.
    if (newHits > 0 && !this._swingShookCam) {
      this._swingShookCam = true;
      const heft = Math.min(1, as.damageMult / 2);
      this.effects.shakeCamera(0.20 + 0.30 * heft);
    }
  }

  // True if this player can still take another stack of `id`. Item runes
  // consult this before magneting/picking up so a maxed-out player doesn't
  // silently swallow the rune.
  canAcceptItem(id) {
    const def = ITEM_BY_ID[id];
    const cap = def?.maxStacks ?? MAX_STACKS;
    return (this.items[id] || 0) < cap;
  }

  // Stack a passive item on this player. Returns true if it was added,
  // false if the player is already at the per-item cap.
  addItem(id) {
    const def = ITEM_BY_ID[id];
    const cap = def?.maxStacks ?? MAX_STACKS;
    const cur = this.items[id] || 0;
    if (cur >= cap) return false;
    this.items[id] = cur + 1;
    return true;
  }

  // Drop one stack of `id` (used by the altar's sacrifice/fuse/reroll).
  // Returns true on success.
  removeItem(id, count = 1) {
    const cur = this.items[id] || 0;
    if (cur < count) return false;
    const next = cur - count;
    if (next <= 0) delete this.items[id];
    else this.items[id] = next;
    return true;
  }

  // Replace the active ability slot. Returns the previous ability id (or null).
  setAbility(id) {
    const prev = this.ability;
    this.ability = id;
    this.abilityCd = 0;
    return prev;
  }

  // Try to cast the equipped ability. Returns true if it fired.
  tryCastAbility(ctx) {
    if (!this.ability) return false;
    if (this.abilityCd > 0) return false;
    if (!this.alive) return false;
    const def = ABILITY_BY_ID[this.ability];
    if (!def) return false;
    try {
      def.cast(this, ctx);
    } catch (err) {
      console.warn('[ability cast]', this.ability, err);
      return false;
    }
    this.abilityCd = def.cd;
    return true;
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
    if (kind === 'attackSpeed') {
      // Cooldown lives on the weapon profile; we apply attack-speed upgrades
      // as a multiplier so they stack with whatever weapon is held. Floor at
      // 0.27 so even a maxed-out fast weapon doesn't outrun the swing
      // animation it triggers.
      this.stats.attackSpeedMult = Math.max(0.27, 1.0 - (lvl + 1) * 0.13);
    }
  }
}
