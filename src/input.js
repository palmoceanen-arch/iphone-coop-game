// Two-player local input. Reads keys (and optional remote/touch state) and
// exposes per-player intent each frame.
const P1_KEYS = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  attack: ['KeyF'], dash: ['KeyR'], interact: ['KeyE'],
  // Build-mode recipe slots 1..4 (entering build mode with that recipe, or
  // toggling off if the same one is already active). Stays out of the swing
  // / dash key set so it doesn't conflict with combat.
  // The first 4 RECIPE_ORDER entries get number-key fast-paths; everything
  // beyond that is reachable only through the build-wheel UI (KeyB / KeyN)
  // because there are only so many comfortable digits in either hand.
  build: ['Digit1', 'Digit2', 'Digit3', 'Digit4'],
  // Open the build-wheel picker. Sits next to E (interact) on the
  // left-hand cluster so opening the menu while moving feels natural.
  buildMenu: ['KeyB'],
  // Cycle the player's "selected crop kind" used when planting a seed in a
  // tilled planter (M3 farming). Out of the WASD/F/R/E cluster so the
  // movement+combat reach stays uncluttered.
  seedCycle: ['KeyQ'],
};
const P2_KEYS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  attack: ['KeyL', 'Slash'], dash: ['KeyK', 'ShiftRight'], interact: ['KeyJ', 'Period'],
  // Right-hand digits 7..0 mirror the same 4-recipe catalog for player 2.
  build: ['Digit7', 'Digit8', 'Digit9', 'Digit0'],
  // N sits one row below J/K/L in the right-hand cluster, mirroring P1's
  // KeyB. Was KeyM until M was claimed for the minimap toggle UI; KeyN
  // is the next-best ergonomic neighbour and is unused by every other
  // system (combat / build / pause / minimap).
  buildMenu: ['KeyN'],
  // U is unbound by every existing system (combat / build / pause) and sits
  // in P2's right-hand cluster next to J/K/L, mirroring P1's Q.
  seedCycle: ['KeyU'],
};

const GAMEPAD_DEAD_ZONE = 0.18;
const GAMEPAD_BUTTON = {
  seedCycle: 4,    // LB / L1
  ability: 5,      // RB / R1
  buildLayerDown: 6, // LT / L2
  buildLayerUp: 7,   // RT / R2
  shop: 8,         // Back / View / Select
  pause: 9,        // Start / Menu
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

function faceButtons(pad) {
  return nintendoLike(pad)
    ? { attack: 1, dash: 0, interact: 3, buildMenu: 2 }
    : { attack: 0, dash: 1, interact: 2, buildMenu: 3 };
}

function blankGamepadSlot() {
  return {
    index: null,
    id: '',
    moveX: 0,
    moveZ: 0,
    lookX: 0,
    lookZ: 0,
    attackHeld: false,
    dashHeld: false,
    interactHeld: false,
    seedCycleHeld: false,
    attackEdge: false,
    dashEdge: false,
    interactEdge: false,
    buildMenuEdge: false,
    seedCycleEdge: false,
    abilityEdge: false,
    shopEdge: false,
    pauseEdge: false,
    buildLayerUpEdge: false,
    buildLayerDownEdge: false,
    navUpEdge: false,
    navDownEdge: false,
    navLeftEdge: false,
    navRightEdge: false,
    buttonsDown: new Set(),
  };
}

function buttonDown(pad, idx) {
  const b = pad.buttons[idx];
  return !!b && (b.pressed || b.value > 0.5);
}

function stickAxis(value) {
  const v = Number(value) || 0;
  return Math.abs(v) < GAMEPAD_DEAD_ZONE ? 0 : Math.max(-1, Math.min(1, v));
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

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set(); // edge-triggered, cleared after consume
    this.consumedThisFrame = new Set();
    // Remote (mobile) state per slot. Each entry: { moveX, moveZ, attackHeld, dashHeld }
    // Edge events (attack/dash) come through pressed flags below, set true once and consumed by .intent().
    this.remote = [
      { moveX: 0, moveZ: 0, attackHeld: false, dashHeld: false, attackEdge: false, dashEdge: false, interactEdge: false, buildMenuEdge: false },
      { moveX: 0, moveZ: 0, attackHeld: false, dashHeld: false, attackEdge: false, dashEdge: false, interactEdge: false, buildMenuEdge: false },
    ];
    this.gamepads = [blankGamepadSlot(), blankGamepadSlot()];
    this._onDown = (e) => {
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Tab'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    };
    this._onUp = (e) => { this.down.delete(e.code); };
    this._onBlur = () => { this.down.clear(); this.pressed.clear(); };
    this._onGamepadConnected = () => this.pollGamepads();
    this._onGamepadDisconnected = (e) => this._releaseGamepad(e.gamepad?.index);
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }

  destroy() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }

  setRemoteState(slot, state) {
    if (slot < 0 || slot > 1) return;
    const r = this.remote[slot];
    if (typeof state.moveX === 'number') r.moveX = Math.max(-1, Math.min(1, state.moveX));
    if (typeof state.moveZ === 'number') r.moveZ = Math.max(-1, Math.min(1, state.moveZ));
    if (typeof state.attack === 'boolean') r.attackHeld = state.attack;
    if (typeof state.dash === 'boolean') r.dashHeld = state.dash;
  }

  remoteEvent(slot, type) {
    if (slot < 0 || slot > 1) return;
    const r = this.remote[slot];
    if (type === 'attack') r.attackEdge = true;
    else if (type === 'dash') r.dashEdge = true;
    else if (type === 'interact') r.interactEdge = true;
    else if (type === 'buildMenu') r.buildMenuEdge = true;
  }

  anyDown(codes) { for (const c of codes) if (this.down.has(c)) return true; return false; }
  consumePressed(codes) {
    for (const c of codes) {
      if (this.pressed.has(c)) { this.pressed.delete(c); return true; }
    }
    return false;
  }

  pollGamepads() {
    if (!navigator.getGamepads) return;
    const pads = [...navigator.getGamepads()].filter((pad) => pad && pad.connected);
    const byIndex = new Map(pads.map((pad) => [pad.index, pad]));

    for (let slot = 0; slot < this.gamepads.length; slot++) {
      const gp = this.gamepads[slot];
      if (gp.index !== null && !byIndex.has(gp.index)) this._clearGamepadSlot(slot);
    }

    const used = new Set(this.gamepads.map((gp) => gp.index).filter((idx) => idx !== null));
    for (const pad of pads) {
      if (used.has(pad.index)) continue;
      const slot = this.gamepads.findIndex((gp) => gp.index === null);
      if (slot < 0) break;
      this.gamepads[slot].index = pad.index;
      this.gamepads[slot].id = pad.id || `Gamepad ${pad.index + 1}`;
      used.add(pad.index);
    }

    for (const gp of this.gamepads) {
      if (gp.index === null) continue;
      const pad = byIndex.get(gp.index);
      if (!pad) continue;
      this._readGamepad(gp, pad);
    }
  }

  _readGamepad(gp, pad) {
    const buttonsNow = new Set();
    for (let i = 0; i < pad.buttons.length; i++) {
      if (buttonDown(pad, i)) buttonsNow.add(i);
    }
    const edge = (idx) => buttonsNow.has(idx) && !gp.buttonsDown.has(idx);
    const face = faceButtons(pad);

    const sx = stickAxis(pad.axes[0]);
    const sz = stickAxis(pad.axes[1]);
    gp.lookX = stickAxis(pad.axes[2]);
    gp.lookZ = stickAxis(pad.axes[3]);
    const dx = (buttonDown(pad, GAMEPAD_BUTTON.dpadRight) ? 1 : 0) -
      (buttonDown(pad, GAMEPAD_BUTTON.dpadLeft) ? 1 : 0);
    const dz = (buttonDown(pad, GAMEPAD_BUTTON.dpadDown) ? 1 : 0) -
      (buttonDown(pad, GAMEPAD_BUTTON.dpadUp) ? 1 : 0);
    gp.moveX = Math.abs(dx) > Math.abs(sx) ? dx : sx;
    gp.moveZ = Math.abs(dz) > Math.abs(sz) ? dz : sz;

    gp.attackHeld = buttonDown(pad, face.attack);
    gp.dashHeld = buttonDown(pad, face.dash);
    gp.interactHeld = buttonDown(pad, face.interact);
    gp.seedCycleHeld = buttonDown(pad, GAMEPAD_BUTTON.seedCycle);

    if (edge(face.attack)) gp.attackEdge = true;
    if (edge(face.dash)) gp.dashEdge = true;
    if (edge(face.interact)) gp.interactEdge = true;
    if (edge(face.buildMenu)) gp.buildMenuEdge = true;
    if (edge(GAMEPAD_BUTTON.seedCycle)) gp.seedCycleEdge = true;
    if (edge(GAMEPAD_BUTTON.ability)) gp.abilityEdge = true;
    if (edge(GAMEPAD_BUTTON.shop)) gp.shopEdge = true;
    if (edge(GAMEPAD_BUTTON.pause)) gp.pauseEdge = true;
    if (edge(GAMEPAD_BUTTON.buildLayerUp)) gp.buildLayerUpEdge = true;
    if (edge(GAMEPAD_BUTTON.buildLayerDown)) gp.buildLayerDownEdge = true;
    const leftX = pad.axes[0] || 0;
    const leftY = pad.axes[1] || 0;
    const extra = extraAxisDir(pad);
    const leftDirX = axisDir(leftX);
    const leftDirY = axisDir(leftY);
    const prevLeftDirX = axisDir(gp._lastLeftX);
    const prevLeftDirY = axisDir(gp._lastLeftY);
    const prevExtraX = axisDir(gp._lastExtraX);
    const prevExtraY = axisDir(gp._lastExtraY);
    if (edge(GAMEPAD_BUTTON.dpadUp) || (leftDirY < 0 && prevLeftDirY >= 0) || (extra.y < 0 && prevExtraY >= 0)) gp.navUpEdge = true;
    if (edge(GAMEPAD_BUTTON.dpadDown) || (leftDirY > 0 && prevLeftDirY <= 0) || (extra.y > 0 && prevExtraY <= 0)) gp.navDownEdge = true;
    if (edge(GAMEPAD_BUTTON.dpadLeft) || (leftDirX < 0 && prevLeftDirX >= 0) || (extra.x < 0 && prevExtraX >= 0)) gp.navLeftEdge = true;
    if (edge(GAMEPAD_BUTTON.dpadRight) || (leftDirX > 0 && prevLeftDirX <= 0) || (extra.x > 0 && prevExtraX <= 0)) gp.navRightEdge = true;
    gp._lastLeftX = leftX;
    gp._lastLeftY = leftY;
    gp._lastExtraX = extra.x;
    gp._lastExtraY = extra.y;

    gp.buttonsDown = buttonsNow;
  }

  _clearGamepadSlot(slot) {
    this.gamepads[slot] = blankGamepadSlot();
  }

  _releaseGamepad(index) {
    for (let slot = 0; slot < this.gamepads.length; slot++) {
      if (this.gamepads[slot].index === index) this._clearGamepadSlot(slot);
    }
  }

  _consumeGamepadEdge(slot, prop) {
    if (slot < 0 || slot > 1) return false;
    const gp = this.gamepads[slot];
    const value = !!gp[prop];
    gp[prop] = false;
    return value;
  }

  consumeGamepadPause() {
    for (let slot = 0; slot < this.gamepads.length; slot++) {
      if (this._consumeGamepadEdge(slot, 'pauseEdge')) return true;
    }
    return false;
  }

  consumeGamepadShop(slot) {
    return this._consumeGamepadEdge(slot, 'shopEdge');
  }

  consumeGamepadAbility(slot) {
    return this._consumeGamepadEdge(slot, 'abilityEdge');
  }

  consumeGamepadUpgrade(slot) {
    const edges = ['attackEdge', 'dashEdge', 'interactEdge', 'buildMenuEdge'];
    for (let i = 0; i < edges.length; i++) {
      if (this._consumeGamepadEdge(slot, edges[i])) return i;
    }
    return -1;
  }

  consumeGamepadNav(slot) {
    const gp = this.gamepads[slot];
    const nav = {
      up: this._consumeGamepadEdge(slot, 'navUpEdge'),
      down: this._consumeGamepadEdge(slot, 'navDownEdge'),
      left: this._consumeGamepadEdge(slot, 'navLeftEdge'),
      right: this._consumeGamepadEdge(slot, 'navRightEdge'),
      confirm: this._consumeGamepadEdge(slot, 'attackEdge'),
      back: this._consumeGamepadEdge(slot, 'dashEdge'),
      tab: this._consumeGamepadEdge(slot, 'buildMenuEdge'),
      shoulderLeft: this._consumeGamepadEdge(slot, 'seedCycleEdge'),
      shoulderRight: this._consumeGamepadEdge(slot, 'abilityEdge'),
      lookX: gp.lookX,
      lookZ: gp.lookZ,
      connected: gp.index !== null,
    };
    nav.any = nav.up || nav.down || nav.left || nav.right || nav.confirm || nav.back || nav.tab ||
      nav.shoulderLeft || nav.shoulderRight || Math.hypot(nav.lookX, nav.lookZ) > 0.45;
    return nav;
  }

  intent(playerIndex) {
    const map = playerIndex === 0 ? P1_KEYS : P2_KEYS;
    const r = this.remote[playerIndex];
    const g = this.gamepads[playerIndex];
    let mx = 0, mz = 0;
    if (this.anyDown(map.up)) mz -= 1;
    if (this.anyDown(map.down)) mz += 1;
    if (this.anyDown(map.left)) mx -= 1;
    if (this.anyDown(map.right)) mx += 1;
    // Mobile stick adds/overrides; if magnitude > keyboard, use mobile.
    if (Math.abs(r.moveX) > Math.abs(mx)) mx = r.moveX;
    if (Math.abs(r.moveZ) > Math.abs(mz)) mz = r.moveZ;
    if (Math.abs(g.moveX) > Math.abs(mx)) mx = g.moveX;
    if (Math.abs(g.moveZ) > Math.abs(mz)) mz = g.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }

    const attackPressed = this.consumePressed(map.attack);
    const dashPressed = this.consumePressed(map.dash);
    const remoteAttackEdge = r.attackEdge; r.attackEdge = false;
    const remoteDashEdge = r.dashEdge; r.dashEdge = false;
    const remoteInteractEdge = r.interactEdge; r.interactEdge = false;
    const remoteBuildMenuEdge = r.buildMenuEdge; r.buildMenuEdge = false;
    const gamepadAttackEdge = g.attackEdge; g.attackEdge = false;
    const gamepadDashEdge = g.dashEdge; g.dashEdge = false;
    const gamepadInteractEdge = g.interactEdge; g.interactEdge = false;
    const gamepadBuildMenuEdge = g.buildMenuEdge; g.buildMenuEdge = false;
    const gamepadSeedCycleEdge = g.seedCycleEdge; g.seedCycleEdge = false;
    const gamepadBuildLayerUpEdge = g.buildLayerUpEdge; g.buildLayerUpEdge = false;
    const gamepadBuildLayerDownEdge = g.buildLayerDownEdge; g.buildLayerDownEdge = false;
    // Build-mode recipe select: returns 0..3 for the slot pressed this
    // frame, or -1 if no recipe key was hit. Each slot is a single keycode
    // so we can't piggy-back consumePressed (which dedupes the first match
    // across an array of synonymous keys).
    let buildSelect = -1;
    for (let i = 0; i < map.build.length; i++) {
      if (this.consumePressed([map.build[i]])) { buildSelect = i; break; }
    }
    const seedCycle = this.consumePressed(map.seedCycle);
    const buildMenu = this.consumePressed(map.buildMenu) || remoteBuildMenuEdge;
    // Build-mode vertical layer nudge: Shift = up, Ctrl = down. Modifier
    // keys aren't naturally per-player, so both intents read the same
    // global edges — first .intent() call this frame consumes them.
    // PageUp / PageDown are aliased so the layer nudge still works
    // when the player has remapped Shift to a controller / on touch
    // devices that don't expose Ctrl.
    const buildLayerUp = this.consumePressed(['ShiftLeft', 'PageUp']) || gamepadBuildLayerUpEdge;
    const buildLayerDown = this.consumePressed(['ControlLeft', 'PageDown']) || gamepadBuildLayerDownEdge;

    return {
      moveX: mx,
      moveZ: mz,
      attack: attackPressed || remoteAttackEdge || gamepadAttackEdge,
      attackHeld: this.anyDown(map.attack) || r.attackHeld || g.attackHeld,
      dash: dashPressed || remoteDashEdge || gamepadDashEdge,
      dashHeld: this.anyDown(map.dash) || r.dashHeld || g.dashHeld,
      interact: this.consumePressed(map.interact) || remoteInteractEdge || gamepadInteractEdge,
      interactHeld: this.anyDown(map.interact) || g.interactHeld,
      buildSelect,
      buildMenu: buildMenu || gamepadBuildMenuEdge,
      seedCycle: seedCycle || gamepadSeedCycleEdge,
      seedCycleHeld: this.anyDown(map.seedCycle) || g.seedCycleHeld,
      buildLayerUp,
      buildLayerDown,
      gamepad: {
        connected: g.index !== null,
        moveX: g.moveX,
        moveZ: g.moveZ,
        lookX: g.lookX,
        lookZ: g.lookZ,
        attack: gamepadAttackEdge,
        dash: gamepadDashEdge,
        buildMenu: gamepadBuildMenuEdge,
      },
    };
  }

  consumeGlobal(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  endFrame() {
    this.pressed.clear();
    for (const gp of this.gamepads) {
      gp.attackEdge = false;
      gp.dashEdge = false;
      gp.interactEdge = false;
      gp.buildMenuEdge = false;
      gp.seedCycleEdge = false;
      gp.abilityEdge = false;
      gp.shopEdge = false;
      gp.pauseEdge = false;
      gp.buildLayerUpEdge = false;
      gp.buildLayerDownEdge = false;
      gp.navUpEdge = false;
      gp.navDownEdge = false;
      gp.navLeftEdge = false;
      gp.navRightEdge = false;
    }
  }
}
