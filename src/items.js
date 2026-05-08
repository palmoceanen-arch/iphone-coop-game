import { defaultRandom } from './utils.js';

// Stacking passive items (Risk of Rain style).
//
// Каждый предмет имеет набор хуков — onAttack / onHit / onTakeDamage /
// onTick / onDash / onKill — которые игра вызывает в соответствующие
// моменты боя. Хук читает количество стаков (player.items[id]) и
// мутирует ctx (например множит урон, помечает крит, лечит).
//
// Балансировка через breakpoint'ы 1 / 3 / 5: эффект растёт ступенями
// при достижении 1, 3 и 5 стаков. Это даёт чёткое решение "стоит ли
// добивать до следующего тира", вместо линейного снежного кома.
//
// Кэп стаков = 5 для каждого предмета. Когда стак достигает максимума,
// runes.js пропускает игрока и выводит подсказку. Обмен и переплавка
// предметов делается на алтаре (altar.js).

export const RARITY = {
  common:    { weight: 60, color: 0xb8c7d6, label: 'common',    sacrificeGold: 30  },
  uncommon:  { weight: 28, color: 0x66d97a, label: 'uncommon',  sacrificeGold: 80  },
  rare:      { weight: 10, color: 0x6aa6ff, label: 'rare',      sacrificeGold: 200 },
  legendary: { weight: 2,  color: 0xffb84d, label: 'legendary', sacrificeGold: 500 },
};

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'legendary'];
export const MAX_STACKS = 5;

// Lightweight RNG bound to the world-seeded default RNG (utils.defaultRandom).
// Routing item rolls through it makes loot tables reproducible for a given
// world seed, which is required for the upcoming save/load feature.
function rng() { return defaultRandom(); }
function chance(p) { return defaultRandom() < p; }

// Helper: distance between two players (used by coop items).
function partnerDist(player, ctx) {
  if (!ctx || !ctx.partner) return Infinity;
  const dx = player.pos.x - ctx.partner.pos.x;
  const dz = player.pos.z - ctx.partner.pos.z;
  return Math.hypot(dx, dz);
}

// Tier index from stack count: 0 at 1-2 стаков, 1 at 3-4, 2 at 5+. -1 if no stacks.
export function tierOf(n) {
  if (n >= 5) return 2;
  if (n >= 3) return 1;
  if (n >= 1) return 0;
  return -1;
}

// Pick a tier-indexed value: triple[T] is used for the active tier.
function pick(n, [t1, t2, t3]) {
  const t = tierOf(n);
  return t === 2 ? t3 : t === 1 ? t2 : t === 0 ? t1 : 0;
}

export const ITEMS = [
  // ---- common ---------------------------------------------------------
  {
    id: 'boots', name: 'Ловкие сапоги', icon: 'boot', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Бежишь быстрее. 1 стак: +10% к скорости. 3: +20%. 5: +35%.',
    hooks: {
      onTick(player) {
        const n = player.items[this.id] || 0;
        player._itemSpeedMult = 1 + pick(n, [0.10, 0.20, 0.35]);
      },
    },
  },
  {
    id: 'thorns', name: 'Колючая броня', icon: 'shield', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Враг получает урон, когда бьёт тебя. 1 стак: 2 урона. 3: 5. 5: 10.',
    hooks: {
      onTakeDamage(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.attacker || !ctx.attacker.alive) return;
        const refl = pick(n, [2, 5, 10]);
        ctx.attacker.takeDamage(refl, player.pos.x, player.pos.z, 0);
      },
    },
  },
  {
    id: 'regen', name: 'Серебряное ожерелье', icon: 'gem', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Лечит, пока ты в порядке. 1 стак: +1 HP/с. 3: +3 HP/с. 5: +6 HP/с.',
    hooks: {
      onTick(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.dt) return;
        if (player.hp >= player.maxHP) return;
        const rate = pick(n, [1, 3, 6]);
        player.heal(rate * ctx.dt);
      },
    },
  },
  {
    id: 'fang', name: 'Гадюкин клык', icon: 'snake', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Удар травит врага. 1 стак: 4% макс HP/с, 2с. 3: 5%/с, 4с. 5: 7%/с, 6с.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.enemy) return;
        const dur = pick(n, [2, 4, 6]);
        const dpsPct = pick(n, [0.04, 0.05, 0.07]);
        ctx.enemy._poison = { dur, dps: ctx.enemy.maxHP * dpsPct, src: player };
      },
    },
  },
  {
    id: 'pyromancer', name: 'Уголёк феникса', icon: 'flame', rarity: 'common', maxStacks: MAX_STACKS,
    element: 'fire',
    desc: 'Огненные способности (Фаербол, Берсерк) сильнее. 1 стак: +25% урона. 3: +60%. 5: +100%.',
    // No combat hooks — applied at ability cast time via elementDamageMult().
    hooks: {},
  },

  // ---- uncommon -------------------------------------------------------
  {
    id: 'echo', name: 'Лук эхо', icon: 'bow', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Удар иногда повторяется по другому врагу. 1 стак: 25% шанс / 60% урона. 3: 45% / 60%. 5: 70% / 80%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || ctx.echo) return;
        const t = tierOf(n);
        const p = t === 2 ? 0.70 : t === 1 ? 0.45 : 0.25;
        const mult = t === 2 ? 0.80 : 0.60;
        if (!chance(p)) return;
        const list = ctx.enemyList || [];
        let best = null, bestD = 5;
        for (const e of list) {
          if (!e.alive || e === ctx.enemy) continue;
          const d = Math.hypot(e.pos.x - ctx.enemy.pos.x, e.pos.z - ctx.enemy.pos.z);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (best) {
          best.takeDamage(ctx.dmg * mult, ctx.enemy.pos.x, ctx.enemy.pos.z, 4);
        }
      },
    },
  },
  {
    id: 'rage', name: 'Ярость берсерка', icon: 'flame', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Бьёшь сильнее, когда тебя мало HP (меньше половины). 1 стак: +30% урона. 3: +60%. 5: +120%.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (player.hp >= player.maxHP * 0.5) return;
        ctx.dmgMult *= 1 + pick(n, [0.30, 0.60, 1.20]);
      },
    },
  },
  {
    id: 'crit', name: 'Молот разлома', icon: 'hammer', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Шанс крита (×2 урон). 1 стак: 15%. 3: 35%. 5: 60%.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = pick(n, [0.15, 0.35, 0.60]);
        if (chance(p)) { ctx.crit = true; ctx.dmgMult *= 2; }
      },
    },
  },
  {
    id: 'leech', name: 'Пилюля кровавой охоты', icon: 'drop', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Лечишься от своего урона. 1 стак: 8%. 3: 18%. 5: 30%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const ratio = pick(n, [0.08, 0.18, 0.30]);
        const heal = ctx.dmg * ratio;
        if (heal > 0) player.heal(heal);
      },
    },
  },
  {
    id: 'doubleStrike', name: 'Мерцающий клинок', icon: 'bolt', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Шанс ударить повторно за 50% урона. 1 стак: 25%. 3: 50%. 5: 75%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || ctx.echo) return;
        const p = pick(n, [0.25, 0.50, 0.75]);
        if (chance(p)) {
          ctx.enemy.takeDamage(ctx.dmg * 0.5, player.pos.x, player.pos.z, 3);
        }
      },
    },
  },
  {
    id: 'dashBlast', name: 'Аура отдачи', icon: 'burst', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'При рывке — взрыв вокруг тебя. 1 стак: 2.5м, 20 урона. 3: 3.5м, 45. 5: 5м, 80.',
    hooks: {
      onDash(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const r = pick(n, [2.5, 3.5, 5.0]);
        const dmg = pick(n, [20, 45, 80]);
        for (const e of (ctx.enemyList || [])) {
          if (!e.alive) continue;
          const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
          if (d <= r + e.radius) {
            e.takeDamage(dmg, player.pos.x, player.pos.z, 6);
          }
        }
        if (player.effects?.flashSphere) {
          player.effects.flashSphere(player.pos.x, 0.5, player.pos.z, 0xff8a30, r, 0.25);
          player.effects.ring(player.pos.x, 0.05, player.pos.z, 0xff8a30, r, 0.35);
        }
      },
    },
  },
  {
    id: 'cryomancer', name: 'Сердце морозов', icon: 'snowflake', rarity: 'uncommon', maxStacks: MAX_STACKS,
    element: 'ice',
    desc: 'Ледяные способности (Ледяная стрела, Замедление) сильнее и дольше. 1 стак: +25% урона, +0.5с заморозки. 3: +60%, +1с. 5: +100%, +1.5с.',
    hooks: {},
  },

  // ---- rare ----------------------------------------------------------
  {
    id: 'frost', name: 'Снежная буря', icon: 'snowflake', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Шанс заморозить врага на 1с. 1 стак: 12%. 3: 30%. 5: 50%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = pick(n, [0.12, 0.30, 0.50]);
        if (!chance(p)) return;
        ctx.enemy._frozen = Math.max(ctx.enemy._frozen || 0, 1.0);
      },
    },
  },
  {
    id: 'dodge', name: 'Кольцо тени', icon: 'wind', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Шанс полностью увернуться от урона. 1 стак: 12%. 3: 30%. 5: 50%.',
    hooks: {
      onTakeDamage(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = pick(n, [0.12, 0.30, 0.50]);
        if (chance(p)) ctx.dodged = true;
      },
    },
  },
  {
    id: 'companion', name: 'Дружеский амулет', icon: 'handshake', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Бьёшь сильнее, когда напарник в 5м. 1 стак: +30%. 3: +75%. 5: +150% урона.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (partnerDist(player, ctx) <= 5) {
          ctx.dmgMult *= 1 + pick(n, [0.30, 0.75, 1.50]);
        }
      },
    },
  },
  {
    id: 'stormcaller', name: 'Жезл бури', icon: 'bolt', rarity: 'rare', maxStacks: MAX_STACKS,
    element: 'lightning',
    desc: 'Молнии (Цепная молния, Ветер удар) сильнее, цепная молния прыгает на больше целей. 1 стак: +30% урона. 3: +75%, +1 цель. 5: +120%, +2 цели.',
    hooks: {},
  },

  // ---- legendary -----------------------------------------------------
  {
    id: 'thunder', name: 'Молот Тора', icon: 'trident', rarity: 'legendary', maxStacks: MAX_STACKS,
    desc: 'Каждый N-й удар — молния по площади. 1 стак: каждый 8-й, 30 урона, 2.5м. 3: каждый 5-й, 55, 3м. 5: каждый 3-й, 85, 3.5м.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const need = pick(n, [8, 5, 3]);
        const dmg = pick(n, [30, 55, 85]);
        const r = pick(n, [2.5, 3.0, 3.5]);
        player._thunderCount = (player._thunderCount || 0) + 1;
        if (player._thunderCount < need) return;
        player._thunderCount = 0;
        for (const e of (ctx.enemyList || [])) {
          if (!e.alive) continue;
          const d = Math.hypot(e.pos.x - ctx.enemy.pos.x, e.pos.z - ctx.enemy.pos.z);
          if (d <= r + e.radius) e.takeDamage(dmg, ctx.enemy.pos.x, ctx.enemy.pos.z, 5);
        }
        if (player.effects?.flashSphere) {
          player.effects.flashSphere(ctx.enemy.pos.x, 1.5, ctx.enemy.pos.z, 0x9dfcff, r, 0.3);
          player.effects.ring(ctx.enemy.pos.x, 0.05, ctx.enemy.pos.z, 0x9dfcff, r, 0.4);
        }
        player.sound?.bomb?.();
      },
    },
  },
  {
    id: 'bond', name: 'Резонатор бонда', icon: 'heart', rarity: 'legendary', maxStacks: MAX_STACKS,
    desc: 'Бьёшь сильнее, пока поводок натянут (далеко от напарника). 1 стак: +60%. 3: +120%. 5: +200% урона.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const d = partnerDist(player, ctx);
        if (d > 12) {
          ctx.dmgMult *= 1 + pick(n, [0.60, 1.20, 2.00]);
        }
      },
    },
  },
  {
    id: 'lifebloom', name: 'Цветок жизни', icon: 'heart', rarity: 'legendary', maxStacks: MAX_STACKS,
    element: 'heal',
    desc: 'Любое лечение (еда, регенерация, аура, вампиризм) и щиты сильнее. 1 стак: +30%. 3: +70%. 5: +120%.',
    hooks: {},
  },
];

// id -> definition
export const ITEM_BY_ID = Object.fromEntries(ITEMS.map(it => [it.id, it]));

// ----------------------------------------------------------------------
// Synergy helpers — read by abilities.js / player.js to scale damage,
// healing and ability-specific extras based on the synergy item the
// player owns. All return a multiplier (>=1) or a flat bonus (>=0).
// ----------------------------------------------------------------------

const ELEMENT_TO_ITEM = {
  fire:      'pyromancer',
  ice:       'cryomancer',
  lightning: 'stormcaller',
  heal:      'lifebloom',
};

// Multiplier on outgoing ability damage for the given element.
export function elementDamageMult(player, element) {
  if (!player || !element) return 1;
  const id = ELEMENT_TO_ITEM[element];
  if (!id) return 1;
  const n = player.items?.[id] || 0;
  if (element === 'lightning') return 1 + pick(n, [0.30, 0.75, 1.20]);
  // fire and ice share the same +25/+60/+100 ramp.
  if (element === 'fire' || element === 'ice') return 1 + pick(n, [0.25, 0.60, 1.00]);
  return 1;
}

// Extra freeze duration in seconds (cryomancer).
export function freezeDurationBonus(player) {
  const n = player?.items?.cryomancer || 0;
  return pick(n, [0.5, 1.0, 1.5]);
}

// Extra chain jumps (stormcaller).
export function chainBonusJumps(player) {
  const n = player?.items?.stormcaller || 0;
  return pick(n, [0, 1, 2]);
}

// Multiplier on every heal amount (food, regen item, leech, regenAura).
// Also used by shield to scale absorbed HP at cast time.
export function healMultiplier(player) {
  const n = player?.items?.lifebloom || 0;
  return 1 + pick(n, [0.30, 0.70, 1.20]);
}

// ----------------------------------------------------------------------
// Hook plumbing
// ----------------------------------------------------------------------

// Run a named hook for every item the player owns. ctx is mutable and
// is passed by reference; each hook may modify it.
export function runItemHook(player, hookName, ctx) {
  if (!player || !player.items) return;
  for (const id of Object.keys(player.items)) {
    if ((player.items[id] || 0) <= 0) continue;
    const it = ITEM_BY_ID[id];
    const hook = it && it.hooks && it.hooks[hookName];
    if (typeof hook === 'function') {
      try { hook.call(it, player, ctx); } catch (err) { console.warn(`[item ${id}/${hookName}]`, err); }
    }
  }
}

// Called from Game when an elite is killed or a chest is opened. Picks a
// random item id weighted by rarity. Pass `rarityFilter` to bias toward
// higher rarities (e.g. for legendary chests).
export function pickRandomItemId(rarityFilter = null) {
  const pool = ITEMS.filter(it => !rarityFilter || it.rarity === rarityFilter);
  if (pool.length === 0) return null;
  let total = 0;
  for (const it of pool) total += RARITY[it.rarity].weight;
  let roll = rng() * total;
  for (const it of pool) {
    roll -= RARITY[it.rarity].weight;
    if (roll <= 0) return it.id;
  }
  return pool[0].id;
}

// Pick a different random item id of the given rarity (used by altar reroll).
// Falls back to any same-rarity item, including the original, if there is
// only one item of that rarity in the pool.
export function pickRandomItemIdInRarityExcept(rarity, excludeId) {
  const pool = ITEMS.filter(it => it.rarity === rarity && it.id !== excludeId);
  if (pool.length === 0) {
    const fallback = ITEMS.filter(it => it.rarity === rarity);
    if (fallback.length === 0) return null;
    return fallback[Math.floor(defaultRandom() * fallback.length)].id;
  }
  return pool[Math.floor(defaultRandom() * pool.length)].id;
}

// Next-rarity-up id used by altar fuse. Returns null if `rarity` has no upgrade.
export function rarityAbove(rarity) {
  const i = RARITY_ORDER.indexOf(rarity);
  if (i < 0 || i >= RARITY_ORDER.length - 1) return null;
  return RARITY_ORDER[i + 1];
}
