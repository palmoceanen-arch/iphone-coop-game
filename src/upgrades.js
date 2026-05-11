import { ITEM_BY_ID } from './items.js';
import { ABILITY_BY_ID } from './abilities.js';
import { iconHTML } from './icons.js';

// Upgrade definitions and shop UI logic.
export const UPGRADES = [
  { id: 'damage', name: 'Fight Skill', desc: '+2 damage', baseCost: 20, growth: 1.6 },
  { id: 'hp', name: 'Stout Heart', desc: '+10 max HP', baseCost: 25, growth: 1.55 },
  { id: 'speed', name: 'Light Boots', desc: '+0.1 move speed', baseCost: 22, growth: 1.6 },
  { id: 'attackSpeed', name: 'Quick Hands', desc: '-4% attack cooldown', baseCost: 28, growth: 1.7 },
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
    if (!player || player._phantom) return;
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
          <span class="price">${iconHTML('coin', { size: 14 })} ${price}</span>
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
  const gold1El = document.getElementById('shop-gold1');
  if (gold1El) gold1El.textContent = String((player1 && !player1._phantom) ? player1.gold : 0);
  const gold2El = document.getElementById('shop-gold2');
  if (gold2El) gold2El.textContent = String((player2 && !player2._phantom) ? player2.gold : 0);

  const renderInv = (containerId, player) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    if (!player || player._phantom) return;

    // Ability
    const ah = document.createElement('h4');
    ah.textContent = 'Способность';
    el.appendChild(ah);
    const toggle = (ev) => ev.currentTarget.classList.toggle('open');

    if (player.ability) {
      const def = ABILITY_BY_ID[player.ability];
      if (def) {
        const d = document.createElement('div');
        d.className = 'inv-ability';
        const castKey = player.index === 0 ? 'G' : 'H';
        d.innerHTML = `<span class="inv-name"><span class="inv-ico" style="display:inline-flex;align-items:center;margin-right:6px;">${iconHTML(def.icon || 'sparkle', { size: 16 })}</span>${def.name} <kbd>${castKey}</kbd></span><div class="inv-desc">${def.desc}</div>`;
        d.addEventListener('click', toggle);
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
        d.innerHTML = `<span class="inv-name"><span class="inv-ico" style="display:inline-flex;align-items:center;margin-right:6px;">${iconHTML(def.icon || 'sparkle', { size: 16 })}</span>${def.name}${count > 1 ? ' ×' + count : ''}</span><div class="inv-desc">${def.desc || ''}</div>`;
        d.addEventListener('click', toggle);
        el.appendChild(d);
      }
    }
  };
  renderInv('shop-inv-1', player1);
  renderInv('shop-inv-2', player2);
}
