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
    desc: 'Бежишь быстрее. 1 стак: +6% к скорости. 3: +14%. 5: +24%.',
    hooks: {
      onTick(player) {
        const n = player.items[this.id] || 0;
        player._itemSpeedMult = 1 + pick(n, [0.06, 0.14, 0.24]);
      },
    },
  },
  {
    id: 'thorns', name: 'Колючая броня', icon: 'shield', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Враг получает урон, когда бьёт тебя. 1 стак: 2 урона. 3: 4. 5: 8.',
    hooks: {
      onTakeDamage(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.attacker || !ctx.attacker.alive) return;
        const refl = pick(n, [2, 4, 8]);
        ctx.attacker.takeDamage(refl, player.pos.x, player.pos.z, 0);
      },
    },
  },
  {
    id: 'regen', name: 'Серебряное ожерелье', icon: 'gem', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Лечит, пока ты в порядке. 1 стак: +1 HP/с. 3: +2 HP/с. 5: +4 HP/с.',
    hooks: {
      onTick(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.dt) return;
        if (player.hp >= player.maxHP) return;
        const rate = pick(n, [1, 2, 4]);
        player.heal(rate * ctx.dt);
      },
    },
  },
  {
    id: 'fang', name: 'Гадюкин клык', icon: 'snake', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'Удар травит врага. 1 стак: 3% макс HP/с, 2с. 3: 4%/с, 3с. 5: 5%/с, 5с.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.enemy) return;
        const dur = pick(n, [2, 3, 5]);
        const dpsPct = pick(n, [0.03, 0.04, 0.05]);
        ctx.enemy._poison = { dur, dps: ctx.enemy.maxHP * dpsPct, src: player };
      },
    },
  },
  {
    id: 'pyromancer', name: 'Уголёк феникса', icon: 'flame', rarity: 'common', maxStacks: MAX_STACKS,
    element: 'fire',
    desc: 'Огненные способности (Фаербол) сильнее. 1 стак: +15% урона. 3: +35%. 5: +60%.',
    // No combat hooks — applied at ability cast time via elementDamageMult().
    hooks: {},
  },

  // ---- uncommon -------------------------------------------------------
  {
    id: 'echo', name: 'Лук эхо', icon: 'bow', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Удар иногда повторяется по другому врагу. 1 стак: 20% шанс / 50% урона. 3: 35% / 50%. 5: 55% / 65%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || ctx.echo) return;
        const t = tierOf(n);
        const p = t === 2 ? 0.55 : t === 1 ? 0.35 : 0.20;
        const mult = t === 2 ? 0.65 : 0.50;
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
    desc: 'Бьёшь сильнее, когда тебя мало HP (меньше половины). 1 стак: +15% урона. 3: +30%. 5: +60%.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (player.hp >= player.maxHP * 0.5) return;
        ctx.dmgMult *= 1 + pick(n, [0.15, 0.30, 0.60]);
      },
    },
  },
  {
    id: 'crit', name: 'Молот разлома', icon: 'hammer', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Шанс крита (×2 урон). 1 стак: 10%. 3: 20%. 5: 35%.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = pick(n, [0.10, 0.20, 0.35]);
        if (chance(p)) { ctx.crit = true; ctx.dmgMult *= 2; }
      },
    },
  },
  {
    id: 'leech', name: 'Пилюля кровавой охоты', icon: 'drop', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Лечишься от своего урона. 1 стак: 6%. 3: 12%. 5: 20%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const ratio = pick(n, [0.06, 0.12, 0.20]);
        const heal = ctx.dmg * ratio;
        if (heal > 0) player.heal(heal);
      },
    },
  },
  {
    id: 'doubleStrike', name: 'Мерцающий клинок', icon: 'bolt', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Шанс ударить повторно за 40% урона. 1 стак: 20%. 3: 35%. 5: 55%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || ctx.echo) return;
        const p = pick(n, [0.20, 0.35, 0.55]);
        if (chance(p)) {
          ctx.enemy.takeDamage(ctx.dmg * 0.4, player.pos.x, player.pos.z, 3);
        }
      },
    },
  },
  {
    id: 'dashBlast', name: 'Аура отдачи', icon: 'burst', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'При рывке — взрыв вокруг тебя. 1 стак: 2.5м, 15 урона. 3: 3.5м, 30. 5: 5м, 55.',
    hooks: {
      onDash(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const r = pick(n, [2.5, 3.5, 5.0]);
        const dmg = pick(n, [15, 30, 55]);
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
    desc: 'Ледяные способности (Ледяная стрела, Замедление) сильнее и дольше. 1 стак: +15% урона, +0.4с заморозки. 3: +35%, +0.8с. 5: +60%, +1.2с.',
    hooks: {},
  },

  // ---- rare ----------------------------------------------------------
  {
    id: 'frost', name: 'Снежная буря', icon: 'snowflake', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Шанс заморозить врага на 1с. 1 стак: 8%. 3: 18%. 5: 30%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = pick(n, [0.08, 0.18, 0.30]);
        if (!chance(p)) return;
        ctx.enemy._frozen = Math.max(ctx.enemy._frozen || 0, 1.0);
      },
    },
  },
  {
    id: 'dodge', name: 'Кольцо тени', icon: 'wind', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Шанс полностью увернуться от урона. 1 стак: 8%. 3: 18%. 5: 30%.',
    hooks: {
      onTakeDamage(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const p = pick(n, [0.08, 0.18, 0.30]);
        if (chance(p)) ctx.dodged = true;
      },
    },
  },
  {
    id: 'companion', name: 'Дружеский амулет', icon: 'handshake', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Бьёшь сильнее, когда напарник в 5м. 1 стак: +15%. 3: +35%. 5: +70% урона.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (partnerDist(player, ctx) <= 5) {
          ctx.dmgMult *= 1 + pick(n, [0.15, 0.35, 0.70]);
        }
      },
    },
  },
  {
    id: 'stormcaller', name: 'Жезл бури', icon: 'bolt', rarity: 'rare', maxStacks: MAX_STACKS,
    element: 'lightning',
    desc: 'Молнии (Цепная молния) сильнее, цепная молния прыгает на больше целей. 1 стак: +20% урона. 3: +40%, +1 цель. 5: +70%, +2 цели.',
    hooks: {},
  },

  // ---- legendary -----------------------------------------------------
  {
    id: 'thunder', name: 'Молот Тора', icon: 'trident', rarity: 'legendary', maxStacks: MAX_STACKS,
    desc: 'Каждый N-й удар — молния по площади. 1 стак: каждый 8-й, 20 урона, 2.5м. 3: каждый 5-й, 40, 3м. 5: каждый 3-й, 65, 3.5м.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const need = pick(n, [8, 5, 3]);
        const dmg = pick(n, [20, 40, 65]);
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
          // Thor's hammer is a lightning AoE — visuals use the same
          // lightning-yellow palette as chain lightning / cycle, not
          // the icy blue that previously made it read as a freeze.
          player.effects.flashSphere(ctx.enemy.pos.x, 1.5, ctx.enemy.pos.z, 0xfff7a0, r, 0.3);
          player.effects.ring(ctx.enemy.pos.x, 0.05, ctx.enemy.pos.z, 0xfff7a0, r, 0.4);
        }
        player.sound?.bomb?.();
      },
    },
  },
  {
    id: 'bond', name: 'Резонатор бонда', icon: 'heart', rarity: 'legendary', maxStacks: MAX_STACKS,
    desc: 'Бьёшь сильнее, пока поводок натянут (далеко от напарника). 1 стак: +25%. 3: +50%. 5: +90% урона.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const d = partnerDist(player, ctx);
        if (d > 12) {
          ctx.dmgMult *= 1 + pick(n, [0.25, 0.50, 0.90]);
        }
      },
    },
  },
  {
    id: 'lifebloom', name: 'Цветок жизни', icon: 'heart', rarity: 'legendary', maxStacks: MAX_STACKS,
    element: 'heal',
    desc: 'Любое лечение (еда, регенерация, аура, вампиризм) и щиты сильнее. 1 стак: +20%. 3: +45%. 5: +80%.',
    hooks: {},
  },

  // ---- common (new) ---------------------------------------------------
  // Distance-conditional damage — rewards staying out of melee range.
  {
    id: 'headshot', name: 'Прицел снайпера', icon: 'bow', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'По цели дальше 5м удар сильнее. 1 стак: +10%. 3: +20%. 5: +35%.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.enemy) return;
        const dx = ctx.enemy.pos.x - player.pos.x;
        const dz = ctx.enemy.pos.z - player.pos.z;
        if (Math.hypot(dx, dz) <= 5) return;
        ctx.dmgMult *= 1 + pick(n, [0.10, 0.20, 0.35]);
      },
    },
  },
  // Reactive shield — pops a small absorb on every fifth-or-so hit.
  // 12s internal cooldown keeps it from snowballing in continuous DPS.
  {
    id: 'barrier', name: 'Реактивный барьер', icon: 'shield', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'После удара щит на N HP (КД 12с). 1 стак: 5. 3: 12. 5: 22.',
    hooks: {
      onTakeDamage(player) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const now = performance.now() / 1000;
        if (player._barrierCdUntil && now < player._barrierCdUntil) return;
        const hp = pick(n, [5, 12, 22]) * healMultiplier(player);
        const cur = player._shield?.hp || 0;
        player._shield = { hp: Math.max(cur, hp), ttl: Math.max(player._shield?.ttl || 0, 4) };
        player._barrierCdUntil = now + 12;
      },
    },
  },
  // Flat heal on kill — pairs with rage / dash-blast clear builds.
  {
    id: 'soulthief', name: 'Лайфстрайк', icon: 'drop', rarity: 'common', maxStacks: MAX_STACKS,
    desc: 'После убийства мгновенно лечит. 1 стак: +2 HP. 3: +5. 5: +10.',
    hooks: {
      onKill(player) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        player.heal(pick(n, [2, 5, 10]));
      },
    },
  },

  // ---- uncommon (new) -------------------------------------------------
  // After-cast empowered next hit — rewards weaving cast + auto attack.
  // Charge expires after 5s so it can't be banked indefinitely.
  {
    id: 'sheen', name: 'Шин', icon: 'sparkle', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'После каста следующий удар сильнее (1 заряд, 5с). 1 стак: +50%. 3: +90%. 5: +140%.',
    hooks: {
      onCast(player) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const bonus = pick(n, [0.50, 0.90, 1.40]);
        player._sheenCharge = { mult: 1 + bonus, ttl: 5 };
      },
      onAttack(player, ctx) {
        const ch = player._sheenCharge;
        if (!ch || ch.ttl <= 0) return;
        ctx.dmgMult *= ch.mult;
        player._sheenCharge = null;
      },
      onTick(player, ctx) {
        const ch = player._sheenCharge;
        if (!ch || !ctx?.dt) return;
        ch.ttl -= ctx.dt;
        if (ch.ttl <= 0) player._sheenCharge = null;
      },
    },
  },
  // Stun-on-hit — chance to lock down a single enemy for a brief moment.
  // Duration 0.4s so it doesn't cheese hard CC, just disrupts windups.
  {
    id: 'stunhammer', name: 'Череполом', icon: 'hammer', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'Шанс оглушить врага на 0.4с при ударе. 1 стак: 8%. 3: 14%. 5: 22%.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.enemy) return;
        const p = pick(n, [0.08, 0.14, 0.22]);
        if (!chance(p)) return;
        ctx.enemy._stunned = Math.max(ctx.enemy._stunned || 0, 0.4);
      },
    },
  },
  // Stand-still empower — rewards positioned play; tap-and-move erases it.
  // Slightly weaker than Sheen because the trigger is passive instead of
  // requiring a separate ability cast.
  {
    id: 'standstill', name: 'Активная перезарядка', icon: 'bolt', rarity: 'uncommon', maxStacks: MAX_STACKS,
    desc: 'После 1с без движения следующий удар сильнее. 1 стак: +30%. 3: +60%. 5: +100%.',
    hooks: {
      onTick(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx?.dt) return;
        // Approximate "standing still" via last-frame velocity. Read the
        // player's intent vector; if zero, count up. Otherwise reset.
        const intent = player._lastIntent;
        const moving = intent && (Math.abs(intent.x || 0) > 0.02 || Math.abs(intent.z || 0) > 0.02);
        if (moving) {
          player._standstillT = 0;
          player._standstillReady = false;
        } else {
          player._standstillT = (player._standstillT || 0) + ctx.dt;
          if (player._standstillT >= 1) player._standstillReady = true;
        }
      },
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !player._standstillReady) return;
        ctx.dmgMult *= 1 + pick(n, [0.30, 0.60, 1.00]);
        player._standstillReady = false;
        player._standstillT = 0;
      },
    },
  },

  // ---- rare (new) -----------------------------------------------------
  // Percent-max-HP steal + flat heal. Strong vs elites/bosses with big
  // health pools, modest vs trash so it doesn't trivialise clear.
  {
    id: 'ravinger', name: 'Лезвие Раджин', icon: 'drop', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Каждый удар крадёт % макс HP цели и лечит флэт. 1 стак: 1.5% / +3. 3: 2.8% / +6. 5: 4.5% / +10.',
    hooks: {
      onHit(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0 || !ctx.enemy) return;
        const pct = pick(n, [0.015, 0.028, 0.045]);
        const flat = pick(n, [3, 6, 10]);
        const bonus = (ctx.enemy.maxHP || 0) * pct;
        // Cap %max HP damage at 25/sec/target so a hyper attack-speed
        // build still has to apply pressure for the kill to land.
        const now = performance.now() / 1000;
        ctx.enemy._ravingerCapResetAt = ctx.enemy._ravingerCapResetAt || (now + 1);
        if (now > ctx.enemy._ravingerCapResetAt) {
          ctx.enemy._ravingerDealt = 0;
          ctx.enemy._ravingerCapResetAt = now + 1;
        }
        const cap = 25;
        const allowed = Math.max(0, cap - (ctx.enemy._ravingerDealt || 0));
        const dealt = Math.min(bonus, allowed);
        ctx.enemy._ravingerDealt = (ctx.enemy._ravingerDealt || 0) + dealt;
        if (dealt > 0) ctx.enemy.takeDamage(dealt, player.pos.x, player.pos.z, 0);
        player.heal(flat);
      },
    },
  },
  // Per-hit attack-speed stacking — caps at +18/32/50% so the swing
  // animation can still keep up at the floor of `attackSpeedMult`.
  {
    id: 'tempestbeast', name: 'Лютый барс', icon: 'flame', rarity: 'rare', maxStacks: MAX_STACKS,
    desc: 'Каждое попадание +1% скорости атаки на 6с (стэкается). 1 стак: макс +18%. 3: +32%. 5: +50%.',
    hooks: {
      onHit(player) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        const max = pick(n, [0.18, 0.32, 0.50]);
        const now = performance.now() / 1000;
        const cur = player._tempestStacks || 0;
        player._tempestStacks = Math.min(max, cur + 0.01);
        player._tempestUntil = now + 6;
      },
      onTick(player) {
        const n = player.items[this.id] || 0;
        if (n <= 0) {
          if (player._tempestStacks) player._tempestStacks = 0;
          if (player._itemAtkSpeedMult > 1) player._itemAtkSpeedMult = 1;
          return;
        }
        const now = performance.now() / 1000;
        if (player._tempestUntil && now > player._tempestUntil) {
          player._tempestStacks = 0;
        }
        // Compose with boots/other AS items by setting a player-wide
        // multiplier. _attackCdMult() divides by this on top of base.
        player._itemAtkSpeedMult = 1 + (player._tempestStacks || 0);
      },
    },
  },

  // ---- legendary (new) ------------------------------------------------
  // Crit multiplier upgrade — replaces the stock ×2 with ×2.5/3/3.5
  // and adds flat crit chance on top. The multiplier is applied in
  // game._onPlayerHitsEnemy after all onAttack hooks resolve so hook
  // ordering doesn't matter (see comment there).
  {
    id: 'infinity_edge', name: 'Бесконечное лезвие', icon: 'bolt', rarity: 'legendary', maxStacks: MAX_STACKS,
    desc: 'Криты сильнее и шанс крита выше. 1 стак: ×2.5 / +5% шанс. 3: ×3 / +8%. 5: ×3.5 / +12%.',
    hooks: {
      onAttack(player, ctx) {
        const n = player.items[this.id] || 0;
        if (n <= 0) return;
        if (ctx.crit) return;
        const p = pick(n, [0.05, 0.08, 0.12]);
        if (chance(p)) { ctx.crit = true; ctx.dmgMult *= 2; }
      },
    },
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
  if (element === 'lightning') return 1 + pick(n, [0.20, 0.40, 0.70]);
  // fire and ice share the same +15/+35/+60 ramp.
  if (element === 'fire' || element === 'ice') return 1 + pick(n, [0.15, 0.35, 0.60]);
  return 1;
}

// Extra freeze duration in seconds (cryomancer).
export function freezeDurationBonus(player) {
  const n = player?.items?.cryomancer || 0;
  return pick(n, [0.4, 0.8, 1.2]);
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
  return 1 + pick(n, [0.20, 0.45, 0.80]);
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
