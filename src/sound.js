// Sample-based audio for Twin Hearts.
//
// One-shot SFX (sword swing, hits, hurt, breakables, pickups) play short
// CC0 .ogg samples from `public/sounds/` — variants are picked at random
// and the buffer cache is loaded lazily so cold-boot has zero audio cost.
//
// Ambient nature (wind, water lap, campfire bed) is also sample-based:
// each layer owns one looping AudioBufferSourceNode pointing at a CC0
// field recording. Forest hum stays procedural (shaped noise + bandpass)
// because no single recording reads as "leaf rustle on a windless day"
// without sounding like a specific real-world location. Day/night chorus
// (birds, crickets) is procedural — many tiny chirps scheduled with
// per-frame probability — so the meadow gets a sparse, randomised chorus
// instead of a looping recording with an audible seam.
//
// Layer gains are modulated each frame from world context (player
// proximity to ponds & campfires, day/night phase, tree-density noise),
// so the soundscape responds to where the players are without ever
// rebuilding the WebAudio graph.
//
// Routing:
//   one-shot SFX  → sfxBus  →┐
//   ambient       → ambBus  →┴→ master → ctx.destination
//
// Volume sliders in the pause menu (`settings.applyAudio`) feed live values
// into setMasterVolume / setSfxVolume / setAmbientVolume / setMuted without
// touching the graph itself.

// Static sample manifest. Multiple files per `id` give natural variation —
// every play picks a fresh variant with a small per-shot pitch jitter so
// repeated combat hits never sound mechanically identical.
const SAMPLES = {
  // Sword/weapon swing — bamboo-stick whooshes (qubodup, CC0). Reads as
  // air being cut, not a knife on cloth like the original RPG-Audio
  // knifeSlice + cloth pair we shipped first.
  swing:        ['swing_whoosh_a.ogg', 'swing_whoosh_b.ogg', 'swing_whoosh_c.ogg', 'swing_whoosh_d.ogg'],
  hitFlesh:     ['hit_flesh_a.ogg', 'hit_flesh_b.ogg', 'hit_flesh_c.ogg'],
  hitHeavy:     ['hit_heavy_a.ogg', 'hit_heavy_b.ogg'],
  // Short monster vocalisations layered on top of the hit_flesh impact
  // when the player damages an enemy. Two clips so repeated combat hits
  // don't sound identical: a guttural monster grumble (monster_05) and
  // a pitched-up pained 'hurt' (hurt_05 +10% rate). Plays at a lower
  // gain than the impact itself so the weapon-flesh punch still leads,
  // with the voice as a sweetener. All clips are CC0 from OpenGameArt's
  // "80 creature SFX" pack (rubberduck).
  enemyVoice:   ['enemy_voice_a.ogg', 'enemy_voice_d.ogg'],
  // Bigger, slower roar reserved for the suicide-bomber kind on hit —
  // hooked up via enemyHit({ kind: 'bomber' }). Probabilistic, so most
  // bomber hits still use the regular enemyVoice pool.
  enemyVoiceBomber: ['enemy_voice_bomber_a.ogg'],
  // Two odd, otherworldly vocalisations reserved for elite (legendary)
  // enemies — hooked up via enemyHit({ elite: true }). Plays rarely so
  // it stays special.
  enemyVoiceLegendary: ['enemy_voice_legendary_a.ogg', 'enemy_voice_legendary_b.ogg'],
  hurt:         ['hurt_armor_a.ogg', 'hurt_armor_b.ogg'],
  // Death cry on enemy.die() — short creature grunts so a kill reads
  // as a vocal end-of-life rather than a generic impact splat.
  enemyDie:     ['enemy_die_a.ogg', 'enemy_die_b.ogg'],
  // Heavy plank-snap impacts (Kenney impactWood_heavy) — meatier
  // splintering crack than the previous medium variants. `treeFall()`
  // plays a slightly louder variant of these so a felled tree reads as a
  // pure splinter-crack with no creaky preamble.
  woodBreak:    ['wood_break_a.ogg', 'wood_break_b.ogg', 'wood_break_c.ogg'],
  potBreak:     ['pot_break_a.ogg', 'pot_break_b.ogg'],
  // Per-swing impact when a melee weapon connects with a tree (axe-on-
  // plank texture) or a rock (pickaxe / mining strike). Different
  // material from the breakable crate / glass pot samples so the
  // gathering loop has its own ear-recognisable rhythm.
  hitWood:      ['hit_wood_a.ogg', 'hit_wood_b.ogg', 'hit_wood_c.ogg'],
  hitStone:     ['hit_stone_a.ogg', 'hit_stone_b.ogg', 'hit_stone_c.ogg'],
  coin:         ['coin_a.ogg', 'coin_b.ogg'],
  treeCreak:    ['tree_creak_a.ogg', 'tree_creak_b.ogg'],
};

// Min spacing between two plays of the same id, in seconds. Multi-hit
// abilities (e.g. fireball AoE landing on 6 enemies) would otherwise stack
// 6 identical impacts on the same ms, which both sounds bad and pegs the
// audio thread.
const RATE_LIMIT = {
  swing: 0.04,
  hitFlesh: 0.03,
  hitHeavy: 0.05,
  hurt: 0.10,
  // Voice plays alongside hitFlesh on every enemy hit, so it'd otherwise
  // smear into a roar on AoE / multi-hit abilities. 90 ms gives a clear
  // gap between vocalisations even when 6 enemies eat the same fireball.
  enemyVoice: 0.09,
  enemyVoiceBomber: 0.20,
  enemyVoiceLegendary: 0.20,
  enemyDie: 0.05,
  woodBreak: 0.05,
  potBreak: 0.05,
  hitWood: 0.06,
  hitStone: 0.06,
  coin: 0.04,
  treeCreak: 0.10,
};

// Each per-id rate-limit also has a parallel "voice cap" — when the same
// effect is already sounding `cap` times we drop the new trigger entirely
// instead of stacking another voice on top. Without this, a fireball
// landing on a dense pack of 8 enemies would smear into a single muddy
// roar; the cap keeps it crisp.
const VOICE_CAP = {
  swing: 4,
  hitFlesh: 5,
  hitHeavy: 3,
  hurt: 2,
  enemyVoice: 3,
  enemyVoiceBomber: 2,
  enemyVoiceLegendary: 2,
  enemyDie: 4,
  woodBreak: 3,
  potBreak: 3,
  hitWood: 3,
  hitStone: 3,
  coin: 5,
  treeCreak: 2,
};

const SOUNDS_BASE = 'sounds/';

// File names (under SOUNDS_BASE) for the three sample-based ambient layers.
// All three are CC0, sourced as documented in public/sounds/LICENSE.txt:
//   wind   — rubberduck ambient_03 from "30 CC0 SFX loops" (~7s, CC0,
//            broadband air-noise loop — picked because the spectrogram
//            is clean broadband noise with no tonal/melodic content)
//   water  — rubberduck loop_water_02 from "40 CC0 water/splash/slime SFX"
//            (~7s, CC0)
//   fire   — supplied by the project owner (~20s, CC0; re-encoded from
//            stereo MP3 to mono OGG q=4) — long enough that the loop
//            seam isn't perceptible at the gain levels updateAmbient
//            drives the campfire bus to
// Each loads on `ensure()` and is then played as a single looping
// AudioBufferSourceNode for the lifetime of the page. Loop seams are
// long enough (or busy enough) that they aren't perceptible at the
// modulated gain levels the meadow uses.
const AMBIENT_SAMPLES = {
  wind:  'ambient_wind.ogg',
  water: 'ambient_water.ogg',
  fire:  'ambient_fire.ogg',
};

// 8 seconds of pre-rendered seeded noise. Used only by the procedural
// forest layer (no good single-source recording reads as a generic
// leaf-rustle hum without sounding like a specific real location).
const AMBIENT_NOISE_SECONDS = 8.0;

// 32-bit LCG so the ambient noise buffer is identical across reloads
// (helps debugging, and avoids the one-frame loudness blip you get from
// freshly seeded white noise when a player hits Resume).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Two-pole leaky integrator: turn white noise into pinkish/brown noise
// without an FFT. Brown noise (alpha≈0.99) is the natural texture for
// wind & water; pink (alpha≈0.85) for forest hum.
function shapedNoiseBuffer(ctx, seconds, alpha = 0.99, seed = 0xDEADBEEF) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);
  const rand = lcg(seed);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = rand() * 2 - 1;
    last = alpha * last + (1 - alpha) * w;
    ch[i] = last;
  }
  // Normalise so the loudest sample sits at 0.95 — pre-shaping leaves the
  // peak at a few percent which would force every gain stage above to crank.
  let peak = 0;
  for (let i = 0; i < len; i++) if (Math.abs(ch[i]) > peak) peak = Math.abs(ch[i]);
  if (peak > 0) {
    const k = 0.95 / peak;
    for (let i = 0; i < len; i++) ch[i] *= k;
  }
  return buf;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.ambBus = null;
    this.muted = false;
    this.masterVolume = 0.5;
    this.sfxVolume = 1.0;
    this.ambientVolume = 0.6;

    // Sample cache. `null` = not requested yet, Promise = in-flight,
    // AudioBuffer = ready, false = failed-load (don't retry forever).
    this._buffers = new Map();   // path → AudioBuffer | Promise | false
    this._lastPlayed = new Map();// id → ctx.currentTime of last play
    this._activeVoices = new Map(); // id → count of currently sounding voices

    // Ambient layer registry built lazily on `ensure()` so AudioContext
    // creation is still gated on the user's first input gesture.
    this._ambient = null;
    // External world reference for proximity probing (water, fire, …).
    this._world = null;
    // Smoothed ambient parameters. Each layer has a `current` gain that
    // chases its `target` exponentially in `updateAmbient(dt)`, so toggling
    // a layer (e.g. dawn breaks, cricket fades) is gradual, not a click.
    this._ambSmooth = null;
  }

  // ---- Lifecycle --------------------------------------------------------

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.ambBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.ambBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    this._applyGains();
    this._buildAmbient();
    this._bindVisibilityMute();
  }

  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    // Kick off background prefetch of the most-common combat samples on
    // first user gesture so the first swing isn't silent. Less-common
    // samples still load on demand; the loader is idempotent.
    this._prefetch(['swing', 'hitFlesh', 'enemyVoice', 'enemyVoiceBomber', 'enemyVoiceLegendary', 'hurt', 'enemyDie']);
  }

  // Yandex Games requirement 1.3 (and a general courtesy on every host):
  // game audio must stop when the tab/window is minimised, hidden, or
  // the user switches to another tab. We do this by suspending the
  // AudioContext so processing actually halts (zero CPU) rather than
  // just zeroing the master gain. Idempotent — the same handler is
  // safe to fire while already suspended (no-op) and on the resume
  // side AudioContext.resume() is a no-op if already running.
  _bindVisibilityMute() {
    if (typeof document === 'undefined') return;
    if (this._visibilityBound) return;
    this._visibilityBound = true;
    const onChange = () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') {
        if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
      } else if (document.visibilityState === 'visible') {
        // Only resume if the user already kicked off audio via a gesture
        // (i.e. we ever called resume()). Re-suspending an autoplay-blocked
        // context with no user interaction would warn in Chrome.
        if (this.ctx.state === 'suspended' && !this.muted) {
          this.ctx.resume().catch(() => {});
        }
      }
    };
    document.addEventListener('visibilitychange', onChange);
    // pagehide fires on bfcache navigation away (iOS Safari especially)
    // where visibilitychange alone can lag; suspending here matches the
    // "sound stops within 2 s of leaving the tab" allowance in 1.3.
    window.addEventListener('pagehide', () => {
      try { this.ctx?.suspend?.(); } catch { /* ignore */ }
    });
  }

  setWorld(world) { this._world = world; }

  // ---- Volume controls (wired from settings.applyAudio) -----------------

  _applyGains() {
    if (!this.master) return;
    const m = this.muted ? 0 : this.masterVolume;
    this.master.gain.value = m;
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxVolume;
    if (this.ambBus) this.ambBus.gain.value = this.ambientVolume;
  }
  setMuted(m) { this.muted = !!m; this._applyGains(); }
  setMasterVolume(v) { this.masterVolume = clamp01(Number(v) || 0); this._applyGains(); }
  setSfxVolume(v) { this.sfxVolume = clamp01(Number(v) || 0); this._applyGains(); }
  setAmbientVolume(v) { this.ambientVolume = clamp01(Number(v) || 0); this._applyGains(); }

  // ---- Sample loading ---------------------------------------------------

  _prefetch(ids) {
    if (!this.ctx) return;
    for (const id of ids) {
      const list = SAMPLES[id];
      if (!list) continue;
      for (const f of list) this._loadBuffer(f);
    }
  }

  _loadBuffer(file) {
    if (!this.ctx) return null;
    const cached = this._buffers.get(file);
    if (cached !== undefined && cached !== null) return cached;
    const promise = fetch(SOUNDS_BASE + file)
      .then((r) => {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this._buffers.set(file, buf); return buf; })
      .catch(() => { this._buffers.set(file, false); return null; });
    this._buffers.set(file, promise);
    return promise;
  }

  // ---- One-shot SFX -----------------------------------------------------

  // Internal: play one variant of `id` with optional pitch/gain jitter.
  // Falls back to a synthesised `tone`/`noise` placeholder so the first
  // call (before the .ogg has finished decoding) is still audible.
  _play(id, opts = {}) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const last = this._lastPlayed.get(id) || -Infinity;
    const limit = RATE_LIMIT[id] ?? 0;
    if (t - last < limit) return;
    const cap = VOICE_CAP[id] ?? Infinity;
    const live = this._activeVoices.get(id) || 0;
    if (live >= cap) return;
    this._lastPlayed.set(id, t);

    const list = SAMPLES[id];
    const file = list[(Math.random() * list.length) | 0];
    const buffered = this._buffers.get(file);

    // First play of a category: kick off the load AND emit a synthesised
    // placeholder so the action still has feedback. Once the buffer
    // resolves, every subsequent call uses the real sample.
    if (buffered === undefined || buffered === null) {
      this._loadBuffer(file);
      this._fallback(id);
      return;
    }
    if (buffered === false) { this._fallback(id); return; }
    if (typeof buffered.then === 'function') {
      // Still decoding — placeholder this one too.
      this._fallback(id);
      return;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffered;
    const detune = (opts.detune ?? 200);
    if (detune) src.detune.value = (Math.random() * 2 - 1) * detune;
    const g = this.ctx.createGain();
    g.gain.value = (opts.gain ?? 1.0);
    src.connect(g).connect(this.sfxBus);
    src.start(t);
    this._activeVoices.set(id, live + 1);
    src.onended = () => {
      try { src.disconnect(); g.disconnect(); } catch { /* already detached */ }
      this._activeVoices.set(id, Math.max(0, (this._activeVoices.get(id) || 1) - 1));
    };
  }

  // Synthesised placeholder used during first-play decode + as a fallback
  // when the .ogg fails to load (offline / 404). Voice-capping still
  // applies via _play(), so multi-hit AoE doesn't stack here either.
  _fallback(id) {
    switch (id) {
      case 'swing':     this.tone({ freq: 720, type: 'triangle', dur: 0.07, gain: 0.16, slide: -350 }); break;
      case 'hitFlesh':  this.noise({ dur: 0.08, gain: 0.32, lp: 2000 }); this.tone({ freq: 320, type: 'sawtooth', dur: 0.05, gain: 0.13, slide: -160 }); break;
      case 'hitHeavy':  this.noise({ dur: 0.16, gain: 0.5, lp: 1400, hp: 90 }); this.tone({ freq: 180, type: 'sawtooth', dur: 0.10, gain: 0.18, slide: -120 }); break;
      case 'hurt':      this.tone({ freq: 220, type: 'sawtooth', dur: 0.16, gain: 0.26, slide: -90 }); this.noise({ dur: 0.10, gain: 0.22 }); break;
      case 'enemyDie':  this.noise({ dur: 0.28, gain: 0.45, lp: 1200 }); this.tone({ freq: 180, type: 'sawtooth', dur: 0.20, gain: 0.16, slide: -130 }); break;
      // Cheap synth stand-in for the creature-yelp .ogg: a chirpy
      // triangle that sweeps up then down, so even with the buffer
      // missing the player still hears "something vocal" under each hit.
      case 'enemyVoice':this.tone({ freq: 520, type: 'triangle', dur: 0.10, gain: 0.18, slide: 220 }); this.tone({ freq: 740, type: 'triangle', dur: 0.10, gain: 0.14, slide: -260 }); break;
      // Bomber stand-in: lower, longer grumble.
      case 'enemyVoiceBomber': this.tone({ freq: 260, type: 'sawtooth', dur: 0.20, gain: 0.22, slide: -120 }); this.noise({ dur: 0.12, gain: 0.18, lp: 900 }); break;
      // Legendary stand-in: dissonant chirp that sounds 'wrong'.
      case 'enemyVoiceLegendary': this.tone({ freq: 380, type: 'square', dur: 0.18, gain: 0.18, slide: 540 }); this.tone({ freq: 920, type: 'triangle', dur: 0.18, gain: 0.12, slide: -480 }); break;
      case 'woodBreak': this.noise({ dur: 0.18, gain: 0.5, lp: 1100, hp: 200 }); break;
      case 'hitWood':   this.noise({ dur: 0.10, gain: 0.42, lp: 1300, hp: 240 }); this.tone({ freq: 240, type: 'sawtooth', dur: 0.06, gain: 0.14, slide: -90 }); break;
      case 'hitStone':  this.noise({ dur: 0.10, gain: 0.45, lp: 2200, hp: 500 }); this.tone({ freq: 360, type: 'square',   dur: 0.05, gain: 0.10, slide: -160 }); break;
      case 'potBreak':  this.noise({ dur: 0.22, gain: 0.55, lp: 4000, hp: 800 }); this.tone({ freq: 1400, type: 'square', dur: 0.10, gain: 0.18, slide: 800 }); break;
      // No 'coin' case: the synth fallback was a two-tone square-wave
      // chiptune that read as out-of-place 8-bit when the Kenney coin .ogg
      // hadn't finished decoding on the very first pickup. Better to be
      // briefly silent than to slot a different aesthetic into the mix.
      case 'treeCreak': this.tone({ freq: 240, type: 'sawtooth', dur: 0.40, gain: 0.18, slide: -50 }); break;
    }
  }

  // ---- Public SFX API (back-compat with the old method names) -----------

  // Sword/weapon whoosh on every swing — pulled down to ~0.45 so it sits
  // under the chop / mining impact tier instead of dominating dense
  // attack-speed loops. Callers can still override via opts.gain.
  swing(opts)      { this._play('swing', { gain: 0.45, ...(opts || {}) }); }
  hit(opts)        { this._play('hitFlesh', opts); }            // sword hits flesh
  enemyHit(opts)   {
    const o = opts || {};
    this._play('hitFlesh', { ...o, gain: 0.7 });
    // Layer a short monster yelp under the impact. The voice pool is
    // picked based on the enemy's `kind` / `elite` flags passed in:
    //   • elite → 15% chance to play a rarer "legendary" vocalisation
    //     (otherworldly weird_01/02). Falls through to normal pool on
    //     the other 85% of hits so elite enemies still sound consistent
    //     with their non-elite cousins.
    //   • kind === 'bomber' → 33% chance to play the bigger monster_03
    //     roar so the suicide-bomber occasionally announces itself.
    //   • otherwise → regular enemyVoice pool (monster_05 / pitched
    //     hurt_05).
    // Voice never replaces the punch; the lower 0.55 gain keeps combat
    // reading as "swing-and-thump-with-grunt" rather than "swing-and-
    // yelp".
    let pool = 'enemyVoice';
    if (o.elite && Math.random() < 0.15) pool = 'enemyVoiceLegendary';
    else if (o.kind === 'bomber' && Math.random() < 0.33) pool = 'enemyVoiceBomber';
    this._play(pool, { gain: 0.55 });
  }
  enemyDie(opts)   { this._play('enemyDie', opts); }
  hurt(opts)       { this._play('hurt', opts); }
  pickupGold(opts) { this._play('coin', opts); }
  pickupFood() {
    // Food is a soft, friendly chirp — keeping the original two-tone
    // synthetic blip preserves the cozy "om nom" feel that a percussive
    // sample wouldn't.
    if (this.muted || !this.ctx) return;
    this.tone({ freq: 540, type: 'triangle', dur: 0.10, gain: 0.18, slide: 220 });
    this.tone({ freq: 720, type: 'sine', dur: 0.12, gain: 0.20, slide: 200 });
  }
  woodBreak(opts)  { this._play('woodBreak', opts); }
  potBreak(opts)   { this._play('potBreak', opts); }
  treeCreak(opts)  { this._play('treeCreak', opts); }
  // Per-swing impact on a tree (axe-on-plank). Pushed up to ~1.0 so the
  // chop loop reads as a confident, audible thunk over the (now quieter)
  // sword whoosh; the eventual tree-felled splinter is still louder.
  hitWood(opts)    { this._play('hitWood', { gain: 1.0, ...(opts || {}) }); }
  // Per-swing impact on a rock. Mining-pick crack — sharper than wood,
  // distinct from the procedural rockBreak shatter so multiple hits
  // don't all sound like the rock just died. Same loudness tier as
  // hitWood so trees and rocks share a "gathering connect" volume.
  hitStone(opts)   { this._play('hitStone', { gain: 1.0, ...(opts || {}) }); }
  // Tree felled: just the wood-splinter crack at a slightly hotter gain
  // (1.0 vs the default crate-break ~1.0 too — the rate-limit + voice cap
  // already keep stacked fells from smearing). The old version layered
  // tree_creak as a slow creaky preamble, but on a fast resource-gather
  // loop that creak read as drag rather than weight, so it's gone.
  treeFall(opts)   { this._play('woodBreak', { gain: 1.0, ...(opts || {}) }); }
  // Rock crumbling on death — chunkier than the glassy potBreak. Procedural
  // because no Kenney sample reads cleanly as "boulder shatter"; the
  // filtered-noise + low square fundamental combo lands on the right side
  // of "rocky" without competing with bomb/explosion.
  rockBreak() {
    if (this.muted || !this.ctx) return;
    this.noise({ dur: 0.30, gain: 0.55, lp: 1600, hp: 200 });
    this.tone({ freq: 260, type: 'square', dur: 0.18, gain: 0.18, slide: -180 });
    // Layer a mining-pick crack on top so the death moment of a rock
    // sounds chunkier than just the noise sweep — reuses the same
    // hit_stone_*.ogg variants we play on each chip swing, at a louder
    // gain to read as a final "crack open".
    this._play('hitStone', { gain: 0.95 });
  }
  // Resource pickups: distinct from coin so the topbar counters can be
  // identified by ear. Wood = soft thunk, stone = sharp clack. Both stay
  // procedural — a coin sample re-tinted would still read as "coin".
  pickupWood() {
    if (this.muted || !this.ctx) return;
    this.noise({ dur: 0.06, gain: 0.18, lp: 1100 });
    this.tone({ freq: 220, type: 'triangle', dur: 0.09, gain: 0.18, slide: -40 });
  }
  pickupStone() {
    if (this.muted || !this.ctx) return;
    this.noise({ dur: 0.07, gain: 0.32, lp: 1900, hp: 400 });
    this.tone({ freq: 380, type: 'square', dur: 0.05, gain: 0.10, slide: -180 });
  }
  // Farming sfx (M3). Each routes to a small synth so we don't ship a new
  // .ogg category for them; tuned to read against combat noise without
  // crowding the breakable / pickup tier.
  till() {
    // Wet-soil scrape: a low filtered noise sweep, no tonal accent so it
    // reads as "earth being turned" rather than a bell.
    if (this.muted || !this.ctx) return;
    this.noise({ dur: 0.20, gain: 0.30, lp: 700, hp: 80 });
    this.tone({ freq: 130, type: 'triangle', dur: 0.18, gain: 0.10, slide: -30 });
  }
  plant() {
    // Two-note pluck: a small "you placed a seed" affirmation distinct
    // from the coin pickup ding.
    if (this.muted || !this.ctx) return;
    this.tone({ freq: 540, type: 'triangle', dur: 0.07, gain: 0.18, slide: 60 });
    this.tone({ freq: 720, type: 'sine',     dur: 0.10, gain: 0.14, slide: 80 });
  }
  harvest() {
    // Bright triple-arpeggio: rewards the player after the long grow wait.
    if (this.muted || !this.ctx) return;
    this.tone({ freq: 660, type: 'triangle', dur: 0.08, gain: 0.18 });
    this.tone({ freq: 880, type: 'triangle', dur: 0.10, gain: 0.16 });
    this.tone({ freq: 1100, type: 'sine',    dur: 0.14, gain: 0.14 });
  }
  // Generic destroy — used by abilities AoE / bombs against breakables.
  bomb(opts) {
    if (this.muted || !this.ctx) return;
    // Big low boom always synthesised: combines a punchy noise burst with
    // a sub-bass thump. Tuned for clarity over a battlefield of voices.
    this.noise({ dur: 0.55, gain: 0.55, lp: 1100, hp: 80 });
    this.tone({ freq: 90, type: 'sawtooth', dur: 0.4, gain: 0.36, slide: -50 });
    if (opts && opts.heavy) this._play('hitHeavy', { gain: 0.7 });
  }
  dash() {
    // Dash whoosh stays procedural — short filtered noise tail reads as
    // "air" without needing a sample, and no Kenney pack ships a clean
    // dash whoosh anyway.
    this.noise({ dur: 0.18, gain: 0.3, lp: 1800, hp: 700 });
  }
  buy() {
    if (this.muted || !this.ctx) return;
    this.tone({ freq: 660, type: 'square', dur: 0.06, gain: 0.18, slide: 180 });
    this.tone({ freq: 880, type: 'square', dur: 0.08, gain: 0.16, slide: 200 });
  }
  death() { if (!this.muted) this.tone({ freq: 220, type: 'sawtooth', dur: 0.5, gain: 0.3, slide: -150 }); }
  arrow() { if (!this.muted) this.tone({ freq: 1200, type: 'triangle', dur: 0.06, gain: 0.12, slide: -700 }); }
  bell() {
    if (this.muted || !this.ctx) return;
    this.tone({ freq: 880, type: 'sine', dur: 0.4, gain: 0.18 });
    this.tone({ freq: 1320, type: 'sine', dur: 0.3, gain: 0.12 });
  }

  // ---- Procedural primitives (kept for back-compat; abilities still use
  //      tone/noise to colour their casts and impacts) -------------------

  tone({ freq = 440, type = 'sine', dur = 0.15, gain = 0.4, slide = 0, attack = 0.005, release = 0.08 }) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + release + 0.02);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already detached */ } };
  }

  noise({ dur = 0.18, gain = 0.45, lp = 1500, hp = 200 }) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lpf = this.ctx.createBiquadFilter(); lpf.type = 'lowpass';  lpf.frequency.value = lp;
    const hpf = this.ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hpf).connect(lpf).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.02);
    src.onended = () => {
      try { src.disconnect(); hpf.disconnect(); lpf.disconnect(); g.disconnect(); }
      catch { /* already detached */ }
    };
  }

  // ---- Ambient layers ---------------------------------------------------
  //
  // Wind / water / fire are real CC0 field recordings, played as a single
  // looping AudioBufferSourceNode each (created once the .ogg has
  // decoded). Forest is procedural — shaped brown noise → bandpass —
  // because no single recording sounds like a generic windless leaf-rustle
  // hum without locking the player to a specific real location.
  //
  // updateAmbient() modulates the per-layer GainNode each frame from world
  // context. The graph itself is fixed once built; we never recreate nodes.
  _buildAmbient() {
    if (!this.ctx || this._ambient) return;
    const ctx = this.ctx;

    // Procedural noise source for the forest layer only.
    const noise = shapedNoiseBuffer(ctx, AMBIENT_NOISE_SECONDS, 0.99, 0xC0FFEE);

    // Sample-based layer. Returns the gain handle immediately; the
    // BufferSourceNode is plugged in once the fetch+decode resolves.
    // Until then the layer sits silently in the graph (gain = 0). On a
    // warm reload the buffer is already cached, so this resolves on the
    // next microtask.
    //
    // Topology: src → [optional lowpass] → gain → ambBus
    const sampleLayer = (file, { lowpass = 0 } = {}) => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.ambBus);
      let inputNode = gain;
      let filt = null;
      if (lowpass > 0) {
        // Used on the wind sample to soften the winter-recording's icy
        // treble down to a meadow breeze. Q stays low so the cutoff
        // shoulders gently rather than ringing.
        filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = lowpass;
        filt.Q.value = 0.5;
        filt.connect(gain);
        inputNode = filt;
      }
      const layer = { src: null, gain, filt, ready: false };
      Promise.resolve(this._loadBuffer(file)).then((buf) => {
        if (!buf || !this.ctx) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(inputNode);
        // Stagger the start so the three samples don't loop in lockstep.
        src.start(ctx.currentTime + Math.random() * 0.6);
        layer.src = src;
        layer.ready = true;
      });
      return layer;
    };

    // Procedural shaped-noise layer (forest only).
    const noiseLayer = ({ filterType = 'lowpass', cutoff = 800, q = 0.6, baseGain = 0.0 } = {}) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = filterType;
      filt.frequency.value = cutoff;
      filt.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = baseGain;
      src.connect(filt).connect(gain).connect(this.ambBus);
      src.start(ctx.currentTime + Math.random() * 0.1);
      return { src, filt, gain, ready: true };
    };

    this._ambient = {
      // Wind: rubberduck ambient_03 from "30 CC0 SFX loops". Played raw
      // (no lowpass) — the sample is already broadband air-noise, no icy
      // treble to soften.
      wind:   sampleLayer(AMBIENT_SAMPLES.wind),
      // Water: rubberduck loop_water_02 (CC0).
      water:  sampleLayer(AMBIENT_SAMPLES.water),
      // Fire: project-supplied 20s campfire recording (CC0). Sample
      // already contains crackles — no procedural crackle scheduler
      // needed.
      fire:   sampleLayer(AMBIENT_SAMPLES.fire),
      // Forest hum stays procedural: bandpass on shaped brown noise gives
      // a generic leaf-rustle/insect-chorus tail that mixes under any
      // real-world location without sounding out of place.
      forest: noiseLayer({ filterType: 'bandpass', cutoff: 1500, q: 0.9, baseGain: 0.0 }),
    };

    // Cricket / bird chorus runs on a recursive scheduler. Day/night weight
    // chooses which to emit (or nothing during dawn/dusk transition).
    this._dayNoctStop = false;
    this._scheduleDayNoct();

    this._ambSmooth = {
      wind: 0, water: 0, forest: 0, fire: 0, crickets: 0, birds: 0,
      // Targets get rewritten in updateAmbient(); here are sane idle values.
      windTarget: 0.10, waterTarget: 0, forestTarget: 0, fireTarget: 0,
      cricketsTarget: 0, birdsTarget: 0,
    };
  }

  // Day-time bird chirps + night-time cricket pulses. One scheduler drives
  // both because they're mutually exclusive (cricketsTarget rises as
  // birdsTarget falls across sunset).
  _scheduleDayNoct() {
    if (!this.ctx || this._dayNoctStop) return;
    const ctx = this.ctx;
    const wait = 0.6 + Math.random() * 2.8;
    const dummyBuf = ctx.createBuffer(1, Math.max(2, Math.floor(ctx.sampleRate * wait)), ctx.sampleRate);
    const dummy = ctx.createBufferSource();
    dummy.buffer = dummyBuf;
    dummy.connect(ctx.destination);
    dummy.start();
    dummy.onended = () => {
      try { dummy.disconnect(); } catch { /* */ }
      const a = this._ambSmooth;
      if (a) {
        if (Math.random() < a.birds) this._birdChirp();
        if (Math.random() < a.crickets * 1.2) this._cricketChirp();
      }
      this._scheduleDayNoct();
    };
  }

  _birdChirp() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Two-note sweep — high triangle wave, soft envelope. Random pick of
    // a few "species" so the meadow doesn't sound like one bird on loop.
    // Slightly louder than the cricket pulse so the daytime chorus reads
    // over the wind bed without needing the player to crank ambient up.
    const species = [
      { f0: 2400, f1: 3200, dur: 0.10, gain: 0.10 },
      { f0: 1900, f1: 2600, dur: 0.14, gain: 0.10 },
      { f0: 3000, f1: 2200, dur: 0.12, gain: 0.08 },
      { f0: 2200, f1: 2800, dur: 0.18, gain: 0.09 },
      { f0: 2700, f1: 2300, dur: 0.16, gain: 0.09 },
    ];
    const s = species[(Math.random() * species.length) | 0];
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(s.f0, t);
    o.frequency.exponentialRampToValueAtTime(s.f1, t + s.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur + 0.05);
    o.connect(g).connect(this.ambBus);
    o.start(t);
    o.stop(t + s.dur + 0.10);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* */ } };
  }

  _cricketChirp() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    // 3..6 quick pulses ~30 ms apart at ~4 kHz — that's the texture of a
    // field cricket trill.
    const pulses = 3 + ((Math.random() * 4) | 0);
    for (let i = 0; i < pulses; i++) {
      const t = t0 + i * (0.025 + Math.random() * 0.015);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(3800 + Math.random() * 600, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.04, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.020);
      o.connect(g).connect(this.ambBus);
      o.start(t);
      o.stop(t + 0.06);
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* */ } };
    }
  }

  // Called by Game._loop each tick with the listener (player midpoint),
  // the day/night phase, and the world reference. Cheap: a few water
  // probes + a setTargetAtTime on each layer's gain.
  updateAmbient(dt, ctx) {
    if (!this.ctx || !this._ambient || !this._ambSmooth) return;
    const a = this._ambSmooth;
    const audioCtx = this.ctx;
    const t = audioCtx.currentTime;

    // ----- Compute targets ------------------------------------------------
    const playerX = ctx?.x ?? 0;
    const playerZ = ctx?.z ?? 0;
    const dayWeight = clamp01(ctx?.dayWeight ?? 1.0); // 1=full day, 0=full night
    const world = ctx?.world ?? this._world;

    // Wind: always present, slightly louder during the day, dies at
    // night. The sample is a steady broadband air-noise loop, so we keep
    // the bus quiet by default and let dayWeight nudge it up — the loop
    // would otherwise read as a constant hiss in the player's ear.
    a.windTarget = 0.10 + dayWeight * 0.05;

    // Water: scan a ring around the player for water cells. The hearing
    // radius is 22 m so a stream or pond is audible from across a chunk
    // before the players actually wade into it (the pond shapes sit a
    // good 12-18 m from the spawn pad in some seeds and were inaudible
    // until the player was almost on top of them).
    //
    // Probes step every ~3 m out to 21 m: 4 / 7 / 10 / 13 / 16 / 19 / 21.
    // The cardinal+diagonal pairs at each ring make sure no pond can fall
    // entirely between two probes — the closest point of any pond will
    // always be within ~3 m of at least one tap.
    let waterDist = Infinity;
    if (world && typeof world.isWaterAt === 'function') {
      const RING = [
        // 4 m — touch / overlap radius
        [4, 0], [-4, 0], [0, 4], [0, -4],
        [3, 3], [-3, 3], [3, -3], [-3, -3],
        // 7 m
        [7, 0], [-7, 0], [0, 7], [0, -7],
        [5, 5], [-5, 5], [5, -5], [-5, -5],
        // 10 m
        [10, 0], [-10, 0], [0, 10], [0, -10],
        [7, 7], [-7, 7], [7, -7], [-7, -7],
        // 13 m
        [13, 0], [-13, 0], [0, 13], [0, -13],
        // 16 m
        [16, 0], [-16, 0], [0, 16], [0, -16],
        [11, 11], [-11, 11], [11, -11], [-11, -11],
        // 19 m
        [19, 0], [-19, 0], [0, 19], [0, -19],
        // 21 m — outer cap
        [21, 0], [-21, 0], [0, 21], [0, -21],
        [15, 15], [-15, 15], [15, -15], [-15, -15],
      ];
      for (const [dx, dz] of RING) {
        const rx = playerX + dx;
        const rz = playerZ + dz;
        if (world.isWaterAt(rx, rz)) {
          const d = Math.hypot(dx, dz);
          if (d < waterDist) waterDist = d;
        }
      }
    }
    // Inverse-square-ish falloff (1 - d/R)^1.5 makes the bus pull back
    // softly as the players walk away rather than dropping linearly to
    // silence right at the radius cap.
    const WATER_R = 22;
    if (waterDist < WATER_R) {
      const t01 = clamp01(1 - waterDist / WATER_R);
      a.waterTarget = t01 * t01 * Math.sqrt(t01) * 0.6;
    } else {
      a.waterTarget = 0;
    }

    // Forest: derived from the world's tree-density noise. Same noise the
    // terrain uses to scatter trees, so "louder forest hum" lines up with
    // a genuinely tree-rich chunk.
    let treeN = 0.5;
    if (world && typeof world.noise === 'function') {
      // Average of a 3-tap noise sample so a single rocky cell doesn't
      // briefly mute the forest.
      const TAPS = [
        [0, 0], [4, 0], [0, 4],
      ];
      let s = 0;
      for (const [dx, dz] of TAPS) s += world.noise((playerX + dx) * 0.05, (playerZ + dz) * 0.05);
      treeN = s / TAPS.length;
    }
    a.forestTarget = clamp01(treeN - 0.25) * 0.7 * (0.5 + dayWeight * 0.5);

    // Campfires: aggregate proximity over
    //   1. The world-spawned starter campfire (positioned by World._buildCampfire,
    //      typically a few metres off origin — Math.hypot(x, z) was treating
    //      this as if it were at (0, 0), so the gain peaked when the player
    //      walked past origin instead of the actual fire pit).
    //   2. Every player-placed `campfire` structure in `world.placedStructures`.
    //   3. Every `torch` structure, contributing at TORCH_W weight with a
    //      tighter TORCH_R falloff so a row of torches lining a path reads
    //      as a faint flicker without ever drowning out a real campfire.
    // Score is summed (not maxed) so a cluster of fires/torches reads as a
    // louder pit than a single one, then clamped at 1 before scaling so the
    // fire bus can't blow past its own cap.
    const FIRE_R = 14;
    const TORCH_R = 5;
    const TORCH_W = 0.35;
    let fireScore = 0;
    if (world?.campfire?.position) {
      const fx = world.campfire.position.x;
      const fz = world.campfire.position.z;
      const d = Math.hypot(playerX - fx, playerZ - fz);
      if (d < FIRE_R) fireScore += clamp01(1 - d / FIRE_R);
    }
    if (world?.placedStructures) {
      for (const arr of world.placedStructures.values()) {
        for (const desc of arr) {
          if (desc.kind === 'campfire') {
            const d = Math.hypot(playerX - desc.x, playerZ - desc.z);
            if (d < FIRE_R) fireScore += clamp01(1 - d / FIRE_R);
          } else if (desc.kind === 'torch') {
            const d = Math.hypot(playerX - desc.x, playerZ - desc.z);
            if (d < TORCH_R) fireScore += TORCH_W * clamp01(1 - d / TORCH_R);
          }
        }
      }
    }
    a.fireTarget = clamp01(fireScore) * 0.55;

    // Day/night chorus.
    // Birds: bumped p(emit) so the meadow actually has a daytime chorus
    // instead of a single chirp every ~10s.
    a.birdsTarget = dayWeight * dayWeight * 0.55;        // p(emit) per scheduler tick
    a.cricketsTarget = (1 - dayWeight) * (1 - dayWeight) * 0.45;

    // ----- Smooth & write -------------------------------------------------
    // Time constant ≈ 1.2s. Long enough that walking past a pond doesn't
    // pop the lap in/out, short enough to keep up with day/night fades.
    const smooth = 1 - Math.exp(-dt / 1.2);
    a.wind   = lerp(a.wind,   a.windTarget,   smooth);
    a.water  = lerp(a.water,  a.waterTarget,  smooth);
    a.forest = lerp(a.forest, a.forestTarget, smooth);
    a.fire   = lerp(a.fire,   a.fireTarget,   smooth);
    a.crickets = lerp(a.crickets, a.cricketsTarget, smooth);
    a.birds    = lerp(a.birds,    a.birdsTarget,    smooth);

    const setG = (n, v) => { n.gain.gain.setTargetAtTime(v, t, 0.05); };
    setG(this._ambient.wind,   a.wind);
    setG(this._ambient.water,  a.water);
    setG(this._ambient.forest, a.forest);
    setG(this._ambient.fire,   a.fire);
  }
}
