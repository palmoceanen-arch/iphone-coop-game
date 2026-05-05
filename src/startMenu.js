// Start-menu controller: shown once on app launch, before the lobby/QR
// screen. Lets the host pick a world seed and configure each local player's
// colour + starter weapon. The actual `Game` instance is constructed by
// main.js *after* the user clicks "Начать", so the picked options can flow
// into `new Game({ seed, players })` without forcing a page reload.
//
// The menu also exposes "Загрузить" (placeholder until save/load lands) and
// "Настройки", which reuses the existing pause-menu overlay so audio/video
// config can be tweaked before a run starts. PauseMenu is injected from the
// outside so the same instance is shared with the in-game Esc menu later.
import { PLAYER_COLOR_PRESETS } from './player.js';
import { WEAPONS } from './models.js';

// Default picks per slot — match the historical P1 cyan-sword / P2 coral-axe
// loadout so a user who just clicks "Начать" without touching anything sees
// the original characters.
const DEFAULT_COLOR_BY_INDEX = ['cyan', 'coral'];
const DEFAULT_WEAPON_BY_INDEX = ['sword_1h', 'axe_1h'];

const SLOT_TITLES = ['Игрок 1', 'Игрок 2'];

function randomSeed() {
  // 4–6 char alphanumeric — matches the format used by the URL-derived seed
  // generator in game.js so seeds saved here look identical to seeds shared
  // via the browser address bar.
  return Math.floor(Math.random() * 1_000_000).toString(36).toUpperCase().padStart(4, '0');
}

// Pre-populate the seed input from `?seed=` on first visit so a refresh /
// shared link returns the user to the same seed they last chose. Falls back
// to a fresh random seed when the URL has none.
function initialSeed() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('seed');
    if (fromUrl && fromUrl.length > 0) return fromUrl.toUpperCase().slice(0, 12);
  } catch { /* SSR / no window */ }
  return randomSeed();
}

export class StartMenu {
  constructor({ pauseMenu }) {
    this.root = document.getElementById('start-menu');
    this.pauseMenu = pauseMenu;
    if (!this.root) return;

    this.onStart = null; // ({ seed, players: [{color, weapon}, …] }) => void

    // Per-slot working state, mutated as the user clicks swatches / weapons.
    this.config = [
      { color: DEFAULT_COLOR_BY_INDEX[0], weapon: DEFAULT_WEAPON_BY_INDEX[0] },
      { color: DEFAULT_COLOR_BY_INDEX[1], weapon: DEFAULT_WEAPON_BY_INDEX[1] },
    ];
    this.seed = initialSeed();

    this._renderSlots();
    this._bind();
    this._showView('main');
  }

  open() {
    if (this.root) this.root.classList.add('open');
  }

  close() {
    if (this.root) this.root.classList.remove('open');
  }

  // ---- View switching ---------------------------------------------------

  _showView(name) {
    const views = this.root.querySelectorAll('.start-view');
    views.forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'newgame') {
      const seedInp = this.root.querySelector('#start-seed');
      if (seedInp && !seedInp.value) seedInp.value = this.seed;
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
        color: this._colorHexFor(c.color),
        weapon: c.weapon,
      }));
      this.close();
      this.onStart && this.onStart({ seed, players });
    });
  }

  _openSettings() {
    if (!this.pauseMenu) return;
    // Pause menu lives in its own overlay (#pause), so it stacks naturally
    // on top of the start menu. Closing it (via "Продолжить" / Esc) just
    // returns the user to whatever start-menu view was showing before.
    this.pauseMenu.open();
  }

  // ---- Slot rendering ---------------------------------------------------

  _colorHexFor(id) {
    const preset = PLAYER_COLOR_PRESETS.find((p) => p.id === id) || PLAYER_COLOR_PRESETS[0];
    return preset.body;
  }

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

    // ---- Colour swatches ----
    const colorLabel = document.createElement('div');
    colorLabel.className = 'start-section-label';
    colorLabel.textContent = 'Цвет персонажа';
    slot.appendChild(colorLabel);

    const colorRow = document.createElement('div');
    colorRow.className = 'start-color-row';
    for (const preset of PLAYER_COLOR_PRESETS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'start-swatch';
      sw.style.background = `#${preset.body.toString(16).padStart(6, '0')}`;
      sw.title = preset.name;
      sw.setAttribute('data-color', preset.id);
      sw.setAttribute('aria-label', preset.name);
      if (this.config[index].color === preset.id) sw.classList.add('active');
      sw.addEventListener('click', () => {
        this.config[index].color = preset.id;
        colorRow.querySelectorAll('.start-swatch').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-color') === preset.id);
        });
      });
      colorRow.appendChild(sw);
    }
    slot.appendChild(colorRow);

    // ---- Weapon picker ----
    const weaponLabel = document.createElement('div');
    weaponLabel.className = 'start-section-label';
    weaponLabel.textContent = 'Оружие';
    slot.appendChild(weaponLabel);

    const weaponRow = document.createElement('div');
    weaponRow.className = 'start-weapon-row';
    for (const [id, profile] of Object.entries(WEAPONS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'start-weapon';
      btn.setAttribute('data-weapon', id);
      btn.innerHTML = `<span class="w-name">${profile.label}</span><span class="w-meta">DMG ×${profile.damageMult.toFixed(1)} · CD ${profile.cooldown.toFixed(2)}c</span>`;
      if (this.config[index].weapon === id) btn.classList.add('active');
      btn.addEventListener('click', () => {
        this.config[index].weapon = id;
        weaponRow.querySelectorAll('.start-weapon').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-weapon') === id);
        });
      });
      weaponRow.appendChild(btn);
    }
    slot.appendChild(weaponRow);

    return slot;
  }
}
