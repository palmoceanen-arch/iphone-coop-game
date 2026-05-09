import * as THREE from 'three';
import { World } from './world.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Projectile } from './projectile.js';
import { spawnDrops } from './pickups.js';
import { Effects } from './effects.js';
import { FollowCamera } from './camera.js';
import { Sound } from './sound.js';
import { Input } from './input.js';
import { UPGRADES, buy, renderShop, priceFor } from './upgrades.js';
import { vdist, clamp, hashString, setDefaultSeed, defaultRandom, compactInPlace } from './utils.js';
import { getSettings } from './settings.js';
import { PauseMenu } from './pause.js';
import {
  runItemHook,
  ITEM_BY_ID,
  pickRandomItemId,
  pickRandomItemIdInRarityExcept,
  rarityAbove,
  RARITY,
} from './items.js';
import { ABILITY_BY_ID, AbilityProjectile } from './abilities.js';
import { Rune } from './runes.js';
import { Chest } from './chest.js';
import { Breakable } from './breakable.js';
import { Resource, harvestYield } from './resource.js';
import {
  Structure, RECIPES, buildStructureMesh, buildFenceMesh, buildGateMesh, buildDoorFullMesh,
  buildWoodWallMesh, buildGlassWallMesh, buildRoofPitchedMesh,
  GATE_OPEN_RADIUS, structureMaterial, pickRandomRoofColor,
} from './structure.js';
import { BuildController } from './buildMode.js';
import { Crop, CROPS, CROP_ORDER, cropLabel } from './farming.js';
import { spawnHarvestDrops } from './pickups.js';
import { Altar, ALTAR_USE_RADIUS, REROLL_COST } from './altar.js';
import { AltarUI } from './altarUI.js';
import { BuildWheel } from './buildWheel.js';
import { Minimap } from './minimap.js';
import { iconHTML } from './icons.js';
import { SaveSystem } from './saveSystem.js';
import {
  RECIPES as COOK_RECIPES, RECIPE_ORDER as COOK_RECIPE_ORDER,
  canCook, cook, recipeCostLabel, buffLabel,
  COOK_HOLD_S, EAT_HOLD_S, COOK_INTERACT_RADIUS,
} from './cooking.js';

const LEASH_WARN = 14;
const LEASH_MAX  = 22;
const LEASH_DRAIN = 14;
const REVIVE_RANGE = 2.5;        // metres
const REVIVE_HOLD = 2.0;         // seconds of dashHeld required
const REVIVE_HP = 0.5;           // fraction of maxHP after revive

// Fixed simulation timestep used by Game._loop. 1/60s mirrors the
// historical RAF cadence so balance / feel doesn't shift, while still
// giving us a deterministic step size that's independent of monitor
// refresh rate (60/120/144 Hz panels all advance the simulation at the
// same rate).
const FIXED_DT = 1 / 60;
// Cap how many fixed-steps we may catch up in a single RAF callback.
// A long stall (e.g. 1s freeze on tab restore) would otherwise queue 60
// steps and freeze the page further; instead we discard the surplus and
// move on.
const MAX_STEPS_PER_FRAME = 5;

// Heuristic to detect mobile / integrated GPUs that may struggle with
// shadow mapping or aggressive WebGL options.
function isLikelyLowEndGPU() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod|android|mobile/.test(ua)) return true;
  return false;
}

// Build a WebGLRenderer with progressively-degraded options. iOS Safari /
// older mobile browsers occasionally fail to allocate a context with
// antialias=true, so we fall back to no-AA, then to an explicit WebGL1
// context if needed.
function createRenderer(canvas) {
  const attempts = [
    { antialias: true,  powerPreference: 'high-performance' },
    { antialias: false, powerPreference: 'default' },
    { antialias: false, powerPreference: 'low-power' },
  ];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      const r = new THREE.WebGLRenderer({ canvas, ...opts, preserveDrawingBuffer: false });
      // Listen for context loss so we can show a graceful message instead of
      // a hard crash if the GPU drops the context later (common on iOS when
      // backgrounding the tab).
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        console.warn('[renderer] WebGL context lost');
      });
      return r;
    } catch (err) {
      lastErr = err;
      console.warn('[renderer] WebGL attempt failed:', opts, err?.message || err);
    }
  }
  // Final fallback: surface a friendly error in the DOM.
  const msg = document.createElement('div');
  msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;background:#222;font:16px system-ui;padding:20px;text-align:center;';
  msg.innerHTML = `Не удалось инициализировать WebGL.<br>На iPhone попробуй зайти на <code>/controller</code> вместо хост-страницы.<br><br>${(lastErr?.message || lastErr || '')}`;
  document.body.appendChild(msg);
  throw lastErr || new Error('WebGL init failed');
}

function getSeedFromUrl() {
  const params = new URLSearchParams(window.location.search);
  let seed = params.get('seed');
  if (!seed) {
    // generate a memorable 6-char alphanumeric and put it in URL
    seed = Math.floor(Math.random() * 1_000_000).toString(36).toUpperCase().padStart(4, '0');
    params.set('seed', seed);
    const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState({}, '', newUrl);
  }
  return { display: seed, value: hashString(seed) };
}

export class Game {
  constructor(opts = {}) {
    this.canvas = document.getElementById('canvas');
    this.renderer = createRenderer(this.canvas);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Shadows are disabled on mobile/integrated GPUs to avoid context loss.
    const enableShadows = !isLikelyLowEndGPU();
    this.renderer.shadowMap.enabled = enableShadows;
    if (enableShadows) {
      // PCFShadowMap samples on a fixed kernel, so shadow edges stay stable
      // frame-to-frame as the camera/sun move. PCFSoftShadowMap uses a
      // screen-space derivative jitter for its softness, which produces the
      // "shadow swimming" shimmer most visible on the long sunrise/sunset
      // tree shadows. Softness is recovered via DirectionalLight.shadow.radius
      // (configured in src/world.js).
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    }

    this.scene = new THREE.Scene();
    const seedInfo = opts.seed ? { display: String(opts.seed), value: hashString(String(opts.seed)) } : getSeedFromUrl();
    this.seedDisplay = seedInfo.display;
    // Seed the runtime RNG (utils.defaultRandom / rand / chance / pick) from
    // the world seed so gameplay rolls (drop chance, damage variance, AI
    // wander, particle directions for gameplay effects, etc.) replay
    // identically when a save with the same seed is loaded.
    setDefaultSeed(seedInfo.value ^ 0xC0FFEE);
    this.world = new World(this.scene, seedInfo.value);
    this.followCam = new FollowCamera(this.canvas);

    this.sound = new Sound();
    // Hand the world to the audio layer so its `updateAmbient` can probe
    // for nearby water and read the live day-weight without us threading
    // the world through every call.
    this.sound.setWorld(this.world);
    this.input = new Input();
    this.effects = new Effects(this.scene, this.followCam.cam);

    // Per-slot start-menu loadout (body / cape colours + starter weapon).
    // Each entry is `{ color: hexInt, capeColor: hexInt, weapon: 'sword_1h'|... }`
    // and may be partially populated; missing fields fall back to the
    // per-slot defaults inside Player. When `opts.players` is omitted
    // entirely the original cyan-sword / coral-axe defaults still apply.
    const playerOpts = Array.isArray(opts.players) ? opts.players : [];
    this.players = [
      new Player(0, this.world, this.effects, this.sound, playerOpts[0] || {}),
      new Player(1, this.world, this.effects, this.sound, playerOpts[1] || {}),
    ];
    // Solo mode: hide and freeze player 2 so a single player can run the
    // whole game without the other slot ever showing up. We still build
    // the second Player instance so partner-aware code (item hooks, leash
    // math, two-camera fit, save/load) keeps its existing 2-slot shape.
    this.solo = !!opts.solo;
    if (this.solo) {
      const ghost = this.players[1];
      ghost._phantom = true;
      ghost.alive = true;
      if (ghost.mesh) ghost.mesh.visible = false;
      // Glue the phantom to player 0 so the leash distance is always 0
      // (no drain) and so any AoE that catches both at once just hits
      // the live player twice through the same point.
      ghost.pos.x = this.players[0].pos.x;
      ghost.pos.z = this.players[0].pos.z;
      ghost.smoothPos = { x: ghost.pos.x, z: ghost.pos.z };
      // Tag the body so HUD CSS hides the P2 health bar / gold / build bar.
      try { document.body?.classList?.add('solo'); } catch { /* no-op */ }
    } else {
      try { document.body?.classList?.remove('solo'); } catch { /* no-op */ }
    }
    // Starter abilities so phone & desktop have something to cast immediately.
    this.players[0].setAbility('fireball');
    this.players[1].setAbility('icebolt');
    this.enemies = [];
    this.projectiles = [];
    this.abilityProjectiles = [];
    this.pickups = [];
    this.runes = [];   // item / ability rune drops in the world
    this.chests = []; // procedurally placed treasure chests
    this.breakables = []; // pots / crates scattered through chunks
    this.altars = []; // rare item-management altars
    this.resources = []; // harvestable trees / rocks (damageable resource nodes)
    this.structures = []; // player-placed structures (fences / walls / gates / planters)
    // Live Crop entities (M3 farming). One per planter that has been
    // tilled-or-later — never spawned for an 'empty' planter on chunk
    // load (we only build the Crop on first interact / on rehydrate from
    // a non-empty descriptor). Indexed alongside `structures` by
    // chunkKey for chunk-unload cleanup.
    this.crops = [];
    // One BuildController per player, lazily activated when the player
    // presses a recipe-select key. Stays alive across the session so the
    // player's last-used recipe / yaw is preserved when they re-enter.
    this.builders = [];
    // Shared resource pool — wood / stone / seeds. Both players share this
    // because building consumes from the world (unlike personal gold which
    // each player spends on their own upgrades). Future M3 farming will
    // populate `seeds` from chests; for now it stays at 0.
    // The structure also lives on `this.world.resources` so other modules
    // (e.g. pickups) and any future save-system entry point can reach it
    // through a single canonical pointer.
    this.world.resources = { wood: 0, stone: 0, seeds: 0 };

    this.altarUI = new AltarUI();
    this.altarOpen = false;

    // One build-wheel UI per player so a couch-coop pair can each have
    // their own picker open. Constructed up front so the DOM nodes are
    // ready before the first hotkey press.
    this.buildWheels = [new BuildWheel(0), new BuildWheel(1)];

    // When the world streams a chunk out we need to despawn any
    // entities that lived inside it so their THREE meshes are
    // released alongside the chunk's group. Living-but-unloaded
    // entities are dropped (they'll respawn when the chunk reloads
    // because they aren't in the consumed sets); destroyed entities
    // were already marked consumed during their normal cleanup pass.
    //
    // _onCaptureChunkState fires *before* despawn so we can snapshot
    // hp / pos / state into world.chunkOverrides while the entities
    // are still healthy. The capture is a no-op while `_loading` is
    // true (a save is being applied) so we don't accidentally write
    // procedural-baseline state back over the save we just loaded.
    this.world._onChunkUnload = (key) => this._despawnChunkEntities(key);
    this.world._onCaptureChunkState = (key) => this._captureChunkState(key);
    // Set during SaveSystem.apply() → _unloadAllChunks() → reload, so
    // capture skips writing back over the freshly-restored overrides.
    this._loading = false;

    this._spawnInitialEnemies();
    this._drainChestSpawns();
    this._drainBreakableSpawns();
    this._drainAltarSpawns();
    this._drainResourceSpawns();
    this._drainStructureSpawns();
    // _spawnStarterChest() is intentionally deferred until after the
    // load-or-clear branch below so the starter chest can consult the
    // restored _consumedChests set (otherwise a saved run that already
    // opened the starter chest would respawn it on load).
    // Build the per-player build controllers now that scene + world are
    // ready. Construction is cheap; ghost meshes are spawned lazily on
    // first recipe-select.
    this.builders = [
      new BuildController(this.scene, this.world, this.players[0]),
      new BuildController(this.scene, this.world, this.players[1]),
    ];

    // HUD minimap. Rendered every frame from cached per-chunk tiles
    // (see src/minimap.js for the strategy). The canvas is part of
    // index.html so the element exists by constructor time; if it's
    // missing for any reason (e.g. test harness without DOM) we skip
    // minimap wiring entirely instead of throwing.
    const minimapCanvas = document.getElementById('minimap');
    this.minimap = minimapCanvas ? new Minimap(this.world, this.players, minimapCanvas) : null;
    if (this.minimap) {
      // World-side hook: fired when placedStructures changes for a
      // chunk. We just mark the minimap overlay dirty — the actual
      // re-paint happens on the next render() call.
      this.world._onChunkChanged = (key) => this.minimap.invalidate(key);
    }

    this.totalKills = 0;
    this.elapsed = 0;

    this.paused = false;
    this.menuPaused = false; // true while #pause overlay is open
    this.shopOpen = false;
    this._keyboardShop = false;
    this._fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    // Worst single-frame dt seen inside the current FPS window. Tracked so
    // the readout can surface GC pauses / chunk-stream spikes that the
    // averaged frametime would otherwise smooth away.
    this._fpsMaxDt = 0;
    // Per-slot phone shop state (independent from desktop Tab-shop):
    this.phoneShopOpen = [false, false];
    this.lobby = null; // injected from main.js
    this._stateSyncT = 0;
    this.dead = false;
    this.leashRatio = 0;
    this.timescale = 1;

    // Wire user-tunable graphics + audio settings. The Settings module
    // pulls saved values from localStorage in its constructor and applies
    // them to renderer/world/sound/effects/followCam in attach().
    this.settings = getSettings();
    this.settings.attach({
      renderer: this.renderer,
      world: this.world,
      scene: this.scene,
      sound: this.sound,
      followCam: this.followCam,
      effects: this.effects,
    });
    // Reuse a PauseMenu instance constructed earlier (e.g. by main.js so the
    // start menu can open Settings before the Game is built); otherwise build
    // one ourselves. Keeping it singleton-y prevents double event-handler
    // registration on the same DOM nodes.
    this.pauseMenu = opts.pauseMenu || new PauseMenu(this.settings);
    // Persistent save/load — backed by localStorage today, but the on-disk
    // shape is a plain JSON object so the same payload can be POSTed to a
    // server later. Constructed *after* spawn drains so the world's
    // procedural state exists before any save is applied on top.
    this.saveSystem = new SaveSystem(this);
    // World mutations route here so writes are debounced — many small
    // edits coalesce into one localStorage write per ~1.5s window.
    this.world._onPersistDirty = () => this.saveSystem?.markDirty();
    // Right before the SaveSystem stringifies the live state, walk every
    // currently-loaded chunk and snapshot its enemies/resources/altars
    // into world.chunkOverrides — otherwise a tab-close mid-game would
    // serialise stale (last-unloaded) override data and lose any damage
    // dealt inside the player's currently-loaded ring.
    this.saveSystem._beforeSerialize = () => this._captureLiveStateForSave();
    // Pause-menu reset progress button — wipes localStorage and rebuilds
    // the world from scratch via restart(). Wiring goes through PauseMenu
    // so the actual button click is handled inside that module.
    if (this.pauseMenu) this.pauseMenu.onResetProgress = () => this._resetProgress();
    // Only restore from localStorage if the caller explicitly asked for
    // it (e.g. the start-menu's "Загрузить" path). The "Новая игра" path
    // passes loadSave=false so we always start with a clean slate even
    // when the same seed happens to match an existing save. Default of
    // false preserves the new-game-first behaviour for any external
    // callers that don't pass the flag.
    if (opts.loadSave) {
      this._tryLoadSave();
    } else {
      // Starting fresh — nuke any stale save so the first auto-save of
      // this run doesn't accidentally surface in a future "Загрузить"
      // session pointing at the previous game's state.
      SaveSystem.clear();
    }
    // Spawn the starter chest now that any loaded save has populated
    // _consumedChests — the helper will short-circuit if the player
    // already opened it in a previous session.
    this._spawnStarterChest();

    this._bindUI();
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Dev/cheat helpers, exposed via `window.__game.cheat` for quick
    // manual testing (free building, fast gold). Side-effect-only —
    // none of these are referenced by gameplay code paths.
    this.cheat = {
      give: (n = 9999) => {
        if (this.world?.resources) {
          this.world.resources.wood = (this.world.resources.wood || 0) + n;
          this.world.resources.stone = (this.world.resources.stone || 0) + n;
          this.world.resources.seeds = (this.world.resources.seeds || 0) + n;
        }
        for (const p of this.players || []) {
          if (p && !p._phantom) p.gold = (p.gold || 0) + n;
        }
        return {
          wood: this.world?.resources?.wood,
          stone: this.world?.resources?.stone,
          seeds: this.world?.resources?.seeds,
          gold: this.players?.[0]?.gold,
        };
      },
      wood: (n = 9999) => {
        if (this.world?.resources) this.world.resources.wood = (this.world.resources.wood || 0) + n;
        return this.world?.resources?.wood;
      },
      stone: (n = 9999) => {
        if (this.world?.resources) this.world.resources.stone = (this.world.resources.stone || 0) + n;
        return this.world?.resources?.stone;
      },
      seeds: (n = 9999) => {
        if (this.world?.resources) this.world.resources.seeds = (this.world.resources.seeds || 0) + n;
        return this.world?.resources?.seeds;
      },
      gold: (n = 9999) => {
        for (const p of this.players || []) {
          if (p && !p._phantom) p.gold = (p.gold || 0) + n;
        }
        return (this.players || []).map((p) => p?.gold);
      },
      hp: () => {
        for (const p of this.players || []) {
          if (p && !p._phantom) p.hp = p.maxHP;
        }
        return (this.players || []).map((p) => p?.hp);
      },
    };

    // start screen
    this._waitingForStart = true;
    this._lastT = performance.now();
    // Fixed-timestep accumulator. Game logic always advances in slices of
    // exactly FIXED_DT seconds so simulation is reproducible from a seed
    // independent of frame rate. Rendering still happens once per RAF
    // tick; only `update(dt)` runs at the fixed rate, with up to
    // MAX_STEPS_PER_FRAME steps per frame to absorb hitches without
    // letting the queue spiral unbounded.
    this._fixedAccum = 0;
    requestAnimationFrame((t) => this._loop(t));
  }

  _bindUI() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP') this.paused = !this.paused;
      if (e.code === 'Escape') {
        e.preventDefault();
        // Esc closes the altar UI before falling through to the pause menu
        // so it works as the universal "back" key.
        if (this.altarOpen) { this.altarUI.close(); return; }
        // Same for any open build-wheel: prefer dismissing the picker
        // over opening pause when the player is mid-pick.
        for (const w of this.buildWheels || []) {
          if (w?.isOpen) { w.close(); return; }
        }
        this._togglePauseMenu();
      }
      if (e.code === 'KeyG') this._tryCastAbility(0);
      if (e.code === 'KeyH') this._tryCastAbility(1);
      // Minimap is hidden by default; M toggles a UI panel. We swallow
      // the keypress before any game system sees it, but only when the
      // player isn't typing into a text field (so the seed input on the
      // start menu and shop search still receive 'm'). Also gated on
      // _waitingForStart so the lobby flow stays clean.
      if (e.code === 'KeyM' && !this._waitingForStart) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          this._toggleMinimap();
        }
      }
    });
    if (this.pauseMenu) {
      this.pauseMenu.onToggle = (open) => {
        this.menuPaused = !!open;
      };
    }
    document.getElementById('restart')?.addEventListener('click', () => this.restart());
  }

  _togglePauseMenu() {
    if (!this.pauseMenu) return;
    // Don't open the menu over the intro lobby — that's already a modal and
    // the player hasn't actually started yet.
    if (this._waitingForStart) return;
    this.pauseMenu.toggle();
    this.menuPaused = this.pauseMenu.isOpen;
  }

  _toggleMinimap() {
    // The minimap canvas is hidden via CSS (`#minimap` has display:none;
    // `.open` flips it to display:block). `Minimap.render()` reads the
    // same `.open` class and short-circuits when the panel is closed,
    // so toggling here also turns the per-frame minimap work on / off
    // (~16 drawImage calls + any pending tile bakes saved while
    // closed). Tile / overlay caches survive across toggles so reopen
    // is instant for the chunks that were last revealed.
    const el = document.getElementById('minimap');
    if (!el) return;
    el.classList.toggle('open');
  }

  _tryCastAbility(slot) {
    if (this._waitingForStart || this.paused || this.menuPaused || this.shopOpen || this.altarOpen || this.dead) return;
    const player = this.players[slot];
    if (!player) return;
    const partner = this.players[1 - slot];
    // Pass the cached damageables list so AoE / chain-lightning style
    // abilities also break pots & crates in the area. Falls back to the
    // raw enemies list if the damageables snapshot hasn't been built yet
    // (e.g. when the player casts on the very first frame).
    const targets = this._damageables || this.enemies;
    // `enemyList` carries every damageable (enemies + pots/crates + trees /
    // rocks + player-built structures) so AoE explosions still break crates
    // in their blast radius. `livingEnemies` is the strict subset that
    // actually counts as a hostile creature — auto-aiming abilities (ice
    // bolt, chain lightning, slow-time, wind-push, …) target through this
    // list so player-placed walls / fences / trees never steal the lock-on.
    const ctx = {
      enemyList: targets,
      livingEnemies: this.enemies,
      partner,
      effects: this.effects,
      sound: this.sound,
      scene: this.scene,
      spawnAbilityProjectile: (opts) => {
        const ap = new AbilityProjectile(this.scene, opts);
        this.abilityProjectiles.push(ap);
      },
    };
    if (player.tryCastAbility(ctx)) {
      this.effects.shakeCamera(0.1);
    }
  }

  // ---- Phone gamepad shop ------------------------------------------------
  handleRemoteEvent(slot, event) {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'shop') {
      this.phoneShopOpen[slot] = !this.phoneShopOpen[slot];
      this._refreshShopState();
      this._pushPlayerState(slot);
      return;
    }
    if (event.type === 'buy' && this.phoneShopOpen[slot]) {
      const idx = UPGRADES.findIndex(u => u.id === event.id);
      if (idx >= 0) {
        const ok = buy(this.players[slot], UPGRADES[idx], this.sound);
        if (ok && this._keyboardShop) {
          renderShop(this.players[0], this.players[1], (s, i) => this._tryBuy(s, i));
        }
        this._pushPlayerState(slot);
      }
      return;
    }
    if (event.type === 'closeShop') {
      this.phoneShopOpen[slot] = false;
      this._refreshShopState();
      this._pushPlayerState(slot);
      return;
    }
    if (event.type === 'cast') {
      this._tryCastAbility(slot);
      return;
    }
    // Otherwise treat as input edge (attack, dash, interact)
    this.input.remoteEvent(slot, event.type);
  }

  _refreshShopState() {
    // Game pauses if EITHER phone is in shop OR keyboard shop is open.
    const anyPhoneShop = this.phoneShopOpen[0] || this.phoneShopOpen[1];
    this.shopOpen = !!(this._keyboardShop || anyPhoneShop);
    // Show PC shop panel when phone OR keyboard opens shop — monitor
    // has room for full descriptions/inventory that phone lacks.
    const showPc = !!(this._keyboardShop || anyPhoneShop);
    document.getElementById('shop')?.classList.toggle('open', showPc);
    if (showPc) {
      renderShop(this.players[0], this.players[1], (slot, idx) => this._tryBuy(slot, idx));
    }
  }

  _tryBuy(slot, idx) {
    const upg = UPGRADES[idx];
    if (!upg) return;
    const player = this.players[slot];
    if (!player) return;
    if (buy(player, upg, this.sound)) {
      if (this._keyboardShop) {
        renderShop(this.players[0], this.players[1], (s, i) => this._tryBuy(s, i));
      }
      this._pushPlayerState(slot);
    }
  }

  _pushPlayerState(slot) {
    if (!this.lobby) return;
    const p = this.players[slot];
    if (!p) return;
    // Solo mode: don't broadcast a phantom slot to the lobby — there's no
    // phone connected to it and the HUD is hidden anyway.
    if (p._phantom) return;
    const upgrades = UPGRADES.map(u => ({
      id: u.id,
      name: u.name,
      desc: u.desc,
      level: p.upgradeLevels[u.id] || 0,
      price: priceFor(p, u),
    }));
    const items = Object.entries(p.items || {}).map(([id, count]) => {
      const def = ITEM_BY_ID[id];
      return def ? { id, name: def.name, icon: def.icon, rarity: def.rarity, count, desc: def.desc || '' } : null;
    }).filter(Boolean);
    let ability = null;
    if (p.ability) {
      const def = ABILITY_BY_ID[p.ability];
      if (def) {
        // Scale `cdMax` by the player's `abilityCdMult` so the phone
        // HUD's cooldown ring uses the player's *effective* cd —
        // matters for the Mage (0.5×), whose ring would otherwise
        // start half-empty after a cast instead of full.
        const cdMult = p.stats?.abilityCdMult ?? 1;
        ability = {
          id: p.ability,
          name: def.name,
          desc: def.desc || '',
          icon: def.icon,
          color: '#' + def.color.toString(16).padStart(6, '0'),
          cd: Math.max(0, p.abilityCd || 0),
          cdMax: def.cd * cdMult,
        };
      }
    }
    this.lobby.sendToSlot(slot, 'state:player', {
      slot,
      hp: Math.round(p.hp),
      maxHp: Math.round(p.maxHP),
      gold: p.gold,
      level: p.level,
      damage: Math.round(p.stats.damage),
      shopOpen: this.phoneShopOpen[slot],
      upgrades,
      items,
      ability,
      interact: this._nearbyInteractFor(slot),
    });
  }

  _nearbyInteractFor(slot) {
    const p = this.players[slot];
    if (!p || !p.alive) return null;
    let best = null;
    let bestD = Infinity;
    // Item runes auto-pickup so they don't need a prompt — only ability runes + chests do.
    for (const r of this.runes) {
      if (!r.alive || r.kind !== 'ability') continue;
      const dx = r.mesh.position.x - p.pos.x;
      const dz = r.mesh.position.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 2.0 && d < bestD) {
        bestD = d;
        const def = ABILITY_BY_ID[r.payloadId];
        best = {
          kind: 'ability',
          label: def ? `Взять «${def.name}»` : 'Взять способность',
          color: def ? '#' + def.color.toString(16).padStart(6, '0') : '#9bd1ff',
        };
      }
    }
    for (const c of this.chests) {
      if (!c.alive || c.opened) continue;
      const dx = c.pos.x - p.pos.x;
      const dz = c.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.6 && d < bestD) {
        bestD = d;
        best = { kind: 'chest', label: 'Открыть сундук', color: '#ffd166' };
      }
    }
    return best;
  }

  _startGame() {
    if (!this._waitingForStart) return;
    const intro = document.getElementById('intro');
    if (intro) intro.style.display = 'none';
    this._waitingForStart = false;
    this.sound.resume();
    this.sound.bell();
  }

  // Wipe the persistent save and reset the run to a fresh procedural
  // world. Triggered by the pause-menu "Сбросить прогресс" button.
  // restart() handles entity teardown + player respawn; we additionally
  // clear the save blob and the world's persistent overrides so the
  // next chunk reload pulls procedural defaults instead of the previous
  // session's snapshots.
  _resetProgress() {
    this.saveSystem?.suspend();
    SaveSystem.clear();
    if (this.world) {
      this.world._consumedChests?.clear();
      this.world._consumedBreakables?.clear();
      this.world._consumedAltars?.clear();
      this.world.chunkOverrides?.clear();
      // dayTime / shared resources are reset by restart() below.
    }
    this.restart();
    // After teardown + respawn, ensure the active chunk ring is rebuilt
    // around the newly-spawned players so the world is fully populated
    // before the next save is taken.
    this.world?._unloadAllChunks?.();
    this._streamChunks();
    this.saveSystem?.resume();
    // Take a fresh snapshot so the cleared save isn't immediately
    // restored from a stale in-memory blob on the next page load.
    this.saveSystem?.markDirty();
  }

  // Restore a previously-saved game on top of the procedural world that
  // the constructor just built. Must be called after the initial spawn
  // drains so live entities exist (and can be torn down by the chunk
  // reload below). Bails when there's no save, the seed mismatches, or
  // the schema is too old.
  _tryLoadSave() {
    const blob = SaveSystem.read();
    if (!blob) return;
    // Reject saves taken under a different seed — the world's chunk
    // generation depends on the seed so override entries pinned to
    // chunk-key strings would land on completely different terrain.
    const currentSeedHash = (this.world?.seed >>> 0);
    if (typeof blob.seedHash === 'number' && blob.seedHash !== currentSeedHash) {
      return;
    }
    if (blob.seed && this.seedDisplay && String(blob.seed) !== String(this.seedDisplay)) {
      return;
    }
    this._loading = true;
    try {
      this.saveSystem.apply(blob);
      // Tear down the procedurally-spawned chunks (and their entities)
      // and let _streamChunks rebuild them with overrides applied.
      // _loading is true so the capture hook is a no-op, keeping the
      // saved chunkOverrides intact through the reload.
      this.world._unloadAllChunks?.();
      this._streamChunks();
    } catch (err) {
      console.warn('[save] apply failed', err);
    } finally {
      this._loading = false;
    }
  }

  // Capture the in-memory state of every entity tied to `chunkKey` into
  // world.chunkOverrides, so a later chunk reload can restore them at
  // the same hp / pos / state instead of rebuilding from procedural
  // defaults. Wired into world via _onCaptureChunkState; fires once per
  // chunk-unload event, just before _despawnChunkEntities runs.
  _captureChunkState(chunkKey) {
    if (this._loading) return;
    if (!this.world || !chunkKey) return;
    // Resources: hp / state / regrowT. toOverride() returns null when
    // the resource is at procedural baseline (full hp, alive); we still
    // record those so a chunk that had its trees fully respawn doesn't
    // carry a stale damaged-tree override from a previous unload cycle.
    if (this.resources && this.resources.length > 0) {
      for (const r of this.resources) {
        if (r.chunkKey !== chunkKey) continue;
        const ov = typeof r.toOverride === 'function' ? r.toOverride() : null;
        this.world.recordResourceOverride(chunkKey, r.pos.x, r.pos.z, ov);
      }
    }
    // Altars: charges. Same null-equals-baseline contract as resources.
    if (this.altars && this.altars.length > 0) {
      for (const a of this.altars) {
        if (a.chunkKey !== chunkKey) continue;
        const ov = typeof a.toOverride === 'function' ? a.toOverride() : null;
        this.world.recordAltarOverride(chunkKey, a.pos.x, a.pos.z, ov);
      }
    }
    // Enemies: snapshot every alive enemy currently inside this chunk.
    // Skipping dead enemies replaces the chunk's enemy list with the
    // surviving ones — when the chunk reloads, only the captured
    // entries are spawned, so a chunk the player cleared stays empty.
    if (this.enemies && this.enemies.length > 0) {
      const captured = [];
      for (const e of this.enemies) {
        if (!e || !e.alive) continue;
        if (e.chunkKey !== chunkKey) continue;
        const ov = typeof e.toOverride === 'function' ? e.toOverride() : null;
        if (ov) captured.push(ov);
      }
      this.world.recordEnemyOverride(chunkKey, captured);
    }
  }

  // Walk every currently-loaded chunk and capture its live state so
  // the next save serialisation reflects the player's latest progress
  // even for chunks that haven't been streamed out yet. SaveSystem
  // calls this from `_serialize` so the cost only lands once per save
  // window (1.5s debounce + idle scheduling), not every frame.
  _captureLiveStateForSave() {
    if (!this.world || !this.world.chunks) return;
    if (this._loading) return;
    for (const key of this.world.chunks.keys()) {
      this._captureChunkState(key);
    }
  }

  restart() {
    // remove enemies, projectiles, pickups
    for (const e of this.enemies) { if (e.alive) e._releaseMesh?.(); }
    for (const p of this.projectiles) { p._destroy?.(); }
    for (const ap of this.abilityProjectiles) { ap._cleanup?.(); }
    for (const p of this.pickups) { p._destroy?.(); }
    for (const r of this.runes) { r._destroy?.(); }
    for (const c of this.chests) { c._destroy?.(); }
    for (const b of this.breakables) { b.destroyMesh?.(); }
    for (const a of this.altars) { a.destroyMesh?.(); }
    // Resources own no THREE meshes themselves (the chunk owns them); we
    // only need to drop the references so on chunk reload they get
    // re-wrapped fresh. The chunk-resident meshes will reappear naturally
    // when the player walks back into the area.
    if (this.altarUI?.isOpen) this.altarUI.close();
    this.altarOpen = false;
    // Drop any open build-wheel UI when the run is reset so the picker
    // doesn't outlive the player it was bound to.
    for (const w of this.buildWheels || []) w?.close?.();
    // Structures: detach their meshes from chunk groups so the rebuilt
    // chunks don't carry stale wall geometry, and clear the persistent
    // placedStructures map so a fresh run starts with no fortress.
    for (const s of this.structures) { s.destroyMesh?.(); s.removeCollider?.(); }
    // Crops are children of planter meshes; structure destroyMesh() above
    // already detached the parent, so we just drop our references.
    for (const c of this.crops) { c.destroy?.(); }
    if (this.world?.placedStructures) this.world.placedStructures.clear();
    if (this.world?.structureSpawns) this.world.structureSpawns.length = 0;
    // Exit any active build mode so ghost previews don't outlive the run.
    for (const b of this.builders || []) { b?.exit?.(); }
    this.enemies = []; this.projectiles = []; this.abilityProjectiles = []; this.pickups = []; this.runes = []; this.chests = []; this.breakables = []; this.altars = []; this.resources = []; this.structures = []; this.crops = [];
    if (this.world?.resources) {
      this.world.resources.wood = 0;
      this.world.resources.stone = 0;
      this.world.resources.seeds = 0;
    }
    // revive players
    for (const p of this.players) {
      p.pos.x = (p.index === 0 ? -3 : 3); p.pos.z = 4;
      p.vel = { x: 0, z: 0 }; p.knockback = { x: 0, z: 0 };
      // Reset render-interp snapshots so respawn doesn't lerp from
      // wherever they last died.
      if (p.smoothPos) { p.smoothPos.x = p.pos.x; p.smoothPos.z = p.pos.z; }
      p._renderPrev = { x: p.pos.x, z: p.pos.z };
      p._renderPos = { x: p.pos.x, z: p.pos.z };
      // Wipe gold + found items + ability + item-buff state on restart.
      // Shop-purchased upgrades persist across deaths (`upgradeLevels`,
      // `stats`, `maxHP` are intentionally NOT touched here) so the
      // upgrade tree behaves like a meta-progression — dying clears
      // your in-run loot but you keep the permanent stat boosts you
      // bought between waves.
      p.gold = 0;
      p.items = {};
      p.ability = null;
      p.abilityCd = 0;
      p._shield = null;
      p._berserk = null;
      p._healAura = null;
      p._foodBuff = null;
      p._itemSpeedMult = 1;
      p.foods = {};
      p.cookedFoods = {};
      p.selectedFood = null;
      p.cookProgress = 0;
      p.revive();
    }
    // Restore starter abilities so players still have something to cast.
    this.players[0].setAbility('fireball');
    this.players[1].setAbility('icebolt');
    this.dead = false;
    this.totalKills = 0;
    this._starterChestSpawned = false;
    this._spawnInitialEnemies();
    this._spawnStarterChest();
    document.getElementById('death').classList.remove('open');
    // Death-restart resets most of the run state — make sure the save
    // catches the new (revived) baseline so a tab close right after
    // restart doesn't restore the pre-death state.
    this.saveSystem?.markDirty();
  }

  _spawnInitialEnemies() {
    // Drain any pending enemy spawns produced by chunk generation (origin
    // chunk and immediate neighbours are loaded in World.constructor).
    this._drainPendingEnemySpawns();
  }

  // Skip spawn descriptors whose chunk is no longer loaded. This guards
  // against pathological orderings where a chunk was loaded (descriptor
  // pushed), then unloaded, then drained — without it the entity would
  // be created tied to a chunk that doesn't exist, leaking the mesh into
  // the scene because no future _despawnChunkEntities call matches it.
  _isSpawnLive(s) {
    const ck = s.chunkKey || this.world.chunkKeyOf(s.x, s.z);
    return this.world.chunks.has(ck);
  }

  _drainPendingEnemySpawns() {
    while (this.world.enemySpawns.length > 0) {
      const s = this.world.enemySpawns.shift();
      if (!this._isSpawnLive(s)) continue;
      const e = new Enemy(this.world, this.effects, this.sound, s.kind, s.x, s.z, s.level || 1, {
        homeX: s.homeX, homeZ: s.homeZ, elite: !!s.elite,
        chunkKey: s.chunkKey,
      });
      // Persisted spawns carry the full state captured on the previous
      // unload. Apply on top of the freshly-constructed (level-scaled)
      // baseline so hp / asleep / status effects survive the round-trip.
      if (s._persisted && typeof e.applyOverride === 'function') {
        e.applyOverride(s);
      }
      this.enemies.push(e);
    }
  }

  _drainChestSpawns() {
    if (!this.world.chestSpawns) return;
    while (this.world.chestSpawns.length > 0) {
      const s = this.world.chestSpawns.shift();
      if (!this._isSpawnLive(s)) continue;
      const c = new Chest(this.scene, s.x, s.z);
      // chunkKey is stamped onto the entity so chunk-unload streaming
      // can despawn it without rebuilding a spatial index.
      c.chunkKey = s.chunkKey || this.world.chunkKeyOf(s.x, s.z);
      this.chests.push(c);
    }
  }

  _drainBreakableSpawns() {
    if (!this.world.breakableSpawns) return;
    while (this.world.breakableSpawns.length > 0) {
      const s = this.world.breakableSpawns.shift();
      if (!this._isSpawnLive(s)) continue;
      const b = new Breakable(this.scene, s.x, s.z, s.kind);
      b.chunkKey = s.chunkKey || this.world.chunkKeyOf(s.x, s.z);
      this.breakables.push(b);
    }
  }

  _drainAltarSpawns() {
    if (!this.world.altarSpawns) return;
    while (this.world.altarSpawns.length > 0) {
      const s = this.world.altarSpawns.shift();
      if (!this._isSpawnLive(s)) continue;
      const a = new Altar(this.scene, s.x, s.z);
      a.chunkKey = s.chunkKey || this.world.chunkKeyOf(s.x, s.z);
      // Restore charges / spent visuals from a previously-saved snapshot.
      if (s.override && typeof a.applyOverride === 'function') {
        a.applyOverride(s.override);
      }
      this.altars.push(a);
    }
  }

  // Wrap each tree / rock the world generated this frame in a Resource
  // entity so the damageables pipeline can hit them. The chunk already
  // mounted the visual mesh inside its group; we just take a reference so
  // we can hide the mesh on death without re-parenting.
  //
  // Trees and rocks are NOT marked consumed when chopped — chunk reload
  // regenerates them naturally. _isSpawnLive(s) only returns false here for
  // descriptors whose chunk was already unloaded, which can happen on a
  // late drain if the player walked far enough to cycle the chunk between
  // generation and drain.
  _drainResourceSpawns() {
    if (!this.world.resourceSpawns) return;
    while (this.world.resourceSpawns.length > 0) {
      const s = this.world.resourceSpawns.shift();
      if (!this._isSpawnLive(s)) continue;
      const r = new Resource(s.x, s.z, s.kind, s.mesh, s.chunkKey, s.collider, s.colliderArray, s.group);
      // Reapply previously-saved hp / state / regrowT on top of the
      // procedurally-constructed baseline so a chunk reloaded mid-chop
      // resumes from where the player left it.
      if (s.override && typeof r.applyOverride === 'function') {
        r.applyOverride(s.override);
      }
      this.resources.push(r);
    }
  }

  // Build a procedural mesh for the structure descriptor, parent it into
  // the chunk's group at the right yaw, register a collider in the chunk's
  // collider list (so movement is blocked by the new wall) and wrap the
  // whole thing in a Structure entity. Called once per descriptor each
  // time a chunk loads — both for newly-placed pieces and for pre-existing
  // ones surviving a chunk reload.
  _drainStructureSpawns() {
    if (!this.world.structureSpawns) return;
    while (this.world.structureSpawns.length > 0) {
      const s = this.world.structureSpawns.shift();
      // Re-fetch the chunk's group/colliders fresh in case the chunk was
      // unloaded + re-loaded between place and drain (the descriptor's
      // group/colliderArray references would point to a discarded chunk).
      const chunk = this.world.chunks.get(s.chunkKey);
      if (!chunk) continue;
      const recipe = RECIPES[s.kind];
      if (!recipe) continue;
      // Pass world (x,z) so the wall mesh can hash it for a deterministic
      // crack pattern. Other kinds ignore the extra args.
      const mesh = buildStructureMesh(s.kind, s.x, s.z);
      const stackY = s.y || 0;
      mesh.position.set(s.x, stackY, s.z);
      mesh.rotation.y = s.yaw || 0;
      chunk.group.add(mesh);
      let collider = null;
      // Stacked walls (y > 0) skip the ground collider — the wall on the
      // ground in the same cell already blocks horizontal movement, so a
      // second collider at the same (x,z) would just duplicate work.
      // Players can't walk on top of stacked walls anyway (no jump/climb).
      if (recipe.radius > 0 && stackY <= 0.01) {
        // `placed: true` lets the build-mode placement check skip its
        // tree/rock clearance buffer for player-placed structures —
        // structure-vs-structure spacing is governed separately so walls
        // can sit flush on adjacent 1m grid cells without false rejects.
        collider = { x: s.x, z: s.z, r: recipe.radius, placed: true };
        chunk.colliders.push(collider);
      }
      const struct = new Structure(
        this.scene, s.x, s.z, s.kind, s.yaw || 0, s.hp, mesh, s.chunkKey,
        collider, chunk.colliders, chunk.group,
      );
      struct.y = stackY;
      this.structures.push(struct);
      // Planters get an attached Crop entity (M3 farming). New planters
      // start in the 'empty' state with no crop mesh; reloaded planters
      // restore from the descriptor's persisted farm field. The Crop is
      // associated with the Structure so chunk unload / structure
      // destruction drops both at the same time.
      if (s.kind === 'planter') {
        const crop = new Crop(mesh, { x: s.x, z: s.z }, s.chunkKey);
        if (s.farm) crop.loadFromDescriptor(s.farm);
        struct.crop = crop;
        this.crops.push(crop);
      }
      // Fence-connectable structures auto-link with their cardinal
      // neighbours (Minecraft-style fence run). Rebuild the new entry's
      // mesh with the right N/S/E/W arms, then refresh any already-
      // spawned neighbour fence/gate so the connection is mutual.
      // Neighbours that haven't drained yet pick up the connection
      // naturally on their own first build below.
      if (s.kind === 'fence') {
        this._rebuildFenceMesh(struct);
        this._rebuildFenceNeighborsOf(struct.pos.x, struct.pos.z, struct.y || 0);
      } else if (s.kind === 'gate') {
        // Restore persisted open state (chunk reload after the player
        // toggled the gate, then walked away). Gate's `openDir` lives
        // on the Structure so toggling doesn't have to round-trip the
        // descriptor each frame; legacy `s.open` boolean (from the
        // previous fence-style gate) maps to openDir = -1 if found.
        if (typeof s.openDir === 'number') struct.openDir = s.openDir | 0;
        else struct.openDir = s.open ? -1 : 0;
        this._rebuildGateMesh(struct);
        this._rebuildFenceNeighborsOf(struct.pos.x, struct.pos.z, struct.y || 0);
      } else if (s.kind === 'wall') {
        // Stone walls don't render any connection arms themselves, but
        // their presence flips a fence/gate neighbour's connection bit,
        // so refresh those too.
        this._rebuildFenceNeighborsOf(struct.pos.x, struct.pos.z, struct.y || 0);
      } else if (s.kind === 'wood_wall') {
        // Wood walls grow fence-style panels toward their neighbours;
        // build the mesh with the current connection mask, then refresh
        // adjacent fence/gate/wood/glass walls so their arms terminate
        // against this new tile.
        this._rebuildWoodWallMesh(struct);
        this._rebuildFenceNeighborsOf(struct.pos.x, struct.pos.z, struct.y || 0);
      } else if (s.kind === 'glass_wall') {
        this._rebuildGlassWallMesh(struct);
        this._rebuildFenceNeighborsOf(struct.pos.x, struct.pos.z, struct.y || 0);
      } else if (s.kind === 'door_full') {
        // Restore persisted open state (chunk reload after the player
        // toggled the door, then walked away) and rebuild the panel
        // mesh in that state. Also nudges fence/gate neighbours so a
        // fence rail terminates against the door jamb cleanly.
        if (typeof s.openDir === 'number') struct.openDir = s.openDir | 0;
        else struct.openDir = s.open ? -1 : 0;
        this._rebuildDoorFullMesh(struct);
        this._rebuildFenceNeighborsOf(struct.pos.x, struct.pos.z, struct.y || 0, 'door_full');
      } else if (s.kind === 'roof_corner') {
        // After the corner spawns, search for 3 other corners forming
        // an axis-aligned rectangle at the same y. If found and no
        // roof yet exists for it, drop a `roof_pitched` descriptor at
        // the rectangle's centre — its mesh autoassembles from the
        // {minX, minZ, maxX, maxZ} bounds.
        struct._ownerY = struct.y || 0;
        // Persisted "hidden" flag on the spawn descriptor flips the
        // corner's mesh invisible right after mount so chunk reload
        // re-applies the visual hide that _hideRoofCornersAt did when
        // the roof was first formed. Collider + HP stay so a sword
        // swing against the (invisible) corner still tears the roof
        // down via the existing _roofsAtCorner cleanup path.
        if (s.hidden) {
          if (struct.mesh) struct.mesh.visible = false;
          struct._hidden = true;
        }
        this._tryFormRoof(struct.pos.x, struct.pos.z, struct.y || 0);
      } else if (s.kind === 'roof_pitched') {
        // Roof descriptor carries the rectangle bounds; rebuild the
        // mesh with the right dimensions and centre it above the
        // bounding rectangle. The persisted `roofColor` (one of the
        // entries in ROOF_COLOR_PALETTE) drives the tile-imitation
        // skin so a chunk reload picks the same colour we randomised
        // when the roof first formed.
        struct._roofBounds = {
          minX: s.minX, minZ: s.minZ, maxX: s.maxX, maxZ: s.maxZ,
        };
        struct._roofColor = s.roofColor || null;
        this._rebuildRoofPitchedMesh(struct);
      }
    }
  }

  // True if the persisted descriptor map records a fence-connectable
  // structure at world (x,z). Fences hook up to other fences, stone walls
  // and gates (gates are fence-style too) so a player can run a fence
  // straight into the side of a wall or terminate it at a gate without an
  // ugly stub. Planters are NOT connectable — they're walk-through farm
  // plots and a fence rail visually dead-ending at one would look weird.
  // Cheap O(n) scan of the chunk's descriptor list — typical chunk has
  // <20 structures so this is fine inside a 4-neighbour loop.
  _isFenceConnectableAt(x, z, y = 0) {
    const ck = this.world.chunkKeyOf(x, z);
    const arr = this.world.placedStructures.get(ck);
    if (!arr) return false;
    const eps = 0.15;
    const queryFloor = Math.round((y || 0) / 1.0);   // STEP_Y = 1m
    for (const d of arr) {
      // Wood / glass walls and the full-height door are also rigid block
      // structures that fence rails should plug into seamlessly, so they
      // count as fence-connectable for the run-extension logic. The
      // y-match guard keeps a 2nd-storey wood wall from sprouting an
      // arm just because the stone wall directly *below* its neighbour
      // tile happens to be fence-connectable. door_full claims TWO
      // consecutive floors so a wall on the upper floor next to a
      // door also gets to terminate cleanly against the door jamb.
      if (!(d.kind === 'fence' || d.kind === 'wall' || d.kind === 'gate'
           || d.kind === 'wood_wall' || d.kind === 'glass_wall'
           || d.kind === 'door_full')) continue;
      if (Math.abs(d.x - x) >= eps) continue;
      if (Math.abs(d.z - z) >= eps) continue;
      const dBase = Math.round((d.y || 0) / 1.0);
      const dTop = dBase + ((d.kind === 'door_full') ? 1 : 0);
      if (queryFloor >= dBase && queryFloor <= dTop) return true;
    }
    return false;
  }

  // Compute the {N,S,E,W} connection mask for a fence at world (x,z) by
  // probing the four cardinal neighbour cells. North is -Z (matches the
  // facing-vector convention used elsewhere in the codebase). y picks
  // which floor we're querying so a 2nd-storey wood wall ignores any
  // ground-level neighbour stone walls beneath it.
  _fenceConnectionsAt(x, z, y = 0) {
    return {
      N: this._isFenceConnectableAt(x, z - 1, y),
      S: this._isFenceConnectableAt(x, z + 1, y),
      E: this._isFenceConnectableAt(x + 1, z, y),
      W: this._isFenceConnectableAt(x - 1, z, y),
    };
  }

  // Rebuild a single fence's mesh with the current neighbour connection
  // mask. Detaches the old group from the chunk, builds a fresh one,
  // re-parents at the same world position. The fence mesh is 4-way
  // symmetric and its arms are placed in world cardinal directions
  // (N/S/E/W) — so we MUST NOT apply struct.yaw here. If we did, a
  // fence placed with yaw=π/2 would have its "N arm" rotated to face
  // East after the group rotation, and the actual world-North
  // neighbour would receive no arm at all (visible as a fence with a
  // rail jutting into empty space). The descriptor's yaw is still
  // kept for save-format consistency with non-symmetric kinds; it's
  // just not honoured visually for fences.
  _rebuildFenceMesh(struct) {
    if (!struct || struct.kind !== 'fence' || !struct.alive || !struct.group) return;
    const conns = this._fenceConnectionsAt(struct.pos.x, struct.pos.z);
    const old = struct.mesh;
    if (old && old.parent) old.parent.remove(old);
    const next = buildFenceMesh(conns);
    next.position.set(struct.pos.x, 0, struct.pos.z);
    next.rotation.y = 0;
    struct.group.add(next);
    struct.mesh = next;
    struct._restRotZ = next.rotation.z;
  }

  // Sibling of `_rebuildFenceMesh` for the wood-wall recipe — same fence
  // post + 4-cardinal-arm topology, but the arms are full-storey solid
  // plank panels. yaw isn't applied for the same reason as fence: the
  // mesh is N/S/E/W-symmetric and the arms must stay world-aligned.
  _rebuildWoodWallMesh(struct) {
    if (!struct || struct.kind !== 'wood_wall' || !struct.alive || !struct.group) return;
    const y = struct.y || 0;
    const conns = this._fenceConnectionsAt(struct.pos.x, struct.pos.z, y);
    const old = struct.mesh;
    if (old && old.parent) old.parent.remove(old);
    const next = buildWoodWallMesh(conns);
    next.position.set(struct.pos.x, y, struct.pos.z);
    next.rotation.y = 0;
    struct.group.add(next);
    struct.mesh = next;
    struct._restRotZ = next.rotation.z;
  }

  _rebuildGlassWallMesh(struct) {
    if (!struct || struct.kind !== 'glass_wall' || !struct.alive || !struct.group) return;
    const y = struct.y || 0;
    const conns = this._fenceConnectionsAt(struct.pos.x, struct.pos.z, y);
    const old = struct.mesh;
    if (old && old.parent) old.parent.remove(old);
    const next = buildGlassWallMesh(conns);
    next.position.set(struct.pos.x, y, struct.pos.z);
    next.rotation.y = 0;
    struct.group.add(next);
    struct.mesh = next;
    struct._restRotZ = next.rotation.z;
  }

  // Rebuild a single gate's mesh with the current open state. The gate's
  // `openDir` (0/+1/-1) stays on the Structure between calls so the
  // toggle interaction is the only place that flips it. Yaw is
  // preserved so a gate placed at yaw=π/2 keeps its N-S orientation.
  // Collider radius gets nudged to GATE_OPEN_RADIUS when openDir != 0
  // so player movement can pass through the cell.
  _rebuildGateMesh(struct) {
    if (!struct || struct.kind !== 'gate' || !struct.alive || !struct.group) return;
    const old = struct.mesh;
    if (old && old.parent) old.parent.remove(old);
    const dir = struct.openDir | 0;
    const next = buildGateMesh(dir);
    next.position.set(struct.pos.x, 0, struct.pos.z);
    next.rotation.y = struct.yaw || 0;
    struct.group.add(next);
    struct.mesh = next;
    struct._restRotZ = next.rotation.z;
    if (struct.collider) {
      // When the gate is open we *fully* disable the collider — a
      // radial collider at the cell centre with radius small enough
      // to "let the player through" still pushes a 0.55-radius
      // player out by ~0.67m, so a non-zero r here always blocks.
      // The closed gate keeps its normal radius. Mesh stays
      // present in either state.
      struct.collider.disabled = dir !== 0;
      struct.collider.r = dir !== 0
        ? GATE_OPEN_RADIUS
        : (RECIPES.gate?.radius || 0.45);
    }
  }

  // X-ray the roof for any player standing inside it. Walks every live
  // roof_pitched, tests each player's XZ against the roof's rectangle
  // bounds (with a 0.5m margin so brushing the wall doesn't pop the
  // fade), and lerps the roof's per-instance opacity toward 0.1
  // (somebody is inside) or 1.0 (everyone outside). The lerp is
  // frame-rate-independent so the fade timing matches at 30/60/120 fps.
  // Roofs without bounds (legacy / mid-load) and dead roofs are skipped.
  _updateRoofFade(dt) {
    const FADE_OPACITY = 0.10;
    // 1 - exp(-dt * k) is a frame-rate-independent lerp; k≈8 reaches
    // 99% of the target in ~0.6s, which feels snappy without being
    // jarring as you cross the threshold.
    const k = 8;
    const lerp = 1 - Math.exp(-dt * k);
    const margin = 0.5;
    for (const s of this.structures) {
      if (!s.alive || s.kind !== 'roof_pitched' || !s.mesh) continue;
      const b = s._roofBounds;
      if (!b) continue;
      let inside = false;
      for (const p of this.players) {
        if (!p) continue;
        if (p.pos.x < b.minX - margin) continue;
        if (p.pos.x > b.maxX + margin) continue;
        if (p.pos.z < b.minZ - margin) continue;
        if (p.pos.z > b.maxZ + margin) continue;
        inside = true;
        break;
      }
      const target = inside ? FADE_OPACITY : 1.0;
      const cur = (typeof s._roofOpacity === 'number') ? s._roofOpacity : 1.0;
      let next = cur + (target - cur) * lerp;
      // Snap to target near the end of the lerp so we don't sit at
      // 0.9998 forever flagging materials as faded.
      if (Math.abs(next - target) < 0.005) next = target;
      if (next === cur) continue;
      s._roofOpacity = next;
      // Drop depthWrite once we're noticeably translucent so the roof
      // stops occluding whatever's below it in the depth buffer; flip
      // it back on at full opacity so adjacent solid geometry sorts
      // correctly against the roof.
      const transparentLook = next < 0.99;
      s.mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        if (!child.userData?.isRoofOuter && !child.userData?.isRoofInner) return;
        child.material.opacity = next;
        child.material.depthWrite = !transparentLook;
      });
    }
  }

  // Rebuild a roof_pitched mesh from its descriptor's rectangle bounds.
  // The mesh is centred on (cx,cz) and parented at the corner-y so the
  // apex hovers above the centre at apexH = max(w,d)/2. Caller stores
  // the bounds on struct._roofBounds before the first call.
  _rebuildRoofPitchedMesh(struct) {
    if (!struct || struct.kind !== 'roof_pitched' || !struct.alive || !struct.group) return;
    const b = struct._roofBounds;
    if (!b) return;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const old = struct.mesh;
    if (old && old.parent) old.parent.remove(old);
    const next = buildRoofPitchedMesh(w, d, struct._roofColor || null);
    next.position.set(cx, struct.y || 0, cz);
    next.rotation.y = 0;
    struct.group.add(next);
    struct.mesh = next;
    struct._restRotZ = next.rotation.z;
    // The structure's authoritative pos was the descriptor's (x,z).
    // For the spawn descriptor we used the rectangle centre, but
    // floats can drift; sync mesh-side authoritative position back so
    // hit-tests and minimap markers locate the roof centre.
    struct.pos.x = cx;
    struct.pos.z = cz;
  }

  // Search for a complete axis-aligned rectangle of 4 roof_corners
  // including (newX, newZ, newY) at the same y. If found AND no
  // roof_pitched already covers it, spawn one.
  _tryFormRoof(newX, newZ, newY) {
    const eps = 0.15;
    const yEps = 0.5;
    // Gather all roof_corner descriptors at the same y from the chunks
    // around (newX, newZ). 5×5 chunks is plenty even for a large
    // building since corners are placed on cell edges and chunks are
    // 16m wide (default).
    const cornerDescs = [];
    const seen = new Set();
    const radius = 32;            // m — covers buildings up to ~64m on a side
    for (let ox = -radius; ox <= radius; ox += 8) {
      for (let oz = -radius; oz <= radius; oz += 8) {
        const ck = this.world.chunkKeyOf(newX + ox, newZ + oz);
        if (seen.has(ck)) continue;
        seen.add(ck);
        const arr = this.world.placedStructures.get(ck);
        if (!arr) continue;
        for (const d of arr) {
          if (d.kind !== 'roof_corner') continue;
          if (Math.abs((d.y || 0) - newY) >= yEps) continue;
          cornerDescs.push(d);
        }
      }
    }
    if (cornerDescs.length < 4) return;
    // For each pair of OTHER corners, check if they form a rectangle
    // with (newX, newZ). Specifically: looking for OA along the same
    // X (== newX), OB along the same Z (== newZ), and a 4th corner at
    // (OB.x, OA.z). Iterate distinct pairs only.
    for (let i = 0; i < cornerDescs.length; i++) {
      const A = cornerDescs[i];
      if (Math.abs(A.x - newX) >= eps) continue;
      if (Math.abs(A.z - newZ) < eps) continue;     // same point as new
      for (let j = 0; j < cornerDescs.length; j++) {
        if (i === j) continue;
        const B = cornerDescs[j];
        if (Math.abs(B.z - newZ) >= eps) continue;
        if (Math.abs(B.x - newX) < eps) continue;
        // Rectangle is (newX,newZ)-(B.x,newZ)-(B.x,A.z)-(newX,A.z).
        // We need a 4th corner at (B.x, A.z).
        let fourth = null;
        for (const C of cornerDescs) {
          if (Math.abs(C.x - B.x) < eps && Math.abs(C.z - A.z) < eps) {
            fourth = C; break;
          }
        }
        if (!fourth) continue;
        const minX = Math.min(newX, B.x);
        const maxX = Math.max(newX, B.x);
        const minZ = Math.min(newZ, A.z);
        const maxZ = Math.max(newZ, A.z);
        // Reject zero-area or single-cell-edge rectangles — at least
        // 1m on each side so the apex height is non-trivial.
        if ((maxX - minX) < 0.9 || (maxZ - minZ) < 0.9) continue;
        // De-dupe: skip if a roof already exists with these bounds.
        if (this._roofExistsFor(minX, minZ, maxX, maxZ, newY)) continue;
        // Spawn the roof. Anchor at the rectangle centre so the
        // descriptor's chunkKey lands on a sensible chunk. Pick a
        // random tile colour so each new roof has its own look; the
        // name is persisted on the descriptor so chunk reload
        // re-uses the same one.
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;
        const roofRecipe = RECIPES.roof_pitched;
        const roofColor = pickRandomRoofColor();
        this.world.placeStructure(
          cx, cz, 'roof_pitched', 0,
          roofRecipe?.hp ?? 80,
          newY,
          { minX, minZ, maxX, maxZ, roofColor },
        );
        // Once the roof is up, the four corner posts would just poke
        // out of the ridge as wooden stubs. Hide their meshes (NOT
        // mark them dead — that would trigger the corner-death cascade
        // in compactInPlace which kills the roof too). The Structure
        // entries stay live so a sword swing on the now-invisible
        // corner still tears the roof down via the existing
        // _roofsAtCorner cleanup path.
        this._hideRoofCornersAt(minX, minZ, maxX, maxZ, newY);
        return;
      }
    }
  }

  // Visually hide the four roof_corner posts whose positions sit at
  // the corners of the rectangle (minX,minZ)-(maxX,maxZ) at the given
  // y. The Structure entries stay alive (HP, collider, descriptor)
  // — only the rendered mesh is set invisible so the roof-formed
  // building reads as a clean roof+walls combo without four wooden
  // stubs poking out of the ridge. We MUST NOT mark them dead: the
  // structure-death sweep in compactInPlace runs `_roofsAtCorner`
  // for any dying corner and would tear the freshly-spawned roof
  // down with it.
  _hideRoofCornersAt(minX, minZ, maxX, maxZ, y) {
    const eps = 0.15;
    const yEps = 0.5;
    const targets = [
      { x: minX, z: minZ },
      { x: minX, z: maxZ },
      { x: maxX, z: minZ },
      { x: maxX, z: maxZ },
    ];
    let touched = false;
    const spawns = this.world.structureSpawns || [];
    for (const t of targets) {
      // Mark the persisted descriptor hidden so chunk reload re-applies
      // the visual hide on the rebuilt corner mesh.
      const ck = this.world.chunkKeyOf(t.x, t.z);
      const arr = this.world.placedStructures.get(ck);
      if (arr) {
        for (const d of arr) {
          if (d.kind !== 'roof_corner') continue;
          if (Math.abs(d.x - t.x) >= eps) continue;
          if (Math.abs(d.z - t.z) >= eps) continue;
          if (Math.abs((d.y || 0) - y) >= yEps) continue;
          if (!d.hidden) { d.hidden = true; touched = true; }
          break;
        }
      }
      // The roof forms the moment the player drops the 4th corner, but
      // corners 2/3/4's spawn entries may still be sitting in the
      // drain queue (we got here while processing the 1st corner). Flag
      // them so the spawn drainer's "if (s.hidden)" branch flips the
      // freshly-built mesh invisible the moment they mount.
      for (const sp of spawns) {
        if (sp.kind !== 'roof_corner') continue;
        if (Math.abs(sp.x - t.x) >= eps) continue;
        if (Math.abs(sp.z - t.z) >= eps) continue;
        if (Math.abs((sp.y || 0) - y) >= yEps) continue;
        sp.hidden = true;
        break;
      }
      // Hide any already-mounted live Structure's mesh so the post
      // disappears from the scene immediately.
      for (const s of this.structures) {
        if (!s.alive || s.kind !== 'roof_corner') continue;
        if (Math.abs(s.pos.x - t.x) >= eps) continue;
        if (Math.abs(s.pos.z - t.z) >= eps) continue;
        if (Math.abs((s.y || 0) - y) >= yEps) continue;
        if (s.mesh) s.mesh.visible = false;
        s._hidden = true;
        break;
      }
    }
    if (touched) this.world._markPersistDirty?.();
  }

  // True if any persisted roof_pitched descriptor in chunks near
  // (minX,minZ)-(maxX,maxZ) has matching bounds at the same y.
  _roofExistsFor(minX, minZ, maxX, maxZ, y) {
    const eps = 0.15;
    const yEps = 0.5;
    const seen = new Set();
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    for (let ox = -32; ox <= 32; ox += 8) {
      for (let oz = -32; oz <= 32; oz += 8) {
        const ck = this.world.chunkKeyOf(cx + ox, cz + oz);
        if (seen.has(ck)) continue;
        seen.add(ck);
        const arr = this.world.placedStructures.get(ck);
        if (!arr) continue;
        for (const d of arr) {
          if (d.kind !== 'roof_pitched') continue;
          if (Math.abs((d.y || 0) - y) >= yEps) continue;
          if (Math.abs(d.minX - minX) < eps
              && Math.abs(d.minZ - minZ) < eps
              && Math.abs(d.maxX - maxX) < eps
              && Math.abs(d.maxZ - maxZ) < eps) return true;
        }
      }
    }
    return false;
  }

  // Find every live roof_pitched whose rectangle includes the corner at
  // (cx,cz,cy). Used to drop the roof when its supporting corner is
  // destroyed.
  _roofsAtCorner(cx, cz, cy) {
    const eps = 0.15;
    const yEps = 0.5;
    const out = [];
    for (const s of this.structures) {
      if (!s.alive) continue;
      if (s.kind !== 'roof_pitched') continue;
      if (Math.abs((s.y || 0) - cy) >= yEps) continue;
      const b = s._roofBounds;
      if (!b) continue;
      const onMinX = Math.abs(b.minX - cx) < eps;
      const onMaxX = Math.abs(b.maxX - cx) < eps;
      const onMinZ = Math.abs(b.minZ - cz) < eps;
      const onMaxZ = Math.abs(b.maxZ - cz) < eps;
      if ((onMinX || onMaxX) && (onMinZ || onMaxZ)) out.push(s);
    }
    return out;
  }

  // Sibling of `_rebuildGateMesh` for the full-cell `door_full` recipe.
  // Same open/close → collider toggle behaviour, but the panel geometry
  // is taller (2m) and full-cell, so it gets its own mesh builder.
  _rebuildDoorFullMesh(struct) {
    if (!struct || struct.kind !== 'door_full' || !struct.alive || !struct.group) return;
    const old = struct.mesh;
    if (old && old.parent) old.parent.remove(old);
    const dir = struct.openDir | 0;
    const next = buildDoorFullMesh(dir);
    // Honour the placement layer — a door dropped on a Shift-1 layer
    // must rebuild at y=1 so toggling it open/close doesn't warp the
    // mesh back down to the ground.
    next.position.set(struct.pos.x, struct.y || 0, struct.pos.z);
    next.rotation.y = struct.yaw || 0;
    struct.group.add(next);
    struct.mesh = next;
    struct._restRotZ = next.rotation.z;
    if (struct.collider) {
      struct.collider.disabled = dir !== 0;
      struct.collider.r = dir !== 0
        ? GATE_OPEN_RADIUS
        : (RECIPES.door_full?.radius || 0.40);
    }
  }

  // After ANY fence-connectable structure (fence/wall/gate) is placed or
  // destroyed at (x,z), refresh the meshes of the four cardinal neighbour
  // fences and gates so their arms reflect the new state. Walls don't
  // need re-rendering — they're a static block — so we only rebuild
  // fence/gate neighbours. Walks `this.structures` (live entities only);
  // any descriptor-only entry still queued for spawn picks up the right
  // connections when it drains.
  _rebuildFenceNeighborsOf(x, z, y = 0, selfKind = null) {
    const eps = 0.15;
    const yEps = 0.5;
    // door_full claims two consecutive floors, so changing one nudges
    // neighbours on both its base floor and the floor above. Other
    // recipes are single-floor so the inner loop runs once.
    const floors = (selfKind === 'door_full') ? [y, y + 1.0] : [y];
    for (const fy of floors) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        for (const s of this.structures) {
          if (!s.alive) continue;
          if (s.kind !== 'fence' && s.kind !== 'gate'
              && s.kind !== 'wood_wall' && s.kind !== 'glass_wall') continue;
          if (Math.abs(s.pos.x - nx) < eps
              && Math.abs(s.pos.z - nz) < eps
              && Math.abs((s.y || 0) - fy) < yEps) {
            if (s.kind === 'fence') this._rebuildFenceMesh(s);
            else if (s.kind === 'gate') this._rebuildGateMesh(s);
            else if (s.kind === 'wood_wall') this._rebuildWoodWallMesh(s);
            else if (s.kind === 'glass_wall') this._rebuildGlassWallMesh(s);
            break;
          }
        }
      }
    }
  }

  // Despawn every entity tied to `chunkKey`. Invoked by World when a
  // far chunk is unloaded; living entities just disappear (their
  // chunkKey is recomputed from current position so a wandering enemy
  // moves with the chunk grid) and dead-but-not-yet-cleaned entities
  // are released so their meshes drop out of the scene at the same
  // time as the rest of the chunk's geometry.
  _despawnChunkEntities(chunkKey) {
    // Enemies: chunkKey is recomputed in enemy.update() as they walk,
    // so the only enemies still tagged with `chunkKey` are ones that
    // were inside the chunk's footprint at the time of unload. Release
    // their visual handles back to the enemy pool so the next spawn of
    // the same kind doesn't have to re-clone the skeleton + mixer.
    compactInPlace(
      this.enemies,
      e => e.chunkKey !== chunkKey,
      e => { try { e._releaseMesh?.(); } catch { /* ignore */ } },
    );
    // Chests / breakables / altars don't move, so the chunkKey set at
    // spawn time is authoritative. Living-but-unloaded chests &
    // breakables aren't marked consumed — they'll respawn fresh on
    // chunk reload.
    compactInPlace(
      this.chests,
      c => c.chunkKey !== chunkKey,
      c => { c._destroy?.(); },
    );
    compactInPlace(
      this.breakables,
      b => b.chunkKey !== chunkKey,
      b => { b.destroyMesh?.(); },
    );
    compactInPlace(
      this.altars,
      a => a.chunkKey !== chunkKey,
      a => { a.destroyMesh?.(); },
    );
    // Resources don't own meshes (the chunk's group does), so we just drop
    // the references — the chunk's _disposeChunk has already removed the
    // group from the scene. On chunk reload _drainResourceSpawns wraps the
    // freshly-spawned trees / rocks in new Resource entities.
    compactInPlace(
      this.resources,
      r => r.chunkKey !== chunkKey,
    );
    // Structures: drop the entity references; the chunk's group disposal
    // already pulled the meshes out of the scene. On chunk reload, the
    // world re-emits the persisted descriptors and _drainStructureSpawns
    // rebuilds them — preserving HP via the descriptor's `hp` field.
    compactInPlace(
      this.structures,
      s => s.chunkKey !== chunkKey,
    );
    // Crops live in the planter's mesh group (chunk-owned), so chunk
    // disposal already removed their visible meshes. We just drop the
    // references — the persisted farm state stays in the placedStructures
    // descriptor and is rehydrated on chunk reload.
    compactInPlace(
      this.crops,
      c => c.chunkKey !== chunkKey,
      c => { c.destroy?.(); },
    );
  }

  // ---- Farming interaction (M3) -----------------------------------
  // Find the planter closest to `player` within INTERACT_RADIUS and
  // dispatch the player's interact press to it. Returns true if anything
  // was consumed (mirrors _tryOpenAltar's contract). Build-mode is checked
  // by the caller — interact in build mode is already swallowed for ghost
  // rotation so we never reach here while the BuildController is active.
  _tryFarmInteract(player) {
    if (!player || !player.alive || this.crops.length === 0) return false;
    const FARM_INTERACT_RADIUS = 1.4;
    let target = null, bestD = FARM_INTERACT_RADIUS;
    for (const c of this.crops) {
      if (!c.hasPendingAction()) continue;
      const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
      if (d <= bestD) { bestD = d; target = c; }
    }
    if (!target) return false;
    const outcome = target.interact(player.selectedCropKind, this.world.resources);
    switch (outcome.kind) {
      case 'till':
        this.sound.till?.();
        this.effects.ring(target.pos.x, 0.05, target.pos.z, 0x6e4a2a, 0.9, 0.25);
        break;
      case 'plant':
        this.sound.plant?.();
        this.effects.ring(target.pos.x, 0.05, target.pos.z, 0x9ad36b, 0.9, 0.25);
        this.effects.toast?.(`Посажено: ${cropLabel(outcome.cropKind)}`, '#9ad36b');
        break;
      case 'noseed':
        if (outcome.toast) this.effects.toast?.(outcome.toast, '#ff7a7a');
        break;
      case 'harvest': {
        this.sound.harvest?.();
        this.effects.ring(target.pos.x, 0.05, target.pos.z, 0xffd166, 1.4, 0.4);
        this.effects.burst(target.pos.x, 0.6, target.pos.z, 0xffd166, 12, 4, 0.4);
        const food = Math.max(0, outcome.food | 0);
        const seeds = Math.max(0, outcome.seeds | 0);
        // Add harvested crops to the player's food inventory instead of
        // spawning pickup objects. The crop kind determines which raw
        // ingredient the player receives.
        if (food > 0) {
          const cropKind = outcome.cropKind || 'wheat';
          player.foods[cropKind] = (player.foods[cropKind] || 0) + food;
          player._revalidateSelectedFood();
        }
        if (seeds > 0) {
          const drops = spawnHarvestDrops(this.scene, target.pos.x, target.pos.z, 'seed', seeds);
          for (const d of drops) this.pickups.push(d);
        }
        const summary = (seeds > 0)
          ? `${cropLabel(outcome.cropKind)}: +${food} ${cropLabel(outcome.cropKind)}, +${seeds} семян`
          : `${cropLabel(outcome.cropKind)}: +${food} ${cropLabel(outcome.cropKind)}`;
        this.effects.toast?.(summary, '#7aff8a');
        break;
      }
      case 'reset':
        this.sound.till?.();
        break;
      default:
        return false;
    }
    if (target.chunkKey) {
      this.world.updateStructureFarm(target.chunkKey, target.pos.x, target.pos.z, target.toDescriptor());
    }
    return true;
  }

  // Render context-sensitive prompts above the closest pending planter
  // for each player. Cheap: each frame finds the nearest farmable planter
  // within prompt range and forwards the localised label to the toast
  // overlay. Skipped while a player is in build mode — they're focused on
  // ghost placement, not crop maintenance.
  _showFarmPrompts() {
    if (this.crops.length === 0) return;
    const PROMPT_RADIUS = 1.8;
    for (const p of this.players) {
      if (!p.alive) continue;
      const builder = this.builders[p.index];
      if (builder && builder.active) continue;
      let target = null, bestD = PROMPT_RADIUS;
      for (const c of this.crops) {
        const d = Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
        if (d <= bestD) { bestD = d; target = c; }
      }
      if (!target) {
        // Player walked away from every planter — clear the cached
        // prompt key so the next approach re-emits a fresh toast.
        p._farmPromptKey = null;
        continue;
      }
      // Only re-emit a fresh prompt when the closest planter, its state, or
      // the player's selected crop changes — otherwise the toast spams every
      // frame the player stands next to a planter. selectedCropKind is part
      // of the key so pressing Q/U mid-prompt re-renders the
      // "E: Посадить — <crop> (Q: сменить · N сем.)" prompt with the
      // freshly chosen crop.
      const cycleKey = (target.state === 'tilled') ? p.selectedCropKind : '';
      const stateKey = `${target.pos.x.toFixed(2)},${target.pos.z.toFixed(2)}|${target.state}|${cycleKey}`;
      if (p._farmPromptKey === stateKey) continue;
      p._farmPromptKey = stateKey;
      const key = (p.index === 0) ? 'E' : 'J';
      const cycleHintKey = (p.index === 0) ? 'Q' : 'U';
      const verb = target.promptLabel();
      if (!verb) continue;
      let text = `${key}: ${verb}`;
      if (target.state === 'tilled') {
        // The "<key>: сменить" hint moved into the prompt brackets so the
        // standalone seed-selector chip in the corner could go away — the
        // crop pick is now only relevant when you're actually next to a
        // planter, and showing it here keeps it discoverable without a
        // permanent piece of HUD.
        text = `${key}: ${verb} — ${cropLabel(p.selectedCropKind)} (${cycleHintKey}: сменить · ${this.world.resources.seeds || 0} сем.)`;
      } else if (target.state === 'mature' && target.cropKind) {
        text = `${key}: ${verb} — ${cropLabel(target.cropKind)}`;
      }
      this.effects.toast?.(text, '#9ad36b');
    }
  }

  // ---- Gate interaction (open / close) -----------------------------
  // Find the gate closest to `player` within GATE_INTERACT_RADIUS and
  // toggle its open/closed state. Mirrors the contract of
  // `_tryFarmInteract` / `_tryOpenAltar`: returns true if anything was
  // consumed so the caller can clear the player's interact-press intent
  // and not double-fire downstream interactions on the same E press.
  _tryGateInteract(player) {
    if (!player || !player.alive || this.structures.length === 0) return false;
    const GATE_INTERACT_RADIUS = 1.4;
    let target = null, bestD = GATE_INTERACT_RADIUS;
    for (const s of this.structures) {
      if (!s.alive || (s.kind !== 'gate' && s.kind !== 'door_full')) continue;
      const d = Math.hypot(s.pos.x - player.pos.x, s.pos.z - player.pos.z);
      if (d <= bestD) { bestD = d; target = s; }
    }
    if (!target) return false;
    const wasOpen = (target.openDir | 0) !== 0;
    if (wasOpen) {
      target.openDir = 0;
    } else {
      // Open AWAY from the player. Compute the player's z in the gate's
      // local frame (yaw = θ → world→local: rotate by -θ around Y), then
      // pick the sign that puts the door on the opposite side.
      const dx = player.pos.x - target.pos.x;
      const dz = player.pos.z - target.pos.z;
      const yaw = target.yaw || 0;
      const localZ = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
      // localZ > 0 → player on +Z side → swing door to -Z (openDir = -1)
      // localZ <= 0 → player on -Z side → swing door to +Z (openDir = +1)
      target.openDir = (localZ > 0) ? -1 : +1;
    }
    if (target.kind === 'door_full') this._rebuildDoorFullMesh(target);
    else this._rebuildGateMesh(target);
    if (target.chunkKey) {
      this.world.updateStructureOpen(
        target.chunkKey, target.pos.x, target.pos.z, target.openDir,
      );
    }
    // Sound + ring effect cribbed from the farming verbs so the toggle
    // has audible weight without a new asset. Toast announces the new
    // state in Russian (matching the rest of the prompt copy).
    this.sound.till?.();
    this.effects.ring(target.pos.x, 0.05, target.pos.z, 0xc8a060, 0.9, 0.25);
    // "Дверь" and "Калитка" are both feminine in Russian, so they share
    // the same открыта/закрыта endings.
    const doorNoun = (target.kind === 'door_full') ? 'Дверь' : 'Калитка';
    const doorVerbAdj = (target.openDir | 0) !== 0 ? 'открыта' : 'закрыта';
    this.effects.toast?.(`${doorNoun} ${doorVerbAdj}`, '#c8a060');
    // Force a fresh prompt re-emit on the next frame so the "open /
    // close" label flips immediately instead of waiting for the prompt
    // dedup to expire.
    player._gatePromptKey = null;
    return true;
  }

  // Render an interact prompt above the closest open-able gate for each
  // player. Same shape as `_showFarmPrompts` — one per player, deduped
  // on a (gate, state, builder-mode) key so we don't spam the toast
  // queue every frame the player stands next to a gate.
  _showGatePrompts() {
    if (this.structures.length === 0) return;
    const PROMPT_RADIUS = 1.8;
    for (const p of this.players) {
      if (!p.alive) continue;
      const builder = this.builders[p.index];
      if (builder && builder.active) {
        p._gatePromptKey = null;
        continue;
      }
      let target = null, bestD = PROMPT_RADIUS;
      for (const s of this.structures) {
        if (!s.alive || (s.kind !== 'gate' && s.kind !== 'door_full')) continue;
        const d = Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z);
        if (d <= bestD) { bestD = d; target = s; }
      }
      if (!target) {
        p._gatePromptKey = null;
        continue;
      }
      const isOpen = (target.openDir | 0) !== 0;
      const stateKey = `${target.pos.x.toFixed(2)},${target.pos.z.toFixed(2)}|${target.kind}|${isOpen ? 'o' : 'c'}`;
      if (p._gatePromptKey === stateKey) continue;
      p._gatePromptKey = stateKey;
      const key = (p.index === 0) ? 'E' : 'J';
      const verb = isOpen ? 'закрыть' : 'открыть';
      const noun = target.kind === 'door_full' ? 'дверь' : 'калитку';
      this.effects.toast?.(`${key}: ${verb} ${noun}`, '#c8a060');
    }
  }

  // ---- Altar interaction ------------------------------------------
  _tryOpenAltar(player) {
    if (!player || !player.alive) return false;
    if (this.altarOpen) return false;
    let target = null, bestD = ALTAR_USE_RADIUS;
    for (const a of this.altars) {
      if (!a.alive || !a.isActive) continue;
      const d = Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z);
      if (d <= bestD) { bestD = d; target = a; }
    }
    if (!target) return false;
    this.altarOpen = true;
    this.altarUI.open(player, target, {
      onReroll: (id) => this._altarReroll(player, target, id),
      onSacrifice: (id) => this._altarSacrifice(player, target, id),
      onFuse: (id) => this._altarFuse(player, target, id),
      onClose: () => { this.altarOpen = false; },
    });
    this.sound.bell?.();
    return true;
  }

  _altarReroll(player, altar, itemId) {
    if (!altar.isActive) return false;
    if (player.gold < REROLL_COST) {
      this.effects.toast?.('Не хватает золота для перековки.', '#ff7a7a');
      return false;
    }
    const def = ITEM_BY_ID[itemId];
    if (!def) return false;
    const cur = player.items?.[itemId] || 0;
    if (cur < 1) return false;
    const newId = pickRandomItemIdInRarityExcept(def.rarity, itemId);
    if (!newId) return false;
    const newDef = ITEM_BY_ID[newId];
    // The replacement also respects the per-item cap so we can't dodge it
    // by rerolling into something the player already has maxed.
    if (!player.canAcceptItem(newId)) {
      this.effects.toast?.(`У тебя уже максимум стаков «${newDef?.name}». Попробуй другой.`, '#ffd166');
      return false;
    }
    player.gold -= REROLL_COST;
    player.removeItem(itemId, 1);
    player.addItem(newId);
    altar.spendCharge();
    this._recordAltarChange(altar);
    this.effects.toast?.(`Перековал «${def.name}» в «${newDef.name}».`, '#ffd166');
    this.effects.ring(altar.pos.x, 0.05, altar.pos.z, RARITY[newDef.rarity].color, 1.6, 0.4);
    this.effects.burst(altar.pos.x, 1.0, altar.pos.z, RARITY[newDef.rarity].color, 12, 4, 0.4);
    this.sound.pickupGold?.();
    if (altar.charges <= 0) this._closeAltarSoon();
    return true;
  }

  _altarSacrifice(player, altar, itemId) {
    if (!altar.isActive) return false;
    const def = ITEM_BY_ID[itemId];
    if (!def) return false;
    const cur = player.items?.[itemId] || 0;
    if (cur < 1) return false;
    const reward = RARITY[def.rarity]?.sacrificeGold || 0;
    player.removeItem(itemId, 1);
    player.gold += reward;
    altar.spendCharge();
    this._recordAltarChange(altar);
    this.effects.toast?.(`Сжёг «${def.name}» — +${reward} золота.`, '#ffd166');
    this.effects.burst(altar.pos.x, 1.0, altar.pos.z, 0xffb84d, 12, 4, 0.4);
    this.sound.pickupGold?.();
    if (altar.charges <= 0) this._closeAltarSoon();
    return true;
  }

  _altarFuse(player, altar, itemId) {
    if (!altar.isActive) return false;
    const def = ITEM_BY_ID[itemId];
    if (!def) return false;
    const cur = player.items?.[itemId] || 0;
    if (cur < 3) return false;
    const next = rarityAbove(def.rarity);
    if (!next) {
      this.effects.toast?.('Легендарные нельзя слить — нет редкости выше.', '#ff7a7a');
      return false;
    }
    const newId = pickRandomItemIdInRarityExcept(next, null);
    if (!newId) return false;
    const newDef = ITEM_BY_ID[newId];
    if (!player.canAcceptItem(newId)) {
      this.effects.toast?.(`У тебя уже максимум стаков «${newDef?.name}». Попробуй сначала освободить место.`, '#ffd166');
      return false;
    }
    player.removeItem(itemId, 3);
    player.addItem(newId);
    altar.spendCharge();
    this._recordAltarChange(altar);
    this.effects.toast?.(`Сплавил 3× «${def.name}» в «${newDef.name}»!`, '#' + RARITY[newDef.rarity].color.toString(16).padStart(6, '0'));
    this.effects.ring(altar.pos.x, 0.05, altar.pos.z, RARITY[newDef.rarity].color, 1.8, 0.5);
    this.effects.burst(altar.pos.x, 1.2, altar.pos.z, RARITY[newDef.rarity].color, 16, 5, 0.5);
    this.sound.bell?.();
    if (altar.charges <= 0) this._closeAltarSoon();
    return true;
  }

  _closeAltarSoon() {
    setTimeout(() => {
      if (this.altarOpen) this.altarUI.close();
    }, 400);
  }

  // Push the altar's current charge count into world.chunkOverrides so
  // a later chunk reload (or save) restores the altar at exactly this
  // charge level. Centralised so reroll / sacrifice / fuse all stay in
  // sync without duplicating the recording logic three times.
  _recordAltarChange(altar) {
    if (!altar || !altar.chunkKey) return;
    if (!this.world || typeof this.world.recordAltarOverride !== 'function') return;
    const ov = typeof altar.toOverride === 'function' ? altar.toOverride() : null;
    this.world.recordAltarOverride(altar.chunkKey, altar.pos.x, altar.pos.z, ov);
  }

  // Called when a breakable's `alive` flips to false (any damage source).
  // Spawns the kind-specific gold drops and — for crates — sometimes an
  // item rune. Plays a small particle burst + ring + bomb sfx so the
  // destruction reads visually and audibly.
  _onBreakableDestroyed(b) {
    const dropFood = defaultRandom() < b.foodChance;
    const drops = spawnDrops(this.scene, b.pos.x, b.pos.z, b.gold, dropFood);
    for (const d of drops) this.pickups.push(d);
    if (b.itemDropChance > 0 && defaultRandom() < b.itemDropChance) {
      const id = pickRandomItemId();
      if (id) {
        const r = new Rune(this.scene, b.pos.x, b.pos.z, 'item', id);
        this.runes.push(r);
      }
    }
    const color = b.burstColor();
    this.effects.burst(b.pos.x, 0.5, b.pos.z, color, 10, 4, 0.45);
    this.effects.ring(b.pos.x, 0.05, b.pos.z, 0xffd166, 0.8, 0.3);
    // Pots shatter (glass-y crash), crates splinter (wood crack). Different
    // samples make the two breakable kinds distinguishable from offscreen.
    if (b.kind === 'pot') this.sound.potBreak?.();
    else this.sound.woodBreak?.();
    b.destroyMesh();
  }

  // Fired when a Resource (tree / rock) drops to 0 HP. `weaponKind` is the
  // string id of the weapon that landed the killing blow, used by
  // harvestYield() to grant the +25% wood bonus to axe wielders. AoE /
  // ability kills pass `weaponKind = null` and skip the bonus.
  _onResourceGathered(r, weaponKind) {
    const yld = harvestYield(r.kind, weaponKind);
    if (yld && yld.amount > 0) {
      const drops = spawnHarvestDrops(this.scene, r.pos.x, r.pos.z, yld.kind, yld.amount);
      for (const d of drops) this.pickups.push(d);
    }
    // Visual + audio feedback that matches the resource. Trees lean over
    // and emit a leafy burst; rocks crumble in a duster cloud.
    const color = r.burstColor();
    const burstY = r.burstY();
    this.effects.burst(r.pos.x, burstY, r.pos.z, color, 12, 4, 0.55);
    this.effects.ring(r.pos.x, 0.05, r.pos.z, color, 1.0, 0.32);
    if (r.kind === 'tree') this.sound.treeFall?.();
    else this.sound.rockBreak?.();
    // Transition the resource: trees become walk-through stumps that regrow
    // after ~10 game days; rocks vanish from the resources list and only
    // come back via natural chunk regeneration.
    r.enterDeathState();
    // Persist the new state immediately so a chunk that unloads moments
    // later (or a save fired before the next unload) restores the chopped
    // tree / smashed rock instead of a fresh full-hp resource.
    if (r.chunkKey && typeof r.toOverride === 'function') {
      const ov = r.toOverride();
      this.world.recordResourceOverride(r.chunkKey, r.pos.x, r.pos.z, ov);
    }
    // Minimap: tree / rock dots are baked into the *terrain* layer (not
    // the cheap structure overlay), so dropping one requires re-baking
    // the whole tile. Cost is amortised — the bake budget caps it at
    // one per frame inside Minimap.render().
    if (this.minimap && r.chunkKey) this.minimap.invalidateTerrain(r.chunkKey);
  }

  // Always spawn one chest near origin on first load so players see the
  // pickup loop within a few seconds — discovering the first chest can
  // otherwise take a few minutes of exploration. The chest is stamped
  // with the origin chunkKey so the regular open-handler routes it
  // through world.markChestConsumed (same path procedural chests use),
  // and we skip the spawn entirely when the consumed-set already lists
  // (4, 4) so a saved run that already cracked it doesn't get a fresh
  // copy after load.
  _spawnStarterChest() {
    if (this._starterChestSpawned) return;
    this._starterChestSpawned = true;
    const STARTER_X = 4;
    const STARTER_Z = 4;
    const chunkKey = this.world.chunkKeyOf(STARTER_X, STARTER_Z);
    const sk = this.world.spawnKey(chunkKey, STARTER_X, STARTER_Z);
    if (this.world._consumedChests && this.world._consumedChests.has(sk)) {
      return;
    }
    const c = new Chest(this.scene, STARTER_X, STARTER_Z);
    c.chunkKey = chunkKey;
    this.chests.push(c);
  }

  // Walk every loaded player position and ask the world to materialise any
  // missing chunks around them; then update the active chunk set so far-off
  // chunks are hidden + their entities frozen. Cheap.
  //
  // ensureChunksAround() now only synchronously generates the immediate
  // ring around each player and queues the rest; processChunkQueue()
  // drains a small budget per frame so a fresh region streams in
  // without a multi-frame freeze, and refreshActiveChunks() handles
  // unloading anything outside KEEP_RADIUS.
  _streamChunks() {
    if (!this.players) return;
    const positions = [];
    for (const p of this.players) {
      if (!p) continue;
      this.world.ensureChunksAround(p.pos.x, p.pos.z);
      positions.push({ x: p.pos.x, z: p.pos.z });
    }
    this.world.processChunkQueue();
    // Drain before refreshActiveChunks: a chunk that was just sync-loaded
    // (or just async-drained from the queue) has its spawn descriptors
    // sitting in world.{enemy,chest,breakable,altar}Spawns but no Entity
    // object yet. If refresh unloaded that chunk first, _despawnChunkEntities
    // would walk this.{enemies,chests,...} and find nothing to remove —
    // and then the drain below would create entities tied to a now-unloaded
    // chunk, leaking meshes into the scene forever.
    this._drainPendingEnemySpawns();
    this._drainChestSpawns();
    this._drainBreakableSpawns();
    this._drainAltarSpawns();
    this._drainResourceSpawns();
    this._drainStructureSpawns();
    this.world.refreshActiveChunks(positions);
  }

  // Lazy-build and update a small billboarded HP-style bar above a downed
  // player to show revive hold progress.
  _renderReviveBar(player) {
    if (!player._reviveBar) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x101410, transparent: true, opacity: 0.7, depthTest: false })
      );
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.36, 0.12),
        new THREE.MeshBasicMaterial({ color: 0x7aff8a, transparent: true, opacity: 0.95, depthTest: false })
      );
      fg.position.z = 0.001;
      const grp = new THREE.Group();
      grp.add(bg);
      grp.add(fg);
      grp.renderOrder = 999;
      grp.position.set(player.pos.x, 2.4, player.pos.z);
      this.scene.add(grp);
      player._reviveBar = grp;
      player._reviveBarFg = fg;
    }
    const grp = player._reviveBar;
    const fg = player._reviveBarFg;
    const progress = player.reviveProgress / REVIVE_HOLD;
    grp.visible = progress > 0.001;
    if (!grp.visible) return;
    grp.position.set(player.pos.x, 2.4, player.pos.z);
    grp.quaternion.copy(this.followCam.cam.quaternion);
    fg.scale.x = Math.max(0.001, progress);
    fg.position.x = -0.68 * (1 - progress);
  }

  // Check if a player is near a tilled planter (for Q seed cycle context).
  _isNearTilledPlanter(player) {
    const PROMPT_R = 1.8;
    for (const c of this.crops) {
      if (c.state !== 'tilled') continue;
      if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) <= PROMPT_R) return true;
    }
    return false;
  }

  // Check if a player is near a campfire or altar bonfire (for cooking).
  _isNearCampfire(player) {
    // Player-built campfires
    for (const s of this.structures) {
      if (!s.alive || s.kind !== 'campfire') continue;
      if (Math.hypot(s.pos.x - player.pos.x, s.pos.z - player.pos.z) <= COOK_INTERACT_RADIUS) return true;
    }
    // Altar bonfires
    for (const a of this.altars) {
      if (Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z) <= COOK_INTERACT_RADIUS) return true;
    }
    return false;
  }

  // Cook progress bar — same visual pattern as the revive bar.
  _renderCookBar(player) {
    if (!player._cookBar) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x101410, transparent: true, opacity: 0.7, depthTest: false })
      );
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.36, 0.12),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, depthTest: false })
      );
      fg.position.z = 0.001;
      const grp = new THREE.Group();
      grp.add(bg);
      grp.add(fg);
      grp.renderOrder = 999;
      grp.position.set(player.pos.x, 2.6, player.pos.z);
      this.scene.add(grp);
      player._cookBar = grp;
      player._cookBarFg = fg;
    }
    const grp = player._cookBar;
    const fg = player._cookBarFg;
    const progress = player.cookProgress / COOK_HOLD_S;
    grp.visible = progress > 0.001;
    if (!grp.visible) return;
    grp.position.set(player.pos.x, 2.6, player.pos.z);
    grp.quaternion.copy(this.followCam.cam.quaternion);
    fg.scale.x = Math.max(0.001, progress);
    fg.position.x = -0.68 * (1 - progress);
  }

  // Human-readable label for a food item (raw crop or cooked dish).
  _foodItemLabel(id) {
    const recipe = COOK_RECIPES[id];
    if (recipe) return recipe.name;
    const crop = CROPS[id];
    if (crop) return crop.name;
    return id;
  }

  // Show cooking / food prompts near campfires and food cycle HUD.
  _showCookPrompts() {
    for (const p of this.players) {
      if (!p.alive) continue;
      const builder = this.builders[p.index];
      if (builder && builder.active) continue;
      const nearCampfire = this._isNearCampfire(p);
      const qKey = (p.index === 0) ? 'Q' : 'U';
      const eKey = (p.index === 0) ? 'E' : 'J';
      if (nearCampfire) {
        const recipe = COOK_RECIPES[p.selectedRecipe];
        if (!recipe) continue;
        const affordable = canCook(p.foods, p.selectedRecipe);
        const color = affordable ? '#ffd166' : '#ff7a7a';
        const promptKey = `cook|${p.selectedRecipe}|${affordable}`;
        if (p._cookPromptKey === promptKey) continue;
        p._cookPromptKey = promptKey;
        const costStr = recipeCostLabel(p.selectedRecipe);
        const verb = affordable
          ? `${eKey}: Приготовить ${recipe.name} (${costStr}) · ${qKey}: сменить`
          : `${recipe.name} — не хватает (${costStr}) · ${qKey}: сменить`;
        this.effects.toast?.(verb, color);
      } else {
        p._cookPromptKey = null;
        // Food inventory hint when player has food
        const list = p.edibleList();
        if (list.length > 0 && p.selectedFood) {
          const entry = list.find(e => e.id === p.selectedFood);
          const promptKey = `food|${p.selectedFood}|${entry?.count}`;
          if (p._foodPromptKey === promptKey) continue;
          p._foodPromptKey = promptKey;
        } else {
          p._foodPromptKey = null;
        }
      }
    }
  }

  _onPlayerHitsEnemy(player, enemy) {
    const partner = this.players[1 - player.index];
    // ctx is shared between onAttack and onHit so items can tag e.g. crit.
    // enemyList includes breakables (via cached _damageables) so item hooks
    // like Echo / DashBlast can also chain into pots & crates.
    const ctx = {
      enemy,
      partner,
      enemyList: this._damageables || this.enemies,
      dmgMult: 1,
      crit: false,
      dmg: 0,
      echo: false,
    };
    runItemHook(player, 'onAttack', ctx);
    // Per-character charge attacks may force a guaranteed crit on top
    // of any item-rolled crit chance — Rogue dash-strike does this so
    // the lunge always lands as a punchy critical. Mirrors the crit
    // item's behaviour (sets the flag + doubles dmgMult) so item
    // hooks like Echo still chain off the crit.
    const swing = player._activeSwing;
    if (swing?.forceCrit && !ctx.crit) {
      ctx.crit = true;
      ctx.dmgMult *= 2;
    }
    // Mage weapon enchant — every connecting attack while the enchant
    // is active gets a flat damage bonus (read from the enchant state
    // so all the tuning lives in player.js) on top of any element-
    // specific status effect applied below in the post-damage block.
    const enchant = player._weaponEnchant;
    if (enchant) ctx.dmgMult *= enchant.damageMult || 1;
    // Weapon profile scales base damage — a 2H battle axe hits much harder
    // than a wand, but the wand swings ~40% faster so DPS stays comparable.
    // The active-swing snapshot wins over the weapon profile so the spin
    // super's higher damageMult applies for that swing only. Staff/wand
    // tap-fire spell bolts set `_activeRanged` for the duration of the
    // hit callback so the rangedAttack profile's damage scaling lands
    // in this lookup instead of the melee profile's.
    const weaponMult = player._activeRanged?.damageMult
      ?? player._activeSwing?.damageMult
      ?? player.weaponProfile?.damageMult
      ?? 1.0;
    // Class affinity: each Adventurer's CHARACTERS row lists the weapon
    // kinds they're tuned around (Knight on swords, Barbarian on axes,
    // Mage on staff/wand, Rogue on 1H sword + wand) and gets a flat
    // damage multiplier when wielding one of them. Off-class loadouts
    // still work fine — they just don't get the bump.
    const affinityMult = player._character?.def?.weaponAffinity?.[player._weaponKind] ?? 1.0;
    let dmg = player.stats.damage * (1 + defaultRandom() * 0.05) * ctx.dmgMult * weaponMult * affinityMult;
    if (player._berserk) dmg *= player._berserk.dmg;
    if (player._foodBuff && player._foodBuff.kind === 'damage') dmg *= (1 + player._foodBuff.value);
    ctx.dmg = dmg;
    if (enemy.takeDamage(dmg, player.pos.x, player.pos.z, 10)) {
      runItemHook(player, 'onHit', ctx);
      const flashColor = ctx.crit ? 0xffd166 : 0xffffff;
      this.effects.flashSphere(enemy.pos.x, 1.0, enemy.pos.z, flashColor, ctx.crit ? 0.7 : 0.5, 0.12);
      // Per-character charge attack post-hit effects ----------------
      // Knight Block_Attack stuns every enemy it connects with, giving
      // the player a free counter window after the bash resolves.
      // Uses `_stunned` (gold tint) instead of `_frozen` (icy blue) so
      // the visual reads as a bash stun and not as ice freeze — only
      // ice-element sources should ever produce the blue freeze look.
      if (swing?.charKind === 'shieldBash' && swing.stunDuration > 0) {
        enemy._stunned = Math.max(enemy._stunned || 0, swing.stunDuration);
        this.effects.ring(enemy.pos.x, 0.05, enemy.pos.z, 0xffe066, 1.2, 0.25);
      }
      // Rogue dash-strike steals a small amount of gold from each
      // enemy hit during the lunge. Only steals from real enemies
      // (skipping breakables / structures / resources where gold
      // theft is meaningless) and only on living enemies — a hit
      // that immediately kills routes its loot through the regular
      // drop pipeline instead.
      if (swing?.charKind === 'dashStrike' && enemy.alive
          && swing.goldStealMax > 0 && enemy.gold) {
        const min = swing.goldStealMin;
        const max = swing.goldStealMax;
        const stolen = Math.max(1, Math.floor(min + defaultRandom() * (max - min + 1)));
        player.gold += stolen;
        this.effects.damageNumber(
          new THREE.Vector3(enemy.pos.x, 1.8, enemy.pos.z),
          `+${stolen}`, '#ffd166'
        );
      }
      // Mage enchant on-hit element effects. The enchant is purely
      // duration-based now — every connecting attack during the
      // bind window applies the bound element + the flat damage
      // bonus. The state is cleared by Player.update's TTL tick.
      if (enchant) {
        this._applyWeaponEnchantEffect(player, enemy, enchant, ctx.dmg);
      }
      if (!enemy.alive) {
        runItemHook(player, 'onKill', ctx);
        this._onEnemyDies(player, enemy);
      }
    }
  }

  // Apply a Mage weapon-enchant element on a connecting hit. Element
  // is bound at cast time (Player._triggerEnchant) from the player's
  // currently-slotted ability, and resolves to one of:
  //   fire      — burn DoT
  //   ice       — freeze (the ONLY freeze/stun source from enchant —
  //               keeps the blue stun visual exclusive to icebolt)
  //   lightning — chain wave to nearby living enemies (no stun, no
  //               slow) — purely a damage spread
  //   wind      — extra knockback impulse (no stun, no slow)
  //   timeslow  — apply _slow (no freeze, no stun)
  //   heal      — lifesteal back to the player
  // The +30% enchant damage bonus is already baked into the primary
  // hit via ctx.dmgMult in the caller, so each branch here just
  // layers its distinct on-hit effect on top.
  _applyWeaponEnchantEffect(player, enemy, enchant, dmgDealt) {
    const element = enchant.element;
    if (element === 'fire') {
      // Burn for 4s at 5% maxHP/s — same _poison pipeline the fang
      // item uses, so the dot stacks/refreshes consistently.
      enemy._poison = { dur: 4, dps: enemy.maxHP * 0.05, src: player };
    } else if (element === 'ice') {
      enemy._frozen = Math.max(enemy._frozen || 0, 1.0);
    } else if (element === 'lightning') {
      // Electric wave: damage every other living enemy within `radius`
      // around the primary hit, no stun, no slow. The wave is purely a
      // damage spread — visually a yellow ring at the impact + a
      // flashSphere on each arc target.
      const radius = 3.5;
      let zapped = 0;
      for (const e of (this._damageables || this.enemies)) {
        if (!e || !e.alive || e === enemy) continue;
        if (typeof e.gold === 'undefined') continue; // skip non-creature damageables
        const d = Math.hypot(e.pos.x - enemy.pos.x, e.pos.z - enemy.pos.z);
        if (d > radius) continue;
        e.takeDamage(dmgDealt * 0.4, enemy.pos.x, enemy.pos.z, 3);
        if (!e.alive) e._deathCredit = player;
        this.effects.flashSphere(e.pos.x, 1.0, e.pos.z, 0xfff7a0, 0.5, 0.15);
        zapped++;
      }
      if (zapped > 0) {
        this.effects.ring(enemy.pos.x, 0.05, enemy.pos.z, 0xfff7a0, radius, 0.25);
      }
    } else if (element === 'wind') {
      // Wind enchant — punch the enemy back along the player→enemy
      // axis with an extra knockback impulse, on top of the swing's
      // baseline kb that already landed via takeDamage(... , 10).
      const dx = enemy.pos.x - player.pos.x;
      const dz = enemy.pos.z - player.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const extraKb = 18;
      enemy.knockback.x += (dx / len) * extraKb;
      enemy.knockback.z += (dz / len) * extraKb;
    } else if (element === 'timeslow') {
      enemy._slow = Math.max(enemy._slow || 0, 2.0);
    } else if (element === 'heal') {
      // Lifesteal: 4% of player maxHP per enchanted hit so heal
      // mages get a felt benefit even in long fights.
      player.heal(player.maxHP * 0.04);
    }
    // Visual: enchant flash in the bound element's colour, on top of
    // the regular hit flash so the player sees the enchant did fire.
    this.effects.flashSphere(enemy.pos.x, 1.0, enemy.pos.z, enchant.color, 0.7, 0.18);
  }

  _onEnemyDies(killer, enemy) {
    this.totalKills += 1;
    const dropFood = defaultRandom() < 0.18;
    const drops = spawnDrops(this.scene, enemy.pos.x, enemy.pos.z, enemy.gold, dropFood);
    for (const d of drops) this.pickups.push(d);
    // Elites guarantee an item rune drop. Random rarity weighted by the
    // global pool (legendary will still be rare).
    if (enemy.elite) {
      const id = pickRandomItemId();
      if (id) {
        const r = new Rune(this.scene, enemy.pos.x, enemy.pos.z, 'item', id);
        this.runes.push(r);
        this.effects.ring(enemy.pos.x, 0.05, enemy.pos.z, 0xffd166, 1.6, 0.4);
        this.effects.toast?.('Элитный сбрасывает реликвию!', '#ffd166');
      }
    }
    // Shared XP — both players gain regardless of who killed (even if dead;
    // they level up so revival lands them at the proper stats).
    for (const p of this.players) {
      p.xp += enemy.xp;
      const need = p.level * 30;
      if (p.xp >= need) {
        p.xp -= need;
        p.level += 1;
        p.maxHP += 8;
        if (p.alive) p.hp += 8;
        this.effects.toast(`P${p.index+1} reached level ${p.level}!`, p.index === 0 ? '#6ad0ff' : '#ff8a8a');
        this.effects.ring(p.pos.x, 0.06, p.pos.z, 0xfff7a0, 2.2, 0.5);
      }
    }
  }

  _loop(t) {
    // Wall-clock delta — clamped so a tab-resume freeze doesn't queue
    // dozens of fixed steps at once.
    const dt0 = Math.min(0.25, (t - this._lastT) / 1000) || 0;
    this._lastT = t;

    // Run zero-dt update once each RAF so UI / FX timers (camera shake
    // decay, FPS counter, FX pulses, input event drain, shop UI) tick
    // even when the simulation is paused. Inside Game.update() the
    // dt<=0 branch handles this case explicitly.
    const sleeping = this.paused || this.menuPaused || this.shopOpen || this.altarOpen || this._waitingForStart || this.dead;
    if (sleeping) {
      this._fixedAccum = 0;
      this.update(0, dt0);
    } else {
      // Fixed-step simulation. Hit-stop scales the consumption rate of
      // the accumulator instead of the dt fed into update() so the
      // physics step itself stays a constant size — only the apparent
      // game speed slows.
      const consumeRate = this.effects.hitStop > 0 ? 0.15 : 1;
      this._fixedAccum += dt0 * consumeRate;
      let steps = 0;
      while (this._fixedAccum >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        // Snapshot every renderable's pre-step position before the
        // simulation tick so render() can lerp between prev (this
        // snapshot) and curr (post-step pos) using the leftover
        // accumulator as an alpha. This is the canonical Glenn Fiedler
        // 'fix your timestep' approach — without it, on monitors whose
        // refresh isn't a clean integer multiple of 60Hz the render
        // freezes for 1 RAF and then double-steps on the next, which
        // shows up as character-only "rubber-banding" because moving
        // entities are the only ones with a delta to skip.
        this._captureRenderPrev();
        this.update(FIXED_DT, dt0);
        this._fixedAccum -= FIXED_DT;
        steps += 1;
      }
      // If we hit the budget cap, drop the carry so we don't spiral.
      if (steps >= MAX_STEPS_PER_FRAME) this._fixedAccum = 0;
    }
    // Ambient soundscape: tick the procedural nature layers using the
    // live midpoint between the players + the world's day weight. Runs
    // even while paused / dead so the meadow keeps breathing in the
    // background — it costs a few setTargetAtTime calls and doesn't
    // care about simulation timestep.
    this._updateAmbientSound(dt0);
    this.render();
    this._updateFps(dt0);
    requestAnimationFrame((tt) => this._loop(tt));
  }

  // Cheap wrapper around sound.updateAmbient — pulls the listener
  // position from the camera's smoothed centroid (same point the
  // FollowCamera tracks), so the soundscape follows what the player
  // actually sees instead of either dead/alive sim positions.
  _updateAmbientSound(dt0) {
    if (!this.sound || !this.sound.updateAmbient) return;
    const c = this.followCam?.smoothCenter;
    const x = c ? c.x : (this.players[0]?.pos.x ?? 0);
    const z = c ? c.z : (this.players[0]?.pos.z ?? 0);
    const dayWeight = (typeof this.world?.dayWeight === 'number') ? this.world.dayWeight : 1.0;
    this.sound.updateAmbient(dt0, { x, z, dayWeight, world: this.world });
  }

  _updateFps(dt0) {
    if (!this.settings || !this.settings.showFps()) return;
    this._fpsAcc += dt0;
    this._fpsFrames += 1;
    if (dt0 > this._fpsMaxDt) this._fpsMaxDt = dt0;
    if (this._fpsAcc >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsAcc);
      // Average frametime over the same half-second window. Showing both
      // the average and the worst single frame gives an at-a-glance read
      // on GC pauses — a 60-fps average that hides a 50ms spike still
      // means the player just stuttered, and that's exactly the kind of
      // hitch object pooling is meant to remove.
      const avgMs = (this._fpsAcc / this._fpsFrames) * 1000;
      const maxMs = this._fpsMaxDt * 1000;
      this._fpsAcc = 0; this._fpsFrames = 0; this._fpsMaxDt = 0;
      const el = document.getElementById('fps');
      if (el) el.textContent = `FPS ${this._fps} · ${avgMs.toFixed(1)} ms (max ${maxMs.toFixed(0)})`;
    }
  }

  update(dt, dt0) {
    // Always update FX timing using real dt0 (so shake decays even paused)
    this.effects.update(dt > 0 ? dt : dt0 * 0);
    // Stream chunks around the players first so the world update reads a
    // fresh centroid when it snaps the sun shadow camera to the texel grid.
    this._streamChunks();
    this.world.update(dt);
    // Throttled state sync to phones (uses real dt0 so it works while paused)
    this._stateSyncT += dt0;
    if (this._stateSyncT > 0.25 && this.lobby) {
      this._stateSyncT = 0;
      this._pushPlayerState(0);
      this._pushPlayerState(1);
    }
    // ---- Shop toggle / quick-buy (works while paused too) ----
    // Toggle shop with Tab — must run BEFORE the dt<=0 early return so the
    // user can re-press Tab to close the shop.
    if (this.input.consumeGlobal('Tab')) {
      this._keyboardShop = !this._keyboardShop;
      this._refreshShopState();
    }

    // Quick-buy keys 1-4 for P1, 7-0 for P2 (only when keyboard shop open)
    if (this._keyboardShop) {
      const map1 = { 'Digit1': 0, 'Digit2': 1, 'Digit3': 2, 'Digit4': 3 };
      const map2 = { 'Digit7': 0, 'Digit8': 1, 'Digit9': 2, 'Digit0': 3 };
      for (const code of Object.keys(map1)) {
        if (this.input.consumeGlobal(code)) this._tryBuy(0, map1[code]);
      }
      for (const code of Object.keys(map2)) {
        if (this.input.consumeGlobal(code)) this._tryBuy(1, map2[code]);
      }
    }

    if (dt <= 0) { this._updateUI(); this.input.endFrame(); return; }
    this.elapsed += dt;

    // Player intents
    const i1 = this.input.intent(0);
    const i2 = this.input.intent(1);

    // If a teammate is downed and the alive partner is within revive range,
    // their dash button is reserved for the revive hold — suppress the dash
    // edge so pressing R/K starts the lift instead of also firing a dart-away
    // dash on the same tap.
    const intents = [i1, i2];
    if (!this.solo) {
      for (let i = 0; i < this.players.length; i++) {
        const dead = this.players[i];
        const partner = this.players[1 - i];
        if (dead.alive || !partner.alive) continue;
        if (vdist(dead.pos, partner.pos) <= REVIVE_RANGE) {
          intents[partner.index].dash = false;
        }
      }
    }

    // Build mode: route the recipe-select edge first so a press of 1..4 /
    // 7..0 enters build mode (or toggles off the same recipe). When the
    // controller is active, its update() consumes attack/dash/interact for
    // place/cancel/rotate; we then mute those fields on the intent so the
    // player's normal swing / dash logic doesn't double-trigger.
    for (let pi = 0; pi < this.players.length; pi++) {
      const intent = intents[pi];
      const builder = this.builders[pi];
      if (!builder) continue;
      const wheel = this.buildWheels[pi];
      // Build-wheel: open / close on KeyB (P1) / KeyM (P2). While the
      // wheel is open it eats every other intent for this player so
      // pressing B doesn't also fire a sword-swing or step into a
      // direction key.
      if (intent.buildMenu) {
        if (wheel.isOpen) wheel.close();
        else wheel.open(this.world, {
          onPick: (idx) => builder.selectRecipe(idx),
        });
      }
      if (wheel.isOpen) {
        intent.attack = false;
        intent.attackHeld = false;
        intent.dash = false;
        intent.dashHeld = false;
        intent.interact = false;
        intent.moveX = 0;
        intent.moveZ = 0;
        // Don't fall through into builder.update — the player is busy
        // picking a recipe. A previously-active builder ghost stays
        // frozen wherever it was last seen until the wheel closes.
        continue;
      }
      if (intent.buildSelect >= 0) builder.selectRecipe(intent.buildSelect);
      if (builder.active) {
        builder.update(dt, intent);
        intent.attack = false;
        intent.attackHeld = false;
        intent.dash = false;
        intent.dashHeld = false;
        intent.interact = false;
        // While in build mode the WASD/stick axes drive the ghost cursor
        // (consumed inside builder.update above); blank them on the
        // intent so the player's kinematic update doesn't *also* slide
        // the character around. The character is effectively frozen in
        // place until the player exits build (dash / re-press recipe).
        intent.moveX = 0;
        intent.moveZ = 0;
      }
    }

    // Damageables = enemies + breakables + resources + structures. Sword
    // swings, ability projectiles and AoE pulses all hit anything in this
    // list. The swing callback below routes breakables to their loot path,
    // resources to the harvest path and structures to friendly-damage so
    // item-on-kill hooks (xp, drops) don't fire on world props.
    const damageables = (this.breakables.length > 0 || this.resources.length > 0 || this.structures.length > 0)
      ? [...this.enemies, ...this.breakables, ...this.resources, ...this.structures]
      : this.enemies;
    this._damageables = damageables;
    const swingHit = (player, target) => {
      if (target.isBreakable) {
        target.takeDamage(0, player.pos.x, player.pos.z, 0);
      } else if (target.isResource) {
        // Resources soak per-swing damage — players need several hits to
        // chop a tree (HP=40 vs typical melee ~10 dmg = 4 swings) so the
        // gathering loop has weight. Damage is the player's current melee
        // damage so combat upgrades carry over.
        const dmg = Math.max(1, Math.round(player.stats?.damage || 10));
        const wasAlive = target.alive;
        target.takeDamage(dmg, player.pos.x, player.pos.z, 0);
        // Tag killer's weapon so the harvest yield can grant the axe bonus
        // even though the alive→dead transition is processed below in the
        // breakable-style compaction pass.
        target._lastDmgWeapon = player._weaponKind || null;
        // Per-swing material impact — only on hits that *don't* fell the
        // resource, so the killing blow gets to play its own treeFall /
        // rockBreak cue without doubling up.
        if (wasAlive && target.alive) {
          if (target.kind === 'tree') this.sound.hitWood?.();
          else if (target.kind === 'rock') this.sound.hitStone?.();
        }
      } else if (target.isStructure) {
        // Friendly damage — a player can chop down their own walls if
        // they really want to. Reduced damage so a stray accidental swing
        // doesn't immediately ruin a fortress.
        const dmg = Math.max(1, Math.round((player.stats?.damage || 10) * 0.5));
        const wasAlive = target.alive;
        target.takeDamage(dmg, player.pos.x, player.pos.z, 0);
        // Per-swing material impact — only on hits that *don't* break
        // the structure, so the killing blow gets to play its own
        // wood-snap / rock-shatter cue (handled in the death-compact
        // pass below) without doubling up.
        if (wasAlive && target.alive) {
          const mat = structureMaterial(target.kind);
          if (mat === 'stone') this.sound.hitStone?.();
          else this.sound.hitWood?.();
        }
      } else {
        this._onPlayerHitsEnemy(player, target);
      }
    };

    // Combat ctx — passed to player.update so the staff/wand tap-fire
    // spell can spawn a homing projectile and read the strict
    // living-enemies list for auto-aim. The melee swing path doesn't
    // touch this (it routes through the swingHit callback above).
    const combatCtx = {
      livingEnemies: this.enemies,
      spawnAbilityProjectile: (opts) => {
        const ap = new AbilityProjectile(this.scene, opts);
        this.abilityProjectiles.push(ap);
      },
    };

    // Update players. In solo mode the phantom partner doesn't tick at
    // all — we just snap its position onto the live player so leash math
    // and partner item hooks see a zero-distance ghost.
    if (this.solo) {
      const ghost = this.players[1];
      const live = this.players[0];
      ghost.pos.x = live.pos.x;
      ghost.pos.z = live.pos.z;
      ghost.smoothPos = ghost.smoothPos || { x: 0, z: 0 };
      ghost.smoothPos.x = live.pos.x;
      ghost.smoothPos.z = live.pos.z;
      ghost._renderPrev = { x: live.pos.x, z: live.pos.z };
      ghost._renderPos = { x: live.pos.x, z: live.pos.z };
      ghost.hp = ghost.maxHP;
      ghost.alive = true;
      this.players[0].update(dt, i1, null, damageables, swingHit, combatCtx);
    } else {
      this.players[0].update(dt, i1, this.players[1], damageables, swingHit, combatCtx);
      this.players[1].update(dt, i2, this.players[0], damageables, swingHit, combatCtx);
    }

    // Altar interaction — if a player just pressed interact next to an
    // altar, open the altar UI and consume the press so a nearby chest
    // doesn't also open. World generation keeps altars >=4m from chests
    // so the proximity radii (1.6m / 1.2m) shouldn't normally overlap.
    if (!this.altarOpen) {
      for (const p of this.players) {
        if (!p.alive || !p._lastIntent || !p._lastIntent.interact) continue;
        if (this._tryOpenAltar(p)) p._lastIntent.interact = false;
      }
    }
    // Altar idle update (proximity prompt, crystal bob, halo).
    for (const a of this.altars) a.update(dt, this.players, this.sound, this.effects);

    // Context-aware Q button (seedCycle key). Priority:
    //   1. Near a tilled planter → cycle seed kind (instant on press)
    //   2. Near a campfire / altar fire → cycle cooking recipe (instant)
    //   3. Otherwise → short tap cycles food, long-press (0.4s) eats
    // For case 3, the cycle is deferred until Q is *released* before the
    // eat threshold so a long-press doesn't cycle then eat.
    for (const p of this.players) {
      if (!p.alive || !p._lastIntent) continue;
      const intent = p._lastIntent;
      const nearPlanter = this._isNearTilledPlanter(p);
      const nearCampfire = this._isNearCampfire(p);
      if (intent.seedCycle) {
        if (nearPlanter) {
          const idx = CROP_ORDER.indexOf(p.selectedCropKind);
          const next = CROP_ORDER[(idx + 1) % CROP_ORDER.length];
          p.selectedCropKind = next;
          this.effects.toast?.(`Семя: ${cropLabel(next)}`, '#9ad36b');
        } else if (nearCampfire) {
          const idx = COOK_RECIPE_ORDER.indexOf(p.selectedRecipe);
          const next = COOK_RECIPE_ORDER[(idx + 1) % COOK_RECIPE_ORDER.length];
          p.selectedRecipe = next;
          const recipe = COOK_RECIPES[next];
          const affordable = canCook(p.foods, next);
          const color = affordable ? '#ffd166' : '#ff7a7a';
          this.effects.toast?.(`Рецепт: ${recipe.name} (${recipeCostLabel(next)})`, color);
        }
        // For the "else" (no planter, no campfire) case we do NOT cycle
        // here — the cycle fires on key-up below if it was a short tap.
      }
      // Q hold / release logic for eating food (only when not near
      // planter or campfire).
      if (!nearPlanter && !nearCampfire) {
        if (intent.seedCycleHeld) {
          // Track that Q was pressed (for release detection).
          if (!p._qWasHeld) p._qWasHeld = true;
          p._eatHoldT = (p._eatHoldT || 0) + dt;
          if (p._eatHoldT >= EAT_HOLD_S && !p._eatFired) {
            p._eatFired = true;
            if (p.eatSelectedFood()) {
              this.sound.pickupFood?.();
              const buffStr = p._foodBuff ? ` (${buffLabel(p._foodBuff)}, ${Math.round(p._foodBuff.ttl)}с)` : '';
              this.effects.toast?.(`Съедено${buffStr}`, '#7aff8a');
              this.saveSystem?.markDirty();
            } else {
              this.effects.toast?.('Нечего есть', '#ff7a7a');
            }
          }
        } else {
          // Q was just released — if it was a short tap (< EAT_HOLD_S)
          // and we didn't eat, treat it as a food cycle.
          if (p._qWasHeld && !p._eatFired) {
            p.cycleSelectedFood();
            if (p.selectedFood) {
              const entry = p.edibleList().find(e => e.id === p.selectedFood);
              const label = this._foodItemLabel(p.selectedFood);
              this.effects.toast?.(`Еда: ${label} x${entry?.count || 0}`, '#ffd166');
            }
          }
          p._eatHoldT = 0;
          p._eatFired = false;
          p._qWasHeld = false;
        }
      } else {
        p._eatHoldT = 0;
        p._eatFired = false;
        p._qWasHeld = false;
      }
    }

    // Cooking interaction: hold E near a campfire (or altar fire) to cook.
    for (const p of this.players) {
      if (!p.alive || !p._lastIntent) continue;
      const intent = p._lastIntent;
      const nearCampfire = this._isNearCampfire(p);
      if (nearCampfire && intent.interactHeld) {
        if (canCook(p.foods, p.selectedRecipe)) {
          p.cookProgress = Math.min(COOK_HOLD_S, p.cookProgress + dt);
          if (p.cookProgress >= COOK_HOLD_S) {
            // Cook the dish
            const result = cook(p.foods, p.selectedRecipe);
            if (result) {
              p.cookedFoods[result] = (p.cookedFoods[result] || 0) + 1;
              p._revalidateSelectedFood();
              const recipe = COOK_RECIPES[result];
              this.sound.harvest?.();
              this.effects.ring(p.pos.x, 0.05, p.pos.z, 0xffd166, 1.4, 0.4);
              this.effects.burst(p.pos.x, 0.6, p.pos.z, 0xffd166, 8, 4, 0.3);
              this.effects.toast?.(`Приготовлено: ${recipe.name}`, '#ffd166');
              this.saveSystem?.markDirty();
            }
            p.cookProgress = 0;
          }
          // Consume interact press to prevent farm/gate interaction while cooking
          intent.interact = false;
        } else {
          p.cookProgress = 0;
        }
      } else {
        // Decay cook progress when not holding
        if (p.cookProgress > 0) {
          p.cookProgress = Math.max(0, p.cookProgress - dt * 2);
        }
      }
      this._renderCookBar(p);
    }

    // Planter farming interaction. Players in build mode have already had
    // their interact stripped above (build.update consumes it for ghost
    // rotation), so we won't double-fire. We still allow growth ticks for
    // every alive Crop in a sim-loaded chunk regardless of build mode.
    if (!this.altarOpen) {
      // Gate toggle takes precedence over farming if both a gate and a
      // planter are within interact range — a planter rarely sits
      // directly under a gate in practice, but if it does the gate
      // matters more for traversal.
      for (const p of this.players) {
        if (!p.alive || !p._lastIntent || !p._lastIntent.interact) continue;
        if (this._tryGateInteract(p)) p._lastIntent.interact = false;
      }
      for (const p of this.players) {
        if (!p.alive || !p._lastIntent || !p._lastIntent.interact) continue;
        if (this._tryFarmInteract(p)) p._lastIntent.interact = false;
      }
    }
    // Tick crops — only those whose chunk is in SIM_RADIUS so off-screen
    // farms don't progress at full clock. Crop.update guards by state so
    // an empty / mature / harvested planter is a no-op. Snapshot the
    // pre-tick state per crop so the growing→mature transition surfaces a
    // toast exactly once instead of every frame past maturity.
    for (const c of this.crops) {
      if (c.state !== 'growing') continue;
      if (!this.world.simKeys.has(c.chunkKey)) continue;
      const prevState = c.state;
      c.update(dt);
      if (c.state === 'mature' && prevState === 'growing') {
        this.effects.toast?.(`Урожай созрел: ${cropLabel(c.cropKind)}`, '#7aff8a');
      }
      // Persist progress + state once a frame so a chunk unload mid-grow
      // captures the latest progress value.
      if (c.chunkKey) this.world.updateStructureFarm(c.chunkKey, c.pos.x, c.pos.z, c.toDescriptor());
    }
    // Render an interact prompt above the closest farmable planter for
    // each player. Same UX as chest "press E to open" — keeps the rest of
    // the planter logic out of the player module.
    this._showFarmPrompts();
    // Gate prompt sits in the same prompt overlay; runs after the farm
    // prompt so a player who's between a planter and a gate sees the
    // farm hint (the more-frequent action) — the gate hint replaces it
    // only when the planter is out of range.
    this._showGatePrompts();
    this._showCookPrompts();

    // Update enemies
    const ctx = {
      spawnProjectile: (opts) => {
        this.projectiles.push(new Projectile(this.scene, opts));
      },
    };
    for (const e of this.enemies) e.update(dt, this.players, ctx);
    // Credit kills from damage-over-time effects (poison) that happen inside
    // enemy.update. The enemy sets _deathCredit to the source player before
    // calling die().
    for (const e of this.enemies) {
      if (!e.alive && e._deathCredit) {
        this._onEnemyDies(e._deathCredit, e);
        e._deathCredit = null;
      }
    }
    // Cleanup dead enemies (in-place compaction; the filter() variant
    // allocated a fresh array every tick at 60fps).
    compactInPlace(this.enemies, e => e.alive);

    // Projectiles
    for (const pr of this.projectiles) pr.update(dt, this.players, this.world);
    compactInPlace(this.projectiles, pr => pr.alive);

    // Ability projectiles (hit enemies AND breakables, not players)
    for (const ap of this.abilityProjectiles) ap.update(dt, damageables, this.effects, this.sound, this.world);
    compactInPlace(this.abilityProjectiles, ap => ap.alive);

    // Credit kills from ability projectiles and instant-damage abilities
    for (const e of this.enemies) {
      if (!e.alive && e._deathCredit) {
        this._onEnemyDies(e._deathCredit, e);
        e._deathCredit = null;
      }
    }
    compactInPlace(this.enemies, e => e.alive);

    // Pickups — pass the shared resource pool so wood / stone / seed
    // pickups know where to deposit their value. Gold and food don't read
    // it, so existing behaviour is unchanged.
    for (const pk of this.pickups) pk.update(dt, this.players, this.sound, this.effects, this.world.resources);
    compactInPlace(this.pickups, pk => pk.alive);

    // Chests + runes. We record the chest's position in the world's
    // consumed-set the moment the lid pops open (not at fade-end) so
    // that a tab-close / refresh during the ~1.8s open animation still
    // persists the "already opened" state — otherwise the chunk reload
    // would respawn the same chest. The compactInPlace fallback below
    // covers any chest that loses its alive flag without going through
    // the open path (e.g. chunk despawn while the chest was still
    // closed — leave the consumed-set alone in that case).
    for (const c of this.chests) c.update(
      dt, this.players, this.sound, this.effects,
      (rune) => this.runes.push(rune),
      // Seed pouch drops route into the existing pickup list so the
      // gravitate-to-player + shared-resources deposit path handles them
      // exactly like wood / stone pickups.
      (pickup) => this.pickups.push(pickup),
      (chest) => {
        if (chest.chunkKey) {
          this.world.markChestConsumed(chest.chunkKey, chest.pos.x, chest.pos.z);
        }
      },
    );
    compactInPlace(this.chests, c => c.alive, c => {
      // Defensive: if a chest somehow finished its lifetime without the
      // open path firing (chunk unload mid-animation, etc.), still mark
      // it consumed when it had been opened so the chunk reload doesn't
      // recreate it.
      if (c.opened && c.chunkKey) {
        this.world.markChestConsumed(c.chunkKey, c.pos.x, c.pos.z);
      }
    });
    for (const r of this.runes) r.update(dt, this.players, this.sound, this.effects);
    compactInPlace(this.runes, r => r.alive);

    // Breakables: idle wobble, then drain anything destroyed this frame and
    // emit its drops + sfx + visual burst. Compact in-place and mark
    // each destroyed breakable's spawn point consumed so chunk reload
    // doesn't respawn a freshly-smashed pot.
    for (const b of this.breakables) b.update(dt);
    compactInPlace(
      this.breakables,
      b => b.alive,
      b => {
        this._onBreakableDestroyed(b);
        if (b.chunkKey) this.world.markBreakableConsumed(b.chunkKey, b.pos.x, b.pos.z);
      },
    );

    // Structures: tick the hit-shake animation, drop any whose HP hit 0
    // this frame (free their collider, detach their mesh, forget the
    // descriptor so a chunk reload doesn't bring them back). Persist
    // updated HP into the placedStructures map so a mid-damage wall
    // survives chunk unload at its current health.
    for (const s of this.structures) s.update(dt);
    // Roof X-ray: when any player is standing inside a roof's footprint,
    // lerp that roof's opacity down to 0.1 so the player can see what's
    // happening under it (otherwise the roof completely hides the
    // building interior from the top-down camera). Walking back out
    // lerps it back up to 1.0. Each roof has its own cloned material
    // (see buildRoofPitchedMesh) so this is per-instance — adjacent
    // buildings keep their roofs solid.
    this._updateRoofFade(dt);
    for (const s of this.structures) {
      if (s.alive && s.chunkKey) {
        // Cheap save-system stub: keep the persisted descriptor's HP in
        // sync with the live entity. The Map lookup is O(n) per chunk; in
        // typical play n stays under ~20 per chunk so this is fine.
        this.world.updateStructureHP(s.chunkKey, s.pos.x, s.pos.z, s.hp, s.y || 0);
      }
    }
    compactInPlace(
      this.structures,
      s => s.alive,
      s => {
        const color = s.burstColor();
        // Burst at the structure's vertical centre so a stacked wall up
        // on a tower bursts where the wall actually was, not at ground
        // level. Ground ring stays on the floor either way.
        const burstY = 0.6 + (s.y || 0);
        this.effects.burst(s.pos.x, burstY, s.pos.z, color, 14, 4, 0.55);
        this.effects.ring(s.pos.x, 0.05, s.pos.z, color, 1.0, 0.32);
        // Material-specific break cue + 50% chance to drop the matching
        // resource. Wooden structures (fence/gate/planter) splinter into
        // a wood pickup; stone walls crumble into a stone pickup. The
        // 50% drop rate is intentionally lower than the recipe cost so a
        // build/break loop is a *resource sink*, not a no-op generator.
        const mat = structureMaterial(s.kind);
        if (mat === 'stone') this.sound.rockBreak?.();
        else this.sound.woodBreak?.();
        if (Math.random() < 0.5) {
          const drops = spawnHarvestDrops(this.scene, s.pos.x, s.pos.z, mat, 1);
          for (const d of drops) this.pickups.push(d);
        }
        s.removeCollider();
        s.destroyMesh();
        if (s.chunkKey) this.world.forgetStructure(s.chunkKey, s.pos.x, s.pos.z, s.y || 0);
        // Auto-disconnect: any fence-connectable death (fence/wall/gate)
        // empties its cell, so the 4-cardinal fence/gate neighbours need
        // their arms refreshed to stop pointing at it. forgetStructure
        // above has already removed this entry's descriptor, so the
        // rebuild sees the correct post-death state.
        if (s.kind === 'fence' || s.kind === 'wall' || s.kind === 'gate'
            || s.kind === 'wood_wall' || s.kind === 'glass_wall'
            || s.kind === 'door_full') {
          this._rebuildFenceNeighborsOf(s.pos.x, s.pos.z, s.y || 0, s.kind);
        }
        // A roof corner anchors a procedural roof above its building.
        // Killing the corner pulls the rest of the roof down with it
        // — find every roof_pitched whose rectangle uses this corner
        // and mark them dead. The compactInPlace below will sweep
        // both the corner and the roofs out of `this.structures` in
        // the same pass.
        if (s.kind === 'roof_corner') {
          const roofs = this._roofsAtCorner(s.pos.x, s.pos.z, s.y || 0);
          for (const r of roofs) {
            r.alive = false;
            r.hp = 0;
            r.removeCollider();
            r.destroyMesh();
            if (r.chunkKey) {
              this.world.forgetStructure(r.chunkKey, r.pos.x, r.pos.z, r.y || 0);
            }
          }
        }
        // Drop any attached Crop too — the planter mesh is gone so no
        // visible mesh remains, but the Crop entry would otherwise linger
        // in this.crops and try to find a deleted descriptor each tick.
        if (s.crop) {
          s.crop.destroy?.();
          s.crop._destroyed = true;
        }
      },
    );
    // Compact out any crops whose planter was destroyed this frame.
    compactInPlace(this.crops, c => !c._destroyed);

    // Resources: idle hit-shake / regrow timer, then catch newly-dead ones
    // and route to the harvest path. Trees stay in the list as walk-through
    // stumps (state==='stump') while their regrow timer ticks; rocks
    // transition to state==='gone' and get compacted out below. Unlike
    // breakables we don't mark either kind consumed — chunk reload
    // regenerates them from the deterministic seed (the fast path), and
    // the stump-regrow timer is the slow in-place path while the chunk
    // stays loaded.
    for (const r of this.resources) r.update(dt, this.world.dayLength);
    for (const r of this.resources) {
      if (!r.alive && r.state === 'alive') {
        this._onResourceGathered(r, r._lastDmgWeapon || null);
      }
    }
    // Compact only resources fully gone — trees in 'stump' state stay so
    // their regrow timer can keep ticking (and so chunk-unload can drop
    // them in lockstep with the rest of the chunk's entities).
    compactInPlace(this.resources, r => r.state !== 'gone');

    // Leash mechanic. Skipped entirely in solo mode — there's no second
    // player to drift away from, and the phantom is glued to slot 0
    // anyway, but we leave the math out so a fade/warn never triggers
    // on a phantom hiccup.
    if (this.solo) {
      this.leashRatio = 0;
    } else {
      const dBetween = vdist(this.players[0].pos, this.players[1].pos);
      const beyond = Math.max(0, dBetween - LEASH_WARN);
      this.leashRatio = clamp(beyond / (LEASH_MAX - LEASH_WARN), 0, 1);
      if (dBetween > LEASH_MAX) {
        const drain = LEASH_DRAIN * dt * (1 + (dBetween - LEASH_MAX) * 0.05);
        for (const p of this.players) {
          if (p.alive) {
            p.hp = Math.max(0, p.hp - drain);
            if (p.hp <= 0) p.die();
          }
        }
        // subtle warn sound at intervals
        if (Math.floor(this.elapsed * 2) % 2 === 0 && defaultRandom() < 0.05) {
          this.sound.tone({ freq: 240, type: 'sawtooth', dur: 0.2, gain: 0.15, slide: -50 });
        }
      }
    }

    // Revive: if a player is downed, the partner can hold their dash button
    // while standing within REVIVE_RANGE metres for REVIVE_HOLD seconds to
    // bring them back at REVIVE_HP of max. Visual feedback is rendered as
    // a thin progress bar above the downed body.
    for (let i = 0; i < this.players.length; i++) {
      const dead = this.players[i];
      if (dead.alive) continue;
      // Solo mode: dead phantom never reaches here (it's pinned alive),
      // and the live player has no partner to revive them — skip the loop
      // body for both slots.
      if (this.solo) continue;
      const partner = this.players[1 - i];
      const intent = partner.index === 0 ? i1 : i2;
      const inRange = partner.alive && vdist(dead.pos, partner.pos) <= REVIVE_RANGE;
      const holding = inRange && intent.dashHeld;
      if (holding) {
        dead.reviveProgress = Math.min(REVIVE_HOLD, dead.reviveProgress + dt);
      } else {
        dead.reviveProgress = Math.max(0, dead.reviveProgress - dt * 2);
      }
      this._renderReviveBar(dead);
      if (dead.reviveProgress >= REVIVE_HOLD) {
        dead.revive(REVIVE_HP);
        // Place revived player next to partner so they don't immediately die again.
        dead.pos.x = partner.pos.x + 0.6;
        dead.pos.z = partner.pos.z + 0.6;
        dead.smoothPos = { x: dead.pos.x, z: dead.pos.z };
        // Reset render-interp snapshot so the revived player doesn't
        // appear to slide from their pre-death position to the partner.
        dead._renderPrev = { x: dead.pos.x, z: dead.pos.z };
        dead._renderPos = { x: dead.pos.x, z: dead.pos.z };
        dead.knockback = { x: 0, z: 0 };
        this.effects.ring(dead.pos.x, 0.2, dead.pos.z, 0x7aff8a, 2.5, 0.6);
        this.effects.toast(`P${dead.index + 1} revived!`, '#7aff8a');
        this.sound.bell?.();
      }
    }

    // Death check (both fallen)
    if (this.players.every(p => !p.alive)) {
      this.dead = true;
      document.getElementById('death').classList.add('open');
    }

    this._updateUI();
    this.input.endFrame();
  }

  _updateUI() {
    const [p1, p2] = this.players;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    const setW = (id, w) => { const el = document.getElementById(id); if (el) el.style.width = `${w}%`; };
    setW('hp1', Math.max(0, (p1.hp / p1.maxHP) * 100));
    setW('hp2', Math.max(0, (p2.hp / p2.maxHP) * 100));
    set('hpval1', `${Math.max(0, Math.round(p1.hp))} / ${Math.round(p1.maxHP)}`);
    set('hpval2', `${Math.max(0, Math.round(p2.hp))} / ${Math.round(p2.maxHP)}`);
    set('gold1', p1.gold);
    set('gold2', p2.gold);
    set('lvl1', p1.level);
    set('lvl2', p2.level);
    set('dmg1', Math.round(p1.stats.damage));
    set('dmg2', Math.round(p2.stats.damage));
    this._renderItemBar(p1, 'items1');
    this._renderItemBar(p2, 'items2');
    this._renderAbilitySlot(p1, 'ability1', 'G');
    this._renderAbilitySlot(p2, 'ability2', 'H');
    // clock
    const total = this.world.dayTime * 24;
    const hh = Math.floor(total).toString().padStart(2, '0');
    const mm = Math.floor((total % 1) * 60).toString().padStart(2, '0');
    const phase = this.world.isNight() ? 'Night' : 'Day';
    set('clock', `${phase} · ${hh}:${mm}`);
    const dot = document.getElementById('clockdot');
    if (dot) dot.style.background = this.world.isNight() ? '#7aa6ff' : '#ffd166';
    // Shared resource counters live on the world (wood / stone / seeds)
    // so building consumes from a single pool. Both players see the same
    // numbers, unlike per-player gold.
    const res = this.world.resources;
    if (res) {
      set('wood', res.wood || 0);
      set('stone', res.stone || 0);
      set('seed', res.seeds || 0);
    }
    // Food inventory display for each player.
    this._renderFoodBar(p1, 'food1');
    this._renderFoodBar(p2, 'food2');
    // Build-mode banner — one strip per active player. Hidden when not
    // building. Shows recipe label, cost (red when unaffordable), and a
    // small key-hint reminder so players don't need to memorise the
    // F-place / R-cancel / E-rotate scheme.
    for (let pi = 0; pi < this.builders.length; pi++) {
      const b = this.builders[pi];
      const slot = pi === 0 ? '1' : '2';
      const bar = document.getElementById(`buildbar${slot}`);
      if (!bar) continue;
      if (!b || !b.active) {
        bar.classList.remove('active');
        bar.classList.remove('bad');
        continue;
      }
      bar.classList.add('active');
      bar.classList.toggle('bad', !b.ghostAffordable);
      const recipe = RECIPES[b.currentRecipe()];
      const nameEl = document.getElementById(`bb${slot}-name`);
      const costEl = document.getElementById(`bb${slot}-cost`);
      const layerEl = document.getElementById(`bb${slot}-layer`);
      if (nameEl) nameEl.textContent = recipe?.name || b.currentRecipe();
      if (costEl) {
        const parts = [];
        for (const [k, v] of Object.entries(recipe?.cost || {})) {
          const label = k === 'wood' ? 'дерево' : (k === 'stone' ? 'камень' : (k === 'seeds' ? 'семена' : k));
          parts.push(`${v} ${label}`);
        }
        costEl.textContent = parts.join(' · ');
      }
      if (layerEl) {
        // "Этаж" reads more naturally to a Russian speaker than "слой"
        // for vertical level — same noun used for building floors in
        // real architecture.
        layerEl.textContent = `этаж ${b.cursorLayer | 0}`;
      }
    }
    // Live affordability re-paint for any open build-wheel — without
    // this the slices stay coloured according to the resource snapshot
    // at open() time and don't react to the player picking up wood
    // while the picker is up.
    for (const w of this.buildWheels || []) w?.refresh?.();
    // leash overlay
    const leashEl = document.getElementById('leash');
    if (leashEl) leashEl.style.opacity = String(this.leashRatio * 0.85);
    const greyEl = document.getElementById('grey');
    if (greyEl) greyEl.style.backdropFilter = `grayscale(${this.leashRatio * 100}%) brightness(${1 - this.leashRatio * 0.3})`;
  }

  _renderItemBar(player, elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const ids = Object.keys(player.items).filter(k => (player.items[k] || 0) > 0);
    if (ids.length === 0) {
      if (el.childElementCount > 0) {
        el.innerHTML = '';
        // Drop the cached signature alongside the DOM — otherwise after a
        // death+restart (which clears `player.items`) re-acquiring the
        // same item would compute the same sig as before death and the
        // diff-friendly rebuild would skip emitting the icon back.
        delete el.dataset.sig;
      }
      return;
    }
    // Diff-friendly rebuild: only rewrite when the set/counts changed.
    const sig = ids.map(id => `${id}:${player.items[id]}`).sort().join(',');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = '';
    for (const id of ids) {
      const def = ITEM_BY_ID[id];
      if (!def) continue;
      const node = document.createElement('span');
      node.className = 'item-icon';
      node.dataset.rar = def.rarity;
      node.title = `${def.name} ×${player.items[id]} — ${def.desc}`;
      node.innerHTML = `<span class="hud-ico">${iconHTML(def.icon || 'sparkle', { size: 16 })}</span><span class="stk">×${player.items[id]}</span>`;
      el.appendChild(node);
    }
  }

  // Food inventory HUD — small bar showing raw crops + cooked dishes.
  _renderFoodBar(player, elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const list = player.edibleList();
    if (list.length === 0) {
      if (el.childElementCount > 0) { el.innerHTML = ''; delete el.dataset.sig; }
      return;
    }
    const sig = list.map(e => `${e.id}:${e.count}`).join(',')
      + (player.selectedFood ? `|sel:${player.selectedFood}` : '')
      + (player._foodBuff ? `|b:${player._foodBuff.kind}:${Math.ceil(player._foodBuff.ttl)}` : '');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = '';
    for (const entry of list) {
      const node = document.createElement('span');
      node.className = 'food-icon';
      if (entry.id === player.selectedFood) node.classList.add('selected');
      const label = this._foodItemLabel(entry.id);
      const kindTag = entry.kind === 'cooked' ? '🍳' : '🌱';
      node.title = `${label} ×${entry.count}`;
      node.textContent = `${kindTag}${entry.count}`;
      el.appendChild(node);
    }
    if (player._foodBuff) {
      const bNode = document.createElement('span');
      bNode.className = 'food-buff';
      bNode.textContent = `${buffLabel(player._foodBuff)} ${Math.ceil(player._foodBuff.ttl)}с`;
      el.appendChild(bNode);
    }
  }

  _renderAbilitySlot(player, elId, key) {
    const el = document.getElementById(elId);
    if (!el) return;
    const id = player.ability;
    if (!id) {
      if (!el.classList.contains('empty')) {
        el.classList.add('empty');
        el.classList.remove('ready');
        el.querySelector('.icon').innerHTML = iconHTML('dot', { size: 22 });
        el.querySelector('.ab-name').textContent = 'пусто';
        el.querySelector('.cd-text').textContent = '';
        const circle = el.querySelector('circle');
        if (circle) circle.setAttribute('stroke-dashoffset', '100.53');
      }
      return;
    }
    const def = ABILITY_BY_ID[id];
    if (!def) return;
    el.classList.remove('empty');
    if (el.dataset.id !== id) {
      el.dataset.id = id;
      el.querySelector('.icon').innerHTML = iconHTML(def.icon || 'sparkle', { size: 28 });
      el.querySelector('.ab-name').textContent = def.name;
      el.querySelector('.icon-wrap').style.boxShadow = `inset 0 0 0 2px #${def.color.toString(16).padStart(6, '0')}`;
    }
    // Same scaling as `_pushPlayerState`: the desktop ring should
    // start full (cd / cdMax === 1) right after a cast even when
    // the player has an `abilityCdMult` < 1.
    const cdMult = player.stats?.abilityCdMult ?? 1;
    const cdMax = def.cd * cdMult;
    const cd = player.abilityCd;
    const ready = cd <= 0;
    const circle = el.querySelector('circle');
    if (circle) {
      const C = 2 * Math.PI * 16; // ~100.53
      const frac = ready ? 0 : (cd / cdMax);
      circle.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
    }
    const t = el.querySelector('.cd-text');
    if (t) t.textContent = ready ? '' : cd.toFixed(1);
    el.classList.toggle('ready', ready);
    el.querySelector('.keyhint').textContent = key;
  }

  // Snapshot pre-step positions so render() can lerp between this and the
  // post-step pos using `_fixedAccum / FIXED_DT` as alpha. Lazy-initialises
  // _renderPrev on first capture (and after pool reuse, where the
  // constructor zeroes it) so freshly-spawned entities don't appear to
  // slide from a stale handle's last position.
  _captureRenderPrev() {
    for (const p of this.players) {
      if (!p || !p.alive) continue;
      if (!p._renderPrev) p._renderPrev = { x: p.pos.x, z: p.pos.z };
      else { p._renderPrev.x = p.pos.x; p._renderPrev.z = p.pos.z; }
    }
    for (const e of this.enemies) {
      if (!e || !e.alive) continue;
      if (!e._renderPrev) e._renderPrev = { x: e.pos.x, z: e.pos.z };
      else { e._renderPrev.x = e.pos.x; e._renderPrev.z = e.pos.z; }
    }
    for (const pr of this.projectiles || []) {
      if (!pr) continue;
      if (!pr._renderPrev) pr._renderPrev = { x: pr.pos.x, z: pr.pos.z };
      else { pr._renderPrev.x = pr.pos.x; pr._renderPrev.z = pr.pos.z; }
    }
  }

  render() {
    // Render-side interpolation. alpha is how far we are between the
    // last completed sim step and the next pending one — clamped to
    // [0,1] in case a partial step was queued.
    const alpha = Math.max(0, Math.min(1, this._fixedAccum / FIXED_DT));
    for (const p of this.players) {
      if (!p || !p.alive || !p.mesh || !p._renderPrev) continue;
      const ix = p._renderPrev.x + (p.pos.x - p._renderPrev.x) * alpha;
      const iz = p._renderPrev.z + (p.pos.z - p._renderPrev.z) * alpha;
      // Track the resolved render position so the camera and any
      // entity-following effects can read it without recomputing the
      // lerp. Mesh y is left untouched — locomotion bobs are sim-driven
      // and look fine without sub-step interpolation.
      p._renderPos = p._renderPos || { x: 0, z: 0 };
      p._renderPos.x = ix; p._renderPos.z = iz;
      p.mesh.position.set(ix, p.mesh.position.y, iz);
    }
    for (const e of this.enemies) {
      if (!e || !e.alive || !e.mesh || !e._renderPrev) continue;
      const ix = e._renderPrev.x + (e.pos.x - e._renderPrev.x) * alpha;
      const iz = e._renderPrev.z + (e.pos.z - e._renderPrev.z) * alpha;
      e.mesh.position.set(ix, e.mesh.position.y, iz);
    }
    for (const pr of this.projectiles || []) {
      if (!pr || !pr.mesh || !pr._renderPrev) continue;
      const ix = pr._renderPrev.x + (pr.pos.x - pr._renderPrev.x) * alpha;
      const iz = pr._renderPrev.z + (pr.pos.z - pr._renderPrev.z) * alpha;
      pr.mesh.position.set(ix, pr.mesh.position.y, iz);
    }
    // Camera follows the interpolated player positions. Without this
    // the camera step-snaps to sim pos every fixed step while the
    // meshes glide smoothly, which makes the world appear to "swim"
    // around the player on burst frames.
    const camP1 = this._cameraTarget(this.players[0]);
    const camP2 = this._cameraTarget(this.players[1]);
    this.followCam.update(0.016, camP1, camP2, this.effects.shake);
    this.renderer.render(this.scene, this.followCam.cam);
    if (this.minimap) this.minimap.render();
  }

  _cameraTarget(p) {
    if (!p) return { alive: false, pos: { x: 0, z: 0 } };
    // Solo-mode phantom partner is glued to player 0 — pretend it isn't
    // alive for camera-fit so the camera doesn't try to expand its frame
    // to include a (zero-distance) ghost.
    if (p._phantom) return { alive: false, pos: p._renderPos || p.pos };
    return {
      alive: p.alive,
      pos: p._renderPos || p.pos,
    };
  }
}
