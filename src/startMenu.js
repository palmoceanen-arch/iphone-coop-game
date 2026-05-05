// Start-menu controller: shown once on app launch, before the lobby/QR
// screen. Lets the host pick a world seed and configure each local player's
// body colour, cape colour and starter weapon, with a live 3D preview of
// each character that updates instantly on every click.
//
// The actual `Game` instance is constructed by main.js *after* the user
// clicks "Применить и начать", so the picked options can flow into
// `new Game({ seed, players })` without a page reload. The menu also
// exposes "Загрузить" (placeholder) and "Настройки", which reuses the
// existing pause-menu overlay.
import * as THREE from 'three';
import { PLAYER_COLOR_PRESETS, CAPE_COLOR_PRESETS } from './player.js';
import { WEAPONS, applyCharacterTint, setEquippedWeapon, spawnCharacter } from './models.js';

// Default picks per slot — closest equivalents to the historical
// P1 cyan-sword / P2 coral-axe loadout in the new wheel palette so a
// user who just clicks "Применить" without touching anything sees the
// familiar characters.
const DEFAULT_BODY_BY_INDEX = ['sky', 'red'];
const DEFAULT_CAPE_BY_INDEX = ['royal', 'crimson'];
const DEFAULT_WEAPON_BY_INDEX = ['sword_1h', 'axe_1h'];

const SLOT_TITLES = ['Игрок 1', 'Игрок 2'];

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000).toString(36).toUpperCase().padStart(4, '0');
}

function initialSeed() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('seed');
    if (fromUrl && fromUrl.length > 0) return fromUrl.toUpperCase().slice(0, 12);
  } catch { /* SSR / no window */ }
  return randomSeed();
}

function presetHex(presets, id) {
  const found = presets.find((p) => p.id === id) || presets[0];
  return found.body;
}

// Convert a 24-bit hex int to a CSS `#rrggbb` string for swatch backgrounds.
function hexToCss(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export class StartMenu {
  constructor({ pauseMenu }) {
    this.root = document.getElementById('start-menu');
    this.pauseMenu = pauseMenu;
    if (!this.root) return;

    this.onStart = null;

    // Per-slot working state, mutated as the user clicks swatches / weapons.
    this.config = [
      { color: DEFAULT_BODY_BY_INDEX[0], cape: DEFAULT_CAPE_BY_INDEX[0], weapon: DEFAULT_WEAPON_BY_INDEX[0] },
      { color: DEFAULT_BODY_BY_INDEX[1], cape: DEFAULT_CAPE_BY_INDEX[1], weapon: DEFAULT_WEAPON_BY_INDEX[1] },
    ];
    this.seed = initialSeed();

    // 3D preview state per slot, set up lazily inside _renderSlots(): each
    // entry is `{ renderer, scene, camera, mixer, character }`.
    this._previews = [];
    this._rafId = null;
    this._lastT = 0;

    this._renderSlots();
    this._bind();
    this._showView('main');
  }

  open() {
    if (!this.root) return;
    this.root.classList.add('open');
    this._startPreviewLoop();
  }

  close() {
    if (!this.root) return;
    this.root.classList.remove('open');
    this._stopPreviewLoop();
  }

  // ---- View switching ---------------------------------------------------

  _showView(name) {
    const views = this.root.querySelectorAll('.start-view');
    views.forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'newgame') {
      const seedInp = this.root.querySelector('#start-seed');
      if (seedInp && !seedInp.value) seedInp.value = this.seed;
      // Resize preview canvases — when the parent flexes from `display:none`
      // to visible the canvas may still be reporting 0×0, which makes the
      // initial render appear blank.
      this._resizePreviews();
    }
  }

  // ---- Bindings ---------------------------------------------------------

  _bind() {
    const r = this.root;
    r.querySelector('#start-btn-new').addEventListener('click', () => this._showView('newgame'));
    r.querySelector('#start-btn-load').addEventListener('click', () => this._showView('load'));
    r.querySelector('#start-btn-settings').addEventListener('click', () => this._openSettings());
    r.querySelectorAll('[data-back="main"]').forEach((b) => {
      b.addEventListener('click', () => this._showView('main'));
    });

    const seedInp = r.querySelector('#start-seed');
    if (seedInp) {
      seedInp.value = this.seed;
      seedInp.addEventListener('input', () => {
        this.seed = seedInp.value.trim().toUpperCase().slice(0, 12);
        seedInp.value = this.seed;
      });
    }
    r.querySelector('#start-seed-random')?.addEventListener('click', () => {
      this.seed = randomSeed();
      if (seedInp) seedInp.value = this.seed;
    });

    r.querySelector('#start-btn-confirm').addEventListener('click', () => {
      const seed = (this.seed && this.seed.length > 0) ? this.seed : randomSeed();
      const players = this.config.map((c) => ({
        color: presetHex(PLAYER_COLOR_PRESETS, c.color),
        capeColor: presetHex(CAPE_COLOR_PRESETS, c.cape),
        weapon: c.weapon,
      }));
      this.close();
      this.onStart && this.onStart({ seed, players });
    });

    window.addEventListener('resize', () => this._resizePreviews());
  }

  _openSettings() {
    if (!this.pauseMenu) return;
    this.pauseMenu.open();
  }

  // ---- Slot rendering ---------------------------------------------------

  _renderSlots() {
    const wrap = this.root.querySelector('#start-slots');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      wrap.appendChild(this._buildSlot(i));
    }
  }

  _buildSlot(index) {
    const slot = document.createElement('div');
    slot.className = `start-slot start-slot-p${index + 1}`;
    slot.setAttribute('data-slot', String(index));

    const head = document.createElement('h3');
    head.className = 'start-slot-title';
    head.textContent = SLOT_TITLES[index];
    slot.appendChild(head);

    // ---- 3D preview canvas ----
    const canvas = document.createElement('canvas');
    canvas.className = 'start-preview';
    slot.appendChild(canvas);
    // Defer Three.js scene creation until after the canvas has been attached
    // so `clientWidth`/`clientHeight` are available; do it at the end of
    // _buildSlot() once all DOM is in place.

    // ---- Body colour swatches ----
    const bodyLabel = document.createElement('div');
    bodyLabel.className = 'start-section-label';
    bodyLabel.textContent = 'Цвет персонажа';
    slot.appendChild(bodyLabel);
    const bodyRow = this._buildSwatchRow(PLAYER_COLOR_PRESETS, this.config[index].color, (id) => {
      this.config[index].color = id;
      this._applyTintToPreview(index);
    });
    slot.appendChild(bodyRow);

    // ---- Cape colour swatches ----
    const capeLabel = document.createElement('div');
    capeLabel.className = 'start-section-label';
    capeLabel.textContent = 'Цвет плаща';
    slot.appendChild(capeLabel);
    const capeRow = this._buildSwatchRow(CAPE_COLOR_PRESETS, this.config[index].cape, (id) => {
      this.config[index].cape = id;
      this._applyTintToPreview(index);
    });
    slot.appendChild(capeRow);

    // ---- Weapon picker (compact grid) ----
    const weaponLabel = document.createElement('div');
    weaponLabel.className = 'start-section-label';
    weaponLabel.textContent = 'Оружие';
    slot.appendChild(weaponLabel);
    const weaponRow = document.createElement('div');
    weaponRow.className = 'start-weapon-grid';
    for (const [id, profile] of Object.entries(WEAPONS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'start-weapon-chip';
      btn.setAttribute('data-weapon', id);
      btn.title = `${profile.label} · DMG ×${profile.damageMult.toFixed(1)} · CD ${profile.cooldown.toFixed(2)}c`;
      btn.textContent = profile.label;
      if (this.config[index].weapon === id) btn.classList.add('active');
      btn.addEventListener('click', () => {
        this.config[index].weapon = id;
        weaponRow.querySelectorAll('.start-weapon-chip').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-weapon') === id);
        });
        this._applyWeaponToPreview(index);
      });
      weaponRow.appendChild(btn);
    }
    slot.appendChild(weaponRow);

    // Schedule preview setup after the slot is in the DOM. We use a
    // microtask so `appendChild` has already completed by the time we read
    // the canvas' rendered size in _setupPreview().
    queueMicrotask(() => this._setupPreview(index, canvas));

    return slot;
  }

  // Build a flat-row colour picker. Each swatch is a circular bead
  // (radial-gradient: highlight + darker rim → reads as 3-D), and the
  // row uses flex-wrap so a 13-colour palette breaks into two lines
  // inside the slot's narrow width without overflowing.
  _buildSwatchRow(presets, activeId, onPick) {
    const row = document.createElement('div');
    row.className = 'start-color-row';
    for (const preset of presets) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'start-swatch';
      const css = hexToCss(preset.body);
      // Radial gradient: bright highlight at top-left, fade to base,
      // dark rim at bottom-right — gives the swatch a sphere/bead
      // feel without needing actual lighting.
      sw.style.background = `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.55) 0%, ${css} 38%, ${css} 70%, rgba(0,0,0,0.25) 100%)`;
      sw.title = preset.name;
      sw.setAttribute('data-color', preset.id);
      sw.setAttribute('aria-label', preset.name);
      if (activeId === preset.id) sw.classList.add('active');
      sw.addEventListener('click', () => {
        row.querySelectorAll('.start-swatch').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-color') === preset.id);
        });
        onPick(preset.id);
      });
      row.appendChild(sw);
    }
    return row;
  }

  // ---- Preview scene per slot ------------------------------------------

  _setupPreview(index, canvas) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0); // transparent background

    const scene = new THREE.Scene();
    // Soft ambient + a key light angled from above-front so the cape and
    // armour show off both their lit + shaded sides; matches the in-game
    // look closely enough for a recognisable preview.
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 4, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-2, 2, -1);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    camera.position.set(0, 1.4, 4.4);
    camera.lookAt(0, 0.95, 0);

    const cfg = this.config[index];
    const character = spawnCharacter('knight', {
      tint: presetHex(PLAYER_COLOR_PRESETS, cfg.color),
      capeTint: presetHex(CAPE_COLOR_PRESETS, cfg.cape),
      scale: 0.9,
      skinAware: true,
    });
    // Centre on the canvas roughly at chest height; the model's origin sits
    // at the feet, so we don't translate vertically — the camera lookAt
    // already aims at the chest.
    scene.add(character.root);
    setEquippedWeapon(character, cfg.weapon);

    this._previews[index] = { renderer, scene, camera, character, canvas };

    // Subtle continuous yaw so the user can see the cape from the side
    // without explicit drag controls.
    character.root.rotation.y = 0;

    this._resizePreview(index);
  }

  _applyTintToPreview(index) {
    const p = this._previews[index];
    if (!p) return;
    const cfg = this.config[index];
    applyCharacterTint(p.character, {
      body: presetHex(PLAYER_COLOR_PRESETS, cfg.color),
      cape: presetHex(CAPE_COLOR_PRESETS, cfg.cape),
    });
  }

  _applyWeaponToPreview(index) {
    const p = this._previews[index];
    if (!p) return;
    setEquippedWeapon(p.character, this.config[index].weapon);
  }

  _resizePreview(index) {
    const p = this._previews[index];
    if (!p) return;
    const w = p.canvas.clientWidth || 220;
    const h = p.canvas.clientHeight || 280;
    p.renderer.setSize(w, h, false);
    p.camera.aspect = w / h;
    p.camera.updateProjectionMatrix();
  }

  _resizePreviews() {
    for (let i = 0; i < this._previews.length; i++) this._resizePreview(i);
  }

  _startPreviewLoop() {
    if (this._rafId !== null) return;
    this._lastT = performance.now();
    const t0 = this._lastT;
    const tick = (now) => {
      this._rafId = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this._lastT) / 1000);
      this._lastT = now;
      // Slow side-to-side swivel (~±40°) so the cape is visible on the
      // sides without ever showing the back of the character — this keeps
      // the chest piece, weapon and shield in view at all times.
      const angle = Math.sin((now - t0) * 0.0006) * 0.7;
      for (const p of this._previews) {
        if (!p) continue;
        p.character.root.rotation.y = angle;
        p.character.mixer.update(dt);
        p.renderer.render(p.scene, p.camera);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopPreviewLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
