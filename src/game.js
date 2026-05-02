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
import { vdist, clamp, hashString } from './utils.js';
import { getSettings } from './settings.js';
import { PauseMenu } from './pause.js';
import { runItemHook, ITEM_BY_ID, pickRandomItemId } from './items.js';
import { ABILITY_BY_ID } from './abilities.js';
import { Rune } from './runes.js';
import { Chest } from './chest.js';

const LEASH_WARN = 14;
const LEASH_MAX  = 22;
const LEASH_DRAIN = 14;
const REVIVE_RANGE = 2.5;        // metres
const REVIVE_HOLD = 2.0;         // seconds of dashHeld required
const REVIVE_HP = 0.5;           // fraction of maxHP after revive

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
  msg.innerHTML = `Не удалось инициализировать WebGL.<br>На iPhone попробуй зайти на <code>/controller.html</code> вместо хост-страницы.<br><br>${(lastErr?.message || lastErr || '')}`;
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
    this.world = new World(this.scene, seedInfo.value);
    this.followCam = new FollowCamera(this.canvas);

    this.sound = new Sound();
    this.input = new Input();
    this.effects = new Effects(this.scene, this.followCam.cam);

    this.players = [
      new Player(0, this.world, this.effects, this.sound),
      new Player(1, this.world, this.effects, this.sound),
    ];
    // Starter abilities so phone & desktop have something to cast immediately.
    this.players[0].setAbility('fireball');
    this.players[1].setAbility('icebolt');
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.runes = [];   // item / ability rune drops in the world
    this.chests = []; // procedurally placed treasure chests

    this._spawnInitialEnemies();
    this._drainChestSpawns();
    this._spawnStarterChest();

    this.totalKills = 0;
    this.elapsed = 0;

    this.paused = false;
    this.menuPaused = false; // true while #pause overlay is open
    this.shopOpen = false;
    this._keyboardShop = false;
    this._fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
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
    this.pauseMenu = new PauseMenu(this.settings);

    this._bindUI();
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // start screen
    this._waitingForStart = true;
    this._lastT = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  _bindUI() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP') this.paused = !this.paused;
      if (e.code === 'Escape') {
        e.preventDefault();
        this._togglePauseMenu();
      }
      if (e.code === 'KeyG') this._tryCastAbility(0);
      if (e.code === 'KeyH') this._tryCastAbility(1);
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

  _tryCastAbility(slot) {
    if (this._waitingForStart || this.paused || this.menuPaused || this.shopOpen || this.dead) return;
    const player = this.players[slot];
    if (!player) return;
    const partner = this.players[1 - slot];
    const ctx = {
      enemyList: this.enemies,
      partner,
      effects: this.effects,
      sound: this.sound,
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
    this.shopOpen = !!(this._keyboardShop || this.phoneShopOpen[0] || this.phoneShopOpen[1]);
    document.getElementById('shop')?.classList.toggle('open', !!this._keyboardShop);
    if (this._keyboardShop) {
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
    const upgrades = UPGRADES.map(u => ({
      id: u.id,
      name: u.name,
      desc: u.desc,
      level: p.upgradeLevels[u.id] || 0,
      price: priceFor(p, u),
    }));
    const items = Object.entries(p.items || {}).map(([id, count]) => {
      const def = ITEM_BY_ID[id];
      return def ? { id, name: def.name, icon: def.icon, rarity: def.rarity, count } : null;
    }).filter(Boolean);
    let ability = null;
    if (p.ability) {
      const def = ABILITY_BY_ID[p.ability];
      if (def) {
        ability = {
          id: p.ability,
          name: def.name,
          icon: def.icon,
          color: '#' + def.color.toString(16).padStart(6, '0'),
          cd: Math.max(0, p.abilityCd || 0),
          cdMax: def.cd,
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

  restart() {
    // remove enemies, projectiles, pickups
    for (const e of this.enemies) { if (e.alive) this.scene.remove(e.mesh); }
    for (const p of this.projectiles) { p._destroy?.(); }
    for (const p of this.pickups) { p._destroy?.(); }
    for (const r of this.runes) { r._destroy?.(); }
    for (const c of this.chests) { c._destroy?.(); }
    this.enemies = []; this.projectiles = []; this.pickups = []; this.runes = []; this.chests = [];
    // revive players
    for (const p of this.players) {
      p.pos.x = (p.index === 0 ? -3 : 3); p.pos.z = 4;
      p.vel = { x: 0, z: 0 }; p.knockback = { x: 0, z: 0 };
      // Wipe item / ability progress on restart — fresh roguelike run.
      p.items = {};
      p.ability = null;
      p.abilityCd = 0;
      p._shield = null;
      p._berserk = null;
      p._healAura = null;
      p._itemSpeedMult = 1;
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
  }

  _spawnInitialEnemies() {
    // Drain any pending enemy spawns produced by chunk generation (origin
    // chunk and immediate neighbours are loaded in World.constructor).
    this._drainPendingEnemySpawns();
  }

  _drainPendingEnemySpawns() {
    while (this.world.enemySpawns.length > 0) {
      const s = this.world.enemySpawns.shift();
      const e = new Enemy(this.world, this.effects, this.sound, s.kind, s.x, s.z, s.level || 1, {
        homeX: s.homeX, homeZ: s.homeZ, elite: !!s.elite,
      });
      this.enemies.push(e);
    }
  }

  _drainChestSpawns() {
    if (!this.world.chestSpawns) return;
    while (this.world.chestSpawns.length > 0) {
      const s = this.world.chestSpawns.shift();
      const c = new Chest(this.scene, s.x, s.z);
      this.chests.push(c);
    }
  }

  // Always spawn one chest near origin on first load so players see the
  // pickup loop within a few seconds — discovering the first chest can
  // otherwise take a few minutes of exploration.
  _spawnStarterChest() {
    if (this._starterChestSpawned) return;
    this._starterChestSpawned = true;
    const c = new Chest(this.scene, 4, 4);
    this.chests.push(c);
  }

  // Walk every loaded player position and ask the world to materialise any
  // missing chunks around them; then update the active chunk set so far-off
  // chunks are hidden + their entities frozen. Cheap.
  _streamChunks() {
    if (!this.players) return;
    const positions = [];
    for (const p of this.players) {
      if (!p) continue;
      this.world.ensureChunksAround(p.pos.x, p.pos.z);
      positions.push({ x: p.pos.x, z: p.pos.z });
    }
    this.world.refreshActiveChunks(positions);
    this._drainPendingEnemySpawns();
    this._drainChestSpawns();
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

  _onPlayerHitsEnemy(player, enemy) {
    const partner = this.players[1 - player.index];
    // ctx is shared between onAttack and onHit so items can tag e.g. crit.
    const ctx = {
      enemy,
      partner,
      enemyList: this.enemies,
      dmgMult: 1,
      crit: false,
      dmg: 0,
      echo: false,
    };
    runItemHook(player, 'onAttack', ctx);
    let dmg = player.stats.damage * (1 + Math.random() * 0.05) * ctx.dmgMult;
    if (player._berserk) dmg *= player._berserk.dmg;
    ctx.dmg = dmg;
    if (enemy.takeDamage(dmg, player.pos.x, player.pos.z, 10)) {
      runItemHook(player, 'onHit', ctx);
      const flashColor = ctx.crit ? 0xffd166 : 0xffffff;
      this.effects.flashSphere(enemy.pos.x, 1.0, enemy.pos.z, flashColor, ctx.crit ? 0.7 : 0.5, 0.12);
      if (!enemy.alive) {
        runItemHook(player, 'onKill', ctx);
        this._onEnemyDies(player, enemy);
      }
    }
  }

  _onEnemyDies(killer, enemy) {
    this.totalKills += 1;
    const dropFood = Math.random() < 0.18;
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
    const dt0 = Math.min(0.05, (t - this._lastT) / 1000) || 0;
    this._lastT = t;
    let dt = dt0;
    if (this.paused || this.menuPaused || this.shopOpen || this._waitingForStart || this.dead) dt = 0;
    else if (this.effects.hitStop > 0) dt *= 0.15;
    this.update(dt, dt0);
    this.render();
    this._updateFps(dt0);
    requestAnimationFrame((tt) => this._loop(tt));
  }

  _updateFps(dt0) {
    if (!this.settings || !this.settings.showFps()) return;
    this._fpsAcc += dt0;
    this._fpsFrames += 1;
    if (this._fpsAcc >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsAcc);
      this._fpsAcc = 0; this._fpsFrames = 0;
      const el = document.getElementById('fps');
      if (el) el.textContent = `FPS ${this._fps}`;
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
    for (let i = 0; i < this.players.length; i++) {
      const dead = this.players[i];
      const partner = this.players[1 - i];
      if (dead.alive || !partner.alive) continue;
      if (vdist(dead.pos, partner.pos) <= REVIVE_RANGE) {
        intents[partner.index].dash = false;
      }
    }

    // Update players
    this.players[0].update(dt, i1, this.players[1], this.enemies, (a, b) => this._onPlayerHitsEnemy(a, b));
    this.players[1].update(dt, i2, this.players[0], this.enemies, (a, b) => this._onPlayerHitsEnemy(a, b));

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
    // Cleanup dead enemies
    this.enemies = this.enemies.filter(e => e.alive);

    // Projectiles
    for (const pr of this.projectiles) pr.update(dt, this.players, this.world);
    this.projectiles = this.projectiles.filter(pr => pr.alive);

    // Pickups
    for (const pk of this.pickups) pk.update(dt, this.players, this.sound, this.effects);
    this.pickups = this.pickups.filter(pk => pk.alive);

    // Chests + runes
    for (const c of this.chests) c.update(dt, this.players, this.sound, this.effects, (rune) => this.runes.push(rune));
    this.chests = this.chests.filter(c => c.alive);
    for (const r of this.runes) r.update(dt, this.players, this.sound, this.effects);
    this.runes = this.runes.filter(r => r.alive);

    // Leash mechanic
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
      if (Math.floor(this.elapsed * 2) % 2 === 0 && Math.random() < 0.05) {
        this.sound.tone({ freq: 240, type: 'sawtooth', dur: 0.2, gain: 0.15, slide: -50 });
      }
    }

    // Revive: if a player is downed, the partner can hold their dash button
    // while standing within REVIVE_RANGE metres for REVIVE_HOLD seconds to
    // bring them back at REVIVE_HP of max. Visual feedback is rendered as
    // a thin progress bar above the downed body.
    for (let i = 0; i < this.players.length; i++) {
      const dead = this.players[i];
      if (dead.alive) continue;
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
    const d = vdist(p1.pos, p2.pos);
    set('dist', `${d.toFixed(1)}m apart`);
    // clock
    const total = this.world.dayTime * 24;
    const hh = Math.floor(total).toString().padStart(2, '0');
    const mm = Math.floor((total % 1) * 60).toString().padStart(2, '0');
    const phase = this.world.isNight() ? 'Night' : 'Day';
    set('clock', `${phase} · ${hh}:${mm}`);
    set('seedlabel', this.seedDisplay);
    const dot = document.getElementById('clockdot');
    if (dot) dot.style.background = this.world.isNight() ? '#7aa6ff' : '#ffd166';
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
      if (el.childElementCount > 0) el.innerHTML = '';
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
      node.innerHTML = `<span>${def.icon || '?'}</span><span class="stk">×${player.items[id]}</span>`;
      el.appendChild(node);
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
        el.querySelector('.icon').textContent = '·';
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
      el.querySelector('.icon').textContent = def.icon;
      el.querySelector('.ab-name').textContent = def.name;
      el.querySelector('.icon-wrap').style.boxShadow = `inset 0 0 0 2px #${def.color.toString(16).padStart(6, '0')}`;
    }
    const cdMax = def.cd;
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

  render() {
    this.followCam.update(0.016, this.players[0], this.players[1], this.effects.shake);
    this.renderer.render(this.scene, this.followCam.cam);
  }
}
