import { ITEM_BY_ID } from './items.js';
import { ABILITY_BY_ID } from './abilities.js';

// Upgrade definitions and shop UI logic.
export const UPGRADES = [
  { id: 'damage', name: 'Sharper Blade', desc: '+6 damage', baseCost: 20, growth: 1.6 },
  { id: 'hp', name: 'Stout Heart', desc: '+30 max HP', baseCost: 25, growth: 1.55 },
  { id: 'speed', name: 'Light Boots', desc: '+0.6 move speed', baseCost: 22, growth: 1.6 },
  { id: 'attackSpeed', name: 'Quick Hands', desc: '-0.06s attack cooldown', baseCost: 28, growth: 1.7 },
];

export function priceFor(player, upg) {
  const lvl = player.upgradeLevels[upg.id] || 0;
  return Math.floor(upg.baseCost * Math.pow(upg.growth, lvl));
}

export function buy(player, upg, sound) {
  const price = priceFor(player, upg);
  if (player.gold < price) return false;
  player.gold -= price;
  player.applyUpgrade(upg.id);
  sound.buy();
  return true;
}

export function renderShop(player1, player2, onBuy) {
  const rebuild = (containerId, player, slot) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    UPGRADES.forEach((u, idx) => {
      const lvl = player.upgradeLevels[u.id] || 0;
      const price = priceFor(player, u);
      const can = player.gold >= price;
      const div = document.createElement('div');
      div.className = 'upg' + (can ? '' : ' locked');
      const playerKey = slot === 0 ? '1234' : '7890';
      const idxKey = playerKey[idx];
      div.innerHTML = `
        <div>
          <div>${u.name} <span class="lvl">Lv ${lvl}</span></div>
          <div style="opacity:0.65;font-size:11px;">${u.desc}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="price">⛁ ${price}</span>
          <kbd>${idxKey}</kbd>
        </div>`;
      if (onBuy) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => onBuy(slot, idx));
      }
      el.appendChild(div);
    });
  };
  rebuild('shop-upgs-1', player1, 0);
  rebuild('shop-upgs-2', player2, 1);
  document.getElementById('shop-gold1').textContent = String(player1.gold);
  document.getElementById('shop-gold2').textContent = String(player2.gold);

  const renderInv = (containerId, player) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';

    // Ability
    const ah = document.createElement('h4');
    ah.textContent = 'Способность';
    el.appendChild(ah);
    if (player.ability) {
      const def = ABILITY_BY_ID[player.ability];
      if (def) {
        const d = document.createElement('div');
        d.className = 'inv-ability';
        const castKey = player.index === 0 ? 'G' : 'H';
        d.innerHTML = `<span class="inv-name">${def.icon} ${def.name}</span> <kbd>${castKey}</kbd><br><span class="inv-desc">${def.desc}</span>`;
        el.appendChild(d);
      }
    } else {
      const e = document.createElement('div');
      e.className = 'inv-empty';
      e.textContent = 'Нет способности';
      el.appendChild(e);
    }

    // Items
    const ih = document.createElement('h4');
    ih.textContent = 'Предметы';
    el.appendChild(ih);
    const entries = Object.entries(player.items || {}).filter(([, n]) => n > 0);
    if (entries.length === 0) {
      const e = document.createElement('div');
      e.className = 'inv-empty';
      e.textContent = 'Нет предметов';
      el.appendChild(e);
    } else {
      for (const [id, count] of entries) {
        const def = ITEM_BY_ID[id];
        if (!def) continue;
        const d = document.createElement('div');
        d.className = 'inv-item';
        d.innerHTML = `<span class="inv-name">${def.icon || ''} ${def.name}${count > 1 ? ` ×${count}` : ''}</span><br><span class="inv-desc">${def.desc || ''}</span>`;
        el.appendChild(d);
      }
    }
  };
  renderInv('shop-inv-1', player1);
  renderInv('shop-inv-2', player2);
}
