// Stacking passive items (Risk of Rain style).
//
// Each item has a set of optional hooks. The combat / movement code in
// game.js and player.js calls runItemHook(player, name, ctx) at a handful of
// event points; the hook reads the player's stack count and mutates `ctx`
// (e.g. boosting damage, marking a crit, applying lifesteal, etc.).
//
// Effects are linear in stack count so balance stays predictable: 5 stacks
// of "Колючая броня" reflect 5 damage, 5 stacks of "Сапоги" give +30%
// movement speed, etc. Some items have soft caps (e.g. dodge max 50%).
//
// Items are looked up by id; the id is also what is stored in
// player.items[id] = stack count.

export const RARITY = {
  common:    { weight: 60, color: 0xb8c7d6, label: 'common' },
  uncommon:  { weight: 28, color: 0x66d97a, label: 'uncommon' },
  rare:      { weight: 10, color: 0x6aa6ff, label: 'rare' },
  legendary: { weight: 2,  color: 0xffb84d, label: 'legendary' },
};

// Lightweight RNG using Math.random; a seeded variant could be added later.
function rng() { return Math.random(); }
function chance(p) { return Math.random() < p; }

// Helper: distance between two players (used by coop items).
function partnerDist(player, ctx) {
  if (!ctx || !ctx.partner) return Infinity;
  const dx = player.pos.x - ctx.partner.pos.x;
  const dz = player.pos.z - ctx.partner.pos.z;
  return Math.hypot(dx, dz);
}

export const ITEMS = [
  // ---- common ---------------------------------------------------------
  {
    id: 'boots', name: 'Ловкие сапоги', icon: '👟', rarity: 'common',
    desc: '+6% к скорости передвижения за стак.',
    hooks: {
      onTick(player, ctx) {
        const n = player.items[this.id] || 0;
        // Re-applied each frame so refund-on-pickup stays trivial.
        player._statBonusSpeed = (player._statBonusSpeed || 0) + 0; // no-op marker
        // Permanent multiplier handled in player movement via getMoveSpeed().
        player._itemSpeedMult = 1 + 0.06 * n;
        ctx; // unused
      },
    },
  },
  {
    id: 'thorns', name: 'Колючая броня', icon: '🛡', rarity: 'common',
    desc: 'Отражает 1 урон в атакующего за стак.',
    hooks: {
      onTakeDamage(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.attacker || !ctx.attacker.alive) return;
        ctx.attacker.takeDamage(n, player.pos.x, player.pos.z, 0);
      },
    },
  },
  {
    id: 'regen', name: 'Серебряное ожерелье', icon: '💎', rarity: 'common',
    desc: '+0.6 HP в секунду регенерации за стак.',
    hooks: {
      onTick(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.dt) return;
        if (player.hp < player.maxHP) {
          player.hp = Math.min(player.maxHP, player.hp + 0.6 * n * ctx.dt);
        }
      },
    },
  },
  {
    id: 'fang', name: 'Гадюкин клык', icon: '🐍', rarity: 'common',
    desc: 'Атака отравляет цель: 4% макс HP в секунду на 2с (+1с/стак).',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.enemy) return;
        const dur = 2 + (n - 1) * 1;
        const dps = ctx.enemy.maxHP * 0.04;
        ctx.enemy._poison = { dur, dps, src: player };
      },
    },
  },

  // ---- uncommon -------------------------------------------------------
  {
    id: 'echo', name: 'Лук эхо', icon: '🏹', rarity: 'uncommon',
    desc: '20% шанс повторить удар по другому врагу (+10% за стак, макс 70%).',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || ctx.echo) return;
        const p = Math.min(0.7, 0.2 + 0.1 * (n - 1));
        if (!chance(p)) return;
        // Find a different enemy near the original target.
        const list = ctx.enemyList || [];
        let best = null, bestD = 5;
        for (const e of list) {
          if (!e.alive || e === ctx.enemy) continue;
          const d = Math.hypot(e.pos.x - ctx.enemy.pos.x, e.pos.z - ctx.enemy.pos.z);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (best) {
          best.takeDamage(ctx.dmg * 0.6, ctx.enemy.pos.x, ctx.enemy.pos.z, 4);
        }
      },
    },
  },
  {
    id: 'rage', name: 'Ярость берсерка', icon: '🔥', rarity: 'uncommon',
    desc: '+25% урона при HP < 50% (+15% за стак).',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (player.hp < player.maxHP * 0.5) {
          ctx.dmgMult *= 1 + 0.25 + 0.15 * (n - 1);
        }
      },
    },
  },
  {
    id: 'crit', name: 'Молот разлома', icon: '⚒', rarity: 'uncommon',
    desc: '+8% к шансу крита за стак (×2 урон при крите).',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = Math.min(0.85, 0.08 * n);
        if (chance(p)) { ctx.crit = true; ctx.dmgMult *= 2; }
      },
    },
  },
  {
    id: 'leech', name: 'Пилюля кровавой охоты', icon: '🩸', rarity: 'uncommon',
    desc: 'Вампиризм 4% от нанесённого урона за стак.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const heal = ctx.dmg * 0.04 * n;
        if (heal > 0) player.heal(heal);
      },
    },
  },
  {
    id: 'doubleStrike', name: 'Мерцающий клинок', icon: '⚡', rarity: 'uncommon',
    desc: '20% шанс ударить дважды (+15% за стак, макс 75%).',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || ctx.echo) return;
        const p = Math.min(0.75, 0.2 + 0.15 * (n - 1));
        if (chance(p)) {
          ctx.enemy.takeDamage(ctx.dmg * 0.5, player.pos.x, player.pos.z, 3);
        }
      },
    },
  },
  {
    id: 'dashBlast', name: 'Аура отдачи', icon: '💥', rarity: 'uncommon',
    desc: 'Дэш создаёт взрыв в радиусе 2м (+0.6м за стак), 12 урона/стак.',
    hooks: {
      onDash(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const r = 2 + 0.6 * (n - 1);
        const dmg = 12 * n;
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

  // ---- rare ----------------------------------------------------------
  {
    id: 'frost', name: 'Снежная буря', icon: '❄', rarity: 'rare',
    desc: '8% шанс заморозить врага на 1с (+5%/стак, макс 50%).',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = Math.min(0.5, 0.08 + 0.05 * (n - 1));
        if (!chance(p)) return;
        ctx.enemy._frozen = Math.max(ctx.enemy._frozen || 0, 1.0);
      },
    },
  },
  {
    id: 'dodge', name: 'Кольцо тени', icon: '💨', rarity: 'rare',
    desc: '8% шанс уклониться (+5%/стак, макс 50%).',
    hooks: {
      onTakeDamage(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = Math.min(0.5, 0.08 + 0.05 * (n - 1));
        if (chance(p)) ctx.dodged = true;
      },
    },
  },

  // ---- legendary -----------------------------------------------------
  {
    id: 'thunder', name: 'Молот Тора', icon: '🔱', rarity: 'legendary',
    desc: 'Каждый 8-й удар вызывает молнию (-1 удар за стак, мин 3).',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const need = Math.max(3, 8 - (n - 1));
        player._thunderCount = (player._thunderCount || 0) + 1;
        if (player._thunderCount < need) return;
        player._thunderCount = 0;
        // Strike: extra burst damage in radius around enemy.
        const r = 3.0;
        for (const e of (ctx.enemyList || [])) {
          if (!e.alive) continue;
          const d = Math.hypot(e.pos.x - ctx.enemy.pos.x, e.pos.z - ctx.enemy.pos.z);
          if (d <= r + e.radius) e.takeDamage(40, ctx.enemy.pos.x, ctx.enemy.pos.z, 5);
        }
        if (player.effects?.flashSphere) {
          player.effects.flashSphere(ctx.enemy.pos.x, 1.5, ctx.enemy.pos.z, 0x9dfcff, r, 0.3);
          player.effects.ring(ctx.enemy.pos.x, 0.05, ctx.enemy.pos.z, 0x9dfcff, r, 0.4);
        }
        player.sound?.bomb?.();
      },
    },
  },

  // ---- coop synergies ------------------------------------------------
  {
    id: 'companion', name: 'Дружеский амулет', icon: '🤝', rarity: 'rare',
    desc: '+15% урона за стак, пока напарник в 5м.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (partnerDist(player, ctx) <= 5) ctx.dmgMult *= 1 + 0.15 * n;
      },
    },
  },
  {
    id: 'bond', name: 'Резонатор бонда', icon: '💖', rarity: 'legendary',
    desc: 'Когда поводок натянут — оба игрока получают +60% урона.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const d = partnerDist(player, ctx);
        // "Натянут" — около границы предупреждения поводка (12м+).
        if (d > 12) ctx.dmgMult *= 1 + 0.6 * n;
      },
    },
  },
];

// id -> definition
export const ITEM_BY_ID = Object.fromEntries(ITEMS.map(it => [it.id, it]));

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
  let pick = rng() * total;
  for (const it of pool) {
    pick -= RARITY[it.rarity].weight;
    if (pick <= 0) return it.id;
  }
  return pool[0].id;
}
