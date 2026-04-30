// Two-player local input. Reads keys (and optional remote/touch state) and
// exposes per-player intent each frame.
const P1_KEYS = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  attack: ['KeyF'], dash: ['KeyR'], interact: ['KeyE'],
};
const P2_KEYS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  attack: ['KeyL', 'Slash'], dash: ['KeyK', 'ShiftRight'], interact: ['KeyJ', 'Period'],
};

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set(); // edge-triggered, cleared after consume
    this.consumedThisFrame = new Set();
    // Remote (mobile) state per slot. Each entry: { moveX, moveZ, attackHeld, dashHeld }
    // Edge events (attack/dash) come through pressed flags below, set true once and consumed by .intent().
    this.remote = [
      { moveX: 0, moveZ: 0, attackHeld: false, dashHeld: false, attackEdge: false, dashEdge: false },
      { moveX: 0, moveZ: 0, attackHeld: false, dashHeld: false, attackEdge: false, dashEdge: false },
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

    return {
      moveX: mx,
      moveZ: mz,
      attack: attackPressed || remoteAttackEdge,
      attackHeld: this.anyDown(map.attack) || r.attackHeld,
      dash: dashPressed || remoteDashEdge,
      interact: this.consumePressed(map.interact),
    };
  }

  consumeGlobal(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  endFrame() { this.pressed.clear(); }
}
