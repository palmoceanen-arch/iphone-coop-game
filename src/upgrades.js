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

export function renderShop(player1, player2) {
  const rebuild = (containerId, player) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    UPGRADES.forEach((u, idx) => {
      const lvl = player.upgradeLevels[u.id] || 0;
      const price = priceFor(player, u);
      const can = player.gold >= price;
      const div = document.createElement('div');
      div.className = 'upg' + (can ? '' : ' locked');
      const playerKey = containerId.endsWith('-1') ? '1234' : '7890';
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
      el.appendChild(div);
    });
  };
  rebuild('shop-upgs-1', player1);
  rebuild('shop-upgs-2', player2);
  document.getElementById('shop-gold1').textContent = String(player1.gold);
  document.getElementById('shop-gold2').textContent = String(player2.gold);
}
