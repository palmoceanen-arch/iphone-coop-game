const BUTTON = {
  confirm: 0,
  back: 1,
  tab: 3,
  shoulderLeft: 4,
  shoulderRight: 5,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
};

function buttonDown(pad, idx) {
  const b = pad?.buttons?.[idx];
  return !!b && (b.pressed || b.value > 0.5);
}

function axisDir(v) {
  return v < -0.55 ? -1 : (v > 0.55 ? 1 : 0);
}

export function createGamepadNavState() {
  return { buttons: new Set(), axisX: 0, axisY: 0 };
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
  const x = pad.axes[0] || 0;
  const y = pad.axes[1] || 0;
  const dirX = axisDir(x);
  const dirY = axisDir(y);
  const prevX = axisDir(state.axisX);
  const prevY = axisDir(state.axisY);
  state.buttons = buttons;
  state.axisX = x;
  state.axisY = y;
  const nav = {
    up: edge(BUTTON.dpadUp) || (dirY < 0 && prevY >= 0),
    down: edge(BUTTON.dpadDown) || (dirY > 0 && prevY <= 0),
    left: edge(BUTTON.dpadLeft) || (dirX < 0 && prevX >= 0),
    right: edge(BUTTON.dpadRight) || (dirX > 0 && prevX <= 0),
    confirm: edge(BUTTON.confirm),
    back: edge(BUTTON.back),
    tab: edge(BUTTON.tab),
    shoulderLeft: edge(BUTTON.shoulderLeft),
    shoulderRight: edge(BUTTON.shoulderRight),
    connected: true,
  };
  nav.any = nav.up || nav.down || nav.left || nav.right || nav.confirm || nav.back || nav.tab ||
    nav.shoulderLeft || nav.shoulderRight;
  return nav;
}
