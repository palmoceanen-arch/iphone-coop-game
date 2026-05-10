// Active abilities cast on a single hotkey (G for P1, H for P2).
//
// Each ability defines:
//   id       — internal stable id, also used as player.ability.
//   name     — Russian human-readable name.
//   icon     — single-char glyph used in the HUD slot.
//   color    — accent colour for the slot ring.
//   cd       — cooldown in seconds (always counts down regardless of cast).
//   cast(player, ctx) — the actual gameplay code. ctx exposes:
//     - enemyList:     every damageable (enemies + breakables + resources +
//                      player-built structures). AoE damage iterates this
//                      so e.g. fireball still pops crates in its blast.
//     - livingEnemies: only true Enemy entities. Auto-aiming abilities
//                      (ice bolt, chain lightning, slow-time, wind-push)
//                      target through this list so walls / fences / trees
//                      can never steal the lock-on.
//     - partner:       the other Player (may be null/dead)
//     - effects:       the Effects instance
//     - sound:         the Sound instance
//     - scene:         the THREE.Scene
//     - spawnAbilityProjectile(opts): create a flying projectile
//
// Abilities should be self-contained — they should not mutate global game
// state beyond their effects (damage, buffs, projectiles).

import * as THREE from 'three';
import { defaultRandom } from './utils.js';
import {
  elementDamageMult,
  freezeDurationBonus,
  chainBonusJumps,
  healMultiplier,
  windKnockbackBonus,
} from './items.js';

function vdist2(a, b) {
  const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
  return dx * dx + dz * dz;
}

function enemiesInRadius(player, enemyList, radius) {
  const out = [];
  for (const e of enemyList) {
    if (!e.alive) continue;
    const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= radius + e.radius) out.push({ e, d });
  }
  return out;
}

// True Enemy entities only — pots / crates / trees / rocks / placed
// fences and walls all share the (alive, takeDamage) damageable contract
// but should never count as "an enemy" for auto-aim or status effects.
// Anything that flagged itself as a non-enemy damageable is filtered out
// so a wall behind a slime can't steal an ice-bolt's lock-on.
function isLivingEnemy(e) {
  return !!e
    && e.alive
    && !e.isStructure
    && !e.isBreakable
    && !e.isResource;
}

// Pull the strictest "real enemies" list available — game.js threads
// `livingEnemies` through ctx, but we still defend in depth in case a
// caller hands us only the legacy damageables snapshot (e.g. an item
// hook routing through the abilities API directly).
function livingEnemiesFromCtx(ctx) {
  if (Array.isArray(ctx.livingEnemies)) return ctx.livingEnemies;
  return ctx.enemyList.filter(isLivingEnemy);
}

// -----------------------------------------------------------------------
// AbilityProjectile — a flying projectile that hits enemies
// -----------------------------------------------------------------------
export class AbilityProjectile {
  constructor(scene, opts) {
    this.scene = scene;
    this.pos = { x: opts.x, z: opts.z };
    this.dir = { x: opts.dirX, z: opts.dirZ };
    this.speed = opts.speed || 16;
    this.life = opts.life || 1.0;
    this.alive = true;
    this.radius = opts.radius || 0.3;
    this.color = opts.color || 0xff8a30;
    this.damage = opts.damage || 0;
    this.knockback = opts.knockback || 6;
    this.aoeRadius = opts.aoeRadius || 0;
    this.aoeDamage = opts.aoeDamage || 0;
    this.aoeKnockback = opts.aoeKnockback || 6;
    this.onHitEnemy = opts.onHitEnemy || null;
    this._customAoe = opts._customAoe || null;
    this.piercing = opts.piercing || false;
    this.source = opts.source || null;
    this._trailT = 0;
    this._trailColor = opts.trailColor || this.color;
    // Visual height. Defaults to 1.0 (chest level) so existing
    // abilities — icebolt, fireball — keep their previous look. The
    // staff/wand tap-spell passes ~0.75 so the bolt visibly leaves
    // the weapon hand instead of the character's head.
    this.y = (typeof opts.y === 'number') ? opts.y : 1.0;

    const grp = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius, 10, 10),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.95 })
    );
    grp.add(core);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 1.8, 10, 10),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.25 })
    );
    grp.add(glow);
    grp.position.set(this.pos.x, this.y, this.pos.z);
    scene.add(grp);
    this.mesh = grp;
    this._core = core;
    this._glow = glow;
  }

  update(dt, enemies, effects, sound, world) {
    if (!this.alive) return;
    this.life -= dt;

    this.pos.x += this.dir.x * this.speed * dt;
    this.pos.z += this.dir.z * this.speed * dt;
    this.mesh.position.set(this.pos.x, this.y, this.pos.z);

    // Trail particles
    this._trailT += dt;
    if (this._trailT > 0.025) {
      this._trailT = 0;
      effects.burst(this.pos.x, this.y, this.pos.z, this._trailColor, 1, 1.5, 0.12);
    }

    // Damageable collision (enemies + breakables + resources + structures).
    // Runs BEFORE the world wall-collision check below because rocks,
    // trees, and placed walls are present in BOTH `enemies` (via the
    // damageables list) and `world.colliders` — if `isClear` fired
    // first it would explode the projectile against e.g. a rock
    // *without* ever calling `onHitEnemy`, so the rock would never
    // take damage. Checking damageables first means the rock is hit
    // through the normal pipeline and the projectile is destroyed
    // naturally via the non-piercing explode below.
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < this.radius + e.radius + 0.2) {
        if (this.damage > 0) {
          e.takeDamage(this.damage, this.pos.x, this.pos.z, this.knockback);
          if (!e.alive && this.source) e._deathCredit = this.source;
        }
        if (this.onHitEnemy) this.onHitEnemy(e);
        if (!this.piercing) {
          this._explode(enemies, effects, sound, e);
          return;
        }
      }
    }

    // Wall collision — anything in `world.colliders` that wasn't
    // caught above. In practice this means non-damageable terrain
    // colliders (cliff clusters, water borders) and any damageable
    // we somehow tunneled past in a single frame. Either way the
    // projectile fizzles here without applying damage, which is the
    // intended behaviour for environmental walls.
    if (world && !world.isClear(this.pos.x, this.pos.z, this.radius)) {
      this._explode(enemies, effects, sound, null);
      return;
    }

    // Expire at max range
    if (this.life <= 0) {
      this._explode(enemies, effects, sound, null);
    }
  }

  _explode(enemies, effects, sound, directHitEnemy) {
    if (!this.alive) return;
    this.alive = false;

    // AoE damage. If the projectile already applied direct damage to the
    // collided enemy (this.damage > 0, the icebolt/spell-bolt case), keep
    // skipping that enemy here so it isn't double-hit. But for purely
    // explosive projectiles (this.damage === 0, currently fireball), the
    // collided enemy must be included — otherwise a fireball that collides
    // dead-on with an enemy delivers zero damage to that enemy because the
    // direct branch was a no-op AND the AoE loop excluded them. Same bug
    // would silently hit any future explosive ability with damage:0.
    const directAlreadyDamaged = this.damage > 0;
    if (this.aoeRadius > 0 && this.aoeDamage > 0) {
      for (const e of enemies) {
        if (!e.alive) continue;
        if (directAlreadyDamaged && e === directHitEnemy) continue;
        const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d <= this.aoeRadius + e.radius) {
          e.takeDamage(this.aoeDamage, this.pos.x, this.pos.z, this.aoeKnockback);
          if (!e.alive && this.source) e._deathCredit = this.source;
          if (this.onHitEnemy) this.onHitEnemy(e);
        }
      }
    }

    if (this._customAoe) this._customAoe(this.pos);

    const vfxR = Math.min(this.aoeRadius || 1.0, 1.5);
    effects.flashSphere(this.pos.x, 1.0, this.pos.z, this.color, vfxR * 0.5, 0.2);
    effects.ring(this.pos.x, 0.05, this.pos.z, this.color, vfxR * 0.6, 0.3);
    effects.burst(this.pos.x, 1.0, this.pos.z, this.color, 6, 3, 0.25);
    effects.shakeCamera(0.15);
    sound.bomb?.();

    this._cleanup();
  }

  _cleanup() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this._core.geometry.dispose(); this._core.material.dispose();
    this._glow.geometry.dispose(); this._glow.material.dispose();
  }
}

// -----------------------------------------------------------------------
// Ability definitions
// -----------------------------------------------------------------------

export const ABILITIES = [
  {
    id: 'fireball', name: 'Фаербол', icon: 'flame', color: 0xff8a30, cd: 12,
    element: 'fire',
    desc: 'Огненный снаряд, летящий вперёд. Взрывается при попадании, 45 AoE-урона в 2.5м.',
    cast(player, ctx) {
      const fireMult = elementDamageMult(player, 'fire');
      ctx.spawnAbilityProjectile({
        x: player.pos.x + player.facing.x * 0.8,
        z: player.pos.z + player.facing.z * 0.8,
        dirX: player.facing.x, dirZ: player.facing.z,
        speed: 16, life: 0.65, radius: 0.35,
        color: 0xff8a30, trailColor: 0xff5500,
        damage: 0, aoeRadius: 2.5, aoeDamage: 45 * fireMult, aoeKnockback: 6,
        source: player,
      });
    },
  },
  {
    id: 'icebolt', name: 'Ледяная стрела', icon: 'snowflake', color: 0x9dfcff, cd: 10,
    element: 'ice',
    desc: 'Ледяной снаряд в ближайшего врага. 30 урона и заморозка на 2с в радиусе 2.5м.',
    cast(player, ctx) {
      const iceMult = elementDamageMult(player, 'ice');
      const freezeT = 2.0 + freezeDurationBonus(player);
      let dx = player.facing.x, dz = player.facing.z;
      // Auto-aim only at real creatures within 12m — walls / fences / trees
      // / rocks share the damageable contract but a player firing icebolt
      // at an open wisp shouldn't have it veer into their own picket.
      const targets = livingEnemiesFromCtx(ctx)
        .filter(e => vdist2(player, e) < 144);
      if (targets.length > 0) {
        targets.sort((a, b) => vdist2(player, a) - vdist2(player, b));
        const t = targets[0];
        const tdx = t.pos.x - player.pos.x, tdz = t.pos.z - player.pos.z;
        const d = Math.hypot(tdx, tdz) || 1;
        dx = tdx / d; dz = tdz / d;
      }
      // Freeze AoE only applies to real enemies — chilling a fence post
      // does nothing meaningful, and a frozen tree feels off.
      const freezeTargets = livingEnemiesFromCtx(ctx);
      ctx.spawnAbilityProjectile({
        x: player.pos.x + dx * 0.6,
        z: player.pos.z + dz * 0.6,
        dirX: dx, dirZ: dz,
        speed: 20, life: 0.55, radius: 0.25,
        color: 0x9dfcff, trailColor: 0x60d0ff,
        damage: 30 * iceMult, knockback: 4,
        aoeRadius: 2.5, aoeDamage: 0, aoeKnockback: 0,
        source: player,
        onHitEnemy(e) {
          if (!isLivingEnemy(e)) return;
          e._frozen = Math.max(e._frozen || 0, freezeT);
        },
        _customAoe(pos) {
          for (const e of freezeTargets) {
            if (!e.alive) continue;
            const ex = e.pos.x - pos.x, ez = e.pos.z - pos.z;
            if (Math.hypot(ex, ez) <= 2.5 + e.radius) {
              e._frozen = Math.max(e._frozen || 0, freezeT);
            }
          }
        },
      });
      ctx.sound.tone?.({ freq: 880, type: 'triangle', dur: 0.35, gain: 0.35, slide: -200 });
    },
  },
  {
    id: 'chainLightning', name: 'Цепная молния', icon: 'bolt', color: 0xfff7a0, cd: 7,
    element: 'lightning',
    desc: 'Прыгает по 4 целям, 30 урона за прыжок (-15% за каждый).',
    cast(player, ctx) {
      const lightMult = elementDamageMult(player, 'lightning');
      const jumps = 4 + chainBonusJumps(player);
      let from = { x: player.pos.x, z: player.pos.z };
      let dmg = 30 * lightMult;
      const used = new Set();
      // Chain hops between real enemies only — never arc into a placed
      // wall or a tree, which would both look bizarre and waste jumps on
      // targets that don't move or react to the cc.
      const chainTargets = livingEnemiesFromCtx(ctx);
      for (let i = 0; i < jumps; i++) {
        let best = null, bestD = 7;
        for (const e of chainTargets) {
          if (!e.alive || used.has(e)) continue;
          const edx = e.pos.x - from.x, edz = e.pos.z - from.z;
          const d = Math.hypot(edx, edz);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (!best) break;
        used.add(best);
        best.takeDamage(dmg, from.x, from.z, 4);
        if (!best.alive) best._deathCredit = player;

        const steps = Math.max(3, Math.ceil(bestD * 2));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const bx = from.x + (best.pos.x - from.x) * t + (defaultRandom() - 0.5) * 0.4;
          const bz = from.z + (best.pos.z - from.z) * t + (defaultRandom() - 0.5) * 0.4;
          ctx.effects.burst(bx, 1.0 + defaultRandom() * 0.5, bz, 0xfff7a0, 1, 2, 0.2);
        }
        ctx.effects.flashSphere(best.pos.x, 1.0, best.pos.z, 0xfff7a0, 0.6, 0.2);
        ctx.effects.ring(best.pos.x, 0.05, best.pos.z, 0xfff7a0, 1.2, 0.25);
        from = { x: best.pos.x, z: best.pos.z };
        dmg *= 0.85;
      }
      ctx.sound.tone?.({ freq: 1200, type: 'square', dur: 0.2, gain: 0.3, slide: 400 });
    },
  },
  {
    id: 'shield', name: 'Орб-щит', icon: 'shield', color: 0x6aa6ff, cd: 12,
    element: 'heal',
    desc: 'Поглощает следующие 80 урона в течение 5с.',
    cast(player, ctx) {
      const shieldHp = 80 * healMultiplier(player);
      player._shield = { hp: shieldHp, ttl: 5 };
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0x6aa6ff, 1.4, 0.4);
      ctx.effects.flashSphere(player.pos.x, 1.0, player.pos.z, 0x6aa6ff, 1.2, 0.25);
      ctx.sound.tone?.({ freq: 520, type: 'sine', dur: 0.4, gain: 0.3 });
    },
  },
  {
    id: 'regenAura', name: 'Аура регенерации', icon: 'heart', color: 0x7aff8a, cd: 16,
    element: 'heal',
    desc: 'Лечит обоих игроков на 30% от макс. HP в течение 5с.',
    cast(player, ctx) {
      // 6% maxHP per second × 5s = 30% maxHP total. Stored as a percent
      // so it scales with each player's own max HP and re-evaluates if
      // maxHP changes during the buff (e.g. on level-up).
      const apply = (p) => {
        if (!p || !p.alive) return;
        p._healAura = { pct: 0.06, ttl: 5 };
      };
      apply(player);
      apply(ctx.partner);
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0x7aff8a, 5, 0.6);
      ctx.effects.burst(player.pos.x, 0.5, player.pos.z, 0x7aff8a, 12, 4, 0.4);
      ctx.sound.tone?.({ freq: 660, type: 'sine', dur: 0.3, gain: 0.3 });
    },
  },
  {
    id: 'slowtime', name: 'Замедление времени', icon: 'clock', color: 0xc9a3ff, cd: 14,
    // 'timeslow' is its own enchant element so a Mage binding this
    // ability slows enemies on every hit (without freezing them).
    // The ability cast itself uses `_slow` directly; the enchant
    // mirrors the same effect on weapon hits via the on-hit handler
    // in game.js _applyWeaponEnchantEffect.
    element: 'timeslow',
    desc: 'Замедляет всех врагов в 6м до ×0.35 на 3с.',
    cast(player, ctx) {
      const slowDur = 3.0 + freezeDurationBonus(player);
      // Slow only applies to real enemies — slowing a wall is a no-op
      // and would otherwise eat the cc on a useless target.
      const list = enemiesInRadius(player, livingEnemiesFromCtx(ctx), 6);
      for (const { e } of list) e._slow = Math.max(e._slow || 0, slowDur);
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0xc9a3ff, 6, 0.5);
      ctx.effects.flashSphere(player.pos.x, 0.5, player.pos.z, 0xc9a3ff, 3, 0.25);
      ctx.effects.burst(player.pos.x, 0.8, player.pos.z, 0xc9a3ff, 6, 3, 0.25);
      ctx.sound.tone?.({ freq: 280, type: 'sine', dur: 0.6, gain: 0.3, slide: -150 });
    },
  },
  {
    id: 'windpush', name: 'Ветер удар', icon: 'wind', color: 0xffffff, cd: 8,
    // 'wind' enchant element (white) — hits push enemies harder via
    // an extra knockback impulse on top of the weapon's normal kb.
    // Damage stays the same as a regular swing; the wind read is
    // pure displacement.
    element: 'wind',
    desc: 'Кольцевой взрыв оттолкновения в 4м, 20 урона.',
    cast(player, ctx) {
      // Aeromancer item scales BOTH the damage and the knockback impulse.
      // Damage runs through the standard element multiplier path so
      // rabadon / prismatic also apply; knockback adds windKnockbackBonus
      // on top of the baseline 14 the ability authored.
      const windMult = elementDamageMult(player, 'wind');
      const kb = 14 + windKnockbackBonus(player);
      const dmg = 20 * windMult;
      const list = enemiesInRadius(player, livingEnemiesFromCtx(ctx), 4);
      for (const { e } of list) {
        e.takeDamage(dmg, player.pos.x, player.pos.z, kb);
        if (!e.alive) e._deathCredit = player;
      }
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0xffffff, 4, 0.35);
      ctx.effects.flashSphere(player.pos.x, 0.6, player.pos.z, 0xffffff, 2.5, 0.2);
      ctx.effects.burst(player.pos.x, 0.6, player.pos.z, 0xffffff, 10, 5, 0.3);
      ctx.sound.tone?.({ freq: 200, type: 'sawtooth', dur: 0.35, gain: 0.3, slide: 150 });
    },
  },
];

export const ABILITY_BY_ID = Object.fromEntries(ABILITIES.map(a => [a.id, a]));

export function pickRandomAbilityId() {
  return ABILITIES[Math.floor(defaultRandom() * ABILITIES.length)].id;
}
