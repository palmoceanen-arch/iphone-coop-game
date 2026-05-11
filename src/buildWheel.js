// Build-wheel UI — radial recipe picker. One instance per player; opened
// by KeyB (P1) / KeyN (P2), or by tapping the build button on the mobile
// controller. Tapping a slice enters build mode for that recipe and
// closes the wheel; pressing the same hotkey again, Escape, or the
// number keys 1..N also work as quick paths.
//
// Hooks supplied by the game:
//   onPick(idx)      -> called with the chosen recipe index in RECIPE_ORDER;
//                       game.js then drives the BuildController.
//   onClose()        -> called on dismiss / pick.

import { RECIPES, RECIPE_ORDER } from './structure.js';

// Per-recipe emoji icon. Keep the set short — if a recipe is missing
// here the wheel just shows a neutral square and the recipe name still
// reads, so adding a recipe to RECIPE_ORDER without touching this file
// remains a no-op breakage.
const RECIPE_ICONS = {
  fence: '🪵',
  wall: '🧱',
  gate: '🚪',
  planter: '🪴',
  campfire: '🔥',
  torch: '🕯️',
  wood_wall: '🟫',
  glass_wall: '🪟',
  door_full: '🚪',
  floor_wood: '🟧',
  roof_corner: '🔺',
};

// Pretty-print the recipe cost as "N дерева · M камня" so the slice
// shows the affordability decision at a glance instead of forcing the
// player to memorise prices.
function fmtCost(cost) {
  const parts = [];
  for (const [k, v] of Object.entries(cost || {})) {
    const label = k === 'wood' ? 'дерева' : (k === 'stone' ? 'камня' : (k === 'seeds' ? 'семян' : k));
    parts.push(`${v} ${label}`);
  }
  return parts.join(' · ');
}

function ensureRoot(playerIdx) {
  const id = `build-wheel-p${playerIdx + 1}`;
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('div');
  el.id = id;
  el.className = `build-wheel p${playerIdx + 1}`;
  el.innerHTML = `
    <div class="ring" data-ring>
      <div class="ring-title"><b>${playerIdx === 0 ? 'Игрок 1' : 'Игрок 2'}</b><span>выбери постройку</span><div class="dim">Esc — закрыть</div></div>
    </div>
  `;
  document.getElementById('ui-root')?.appendChild(el);
  return el;
}

export class BuildWheel {
  constructor(playerIdx) {
    this.playerIdx = playerIdx;
    this.root = ensureRoot(playerIdx);
    this.ring = this.root.querySelector('[data-ring]');
    this.hooks = null;
    this.isOpen = false;
    this.world = null;            // set on open(), used to grey-out unaffordable
    this._slices = [];            // {kind, el, idx}
    this._selectedIdx = 0;
  }

  open(world, hooks) {
    this.world = world;
    this.hooks = hooks || {};
    this.isOpen = true;
    this._rebuildSlices();
    this._selectedIdx = 0;
    this.root.classList.add('open');
    // First refresh paints affordability now; subsequent refresh() calls
    // (driven by Game._refreshHUD's per-frame loop) keep it live as the
    // shared resource pool fluctuates.
    this.refresh();
  }

  handleGamepadNav(nav) {
    if (!this.isOpen || this._slices.length === 0) return false;
    if (nav.back) {
      this.close();
      return true;
    }
    if (nav.confirm) {
      this._pick(this._selectedIdx);
      return true;
    }
    if (nav.left || nav.up || nav.shoulderLeft) {
      this._select(this._selectedIdx - 1);
      return true;
    }
    if (nav.right || nav.down || nav.shoulderRight || nav.tab) {
      this._select(this._selectedIdx + 1);
      return true;
    }
    if (Math.hypot(nav.lookX, nav.lookZ) > 0.45) {
      const ang = Math.atan2(nav.lookZ, nav.lookX);
      const N = this._slices.length;
      const idx = Math.round((((ang + Math.PI / 2) / (Math.PI * 2)) * N + N)) % N;
      this._select(idx);
      return true;
    }
    return false;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.hooks?.onClose?.();
    this.hooks = null;
    this.world = null;
  }

  // Re-render the slices from RECIPE_ORDER. Slices are positioned around
  // a circle; first slice points up, then clockwise.
  _rebuildSlices() {
    // Clear previous slice elements (keep the title node).
    for (const s of this._slices) s.el.remove();
    this._slices = [];
    const N = RECIPE_ORDER.length;
    // Slice radius scales with recipe count so 6 recipes hug the centre
    // (compact picker) and 10+ recipes spread out toward the ring edge
    // (no overlapping slices). The ring itself is 360px wide so the
    // outer edge sits at ~155px from centre (180 - slice half-height).
    const radius = N <= 6 ? 110 : 145;
    for (let i = 0; i < N; i++) {
      const kind = RECIPE_ORDER[i];
      const recipe = RECIPES[kind];
      if (!recipe) continue;
      const ang = -Math.PI / 2 + (i / N) * Math.PI * 2;
      const x = Math.cos(ang) * radius;
      const y = Math.sin(ang) * radius;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'slice';
      el.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px))`;
      const icon = RECIPE_ICONS[kind] || '▢';
      el.innerHTML = `
        <span class="ic" aria-hidden="true">${icon}</span>
        <span class="nm">${recipe.name}</span>
        <span class="ct">${fmtCost(recipe.cost)}</span>
      `;
      el.addEventListener('click', () => this._pick(i));
      this.ring.appendChild(el);
      this._slices.push({ kind, el, idx: i });
    }
    this._refreshSelection();
  }

  // Live affordability refresh. Cheap: just toggles a class per slice.
  refresh() {
    if (!this.isOpen || !this.world) return;
    const res = this.world.resources || {};
    for (const s of this._slices) {
      const cost = RECIPES[s.kind]?.cost || {};
      let ok = true;
      for (const [k, v] of Object.entries(cost)) {
        const haveKey = (k === 'seed') ? 'seeds' : k;
        if ((res[haveKey] || 0) < v) { ok = false; break; }
      }
      s.el.classList.toggle('unaffordable', !ok);
    }
  }

  _pick(idx) {
    const cb = this.hooks?.onPick;
    this.close();
    cb?.(idx);
  }

  _select(idx) {
    const N = this._slices.length;
    if (N === 0) return;
    this._selectedIdx = ((idx % N) + N) % N;
    this._refreshSelection();
  }

  _refreshSelection() {
    for (const s of this._slices) {
      s.el.classList.toggle('gp-focus', s.idx === this._selectedIdx);
    }
  }
}
