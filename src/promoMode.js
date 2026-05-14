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
import { CHARACTERS, CHARACTER_BY_ID, crossFadeTo, spawnCharacter, setEquippedWeapon } from './models.js';
import { CAPE_COLOR_PRESETS, PLAYER_COLOR_PRESETS } from './player.js';

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

const PROMO_ANIMS = [
  { key: 'idle', label: 'Idle' },
  { key: 'walk', label: 'Walk' },
  { key: 'run', label: 'Run' },
  { key: 'attack_1h_horiz', label: '1H slice' },
  { key: 'attack_2h_slice', label: '2H slice' },
  { key: 'attack_2h_spinning', label: 'Spin' },
  { key: 'attack_spell', label: 'Spell' },
  { key: 'attack_spell_long', label: 'Long spell' },
  { key: 'attack_throw', label: 'Throw' },
  { key: 'dodge_forward', label: 'Dodge' },
  { key: 'hit', label: 'Hit' },
  { key: 'death', label: 'Death' },
];
const PROMO_DEFAULT_WEAPON = 'sword_1h';
const PROMO_CHARACTER_SCALE = 0.6;

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
    this.flySpeed = 5;         // m/s with W/A/S/D
    this.flySpeedBoost = 18;   // m/s while Shift held
    this.lookSpeedMouse = 0.0025; // rad per pixel

    // Frame-local input state.
    this._keys = new Set();
    this._pointerLocked = false;
    this._lastT = performance.now();

    // DOM bits.
    this._panel = null;
    this._badge = null;
    this._hideStyle = null;
    this._characterMenu = null;
    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._promoCharacters = [];
    this._selectedCharacter = null;
    this._spawnArmed = false;
    this._deleteArmed = false;
    this._hidePlayer = false;

    // Bound handlers for clean remove.
    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onClick = (e) => this._handleCanvasClick(e);
    this._onContextMenu = (e) => this._handleContextMenu(e);
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
    this._removeCharacterMenu();
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
        ЛКМ — выбрать персонажа / поставить / удалить · ПКМ — захват мыши · Колесо — FOV
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
        <button id="promo-hide-player">Скрыть игроков</button>
        <button id="promo-spawn-character">Спавн персонажа</button>
        <button id="promo-delete-character">Удалить персонажа</button>
      </div>
      <div class="promo-row">
        <label>Кого спавнить</label>
        <select id="promo-character-kind">
          ${CHARACTERS.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}
        </select>
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
      #promo-panel select { flex: 1; min-width: 140px; background: #151a22; color: #eee; border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; padding: 4px 6px; }
      #promo-panel button {
        background: rgba(255,255,255,0.08); color: #eee;
        border: 1px solid rgba(255,255,255,0.18); border-radius: 6px;
        padding: 4px 8px; cursor: pointer; font-size: 11px;
      }
      #promo-panel button:hover { background: rgba(255,255,255,0.16); }
      #promo-panel button.armed { background: #ffb84d; color: #000; border-color: #ffb84d; }
      #promo-panel #promo-exit { background: #c33; color: #fff; border-color: #c33; }
      #promo-character-menu {
        position: fixed; z-index: 100000; width: 260px; padding: 10px;
        background: rgba(8,12,18,0.94); color: #eee; border: 1px solid rgba(255,255,255,0.18);
        border-radius: 10px; font: 12px/1.4 system-ui, sans-serif; pointer-events: auto; user-select: none;
      }
      #promo-character-menu .promo-menu-title { color: #ffb84d; font-weight: 700; margin-bottom: 6px; }
      #promo-character-menu .promo-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      #promo-character-menu select { flex: 1; min-width: 120px; background: #151a22; color: #eee; border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; padding: 4px 6px; }
      #promo-character-menu button { background: rgba(255,255,255,0.08); color: #eee; border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
      #promo-character-menu button:hover { background: rgba(255,255,255,0.16); }
      #promo-character-menu button.armed { background: #ffb84d; color: #000; border-color: #ffb84d; }
      #promo-character-menu .danger { background: #7a2a2a; border-color: #a44; }
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
    badge.textContent = 'promo mode · WASD-fly · ПКМ для захвата мыши';
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

    const spawnBtn = panel.querySelector('#promo-spawn-character');
    const deleteBtn = panel.querySelector('#promo-delete-character');
    spawnBtn.addEventListener('click', () => {
      this._spawnArmed = !this._spawnArmed;
      if (this._spawnArmed) this._deleteArmed = false;
      this._syncPanelButtons();
    });
    deleteBtn.addEventListener('click', () => {
      this._deleteArmed = !this._deleteArmed;
      if (this._deleteArmed) this._spawnArmed = false;
      this._syncPanelButtons();
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

  _syncPanelButtons() {
    const spawnBtn = this._panel?.querySelector('#promo-spawn-character');
    const deleteBtn = this._panel?.querySelector('#promo-delete-character');
    spawnBtn?.classList.toggle('armed', this._spawnArmed);
    deleteBtn?.classList.toggle('armed', this._deleteArmed);
    if (this._badge) {
      if (this._spawnArmed) this._badge.textContent = 'promo mode · ЛКМ по земле — поставить персонажа';
      else if (this._deleteArmed) this._badge.textContent = 'promo mode · ЛКМ по персонажу — удалить';
      else this._badge.textContent = 'promo mode · WASD-fly · ПКМ для захвата мыши';
    }
  }

  _pickGroundPoint(e) {
    const cam = this.game.followCam?.cam;
    const canvas = this.game.canvas;
    if (!cam || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    this._pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pointerNdc, cam);
    const point = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(this._groundPlane, point)) return null;
    return point;
  }

  _pickPromoCharacter(e) {
    const cam = this.game.followCam?.cam;
    const canvas = this.game.canvas;
    if (!cam || !canvas || this._promoCharacters.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    this._pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pointerNdc, cam);
    const roots = this._promoCharacters.map((p) => p.root);
    const hits = this._raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      const picked = this._promoCharacters.find((p) => {
        let obj = hit.object;
        while (obj) {
          if (obj === p.root) return true;
          obj = obj.parent;
        }
        return false;
      });
      if (picked) return picked;
    }
    return null;
  }

  _spawnPromoCharacter(point) {
    const select = this._panel?.querySelector('#promo-character-kind');
    const charId = select?.value || CHARACTERS[0].id;
    const def = CHARACTER_BY_ID[charId] || CHARACTERS[0];
    const body = PLAYER_COLOR_PRESETS[this._promoCharacters.length % PLAYER_COLOR_PRESETS.length]?.body ?? 0xffffff;
    const cape = CAPE_COLOR_PRESETS[this._promoCharacters.length % CAPE_COLOR_PRESETS.length]?.body ?? null;
    const character = spawnCharacter(def.kind, {
      tint: body,
      capeTint: cape,
      scale: PROMO_CHARACTER_SCALE,
      skinAware: !!def.skinAware,
      characterDef: def,
    });
    const root = character.root;
    root.position.set(point.x, 0, point.z);
    root.rotation.y = this.yaw + Math.PI;
    root.userData.promoCharacter = true;
    this.game.scene.add(root);
    setEquippedWeapon(character, def.defaultWeapon || PROMO_DEFAULT_WEAPON);
    const item = {
      root,
      character,
      def,
      animKey: 'idle',
      paused: false,
      weaponKind: def.defaultWeapon || PROMO_DEFAULT_WEAPON,
    };
    this._promoCharacters.push(item);
    this._playCharacterAnimation(item, 'idle');
    this._selectedCharacter = item;
    this._openCharacterMenu(item, 0, 0);
  }

  _deletePromoCharacter(item) {
    this._removeCharacterMenu();
    const idx = this._promoCharacters.indexOf(item);
    if (idx >= 0) this._promoCharacters.splice(idx, 1);
    item.character?.mixer?.stopAllAction();
    item.root?.parent?.remove(item.root);
    this._selectedCharacter = null;
  }

  _playCharacterAnimation(item, animKey) {
    const action = item?.character?.actions?.[animKey];
    if (!item || !action) return;
    item.animKey = animKey;
    item.paused = false;
    for (const a of Object.values(item.character.actions)) {
      if (!a) continue;
      a.paused = false;
      a.setEffectiveTimeScale(1);
      a.setEffectiveWeight(1);
      a.setLoop(THREE.LoopRepeat);
      a.clampWhenFinished = false;
    }
    crossFadeTo(item.character.actions, animKey, 0.12);
    this._refreshCharacterMenu();
  }

  _toggleCharacterPause(item) {
    if (!item?.character?.actions) return;
    item.paused = !item.paused;
    for (const a of Object.values(item.character.actions)) {
      if (a) a.paused = item.paused;
    }
    this._refreshCharacterMenu();
  }

  _openCharacterMenu(item, x, y) {
    this._selectedCharacter = item;
    if (!this._characterMenu) {
      const menu = document.createElement('div');
      menu.id = 'promo-character-menu';
      menu.innerHTML = `
        <div class="promo-menu-title">Персонаж</div>
        <div class="promo-row">
          <label>Анимация</label>
          <select id="promo-anim-select">
            ${PROMO_ANIMS.map((a) => `<option value="${a.key}">${a.label}</option>`).join('')}
          </select>
        </div>
        <div class="promo-row">
          <button id="promo-anim-pause">Пауза</button>
          <button id="promo-char-delete" class="danger">Удалить</button>
          <button id="promo-char-close">Закрыть</button>
        </div>
      `;
      document.body.appendChild(menu);
      this._characterMenu = menu;
      menu.querySelector('#promo-anim-select')?.addEventListener('change', (ev) => {
        if (this._selectedCharacter) this._playCharacterAnimation(this._selectedCharacter, ev.target.value);
      });
      menu.querySelector('#promo-anim-pause')?.addEventListener('click', () => {
        if (this._selectedCharacter) this._toggleCharacterPause(this._selectedCharacter);
      });
      menu.querySelector('#promo-char-delete')?.addEventListener('click', () => {
        if (this._selectedCharacter) this._deletePromoCharacter(this._selectedCharacter);
      });
      menu.querySelector('#promo-char-close')?.addEventListener('click', () => this._removeCharacterMenu());
    }
    if (x || y) {
      const pad = 12;
      const left = Math.min(window.innerWidth - 280, Math.max(pad, x + pad));
      const top = Math.min(window.innerHeight - 150, Math.max(pad, y + pad));
      this._characterMenu.style.left = `${left}px`;
      this._characterMenu.style.top = `${top}px`;
    } else {
      this._characterMenu.style.left = '12px';
      this._characterMenu.style.top = '12px';
    }
    this._refreshCharacterMenu();
  }

  _refreshCharacterMenu() {
    if (!this._characterMenu || !this._selectedCharacter) return;
    const item = this._selectedCharacter;
    const select = this._characterMenu.querySelector('#promo-anim-select');
    if (select) {
      for (const opt of select.options) {
        opt.disabled = !item.character?.actions?.[opt.value];
      }
      select.value = item.animKey;
    }
    const pause = this._characterMenu.querySelector('#promo-anim-pause');
    if (pause) {
      pause.textContent = item.paused ? 'Продолжить' : 'Пауза';
      pause.classList.toggle('armed', item.paused);
    }
    const title = this._characterMenu.querySelector('.promo-menu-title');
    if (title) title.textContent = item.def?.label || 'Персонаж';
  }

  _removeCharacterMenu() {
    if (this._characterMenu && this._characterMenu.parentNode) {
      this._characterMenu.parentNode.removeChild(this._characterMenu);
    }
    this._characterMenu = null;
  }

  // ---- Input ------------------------------------------------------------

  _installInput() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.game.canvas?.addEventListener('click', this._onClick);
    this.game.canvas?.addEventListener('contextmenu', this._onContextMenu);
    this.game.canvas?.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  _removeInput() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.game.canvas?.removeEventListener('click', this._onClick);
    this.game.canvas?.removeEventListener('contextmenu', this._onContextMenu);
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

  _handleContextMenu(e) {
    e.preventDefault();
    if (this._panel && this._panel.contains(e.target)) return;
    if (this._characterMenu && this._characterMenu.contains(e.target)) return;
    this.game.canvas?.requestPointerLock?.();
  }

  _handleCanvasClick(e) {
    if (this._panel && this._panel.contains(e.target)) return;
    if (this._characterMenu && this._characterMenu.contains(e.target)) return;
    if (this._deleteArmed) {
      const hit = this._pickPromoCharacter(e);
      if (hit) this._deletePromoCharacter(hit);
      return;
    }
    if (this._spawnArmed) {
      const point = this._pickGroundPoint(e);
      if (point) this._spawnPromoCharacter(point);
      return;
    }
    const hit = this._pickPromoCharacter(e);
    if (hit) this._openCharacterMenu(hit, e.clientX, e.clientY);
    else this._removeCharacterMenu();
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
      for (const item of this._promoCharacters) {
        if (!item.paused) item.character?.mixer?.update(dt);
      }
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
