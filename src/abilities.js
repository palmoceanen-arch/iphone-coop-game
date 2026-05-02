// Active abilities cast on a single hotkey (G for P1, H for P2).
//
// Each ability defines:
//   id       — internal stable id, also used as player.ability.
//   name     — Russian human-readable name.
//   icon     — single-char glyph used in the HUD slot.
//   color    — accent colour for the slot ring.
//   cd       — cooldown in seconds (always counts down regardless of cast).
//   cast(player, ctx) — the actual gameplay code. ctx exposes:
//     - enemyList: live Enemy[] reference
//     - partner:   the other Player (may be null/dead)
//     - effects:   the Effects instance
//     - sound:     the Sound instance
//
// Abilities should be self-contained — they should not mutate global game
// state beyond their effects (damage, buffs, projectiles).

function vdist2(a, b) {
  const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
  return dx * dx + dz * dz;
}

function nearestEnemiesInCone(player, enemyList, range, halfArc) {
  const out = [];
  const fx = player.facing.x, fz = player.facing.z;
  for (const e of enemyList) {
    if (!e.alive) continue;
    const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > range + e.radius) continue;
    const ndx = dx / (d || 1), ndz = dz / (d || 1);
    const dot = ndx * fx + ndz * fz;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang <= halfArc) out.push({ e, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
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

export const ABILITIES = [
  {
    id: 'fireball', name: 'Фаербол', icon: '🔥', color: 0xff8a30, cd: 6,
    desc: 'Конусный AoE — 90 урона по всем врагам в 5м перед собой.',
    cast(player, ctx) {
      const targets = nearestEnemiesInCone(player, ctx.enemyList, 5, Math.PI * 0.45);
      for (const { e } of targets) {
        e.takeDamage(90, player.pos.x, player.pos.z, 8);
      }
      ctx.effects.flashSphere(player.pos.x + player.facing.x * 2.5, 1.0, player.pos.z + player.facing.z * 2.5, 0xff8a30, 2.5, 0.35);
      ctx.effects.ring(player.pos.x + player.facing.x * 2.5, 0.05, player.pos.z + player.facing.z * 2.5, 0xff8a30, 4.5, 0.45);
      ctx.effects.shakeCamera(0.25);
      ctx.sound.bomb?.();
    },
  },
  {
    id: 'icebolt', name: 'Ледяная стрела', icon: '❄', color: 0x9dfcff, cd: 5,
    desc: 'Замораживает ближайших 3 врагов в 8м на 2.5с и наносит 60 урона.',
    cast(player, ctx) {
      const list = ctx.enemyList
        .filter(e => e.alive && vdist2(player, e) < 64)
        .sort((a, b) => vdist2(player, a) - vdist2(player, b))
        .slice(0, 3);
      for (const e of list) {
        e._frozen = Math.max(e._frozen || 0, 2.5);
        e.takeDamage(60, player.pos.x, player.pos.z, 5);
        ctx.effects.flashSphere(e.pos.x, 1.0, e.pos.z, 0x9dfcff, 0.8, 0.3);
      }
      ctx.sound.tone?.({ freq: 880, type: 'triangle', dur: 0.35, gain: 0.35, slide: -200 });
    },
  },
  {
    id: 'chainLightning', name: 'Цепная молния', icon: '⚡', color: 0xfff7a0, cd: 7,
    desc: 'Прыгает по 4 целям, 50 урона за прыжок (-15% за каждый).',
    cast(player, ctx) {
      let from = { pos: player.pos };
      let dmg = 50;
      const used = new Set();
      for (let i = 0; i < 4; i++) {
        let best = null, bestD = 8;
        for (const e of ctx.enemyList) {
          if (!e.alive || used.has(e)) continue;
          const dx = e.pos.x - from.pos.x, dz = e.pos.z - from.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (!best) break;
        used.add(best);
        best.takeDamage(dmg, from.pos.x, from.pos.z, 4);
        ctx.effects.ring(best.pos.x, 0.05, best.pos.z, 0xfff7a0, 1.4, 0.25);
        from = best;
        dmg *= 0.85;
      }
      ctx.sound.tone?.({ freq: 1200, type: 'square', dur: 0.2, gain: 0.3, slide: 400 });
    },
  },
  {
    id: 'shield', name: 'Орб-щит', icon: '🛡', color: 0x6aa6ff, cd: 12,
    desc: 'Поглощает следующие 120 урона в течение 5с.',
    cast(player, ctx) {
      player._shield = { hp: 120, ttl: 5 };
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0x6aa6ff, 1.4, 0.4);
      ctx.sound.tone?.({ freq: 520, type: 'sine', dur: 0.4, gain: 0.3 });
    },
  },
  {
    id: 'regenAura', name: 'Аура регенерации', icon: '💚', color: 0x7aff8a, cd: 16,
    desc: 'Лечит обоих игроков по 25 HP/с в течение 5с.',
    cast(player, ctx) {
      const apply = (p) => {
        if (!p || !p.alive) return;
        p._healAura = { rate: 25, ttl: 5 };
      };
      apply(player);
      apply(ctx.partner);
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0x7aff8a, 5, 0.6);
      ctx.sound.tone?.({ freq: 660, type: 'sine', dur: 0.3, gain: 0.3 });
    },
  },
  {
    id: 'slowtime', name: 'Замедление времени', icon: '⏱', color: 0xc9a3ff, cd: 14,
    desc: 'Замедляет всех врагов в 7м до ×0.35 на 3с.',
    cast(player, ctx) {
      const list = enemiesInRadius(player, ctx.enemyList, 7);
      for (const { e } of list) e._slow = Math.max(e._slow || 0, 3.0);
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0xc9a3ff, 7, 0.6);
      ctx.sound.tone?.({ freq: 280, type: 'sine', dur: 0.6, gain: 0.3, slide: -150 });
    },
  },
  {
    id: 'windpush', name: 'Ветер удар', icon: '🌪', color: 0xa0e8ff, cd: 8,
    desc: 'Кольцевой взрыв оттолкновения в 5м, 35 урона.',
    cast(player, ctx) {
      const list = enemiesInRadius(player, ctx.enemyList, 5);
      for (const { e } of list) {
        e.takeDamage(35, player.pos.x, player.pos.z, 18);
      }
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0xa0e8ff, 5, 0.4);
      ctx.effects.flashSphere(player.pos.x, 0.6, player.pos.z, 0xa0e8ff, 5, 0.25);
      ctx.sound.tone?.({ freq: 200, type: 'sawtooth', dur: 0.35, gain: 0.3, slide: 150 });
    },
  },
  {
    id: 'berserk', name: 'Берсерк', icon: '😡', color: 0xff5050, cd: 14,
    desc: 'Урон ×1.6 и атака ×1.5 быстрее на 5с.',
    cast(player, ctx) {
      player._berserk = { ttl: 5, dmg: 1.6, atk: 1.5 };
      ctx.effects.ring(player.pos.x, 0.05, player.pos.z, 0xff5050, 1.6, 0.4);
      ctx.sound.tone?.({ freq: 140, type: 'sawtooth', dur: 0.4, gain: 0.4 });
    },
  },
];

export const ABILITY_BY_ID = Object.fromEntries(ABILITIES.map(a => [a.id, a]));

export function pickRandomAbilityId() {
  return ABILITIES[Math.floor(Math.random() * ABILITIES.length)].id;
}
