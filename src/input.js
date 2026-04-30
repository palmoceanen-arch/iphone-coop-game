// Two-player local input. Reads keys and exposes per-player intent each frame.
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
    this._onDown = (e) => {
      // Prevent page scroll for arrow / space / tab
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

  // anyDown(codes): is any in this list currently held
  anyDown(codes) { for (const c of codes) if (this.down.has(c)) return true; return false; }

  // consumePressed: returns true if any code was edge-pressed since last consume
  consumePressed(codes) {
    for (const c of codes) {
      if (this.pressed.has(c)) { this.pressed.delete(c); return true; }
    }
    return false;
  }

  // Returns intent for player index 0 (P1) or 1 (P2)
  intent(playerIndex) {
    const map = playerIndex === 0 ? P1_KEYS : P2_KEYS;
    let mx = 0, mz = 0;
    if (this.anyDown(map.up)) mz -= 1;
    if (this.anyDown(map.down)) mz += 1;
    if (this.anyDown(map.left)) mx -= 1;
    if (this.anyDown(map.right)) mx += 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    return {
      moveX: mx,
      moveZ: mz,
      attack: this.consumePressed(map.attack),
      attackHeld: this.anyDown(map.attack),
      dash: this.consumePressed(map.dash),
      interact: this.consumePressed(map.interact),
    };
  }

  // Global presses (shop, pause, restart)
  consumeGlobal(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  endFrame() { this.pressed.clear(); }
}
