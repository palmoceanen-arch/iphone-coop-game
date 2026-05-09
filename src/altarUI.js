// Altar UI overlay — opens when a player presses interact next to an
// Altar. Lists the player's items, lets them pick one and choose an
// action (reroll / sacrifice / fuse). Each completed action consumes a
// charge on the altar; when the altar hits 0 charges the panel auto-
// closes.
//
// The panel is built dynamically once and reused. The host (game.js)
// calls open(player, altar, hooks) to show it and close() to hide it.
//
// Hooks supplied by the game:
//   onReroll(itemId)       -> attempts a reroll, returns true on success
//   onSacrifice(itemId)    -> burns one stack for gold
//   onFuse(itemId)         -> fuses 3 stacks into a higher-rarity item
//   onClose()              -> called by close button / Esc

import { ITEMS, ITEM_BY_ID, RARITY, MAX_STACKS } from './items.js';
import { iconHTML } from './icons.js';

const PANEL_ID = 'altar-panel';
const REROLL_COST = 80;

function fmtRarity(rarity) {
  return rarity === 'common' ? 'обычный'
       : rarity === 'uncommon' ? 'необычный'
       : rarity === 'rare' ? 'редкий'
       : rarity === 'legendary' ? 'легендарный'
       : rarity;
}

function ensurePanel() {
  let el = document.getElementById(PANEL_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = PANEL_ID;
  el.className = 'altar-overlay';
  el.innerHTML = `
    <div class="altar-panel">
      <header>
        <h2>Алтарь древних</h2>
        <div class="altar-meta">
          <span class="charges">Зарядов: <b data-altar-charges>3</b> / ${MAX_STACKS - 2}</span>
          <span class="gold">Золото: <b data-altar-gold>0</b></span>
          <button class="altar-close" data-altar-close>×</button>
        </div>
      </header>
      <p class="altar-help">
        Нажми на действие справа от предмета.<br>
        <b>Перековать</b> — заменит предмет на случайный другой такой же редкости (стоит ${REROLL_COST} золота).<br>
        <b>Сжечь</b> — превратит 1 стак в золото (зависит от редкости).<br>
        <b>Слить</b> — если у тебя 3+ одинаковых, превратит их в 1 случайный предмет более высокой редкости.
      </p>
      <div class="altar-items" data-altar-items></div>
      <footer class="altar-footer">
        <span class="altar-hint">Esc — закрыть</span>
      </footer>
    </div>
  `;
  document.getElementById('ui-root')?.appendChild(el);
  return el;
}

export class AltarUI {
  constructor() {
    this.root = ensurePanel();
    this.player = null;
    this.altar = null;
    this.hooks = null;
    this.isOpen = false;
    this.root.querySelector('[data-altar-close]')?.addEventListener('click', () => {
      this.close();
    });
  }

  open(player, altar, hooks) {
    this.player = player;
    this.altar = altar;
    this.hooks = hooks || {};
    this.isOpen = true;
    this.root.classList.add('open');
    this.refresh();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.hooks?.onClose?.();
    this.player = null;
    this.altar = null;
    this.hooks = null;
  }

  refresh() {
    if (!this.isOpen || !this.player || !this.altar) return;
    const chargesEl = this.root.querySelector('[data-altar-charges]');
    const goldEl = this.root.querySelector('[data-altar-gold]');
    if (chargesEl) chargesEl.textContent = String(this.altar.charges);
    if (goldEl) goldEl.textContent = String(this.player.gold);

    const itemsEl = this.root.querySelector('[data-altar-items]');
    if (!itemsEl) return;
    itemsEl.innerHTML = '';

    const entries = Object.entries(this.player.items || {})
      .map(([id, n]) => ({ id, n, def: ITEM_BY_ID[id] }))
      .filter(e => e.def && e.n > 0);
    entries.sort((a, b) => {
      const ra = ['common', 'uncommon', 'rare', 'legendary'].indexOf(a.def.rarity);
      const rb = ['common', 'uncommon', 'rare', 'legendary'].indexOf(b.def.rarity);
      if (ra !== rb) return ra - rb;
      return a.def.name.localeCompare(b.def.name, 'ru');
    });

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'altar-empty';
      empty.textContent = 'У тебя пока нет предметов. Найди их в сундуках, у элиток или из ящиков.';
      itemsEl.appendChild(empty);
      return;
    }

    for (const { id, n, def } of entries) {
      const row = document.createElement('div');
      row.className = `altar-row rar-${def.rarity}`;

      const sacrificeGold = RARITY[def.rarity]?.sacrificeGold || 0;
      const canReroll = this.altar.charges > 0 && this.player.gold >= REROLL_COST;
      const canSacrifice = this.altar.charges > 0;
      const canFuse = this.altar.charges > 0 && n >= 3 && def.rarity !== 'legendary';

      row.innerHTML = `
        <span class="altar-icon" style="color:#${RARITY[def.rarity].color.toString(16).padStart(6, '0')}">${iconHTML(def.icon || 'sparkle', { size: 22 })}</span>
        <div class="altar-info">
          <div class="altar-name">${def.name} <span class="altar-count">×${n}/${def.maxStacks ?? MAX_STACKS}</span></div>
          <div class="altar-desc">${fmtRarity(def.rarity)} · ${def.desc || ''}</div>
        </div>
        <div class="altar-actions">
          <button data-action="reroll" ${canReroll ? '' : 'disabled'}>Перековать <span class="cost">${REROLL_COST}з</span></button>
          <button data-action="sacrifice" ${canSacrifice ? '' : 'disabled'}>Сжечь <span class="cost">+${sacrificeGold}з</span></button>
          <button data-action="fuse" ${canFuse ? '' : 'disabled'} title="${def.rarity === 'legendary' ? 'Легендарные нельзя слить' : 'Нужно 3+ стака'}">Слить <span class="cost">3 → 1</span></button>
        </div>
      `;
      row.querySelector('[data-action="reroll"]').addEventListener('click', () => {
        if (this.hooks?.onReroll?.(id)) this.refresh();
      });
      row.querySelector('[data-action="sacrifice"]').addEventListener('click', () => {
        if (this.hooks?.onSacrifice?.(id)) this.refresh();
      });
      row.querySelector('[data-action="fuse"]').addEventListener('click', () => {
        if (this.hooks?.onFuse?.(id)) this.refresh();
      });
      itemsEl.appendChild(row);
    }
  }
}

// Export so callers can preload (forces ITEMS evaluation early in tooling)
export const _ITEMS_REF = ITEMS;
