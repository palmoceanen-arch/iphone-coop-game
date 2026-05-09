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
    this._onDown = (e) => {
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Tab'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    };
    this._onUp = (e) => { this.down.delete(e.code); };
    this._onBlur = () => { this.down.clear(); this.pressed.clear(); };
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
  }

  destroy() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
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

  intent(playerIndex) {
    const map = playerIndex === 0 ? P1_KEYS : P2_KEYS;
    const r = this.remote[playerIndex];
    let mx = 0, mz = 0;
    if (this.anyDown(map.up)) mz -= 1;
    if (this.anyDown(map.down)) mz += 1;
    if (this.anyDown(map.left)) mx -= 1;
    if (this.anyDown(map.right)) mx += 1;
    // Mobile stick adds/overrides; if magnitude > keyboard, use mobile.
    if (Math.abs(r.moveX) > Math.abs(mx)) mx = r.moveX;
    if (Math.abs(r.moveZ) > Math.abs(mz)) mz = r.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }

    const attackPressed = this.consumePressed(map.attack);
    const dashPressed = this.consumePressed(map.dash);
    const remoteAttackEdge = r.attackEdge; r.attackEdge = false;
    const remoteDashEdge = r.dashEdge; r.dashEdge = false;
    const remoteInteractEdge = r.interactEdge; r.interactEdge = false;
    const remoteBuildMenuEdge = r.buildMenuEdge; r.buildMenuEdge = false;
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
    const buildLayerUp = this.consumePressed(['ShiftLeft', 'PageUp']);
    const buildLayerDown = this.consumePressed(['ControlLeft', 'PageDown']);

    return {
      moveX: mx,
      moveZ: mz,
      attack: attackPressed || remoteAttackEdge,
      attackHeld: this.anyDown(map.attack) || r.attackHeld,
      dash: dashPressed || remoteDashEdge,
      dashHeld: this.anyDown(map.dash) || r.dashHeld,
      interact: this.consumePressed(map.interact) || remoteInteractEdge,
      buildSelect,
      buildMenu,
      seedCycle,
      buildLayerUp,
      buildLayerDown,
    };
  }

  consumeGlobal(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  endFrame() { this.pressed.clear(); }
}
