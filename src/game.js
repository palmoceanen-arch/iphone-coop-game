import * as THREE from 'three';
import { World, WORLD_SIZE } from './world.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Projectile } from './projectile.js';
import { spawnDrops } from './pickups.js';
import { Effects } from './effects.js';
import { FollowCamera } from './camera.js';
import { Sound } from './sound.js';
import { Input } from './input.js';
import { UPGRADES, buy, renderShop } from './upgrades.js';
import { vdist, clamp, rand } from './utils.js';

const LEASH_WARN = 14; // distance at which screen starts greying
const LEASH_MAX  = 22; // beyond this, both bleed
const LEASH_DRAIN = 14; // hp/sec drain when beyond max
const SPAWN_CAP_BASE = 18;
const ENEMY_KINDS = ['slime', 'archer', 'bomber', 'wisp', 'ogre'];

export class Game {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.world = new World(this.scene);
    this.followCam = new FollowCamera(this.canvas);

    this.sound = new Sound();
    this.input = new Input();
    this.effects = new Effects(this.scene, this.followCam.cam);

    this.players = [
      new Player(0, this.world, this.effects, this.sound),
      new Player(1, this.world, this.effects, this.sound),
    ];
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];

    this.spawnCooldown = 1.5;
    this.dangerLevel = 1;
    this.totalKills = 0;
    this.elapsed = 0;

    this.paused = false;
    this.shopOpen = false;
    this.dead = false;
    this.leashRatio = 0;
    this.timescale = 1;

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
    const start = () => {
      const intro = document.getElementById('intro');
      if (intro) intro.style.display = 'none';
      this._waitingForStart = false;
      this.sound.resume();
      this.sound.bell();
    };
    document.getElementById('start')?.addEventListener('click', start);
    window.addEventListener('keydown', (e) => {
      if (this._waitingForStart) start();
      if (e.code === 'KeyP') this.paused = !this.paused;
    });
    document.getElementById('restart')?.addEventListener('click', () => this.restart());
  }

  restart() {
    // remove enemies, projectiles, pickups
    for (const e of this.enemies) { if (e.alive) this.scene.remove(e.mesh); }
    for (const p of this.projectiles) { p._destroy?.(); }
    for (const p of this.pickups) { p._destroy?.(); }
    this.enemies = []; this.projectiles = []; this.pickups = [];
    // revive players
    for (const p of this.players) {
      p.pos.x = (p.index === 0 ? -3 : 3); p.pos.z = 4;
      p.vel = { x: 0, z: 0 }; p.knockback = { x: 0, z: 0 };
      p.revive();
    }
    this.dead = false;
    this.spawnCooldown = 1.0;
    this.dangerLevel = 1;
    this.totalKills = 0;
    document.getElementById('death').classList.remove('open');
  }

  _spawnEnemy() {
    // Wave/danger curve: increases over time + at night
    const isNight = this.world.isNight();
    const cap = SPAWN_CAP_BASE + Math.floor(this.dangerLevel * 1.5) + (isNight ? 6 : 0);
    if (this.enemies.filter(e => e.alive).length >= cap) return;
    // Don't spawn too close to players
    let x, z, ok = false;
    for (let i = 0; i < 30; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(20, WORLD_SIZE - 6);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      const minD = Math.min(...this.players.map(p => vdist({x,z}, p.pos)));
      if (minD > 16 && this.world.isClear(x, z, 1.5)) { ok = true; break; }
    }
    if (!ok) return;
    // Pick kind weighted by danger level
    const weights = {
      slime:  Math.max(0.8, 2.5 - this.dangerLevel * 0.15),
      archer: 0.9 + this.dangerLevel * 0.05,
      bomber: 0.5 + this.dangerLevel * 0.08 + (isNight ? 0.4 : 0),
      wisp:   0.4 + this.dangerLevel * 0.06 + (isNight ? 0.3 : 0),
      ogre:   0.15 + this.dangerLevel * 0.06,
    };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let kind = 'slime';
    for (const k of ENEMY_KINDS) {
      r -= weights[k];
      if (r <= 0) { kind = k; break; }
    }
    const lvl = 1 + Math.floor(this.dangerLevel / 3) + (isNight ? 1 : 0);
    this.enemies.push(new Enemy(this.world, this.effects, this.sound, kind, x, z, lvl));
  }

  _onPlayerHitsEnemy(player, enemy) {
    const dmg = player.stats.damage * (1 + Math.random() * 0.05);
    if (enemy.takeDamage(dmg, player.pos.x, player.pos.z, 10)) {
      // visual hit
      this.effects.flashSphere(enemy.pos.x, 1.0, enemy.pos.z, 0xffffff, 0.5, 0.12);
      if (!enemy.alive) {
        this._onEnemyDies(player, enemy);
      }
    }
  }

  _onEnemyDies(killer, enemy) {
    this.totalKills += 1;
    if (this.totalKills % 6 === 0) this.dangerLevel += 1;
    const dropFood = Math.random() < 0.18;
    const drops = spawnDrops(this.scene, enemy.pos.x, enemy.pos.z, enemy.gold, dropFood);
    for (const d of drops) this.pickups.push(d);
    // bonus xp granted to killer
    if (killer && killer.alive) {
      killer.xp += enemy.xp;
      const need = killer.level * 30;
      if (killer.xp >= need) {
        killer.xp -= need;
        killer.level += 1;
        killer.maxHP += 8;
        killer.hp += 8;
        this.effects.toast(`P${killer.index+1} reached level ${killer.level}!`, killer.index === 0 ? '#6ad0ff' : '#ff8a8a');
        this.effects.ring(killer.pos.x, 0.06, killer.pos.z, 0xfff7a0, 2.2, 0.5);
      }
    }
  }

  _loop(t) {
    const dt0 = Math.min(0.05, (t - this._lastT) / 1000) || 0;
    this._lastT = t;
    let dt = dt0;
    if (this.paused || this.shopOpen || this._waitingForStart || this.dead) dt = 0;
    else if (this.effects.hitStop > 0) dt *= 0.15;
    this.update(dt, dt0);
    this.render();
    requestAnimationFrame((tt) => this._loop(tt));
  }

  update(dt, dt0) {
    // Always update FX timing using real dt0 (so shake decays even paused)
    this.effects.update(dt > 0 ? dt : dt0 * 0);
    this.world.update(dt);
    if (dt <= 0) { this._updateUI(); return; }
    this.elapsed += dt;

    // Player intents
    const i1 = this.input.intent(0);
    const i2 = this.input.intent(1);

    // Toggle shop with Tab if near campfire (or always allow)
    if (this.input.consumeGlobal('Tab')) {
      this.shopOpen = !this.shopOpen;
      document.getElementById('shop').classList.toggle('open', this.shopOpen);
      if (this.shopOpen) renderShop(this.players[0], this.players[1]);
    }

    // Quick-buy keys 1-4 for P1, 7-0 for P2 (only when shop open)
    if (this.shopOpen) {
      const map1 = { 'Digit1': 0, 'Digit2': 1, 'Digit3': 2, 'Digit4': 3 };
      const map2 = { 'Digit7': 0, 'Digit8': 1, 'Digit9': 2, 'Digit0': 3 };
      for (const code of Object.keys(map1)) {
        if (this.input.consumeGlobal(code)) {
          if (buy(this.players[0], UPGRADES[map1[code]], this.sound)) renderShop(this.players[0], this.players[1]);
        }
      }
      for (const code of Object.keys(map2)) {
        if (this.input.consumeGlobal(code)) {
          if (buy(this.players[1], UPGRADES[map2[code]], this.sound)) renderShop(this.players[0], this.players[1]);
        }
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
    // Cleanup dead bombers etc that left scene
    this.enemies = this.enemies.filter(e => e.alive || e.killedBy === 'self' ? e.alive : true).filter(e => e.alive);

    // Projectiles
    for (const pr of this.projectiles) pr.update(dt, this.players, this.world);
    this.projectiles = this.projectiles.filter(pr => pr.alive);

    // Pickups
    for (const pk of this.pickups) pk.update(dt, this.players, this.sound, this.effects);
    this.pickups = this.pickups.filter(pk => pk.alive);

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

    // Spawn enemies
    this.spawnCooldown -= dt;
    if (this.spawnCooldown <= 0) {
      const interval = clamp(2.0 - this.dangerLevel * 0.05 - (this.world.isNight() ? 0.5 : 0), 0.4, 2.0);
      this.spawnCooldown = interval;
      this._spawnEnemy();
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
    const d = vdist(p1.pos, p2.pos);
    set('dist', `${d.toFixed(1)}m apart`);
    // clock
    const total = this.world.dayTime * 24;
    const hh = Math.floor(total).toString().padStart(2, '0');
    const mm = Math.floor((total % 1) * 60).toString().padStart(2, '0');
    const phase = this.world.isNight() ? 'Night' : 'Day';
    set('clock', `${phase} · ${hh}:${mm}`);
    const dot = document.getElementById('clockdot');
    if (dot) dot.style.background = this.world.isNight() ? '#7aa6ff' : '#ffd166';
    // leash overlay
    const leashEl = document.getElementById('leash');
    if (leashEl) leashEl.style.opacity = String(this.leashRatio * 0.85);
    const greyEl = document.getElementById('grey');
    if (greyEl) greyEl.style.backdropFilter = `grayscale(${this.leashRatio * 100}%) brightness(${1 - this.leashRatio * 0.3})`;
  }

  render() {
    this.followCam.update(0.016, this.players[0], this.players[1], this.effects.shake);
    this.renderer.render(this.scene, this.followCam.cam);
  }
}
