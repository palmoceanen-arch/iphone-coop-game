// Promo / screenshot mode. Enables a free-fly camera, hides the HUD,
// gives the player full control over time-of-day + FOV, freezes the
// simulation, and exposes a "render now at N×M and download PNG"
// button — the goal is to make clean game stills suitable for the
// Yandex Games icon (512×512), cover (800×800), and screenshot gallery
// (1920×1080) without any UI elements or running enemies in frame.
//
// Activated only when `?promo=1` is in the URL — never reachable in a
// normal player session, so production builds incur zero overhead.
import * as THREE from 'three';

// Pre-canned resolutions the promo panel exposes as one-tap buttons.
// Yandex Games asks for 512×512 (icon), the cover is typically 800×800
// or 16:9, and screenshots want 1280×720 / 1920×1080. We don't render
// at the on-screen size for these because the user's window probably
// isn't 1920×1080 anyway and that would force them to maximise just
// to capture a wide cover.
const RES_PRESETS = [
  { w: 512, h: 512, label: '512² icon' },
  { w: 800, h: 800, label: '800² cover' },
  { w: 1024, h: 1024, label: '1024² icon' },
  { w: 1280, h: 720, label: '1280×720 16:9' },
  { w: 1920, h: 1080, label: '1920×1080 16:9' },
];

export class PromoMode {
  constructor(game) {
    this.game = game;
    this.active = false;

    // Free-fly camera state. Initialised on enable() to the current
    // FollowCamera pose so the world doesn't pop on entry.
    this.pos = new THREE.Vector3(0, 14, 18);
    this.yaw = 0;     // around Y
    this.pitch = -0.4; // looking slightly down by default
    this.fov = 55;
    this.flySpeed = 14;        // m/s with W/A/S/D
    this.flySpeedBoost = 36;   // m/s while Shift held
    this.lookSpeedMouse = 0.0025; // rad per pixel

    // Frame-local input state.
    this._keys = new Set();
    this._pointerLocked = false;
    this._lastT = performance.now();

    // DOM bits.
    this._panel = null;
    this._badge = null;
    this._hideStyle = null;

    // Bound handlers for clean remove.
    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onClick = (e) => this._handlePointerLock(e);
    this._onWheel = (e) => this._handleWheel(e);
    this._onPointerLockChange = () => {
      this._pointerLocked = document.pointerLockElement === this.game.canvas;
    };
  }

  enable() {
    if (this.active) return;
    this.active = true;
    this.game._promoActive = true;

    // Seed our free-fly pose from the current FollowCamera so the
    // transition is invisible. We approximate yaw/pitch from the cam's
    // current quaternion by reading its world direction vector.
    const fc = this.game.followCam?.cam;
    if (fc) {
      this.pos.copy(fc.position);
      const dir = new THREE.Vector3();
      fc.getWorldDirection(dir);
      this.yaw = Math.atan2(dir.x, dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this.fov = fc.fov;
    }

    this._installHudHider();
    this._installPanel();
    this._installInput();
    this._loop();
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.game._promoActive = false;

    this._removeInput();
    this._removePanel();
    this._removeHudHider();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ---- HUD hiding -------------------------------------------------------

  // Yandex screenshots must not show our diegetic UI. The cleanest way
  // is a single high-specificity stylesheet that hides every overlay
  // element while leaving the WebGL canvas untouched.
  _installHudHider() {
    const style = document.createElement('style');
    style.id = 'promo-hide-style';
    style.textContent = `
      body.promo-active #ui-root,
      body.promo-active #hud-left,
      body.promo-active #hud-right,
      body.promo-active #cooldown,
      body.promo-active #intro,
      body.promo-active #pause,
      body.promo-active #shop,
      body.promo-active #death,
      body.promo-active #prompt,
      body.promo-active #build-wheel,
      body.promo-active #altar,
      body.promo-active #minimap,
      body.promo-active #toast { display: none !important; }
      /* canvas keeps the cursor visible by default so the user can
         click our panel; pointer-lock hides it while flying. */
    `;
    document.head.appendChild(style);
    document.body.classList.add('promo-active');
    this._hideStyle = style;
  }

  _removeHudHider() {
    document.body.classList.remove('promo-active');
    if (this._hideStyle && this._hideStyle.parentNode) {
      this._hideStyle.parentNode.removeChild(this._hideStyle);
    }
    this._hideStyle = null;
  }

  // ---- Panel ------------------------------------------------------------

  _installPanel() {
    const panel = document.createElement('div');
    panel.id = 'promo-panel';
    panel.innerHTML = `
      <div class="promo-title">📷 PROMO MODE</div>
      <div class="promo-row promo-help">
        WASD/стрелки — лететь · Q/E — вверх/вниз · Shift — ускорить<br>
        ЛКМ по сцене — захват мыши (Esc — отпустить) · Колесо — FOV
      </div>
      <div class="promo-row">
        <label>Время суток</label>
        <input type="range" id="promo-time" min="0" max="1" step="0.005" value="0.5">
        <span id="promo-time-label">12:00</span>
      </div>
      <div class="promo-row">
        <label>FOV</label>
        <input type="range" id="promo-fov" min="20" max="90" step="1" value="55">
        <span id="promo-fov-label">55°</span>
      </div>
      <div class="promo-row">
        <button id="promo-hide-player">👻 Скрыть героя</button>
      </div>
      <div class="promo-row">
        <label>Скриншот →</label>
        ${RES_PRESETS.map((p, i) => `<button class="promo-shot" data-i="${i}">${p.label}</button>`).join('')}
      </div>
      <div class="promo-row">
        <button id="promo-exit">✕ Выйти</button>
      </div>
    `;
    const style = document.createElement('style');
    style.id = 'promo-panel-style';
    style.textContent = `
      #promo-panel {
        position: fixed; right: 12px; top: 12px; z-index: 99999;
        background: rgba(8,12,18,0.92); color: #eee;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 10px; padding: 12px 14px; font: 12px/1.4 system-ui, sans-serif;
        width: 360px; backdrop-filter: blur(6px);
        pointer-events: auto; user-select: none;
      }
      #promo-panel .promo-title { font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #ffb84d; letter-spacing: 0.5px; }
      #promo-panel .promo-help { font-size: 11px; opacity: 0.75; margin-bottom: 8px; line-height: 1.5; }
      #promo-panel .promo-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      #promo-panel label { min-width: 100px; opacity: 0.85; }
      #promo-panel input[type=range] { flex: 1; min-width: 140px; }
      #promo-panel button {
        background: rgba(255,255,255,0.08); color: #eee;
        border: 1px solid rgba(255,255,255,0.18); border-radius: 6px;
        padding: 4px 8px; cursor: pointer; font-size: 11px;
      }
      #promo-panel button:hover { background: rgba(255,255,255,0.16); }
      #promo-panel button.armed { background: #ffb84d; color: #000; border-color: #ffb84d; }
      #promo-panel #promo-exit { background: #c33; color: #fff; border-color: #c33; }
      #promo-badge {
        position: fixed; left: 12px; bottom: 12px; z-index: 99999;
        background: rgba(8,12,18,0.85); color: #ffb84d;
        padding: 6px 10px; border-radius: 6px; font: 11px system-ui, sans-serif;
        pointer-events: none; border: 1px solid rgba(255,184,77,0.4);
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);
    this._panel = panel;
    this._panelStyle = style;

    const badge = document.createElement('div');
    badge.id = 'promo-badge';
    badge.textContent = 'promo mode · WASD-fly · ЛКМ для захвата мыши';
    document.body.appendChild(badge);
    this._badge = badge;

    // Wire controls.
    const timeRange = panel.querySelector('#promo-time');
    const timeLabel = panel.querySelector('#promo-time-label');
    const fmtTime = (t) => {
      const h = Math.floor(t * 24);
      const m = Math.floor((t * 24 - h) * 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    if (this.game.world) {
      timeRange.value = String(this.game.world.dayTime || 0.5);
      timeLabel.textContent = fmtTime(parseFloat(timeRange.value));
    }
    timeRange.addEventListener('input', () => {
      const v = parseFloat(timeRange.value);
      if (this.game.world) this.game.world.dayTime = v;
      timeLabel.textContent = fmtTime(v);
    });

    const fovRange = panel.querySelector('#promo-fov');
    const fovLabel = panel.querySelector('#promo-fov-label');
    fovRange.value = String(Math.round(this.fov));
    fovLabel.textContent = `${Math.round(this.fov)}°`;
    fovRange.addEventListener('input', () => {
      this.fov = parseFloat(fovRange.value);
      fovLabel.textContent = `${Math.round(this.fov)}°`;
    });

    const hidePlayerBtn = panel.querySelector('#promo-hide-player');
    hidePlayerBtn.addEventListener('click', () => {
      this._hidePlayer = !this._hidePlayer;
      hidePlayerBtn.classList.toggle('armed', this._hidePlayer);
      this._applyPlayerVisibility();
    });

    panel.querySelectorAll('.promo-shot').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-i'), 10);
        const r = RES_PRESETS[i];
        if (r) this.captureScreenshot(r.w, r.h);
      });
    });
    panel.querySelector('#promo-exit').addEventListener('click', () => this.disable());
  }

  _removePanel() {
    if (this._panel && this._panel.parentNode) this._panel.parentNode.removeChild(this._panel);
    if (this._badge && this._badge.parentNode) this._badge.parentNode.removeChild(this._badge);
    if (this._panelStyle && this._panelStyle.parentNode) this._panelStyle.parentNode.removeChild(this._panelStyle);
    this._panel = null; this._badge = null; this._panelStyle = null;
    this._applyPlayerVisibility(true);
  }

  _applyPlayerVisibility(forceVisible = false) {
    const want = !this._hidePlayer || forceVisible;
    for (const p of this.game.players || []) {
      if (p?.mesh) p.mesh.visible = want && !p._phantom;
    }
  }

  // ---- Input ------------------------------------------------------------

  _installInput() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.game.canvas?.addEventListener('click', this._onClick);
    this.game.canvas?.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  _removeInput() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.game.canvas?.removeEventListener('click', this._onClick);
    this.game.canvas?.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this._keys.clear();
  }

  _handleKey(e, isDown) {
    // Don't fight typing in the panel's inputs.
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
    if (isDown) this._keys.add(e.code);
    else this._keys.delete(e.code);
    // ESC exits pointer lock automatically; double-Esc could exit promo
    // but we leave that to the panel "Exit" button so users don't bail
    // accidentally mid-composition.
  }

  _handleMouseMove(e) {
    if (!this._pointerLocked) return;
    this.yaw -= e.movementX * this.lookSpeedMouse;
    this.pitch -= e.movementY * this.lookSpeedMouse;
    // Clamp pitch so we don't gimbal-flip past vertical.
    const lim = Math.PI / 2 - 0.01;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
  }

  _handlePointerLock(e) {
    // Don't steal clicks that landed on our panel.
    if (this._panel && this._panel.contains(e.target)) return;
    this.game.canvas?.requestPointerLock?.();
  }

  _handleWheel(e) {
    e.preventDefault();
    this.fov = THREE.MathUtils.clamp(this.fov + Math.sign(e.deltaY) * 2, 20, 90);
    const fovRange = this._panel?.querySelector('#promo-fov');
    const fovLabel = this._panel?.querySelector('#promo-fov-label');
    if (fovRange) fovRange.value = String(Math.round(this.fov));
    if (fovLabel) fovLabel.textContent = `${Math.round(this.fov)}°`;
  }

  // ---- Per-frame update -------------------------------------------------

  // Driven by its own RAF so it ticks even while the game loop has
  // bailed early on `_promoActive` (sleeping branch). Stops when the
  // mode is disabled.
  _loop() {
    if (!this.active) return;
    const t = performance.now();
    const dt = Math.min(0.1, (t - this._lastT) / 1000);
    this._lastT = t;
    this._tick(dt);
    requestAnimationFrame(() => this._loop());
  }

  _tick(dt) {
    // Translate flat-axis WASD/arrows into world-space using current yaw
    // so "forward" always means "where the camera is looking" (project
    // onto horizontal plane). Q/E are world-up so the user can dolly
    // straight up regardless of pitch.
    const k = this._keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp')) ? 1 : 0;
    const back = (k.has('KeyS') || k.has('ArrowDown')) ? 1 : 0;
    const left = (k.has('KeyA') || k.has('ArrowLeft')) ? 1 : 0;
    const right = (k.has('KeyD') || k.has('ArrowRight')) ? 1 : 0;
    const up = k.has('KeyE') ? 1 : 0;
    const down = k.has('KeyQ') ? 1 : 0;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight');
    const v = boost ? this.flySpeedBoost : this.flySpeed;
    const moveZ = fwd - back;
    const moveX = right - left;
    if (moveZ || moveX) {
      // forward vector projected to ground plane, normalised.
      const fx = Math.sin(this.yaw);
      const fz = Math.cos(this.yaw);
      // strafe is the 90° rotation in XZ.
      const sx = Math.cos(this.yaw);
      const sz = -Math.sin(this.yaw);
      this.pos.x += (fx * moveZ + sx * moveX) * v * dt;
      this.pos.z += (fz * moveZ + sz * moveX) * v * dt;
    }
    if (up || down) this.pos.y += (up - down) * v * dt;

    // Apply pose to the FollowCamera's underlying THREE camera and
    // skip its normal update() (Game.render() checks _promoActive).
    const cam = this.game.followCam?.cam;
    if (cam) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
      cam.position.copy(this.pos);
      // Build a look direction from yaw/pitch and orient the camera.
      const dir = new THREE.Vector3(
        Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        Math.cos(this.yaw) * Math.cos(this.pitch),
      );
      const target = new THREE.Vector3().copy(this.pos).add(dir);
      cam.lookAt(target);
    }

    // Push our render explicitly — the game loop's sleeping branch
    // calls update(0,dt0)+render() too, but that calls followCam.update
    // which would clobber our pose. By short-circuiting render() with
    // _promoActive we own the camera; calling renderer.render here also
    // means our FOV/time changes show immediately without waiting for
    // the game loop's next tick.
    const g = this.game;
    if (g.renderer && g.scene) {
      g.renderer.render(g.scene, cam);
    }
  }

  // ---- Screenshot capture -----------------------------------------------

  // Temporarily resize the renderer (and the camera aspect) to the
  // requested resolution, render one frame, read the canvas into a
  // PNG blob, restore the renderer. The on-screen canvas flickers for
  // ~1 frame at the new aspect, which is fine — the user expects it.
  captureScreenshot(width, height) {
    const g = this.game;
    if (!g.renderer || !g.scene || !g.followCam?.cam) return;
    const cam = g.followCam.cam;
    const renderer = g.renderer;

    // Save state.
    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevPR = renderer.getPixelRatio();
    const prevAspect = cam.aspect;

    try {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
      renderer.render(g.scene, cam);
      const canvas = renderer.domElement;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `twin-hearts-${width}x${height}-${ts}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Free the blob URL on next tick.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    } finally {
      // Restore — must happen before the next render frame, but since
      // canvas.toBlob is async we restore synchronously and trust that
      // the blob was already captured from the still-resized canvas
      // before this finally block ran. (Browsers snapshot the canvas
      // on the toBlob call; the resize after doesn't affect the blob.)
      renderer.setPixelRatio(prevPR);
      renderer.setSize(prevSize.x, prevSize.y, false);
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
  }
}
