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

export function createGamepadNavState() {
  return { buttons: new Set(), axisX: 0, axisY: 0, extraX: 0, extraY: 0 };
}

export function readFirstGamepadNav(state) {
  if (!navigator.getGamepads) return null;
  const pad = [...navigator.getGamepads()].find((p) => p && p.connected);
  if (!pad) return null;
  const buttons = new Set();
  for (let i = 0; i < pad.buttons.length; i++) {
    if (buttonDown(pad, i)) buttons.add(i);
  }
  const edge = (idx) => buttons.has(idx) && !state.buttons.has(idx);
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
  state.buttons = buttons;
  state.axisX = x;
  state.axisY = y;
  state.extraX = extra.x;
  state.extraY = extra.y;
  const nav = {
    up: edge(BUTTON.dpadUp) || (dirY < 0 && prevY >= 0) || (extra.y < 0 && prevExtraY >= 0),
    down: edge(BUTTON.dpadDown) || (dirY > 0 && prevY <= 0) || (extra.y > 0 && prevExtraY <= 0),
    left: edge(BUTTON.dpadLeft) || (dirX < 0 && prevX >= 0) || (extra.x < 0 && prevExtraX >= 0),
    right: edge(BUTTON.dpadRight) || (dirX > 0 && prevX <= 0) || (extra.x > 0 && prevExtraX <= 0),
    confirm: edgeAny(face.confirm),
    back: edgeAny(face.back),
    tab: edge(BUTTON.tab),
    shoulderLeft: edge(BUTTON.shoulderLeft),
    shoulderRight: edge(BUTTON.shoulderRight),
    connected: true,
  };
  nav.any = nav.up || nav.down || nav.left || nav.right || nav.confirm || nav.back || nav.tab ||
    nav.shoulderLeft || nav.shoulderRight;
  updateGamepadDebug(pad, buttons, nav);
  return nav;
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
