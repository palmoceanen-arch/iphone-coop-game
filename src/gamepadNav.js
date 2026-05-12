const BUTTON = {
  tab: 3,
  shoulderLeft: 4,
  shoulderRight: 5,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
};

function nintendoLike(pad) {
  const id = (pad?.id || '').toLowerCase();
  return id.includes('nintendo') || id.includes('switch') ||
    id.includes('pro controller') || id.includes('joy-con');
}

function uiButtons(pad) {
  return nintendoLike(pad)
    ? { confirm: [1], back: [0] }
    : { confirm: [0], back: [1] };
}

function buttonDown(pad, idx) {
  const b = pad?.buttons?.[idx];
  return !!b && (b.pressed || b.value > 0.5);
}

function axisDir(v) {
  return v < -0.55 ? -1 : (v > 0.55 ? 1 : 0);
}

function hatDir(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || Math.abs(v) < 0.05) return { x: 0, y: 0 };
  const states = [
    { v: -1.000, x: 0, y: -1 },
    { v: -0.714, x: 1, y: -1 },
    { v: -0.428, x: 1, y: 0 },
    { v: -0.143, x: 1, y: 1 },
    { v: 0.143, x: 0, y: 1 },
    { v: 0.429, x: -1, y: 1 },
    { v: 0.714, x: -1, y: 0 },
    { v: 1.000, x: -1, y: -1 },
  ];
  let best = states[0];
  let bestD = Infinity;
  for (const s of states) {
    const d = Math.abs(v - s.v);
    if (d < bestD) { best = s; bestD = d; }
  }
  return bestD <= 0.12 ? { x: best.x, y: best.y } : { x: 0, y: 0 };
}

function extraAxisDir(pad) {
  let x = 0, y = 0;
  for (let i = 2; i < pad.axes.length; i++) {
    const h = hatDir(pad.axes[i]);
    if (h.x || h.y) { x = h.x; y = h.y; break; }
  }
  for (let i = 2; i + 1 < pad.axes.length; i += 2) {
    const dx = axisDir(pad.axes[i]);
    const dy = axisDir(pad.axes[i + 1]);
    if (dx || dy) { x = dx || x; y = dy || y; break; }
  }
  return { x, y };
}

// Hold-to-repeat parameters for directional inputs. Standard practice: a
// long-ish initial delay so a quick tap doesn't auto-repeat (the user
// just wanted to move once), then a short interval so holding the stick
// or D-pad zips through long lists (13 colour swatches, weapon grid).
// Confirm / back / shoulders / tab are edge-only — holding A to spam
// confirm is virtually never what the user wants in a menu.
const REPEAT_DELAY = 0.32;       // seconds before the first repeat fires
const REPEAT_INTERVAL = 0.085;   // seconds between successive repeats

export function createGamepadNavState() {
  return {
    buttons: new Set(),
    axisX: 0, axisY: 0, extraX: 0, extraY: 0,
    // Per-direction hold time (seconds since the direction was first
    // pressed). 0 means the direction is not currently held. Repeat
    // firing kicks in once a direction's hold exceeds `REPEAT_DELAY`.
    holds: { up: 0, down: 0, left: 0, right: 0, shoulderLeft: 0, shoulderRight: 0 },
    // Wall-clock of the most recent fire for each direction — used to
    // throttle repeats to one every `REPEAT_INTERVAL`.
    fires: { up: 0, down: 0, left: 0, right: 0, shoulderLeft: 0, shoulderRight: 0 },
    // Wall-clock of the previous read; the delta drives `holds` so the
    // repeat cadence is frame-rate independent.
    _lastT: 0,
  };
}

// Core per-pad nav reader. Mutates `state` for edge bookkeeping and
// returns a nav object with edge/repeat-fire flags. Used by both
// `readFirstGamepadNav` (single pad, no repeat — legacy callers) and
// `readGamepadNavSlot` (specific slot, repeat enabled — new callers).
function _readPadNav(pad, state, opts = {}) {
  const repeat = opts.repeat !== false;
  const buttons = new Set();
  for (let i = 0; i < pad.buttons.length; i++) {
    if (buttonDown(pad, i)) buttons.add(i);
  }
  const prevButtons = state.buttons;
  const edge = (idx) => buttons.has(idx) && !prevButtons.has(idx);
  const edgeAny = (idxs) => idxs.some((idx) => edge(idx));
  const x = pad.axes[0] || 0;
  const y = pad.axes[1] || 0;
  const extra = extraAxisDir(pad);
  const dirX = axisDir(x);
  const dirY = axisDir(y);
  const prevX = axisDir(state.axisX);
  const prevY = axisDir(state.axisY);
  const prevExtraX = axisDir(state.extraX);
  const prevExtraY = axisDir(state.extraY);
  const face = uiButtons(pad);

  // Combined "is the direction currently held in any input axis" for
  // each cardinal. Used both for the edge check (vs prev state) and as
  // input to the hold-to-repeat tracker below. Mirrors the legacy
  // OR of D-pad button + stick axis + secondary axis/hat.
  const heldUp = buttons.has(BUTTON.dpadUp) || dirY < 0 || extra.y < 0;
  const heldDown = buttons.has(BUTTON.dpadDown) || dirY > 0 || extra.y > 0;
  const heldLeft = buttons.has(BUTTON.dpadLeft) || dirX < 0 || extra.x < 0;
  const heldRight = buttons.has(BUTTON.dpadRight) || dirX > 0 || extra.x > 0;
  const heldSL = buttons.has(BUTTON.shoulderLeft);
  const heldSR = buttons.has(BUTTON.shoulderRight);

  const nowSec = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
  const dt = state._lastT > 0 ? Math.max(0, Math.min(0.1, nowSec - state._lastT)) : 0;
  state._lastT = nowSec;

  // Compute a "fire" event for a direction. Fires on the leading edge
  // (transition from released -> pressed) and, if `repeat` is enabled,
  // again every `REPEAT_INTERVAL` once the hold time exceeds
  // `REPEAT_DELAY`. Without repeat, behaviour matches the legacy
  // edge-only semantics.
  const fireDir = (key, held) => {
    if (!held) {
      state.holds[key] = 0;
      state.fires[key] = 0;
      return false;
    }
    if (state.holds[key] <= 0) {
      state.holds[key] = Math.max(dt, 0.001);
      state.fires[key] = nowSec;
      return true;
    }
    state.holds[key] += dt;
    if (repeat && state.holds[key] >= REPEAT_DELAY && nowSec - state.fires[key] >= REPEAT_INTERVAL) {
      state.fires[key] = nowSec;
      return true;
    }
    return false;
  };

  // Edge-only for directions (used by `readFirstGamepadNav` for legacy
  // semantics, kept identical to the pre-refactor behaviour so pause /
  // start-menu legacy paths don't change). The hold/repeat path uses
  // fireDir() above which OR's into the edge case automatically.
  const edgeUp = edge(BUTTON.dpadUp) || (dirY < 0 && prevY >= 0) || (extra.y < 0 && prevExtraY >= 0);
  const edgeDown = edge(BUTTON.dpadDown) || (dirY > 0 && prevY <= 0) || (extra.y > 0 && prevExtraY <= 0);
  const edgeLeft = edge(BUTTON.dpadLeft) || (dirX < 0 && prevX >= 0) || (extra.x < 0 && prevExtraX >= 0);
  const edgeRight = edge(BUTTON.dpadRight) || (dirX > 0 && prevX <= 0) || (extra.x > 0 && prevExtraX <= 0);

  const nav = repeat ? {
    up: fireDir('up', heldUp),
    down: fireDir('down', heldDown),
    left: fireDir('left', heldLeft),
    right: fireDir('right', heldRight),
    shoulderLeft: fireDir('shoulderLeft', heldSL) || edge(BUTTON.shoulderLeft),
    shoulderRight: fireDir('shoulderRight', heldSR) || edge(BUTTON.shoulderRight),
    confirm: edgeAny(face.confirm),
    back: edgeAny(face.back),
    tab: edge(BUTTON.tab),
    connected: true,
  } : {
    up: edgeUp,
    down: edgeDown,
    left: edgeLeft,
    right: edgeRight,
    confirm: edgeAny(face.confirm),
    back: edgeAny(face.back),
    tab: edge(BUTTON.tab),
    shoulderLeft: edge(BUTTON.shoulderLeft),
    shoulderRight: edge(BUTTON.shoulderRight),
    connected: true,
  };
  nav.any = nav.up || nav.down || nav.left || nav.right || nav.confirm || nav.back || nav.tab ||
    nav.shoulderLeft || nav.shoulderRight;
  state.buttons = buttons;
  state.axisX = x;
  state.axisY = y;
  state.extraX = extra.x;
  state.extraY = extra.y;
  updateGamepadDebug(pad, buttons, nav);
  return nav;
}

// Legacy entry point: polls the *first* connected pad with edge-only
// semantics (no hold-to-repeat). Kept stable so existing call-sites in
// pause.js and other menus don't change behaviour.
export function readFirstGamepadNav(state) {
  if (!navigator.getGamepads) return null;
  const pad = [...navigator.getGamepads()].find((p) => p && p.connected);
  if (!pad) return null;
  return _readPadNav(pad, state, { repeat: false });
}

// New entry point: polls a *specific* gamepad slot (0..3) with hold-to-
// repeat applied to direction inputs by default. Returns null if the
// slot is empty / disconnected. Each slot needs its own state object
// (see `createGamepadNavState`) so edge / hold timers don't bleed
// between pads.
export function readGamepadNavSlot(state, slot, opts = { repeat: true }) {
  if (!navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  const pad = pads && pads[slot];
  if (!pad || !pad.connected) {
    // Reset state so a disconnect-then-reconnect doesn't fire a phantom
    // edge on the first frame after reconnection.
    state.buttons = new Set();
    state.axisX = 0; state.axisY = 0; state.extraX = 0; state.extraY = 0;
    state.holds.up = 0; state.holds.down = 0; state.holds.left = 0; state.holds.right = 0;
    state.holds.shoulderLeft = 0; state.holds.shoulderRight = 0;
    state.fires.up = 0; state.fires.down = 0; state.fires.left = 0; state.fires.right = 0;
    state.fires.shoulderLeft = 0; state.fires.shoulderRight = 0;
    state._lastT = 0;
    return null;
  }
  return _readPadNav(pad, state, opts);
}

// Returns the indices of all connected pads, in slot order. Used by
// menus that want to fan out polling across every connected gamepad
// (e.g. the start menu's per-slot character picker).
export function listConnectedGamepadSlots() {
  if (!navigator.getGamepads) return [];
  const pads = navigator.getGamepads();
  const out = [];
  for (let i = 0; i < pads.length; i++) {
    if (pads[i] && pads[i].connected) out.push(i);
  }
  return out;
}

function updateGamepadDebug(pad, buttons, nav) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('gpdebug')) return;
  let el = document.getElementById('gp-debug');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gp-debug';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-width:560px;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.78);color:#fff;font:12px ui-monospace,monospace;white-space:pre-wrap;pointer-events:none;';
    document.body.appendChild(el);
  }
  const pressed = [...buttons].join(',') || 'none';
  const axes = pad.axes.map((a, i) => `${i}:${a.toFixed(3)}`).join(' ');
  el.textContent = `gamepad: ${pad.id}\nmapping: ${pad.mapping || 'none'} · profile: ${nintendoLike(pad) ? 'nintendo/8bitdo' : 'standard'}\npressed: ${pressed}\naxes: ${axes}\nnav: ${Object.entries(nav).filter(([, v]) => v === true).map(([k]) => k).join(',') || 'none'}`;
}
