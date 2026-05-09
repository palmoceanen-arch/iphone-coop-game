// Phone controller button layout — defaults, persistence, and an in-place
// "edit mode" so the player can drag and resize each touch control to fit
// their hand without us guessing their grip blindly.
//
// Coordinates are stored in viewport percentages (0..100) for the centre
// of each element + a pixel size for square buttons (the joystick is
// also square). Percent-based positioning survives orientation changes
// and varying device sizes; we never write absolute pixel offsets.
//
// A button "id" here refers to the DOM id of the element on the page.
// When we apply a layout we write inline `left/top/transform/width/height`
// styles that override the static stylesheet positions in controller.html.

const STORAGE_KEY = 'controller_layout_v1';

// Default layout: joystick centred at the intersection of the leftmost
// quarter line and the screen midline; attack symmetrically on the right
// at the same Y so the hands work on the same horizontal axis. Dash sits
// above the attack, ability between attack and joystick (so the right
// thumb naturally reaches it without hopping), interact above ability,
// shop at the top centre.
export const LAYOUT_DEFAULTS = Object.freeze({
  stick:       { cx: 25, cy: 55, size: 168 },
  btnAttack:   { cx: 80, cy: 55, size: 92 },
  btnDash:     { cx: 82, cy: 28, size: 72 },
  btnAbility:  { cx: 64, cy: 60, size: 80 },
  btnInteract: { cx: 66, cy: 32, size: 68 },
  btnShop:     { cx: 50, cy: 8,  size: 52 },
});

// Editable button order — used by the edit-mode toolbar to walk through
// buttons sequentially when the player taps the "next" arrow.
export const EDITABLE_IDS = Object.freeze(Object.keys(LAYOUT_DEFAULTS));

// Minimum / maximum button sizes (px). Joystick is allowed bigger because
// it's the primary control surface.
export const SIZE_LIMITS = Object.freeze({
  stick: { min: 100, max: 240 },
  btnAttack: { min: 56, max: 140 },
  btnDash: { min: 48, max: 120 },
  btnAbility: { min: 52, max: 130 },
  btnInteract: { min: 48, max: 120 },
  btnShop: { min: 36, max: 90 },
});

// Friendly name for each editable button — shown in the edit-mode toolbar.
export const BUTTON_LABEL = Object.freeze({
  stick: 'Джойстик',
  btnAttack: 'Атака',
  btnDash: 'Рывок',
  btnAbility: 'Способность',
  btnInteract: 'Взять / открыть',
  btnShop: 'Магазин',
});

function clone(layout) {
  const out = {};
  for (const k of Object.keys(layout)) out[k] = { ...layout[k] };
  return out;
}

// Load layout from localStorage; missing keys fall back to defaults so
// adding a new button in code doesn't strand existing players.
export function loadLayout() {
  const out = clone(LAYOUT_DEFAULTS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    for (const k of Object.keys(out)) {
      const v = parsed[k];
      if (!v || typeof v !== 'object') continue;
      if (Number.isFinite(v.cx)) out[k].cx = clamp(v.cx, 2, 98);
      if (Number.isFinite(v.cy)) out[k].cy = clamp(v.cy, 2, 98);
      if (Number.isFinite(v.size)) {
        const lim = SIZE_LIMITS[k];
        out[k].size = clamp(v.size, lim ? lim.min : 32, lim ? lim.max : 320);
      }
    }
  } catch {
    /* fall through with defaults */
  }
  return out;
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* quota / private mode; ignore */
  }
}

export function clearLayout() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// Apply a layout to the live DOM. Inline styles override the .joystick
// and .action positions baked into controller.html. We anchor every
// element by its centre so the user's coordinate truly is the centre.
export function applyLayout(layout) {
  for (const id of EDITABLE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = layout[id] || LAYOUT_DEFAULTS[id];
    if (!v) continue;
    el.style.left = v.cx + '%';
    el.style.top = v.cy + '%';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'translate(-50%, -50%)';
    if (Number.isFinite(v.size)) {
      el.style.width = v.size + 'px';
      el.style.height = v.size + 'px';
    }
  }
}

// Reset DOM positions to whatever the static stylesheet had originally,
// for example when leaving edit mode after Cancel without saving.
export function clearAppliedLayout() {
  for (const id of EDITABLE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
