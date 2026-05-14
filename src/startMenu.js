// Start-menu controller: shown once on app launch, before the lobby/QR
// screen. Lets the host pick a world seed and configure each local player's
// body colour, cape colour and starter weapon, with a live 3D preview of
// each character that updates instantly on every click.
//
// The actual `Game` instance is constructed by main.js *after* the user
// clicks "Применить и начать" (new game) or "Загрузить" (load), so the
// picked options can flow into `new Game({ seed, players, loadSave })`
// without a page reload. The menu also exposes "Настройки", which reuses
// the existing pause-menu overlay.
//
// onStart is invoked with `{ mode, seed, players? }`:
//   • mode === 'new'  → start a fresh run with the picked seed/players
//   • mode === 'load' → restore the localStorage save; `seed` is the
//     seed embedded in the save blob so main.js can rebuild the same
//     world before SaveSystem.apply() restores entity state on top.
import * as THREE from 'three';
import { PLAYER_COLOR_PRESETS, CAPE_COLOR_PRESETS } from './player.js';
import {
  WEAPONS,
  CHARACTERS,
  CHARACTER_BY_ID,
  applyCharacterTint,
  setEquippedWeapon,
  spawnCharacter,
  weaponAffinityFor,
} from './models.js';
import { SaveSystem } from './saveSystem.js';
import {
  createGamepadNavState,
  readGamepadNavSlot,
  listConnectedGamepadSlots,
} from './gamepadNav.js';

// Max gamepads we route into the start menu. The Gamepad API itself
// exposes 4 slots; almost no consumer setup has more than 2 plugged
// in, but allocating 4 states up front means we never need to grow
// the array later.
const GP_SLOT_COUNT = 4;

// Visual focus-ring colour per gamepad index. Reused as the
// `.gp-focus-p1` / `.gp-focus-p2` CSS classes so each cursor reads as
// belonging to its slot's player (blue accent for P1, coral for P2).
// Slots 3/4 are virtually never reached but reuse P2 colour as a
// fallback so the cursor remains visible.
const GP_FOCUS_CLASS = ['gp-focus-p1', 'gp-focus-p2', 'gp-focus-p2', 'gp-focus-p2'];

// Default picks per slot — closest equivalents to the historical
// P1 cyan-sword / P2 coral-axe loadout in the new wheel palette so a
// user who just clicks "Применить" without touching anything sees the
// familiar characters.
// Defaults pick body + cape from the same hue family per slot so the
// out-of-the-box pairing reads as a coherent set. Slot 1: pastel sky
// blue with a deeper azure cape; slot 2: pastel coral with a crimson
// cape. (See PLAYER_COLOR_PRESETS / CAPE_COLOR_PRESETS in player.js —
// they're index-aligned, so any matching pair works as a default.)
const DEFAULT_BODY_BY_INDEX = ['sky', 'coral'];
const DEFAULT_CAPE_BY_INDEX = ['azure', 'crimson'];
const DEFAULT_WEAPON_BY_INDEX = ['sword_1h', 'axe_1h'];
// Default character per slot. Both default to Knight so the "click
// Применить without touching anything" path matches the historical
// behaviour where both players were the hardcoded Knight model. The
// picker still lets either slot switch to any of the other KayKit
// Adventurers (Barbarian / Mage / Rogue / Rogue_Hooded).
const DEFAULT_CHARACTER_BY_INDEX = ['knight', 'knight'];

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
  constructor({ pauseMenu, forceSolo = false } = {}) {
    this.root = document.getElementById('start-menu');
    this.pauseMenu = pauseMenu;
    // forceSolo locks the menu into single-player mode and hides the
    // coop toggle entirely. Set by main.js for Yandex Games builds, where
    // there is no LAN lobby and the secondary slot would never get a
    // controller anyway.
    this.forceSolo = !!forceSolo;
    if (!this.root) return;

    this.onStart = null;

    // Per-slot working state, mutated as the user clicks swatches /
    // weapons / characters. `character` is a CHARACTERS[].id (e.g.
    // 'knight', 'mage', 'rogue_hooded'); `color` and `cape` are
    // PLAYER_COLOR_PRESETS / CAPE_COLOR_PRESETS .id values; `weapon`
    // is a key from WEAPONS.
    this.config = [
      {
        character: DEFAULT_CHARACTER_BY_INDEX[0],
        color: DEFAULT_BODY_BY_INDEX[0],
        cape: DEFAULT_CAPE_BY_INDEX[0],
        weapon: DEFAULT_WEAPON_BY_INDEX[0],
      },
      {
        character: DEFAULT_CHARACTER_BY_INDEX[1],
        color: DEFAULT_BODY_BY_INDEX[1],
        cape: DEFAULT_CAPE_BY_INDEX[1],
        weapon: DEFAULT_WEAPON_BY_INDEX[1],
      },
    ];
    this.seed = initialSeed();
    // Solo mode: when true, the second slot is hidden in the picker and
    // only one Player is configured. Game still builds a phantom slot 2
    // (hidden, invulnerable) so partner-aware code keeps its 2-slot shape.
    // Yandex builds force this to true so the menu can't expose a coop
    // option that would never resolve (no lobby → no second controller).
    this.solo = this.forceSolo;

    // 3D preview state per slot, set up lazily inside _renderSlots(): each
    // entry is `{ renderer, scene, camera, mixer, character }`.
    this._previews = [];
    // Weapon picker DOM rows per slot — stashed so we can re-stamp the
    // affinity star + tooltip on character switch without rebuilding
    // the picker (which would lose the user's current weapon pick).
    this._weaponRows = [];
    this._rafId = null;
    this._lastT = 0;
    // Per-gamepad nav state (edge tracking + hold-to-repeat timers).
    // Each pad polls its own slot independently so the second pad
    // doesn't steal edges from the first and vice versa.
    this._gpNavStates = Array.from({ length: GP_SLOT_COUNT }, () => createGamepadNavState());
    // Per-gamepad focus cursor. `regionId` is which region the cursor
    // is currently scoped to ('shared' / 'slot0' / 'slot1'), and
    // `row` / `col` index into the 2D grid computed for that region.
    // `desiredCenterX` survives across row changes so up/down keeps
    // the cursor visually "in the same column" even when target rows
    // have a different number of items.
    this._gpCursors = Array.from({ length: GP_SLOT_COUNT }, (_, i) => ({
      regionId: this._defaultRegionFor(i),
      row: 0, col: 0, desiredCenterX: null,
    }));

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

  // Default region for each gamepad slot. Gamepad 0 owns the shared
  // controls + slot[0]; gamepad 1+ defaults to slot[1] (or slot[0] if
  // we're in solo / the secondary slot doesn't exist yet).
  _defaultRegionFor(padIndex) {
    if (padIndex === 0) return 'shared0';
    return this.solo ? 'shared0' : 'slot1';
  }

  // ---- View switching ---------------------------------------------------

  _showView(name) {
    const views = this.root.querySelectorAll('.start-view');
    views.forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    // Reset every cursor to the top-left of its default region whenever
    // we change views — prevents a stale row index from indexing into a
    // freshly-rendered view that has a completely different grid shape.
    for (let i = 0; i < this._gpCursors.length; i++) {
      this._gpCursors[i].regionId = this._defaultRegionFor(i);
      this._gpCursors[i].row = 0;
      this._gpCursors[i].col = 0;
      this._gpCursors[i].desiredCenterX = null;
    }
    if (name === 'newgame') {
      const seedInp = this.root.querySelector('#start-seed');
      if (seedInp && !seedInp.value) seedInp.value = this.seed;
      // Resize preview canvases — when the parent flexes from `display:none`
      // to visible the canvas may still be reporting 0×0, which makes the
      // initial render appear blank.
      this._resizePreviews();
    }
    this._refreshGamepadFocus();
  }

  // ---- Bindings ---------------------------------------------------------

  _bind() {
    const r = this.root;
    r.querySelector('#start-btn-new').addEventListener('click', () => this._showView('newgame'));
    r.querySelector('#start-btn-load').addEventListener('click', () => this._openLoad());
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

    // Solo / co-op toggle. Re-renders the slot grid so the second
    // panel disappears in solo mode but stays available in co-op.
    const soloBtns = r.querySelectorAll('[data-solo-mode]');
    const applySoloUi = () => {
      soloBtns.forEach((b) => {
        const on = b.dataset.soloMode === (this.solo ? 'solo' : 'coop');
        b.classList.toggle('active', on);
      });
      this.root.classList.toggle('solo', this.solo);
    };
    if (this.forceSolo) {
      // Hide the coop toggle row in builds that don't support it. The
      // surrounding container collapses cleanly when both buttons are
      // gone, so the seed input + confirm button slide up unchanged.
      soloBtns.forEach((b) => { b.style.display = 'none'; });
    } else {
      soloBtns.forEach((b) => {
        b.addEventListener('click', () => {
          const next = b.dataset.soloMode === 'solo';
          if (next === this.solo) return;
          this.solo = next;
          applySoloUi();
          this._renderSlots();
          this._resizePreviews();
          // Reset cursors so a gamepad-2 cursor that was on the (now-
          // hidden) slot[1] doesn't strand. _defaultRegionFor picks
          // shared0 in solo and slot1 in co-op.
          for (let i = 0; i < this._gpCursors.length; i++) {
            this._gpCursors[i].regionId = this._defaultRegionFor(i);
            this._gpCursors[i].row = 0;
            this._gpCursors[i].col = 0;
            this._gpCursors[i].desiredCenterX = null;
          }
        });
      });
    }
    applySoloUi();

    r.querySelector('#start-btn-confirm').addEventListener('click', () => {
      const seed = (this.seed && this.seed.length > 0) ? this.seed : randomSeed();
      const slotCount = this.solo ? 1 : 2;
      const players = this.config.slice(0, slotCount).map((c) => ({
        character: c.character,
        color: presetHex(PLAYER_COLOR_PRESETS, c.color),
        capeColor: presetHex(CAPE_COLOR_PRESETS, c.cape),
        weapon: c.weapon,
      }));
      this.close();
      this.onStart && this.onStart({ mode: 'new', seed, players, solo: this.solo });
    });

    // Confirm button on the load view — visible only when a save was
    // detected. Hands the saved seed back to main.js so the world is
    // rebuilt deterministically before SaveSystem.apply() lays the
    // saved entity state on top. We also pass back the per-player
    // cosmetic snapshot (character / body / cape / weapon) — those are
    // resolved at Player construction time, so the load path needs them
    // *before* `Game` builds the players, not later in apply().
    r.querySelector('#start-btn-load-confirm')?.addEventListener('click', () => {
      const blob = SaveSystem.read();
      if (!blob) return;
      const seed = blob.seed || this.seed || randomSeed();
      const players = Array.isArray(blob.players)
        ? blob.players.map((p) => ({
          character: (p && CHARACTER_BY_ID[p.character]) ? p.character : 'knight',
          color: (p && typeof p.color === 'number') ? p.color : null,
          capeColor: (p && typeof p.capeColor === 'number') ? p.capeColor : null,
          weapon: (p && typeof p.weaponKind === 'string') ? p.weaponKind : null,
        }))
        : null;
      this.close();
      this.onStart && this.onStart({ mode: 'load', seed, players, solo: !!blob.solo });
    });

    window.addEventListener('resize', () => this._resizePreviews());
  }

  // Switch to the load view and populate it with whatever's in
  // localStorage. When there's no save we keep the existing empty-state
  // copy and hide the confirm button; otherwise we show a one-line
  // summary (seed + saved-at timestamp) and reveal the confirm button.
  _openLoad() {
    this._showView('load');
    const r = this.root;
    const empty = r.querySelector('.start-load-empty');
    const summary = r.querySelector('#start-load-summary');
    const confirm = r.querySelector('#start-btn-load-confirm');
    const blob = SaveSystem.read();
    if (!blob) {
      if (empty) empty.style.display = '';
      if (summary) { summary.style.display = 'none'; summary.textContent = ''; }
      if (confirm) confirm.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (summary) {
      const seed = blob.seed ? `Сид: ${blob.seed}` : 'Сид: ?';
      const when = blob.savedAt ? new Date(blob.savedAt).toLocaleString() : '';
      summary.textContent = when ? `${seed} · ${when}` : seed;
      summary.style.display = '';
    }
    if (confirm) confirm.style.display = '';
  }

  _openSettings() {
    if (!this.pauseMenu) return;
    this.pauseMenu.open();
  }

  // ---- Slot rendering ---------------------------------------------------

  _renderSlots() {
    const wrap = this.root.querySelector('#start-slots');
    if (!wrap) return;
    // Tear down existing preview canvases so the WebGL contexts get
    // released before the slot DOM is replaced — otherwise switching
    // between solo/coop leaks renderers each time.
    for (const prev of this._previews || []) {
      if (prev?.renderer) prev.renderer.dispose();
    }
    this._previews = [];
    this._weaponRows = [];
    wrap.innerHTML = '';
    const count = this.solo ? 1 : 2;
    for (let i = 0; i < count; i++) {
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

    // ---- Character picker ----
    // KayKit Adventurers / Skeletons are all `Rig_Medium` skinned meshes,
    // so swapping characters means rebuilding the whole preview clone (we
    // can't just re-skin in place). The handler below tears down the
    // existing preview and recreates it with the new model so colour /
    // weapon overrides re-apply against the freshly-spawned mesh.
    const charLabel = document.createElement('div');
    charLabel.className = 'start-section-label';
    charLabel.textContent = 'Персонаж';
    slot.appendChild(charLabel);
    const charRow = document.createElement('div');
    charRow.className = 'start-character-grid';
    for (const def of CHARACTERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'start-character-chip';
      btn.setAttribute('data-character', def.id);
      btn.title = def.label;
      btn.textContent = def.label;
      if (this.config[index].character === def.id) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (this.config[index].character === def.id) return;
        this.config[index].character = def.id;
        charRow.querySelectorAll('.start-character-chip').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-character') === def.id);
        });
        this._rebuildPreviewCharacter(index);
      });
      charRow.appendChild(btn);
    }
    slot.appendChild(charRow);

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
    // Stash the row + chip refs for affinity-marker refreshes when the
    // user swaps character — the bonus is per-character, so the star
    // and tooltip have to update without rebuilding the picker (which
    // would lose the user's current weapon pick).
    this._weaponRows[index] = weaponRow;
    this._refreshWeaponAffinity(index);

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
    const character = this._spawnPreviewCharacter(cfg);
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

  // Build a fresh preview character from the slot's current config.
  // Shared between initial setup and the picker's character-swap path so
  // both routes resolve the `skinAware` flag and tint args identically.
  _spawnPreviewCharacter(cfg) {
    const def = CHARACTER_BY_ID[cfg.character] || CHARACTERS[0];
    return spawnCharacter(def.kind, {
      tint: presetHex(PLAYER_COLOR_PRESETS, cfg.color),
      capeTint: presetHex(CAPE_COLOR_PRESETS, cfg.cape),
      scale: 0.9,
      skinAware: !!def.skinAware,
      // Pass the catalog row through so `setEquippedWeapon` can
      // toggle the right built-in weapon meshes for non-Knight
      // characters (Barbarian's axe, Mage's staff, Rogue's knife).
      characterDef: def,
    });
  }

  // Tear down the existing preview character and respawn from the
  // slot's current config. KayKit `Rig_Medium` skinned meshes can't be
  // re-skinned in place — every clone is a fresh skinned mesh hierarchy
  // — so on character switch we have to drop the old one and rebuild.
  _rebuildPreviewCharacter(index) {
    const p = this._previews[index];
    if (!p) return;
    const cfg = this.config[index];
    if (p.character?.root) {
      p.scene.remove(p.character.root);
      // Detach from any animation mixer references — the GC will collect
      // the skeleton clones once the scene drops them. Materials are
      // per-instance (toon-cloned in spawnCharacter) so leaking them
      // would compound across rapid character toggling; null the cache
      // so the next applyCharacterTint walks the new mesh fresh.
      p.character.mixer?.stopAllAction?.();
    }
    const character = this._spawnPreviewCharacter(cfg);
    p.scene.add(character.root);
    setEquippedWeapon(character, cfg.weapon);
    character.root.rotation.y = 0;
    p.character = character;
    // Re-stamp affinity markers on the weapon picker: the bonus is
    // tied to the chosen character, so a swap (Knight → Mage) needs
    // the star + bonus tooltip to migrate from the swords to staff/wand.
    this._refreshWeaponAffinity(index);
  }

  // Update each weapon chip's tooltip + visual marker to reflect the
  // active character's weaponAffinity table. Called once at slot build
  // and every time the character toggles. Idempotent.
  _refreshWeaponAffinity(index) {
    const row = this._weaponRows[index];
    if (!row) return;
    const cfg = this.config[index];
    const def = CHARACTER_BY_ID[cfg.character] || CHARACTERS[0];
    for (const chip of row.querySelectorAll('.start-weapon-chip')) {
      const id = chip.getAttribute('data-weapon');
      const profile = WEAPONS[id];
      if (!profile) continue;
      const affinity = weaponAffinityFor(def, id);
      const bonus = affinity > 1 ? ` · ★ +${Math.round((affinity - 1) * 100)}%` : '';
      chip.title = `${profile.label} · урон ×${profile.damageMult.toFixed(1)} · КД ${profile.cooldown.toFixed(2)}с${bonus}`;
      chip.classList.toggle('affinity', affinity > 1);
    }
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
      this._handleGamepadNav();
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

  // ---- Gamepad navigation (multi-pad, 2D grid, hold-to-repeat) --------
  //
  // The start menu polls *every* connected gamepad slot per frame, with
  // each slot driving its own focus cursor through a region of the UI.
  // Slot 0 owns the shared header / footer plus the first player panel;
  // slot 1 owns the second player panel (in co-op) or shares slot 0's
  // region (in solo). Each cursor moves through a 2D grid of focusable
  // buttons computed from the actual rendered layout, so e.g. pressing
  // Down on the bottom colour-swatch row jumps to the weapon picker
  // instead of scrolling sideways through 13 more swatches.
  _handleGamepadNav() {
    if (!this.root?.classList.contains('open')) return;
    // Pause menu opens as an overlay (Settings entry); when it's up it
    // owns the gamepad, so skip our own polling to avoid both layers
    // reacting to the same press.
    if (this.pauseMenu?.isOpen) return;

    // Refresh the region cache whenever the active view changes, the
    // solo/coop toggle flips, or the slot grid is rebuilt. Cheap to
    // rebuild from scratch every frame; we don't bother memoizing.
    const regions = this._buildGamepadRegions();
    if (!regions || regions.shared0.rows.length === 0) return;

    const connectedSlots = listConnectedGamepadSlots();
    // Toggle the controls-hint visibility based on whether *any* pad
    // is currently connected. Users who navigate purely by mouse /
    // keyboard never see the gamepad legend, which keeps the picker
    // visually clean.
    this.root.classList.toggle('gp-connected', connectedSlots.length > 0);
    if (connectedSlots.length === 0) return;

    // Poll each connected pad. Multiple pads can move independently in
    // the same frame; if two pads happen to confirm the same button on
    // the same frame we click it twice (harmless — the click handler is
    // idempotent for swatches/chips).
    for (const slot of connectedSlots) {
      const navState = this._gpNavStates[slot];
      const nav = readGamepadNavSlot(navState, slot, { repeat: true });
      if (!nav?.any) continue;
      this._applyGamepadNavToSlot(slot, nav, regions);
    }

    this._refreshGamepadFocus(regions);
  }

  // Move cursor `slot` in response to one frame's nav events. Splits
  // out of `_handleGamepadNav` so the per-pad logic stays readable.
  _applyGamepadNavToSlot(slot, nav, regions) {
    const cursor = this._gpCursors[slot];
    // Back button: bounce to the main view from any sub-view. Confirmed
    // by gamepad 0 only — if gamepad 1 hits Back we treat it as a
    // "reset my cursor to my region's top" instead, since slot 2 hitting
    // Back to leave the picker mid-coop-setup would be jarring.
    if (nav.back) {
      if (slot === 0) {
        const active = this.root.querySelector('.start-view.active');
        if (active?.dataset.view !== 'main') {
          this._showView('main');
          return;
        }
      } else {
        cursor.row = 0;
        cursor.col = 0;
        cursor.desiredCenterX = null;
        return;
      }
    }

    // Resolve which region this cursor sits in for the current view.
    // Fallback chain handles the case where the user toggled solo/coop
    // while the secondary cursor was on slot[1] (which no longer exists
    // in solo) — we drop it back to slot 0's region with a fresh cursor.
    let region = regions[cursor.regionId];
    if (!region || region.rows.length === 0) {
      cursor.regionId = this._defaultRegionFor(slot);
      region = regions[cursor.regionId];
      cursor.row = 0; cursor.col = 0; cursor.desiredCenterX = null;
    }
    if (!region || region.rows.length === 0) return;

    // Clamp row/col into bounds against the freshly-rebuilt grid — a
    // re-render between frames may have changed row counts.
    cursor.row = Math.max(0, Math.min(cursor.row, region.rows.length - 1));
    let row = region.rows[cursor.row];
    cursor.col = Math.max(0, Math.min(cursor.col, row.length - 1));

    // Up / down: move between rows, preserving the cursor's visual
    // column. `desiredCenterX` is sticky across vertical moves so a
    // run of up-down navigation traces a vertical line through the
    // UI even when target rows have wildly different counts.
    if (nav.up || nav.down) {
      if (cursor.desiredCenterX == null) {
        cursor.desiredCenterX = this._elementCenterX(row[cursor.col]);
      }
      const dir = nav.up ? -1 : 1;
      cursor.row = Math.max(0, Math.min(region.rows.length - 1, cursor.row + dir));
      row = region.rows[cursor.row];
      cursor.col = this._nearestColByCenterX(row, cursor.desiredCenterX);
    }

    // Left / right: move within the current row. Each lateral move
    // updates `desiredCenterX` so a subsequent up/down move tracks the
    // new column position. Shoulder buttons mirror left/right so the
    // user can flick through long colour rows with LB/RB if they want.
    if (nav.left || nav.shoulderLeft) {
      cursor.col = Math.max(0, cursor.col - 1);
      cursor.desiredCenterX = this._elementCenterX(row[cursor.col]);
    }
    if (nav.right || nav.shoulderRight || nav.tab) {
      cursor.col = Math.min(row.length - 1, cursor.col + 1);
      cursor.desiredCenterX = this._elementCenterX(row[cursor.col]);
    }

    if (nav.confirm) {
      const el = region.rows[cursor.row]?.[cursor.col];
      if (el && !el.disabled) {
        // Inputs (the seed field): focus instead of click so on-screen
        // keyboard / OS edit affordances can take over.
        if (el.tagName === 'INPUT') el.focus();
        else el.click();
      }
    }
  }

  // Build a fresh per-region 2D grid of focusable elements from the
  // current DOM. Regions:
  //   - 'shared0': everything outside `.start-slot[data-slot="1"]` (in
  //     newgame view: header seed/mode controls, slot[0] panel, and
  //     the back/confirm footer). In solo this *is* the whole grid.
  //   - 'slot1':   focusables inside the second player slot (co-op
  //     only; absent in solo). Owned by gamepad 1.
  // Other views (main / load) collapse into a single shared region.
  //
  // Rows are detected from the rendered bounding boxes — same `top`
  // (within ±5px) means "same row" — so flex-wrap colour palettes
  // become proper multi-row navigation even though they're authored
  // as a single DOM container.
  _buildGamepadRegions() {
    if (!this.root) return null;
    const active = this.root.querySelector('.start-view.active');
    if (!active) return null;
    const selector = 'button:not(:disabled), input[type=text]';
    const all = [...active.querySelectorAll(selector)].filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (all.length === 0) return { shared0: { rows: [] }, slot1: { rows: [] } };

    const slot1Container = active.querySelector('.start-slot[data-slot="1"]');
    const sharedElems = [];
    const slot1Elems = [];
    for (const el of all) {
      if (slot1Container && slot1Container.contains(el)) slot1Elems.push(el);
      else sharedElems.push(el);
    }

    return {
      shared0: { rows: this._groupElementsIntoRows(sharedElems) },
      slot1: { rows: this._groupElementsIntoRows(slot1Elems) },
    };
  }

  // Group a flat list of elements into rows by rendered Y position.
  // Tolerance of 6px absorbs sub-pixel layout jitter without merging
  // legitimately separate rows (the smallest gap between visual rows
  // in the picker is ~10-12px). Within each row, elements are sorted
  // by their left edge so left/right nav follows reading order.
  _groupElementsIntoRows(elems) {
    const TOLERANCE = 6;
    const buckets = [];
    for (const el of elems) {
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      let bucket = buckets.find((b) => Math.abs(b.cy - cy) <= TOLERANCE);
      if (!bucket) {
        bucket = { cy, items: [] };
        buckets.push(bucket);
      } else {
        // Recentre the bucket toward the running average so a long row
        // doesn't slowly drift past the tolerance window.
        bucket.cy = (bucket.cy * bucket.items.length + cy) / (bucket.items.length + 1);
      }
      bucket.items.push({ el, left: r.left });
    }
    buckets.sort((a, b) => a.cy - b.cy);
    return buckets.map((b) => b.items.sort((x, y) => x.left - y.left).map((x) => x.el));
  }

  _elementCenterX(el) {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  }

  // Pick the element in `row` whose horizontal centre is closest to
  // `targetX`. Used after a vertical move to land on the element that
  // best preserves the cursor's current column.
  _nearestColByCenterX(row, targetX) {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < row.length; i++) {
      const r = row[i].getBoundingClientRect();
      const d = Math.abs((r.left + r.width / 2) - targetX);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    return bestIdx;
  }

  // Repaint the visual focus rings for every cursor. Each gamepad gets
  // its own colour class (P1 blue, P2 coral) so simultaneous co-op
  // configuration is readable at a glance. We strip *all* focus
  // classes first, then stamp the per-cursor class — cheap (the menu
  // has on the order of 50 buttons) and avoids tracking which classes
  // were applied last frame.
  _refreshGamepadFocus(regions) {
    if (!this.root) return;
    if (!regions) regions = this._buildGamepadRegions();
    if (!regions) return;
    this.root.querySelectorAll('.gp-focus-p1, .gp-focus-p2, .gp-focus').forEach((el) => {
      el.classList.remove('gp-focus-p1', 'gp-focus-p2', 'gp-focus');
    });
    const connectedSlots = listConnectedGamepadSlots();
    if (connectedSlots.length === 0) return;
    for (const slot of connectedSlots) {
      const cursor = this._gpCursors[slot];
      const region = regions[cursor.regionId];
      if (!region || region.rows.length === 0) continue;
      const row = region.rows[Math.min(cursor.row, region.rows.length - 1)];
      if (!row || row.length === 0) continue;
      const el = row[Math.min(cursor.col, row.length - 1)];
      if (!el) continue;
      el.classList.add(GP_FOCUS_CLASS[slot] || 'gp-focus-p1');
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  _stopPreviewLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
