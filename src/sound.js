// Hybrid sample-based + procedural audio for Twin Hearts.
//
// One-shot SFX (sword swing, hits, hurt, breakables, pickups) play short
// CC0 .ogg samples from `public/sounds/` — variants are picked at random
// and the buffer cache is loaded lazily so cold-boot has zero audio cost.
//
// Ambient nature (wind, water lap, forest hum, campfire crackle, crickets,
// distant birds) is generated procedurally from a single pre-rendered noise
// buffer that loops forever, with biquad filters + slow LFOs shaping the
// texture. Layer gains are modulated each frame from world context (player
// proximity to ponds, day/night phase, …) so the soundscape responds to
// where the players are without ever rebuilding the WebAudio graph.
//
// Routing:
//   one-shot SFX  → sfxBus  →┐
//   procedural    → ambBus  →┴→ master → ctx.destination
//
// Volume sliders in the pause menu (`settings.applyAudio`) feed live values
// into setMasterVolume / setSfxVolume / setAmbientVolume / setMuted without
// touching the graph itself.

// Static sample manifest. Multiple files per `id` give natural variation —
// every play picks a fresh variant with a small per-shot pitch jitter so
// repeated combat hits never sound mechanically identical.
const SAMPLES = {
  swing:        ['swing_blade_a.ogg', 'swing_blade_b.ogg', 'swing_cloth_a.ogg', 'swing_cloth_b.ogg'],
  hitFlesh:     ['hit_flesh_a.ogg', 'hit_flesh_b.ogg', 'hit_flesh_c.ogg'],
  hitHeavy:     ['hit_heavy_a.ogg', 'hit_heavy_b.ogg'],
  hurt:         ['hurt_armor_a.ogg', 'hurt_armor_b.ogg'],
  enemyDie:     ['enemy_die_a.ogg', 'enemy_die_b.ogg'],
  woodBreak:    ['wood_break_a.ogg', 'wood_break_b.ogg', 'wood_chop.ogg'],
  potBreak:     ['pot_break_a.ogg', 'pot_break_b.ogg'],
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
  enemyDie: 0.05,
  woodBreak: 0.05,
  potBreak: 0.05,
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
  enemyDie: 4,
  woodBreak: 3,
  potBreak: 3,
  coin: 5,
  treeCreak: 2,
};

const SOUNDS_BASE = 'sounds/';

// 8 seconds of pre-rendered seeded noise. Ambient sources loop through
// this single buffer with different filter profiles, so the entire ambient
// stack costs one decode + one source node per layer for the lifetime of
// the page. Long enough that the loop seam isn't audible under modulation.
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
  }

  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    // Kick off background prefetch of the most-common combat samples on
    // first user gesture so the first swing isn't silent. Less-common
    // samples still load on demand; the loader is idempotent.
    this._prefetch(['swing', 'hitFlesh', 'hurt', 'enemyDie']);
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
      case 'woodBreak': this.noise({ dur: 0.18, gain: 0.5, lp: 1100, hp: 200 }); break;
      case 'potBreak':  this.noise({ dur: 0.22, gain: 0.55, lp: 4000, hp: 800 }); this.tone({ freq: 1400, type: 'square', dur: 0.10, gain: 0.18, slide: 800 }); break;
      case 'coin':      this.tone({ freq: 980, type: 'square', dur: 0.06, gain: 0.16, slide: 320 }); this.tone({ freq: 1320, type: 'square', dur: 0.08, gain: 0.14, slide: 200 }); break;
      case 'treeCreak': this.tone({ freq: 240, type: 'sawtooth', dur: 0.40, gain: 0.18, slide: -50 }); break;
    }
  }

  // ---- Public SFX API (back-compat with the old method names) -----------

  swing(opts)      { this._play('swing', opts); }
  hit(opts)        { this._play('hitFlesh', opts); }            // sword hits flesh
  enemyHit(opts)   { this._play('hitFlesh', { ...(opts || {}), gain: 0.7 }); }
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
  // Tree felled: layer a creak preamble onto the wood-splinter break for
  // a one-shot "timber!" cue. Different enough from breakable crate / pot
  // that the gathering loop has its own audio identity even when a tree
  // and a crate die on the same frame.
  treeFall(opts)   { this._play('treeCreak', opts); this._play('woodBreak', { ...(opts || {}), gain: 0.85 }); }
  // Rock crumbling on death — chunkier than the glassy potBreak. Procedural
  // because no Kenney sample reads cleanly as "boulder shatter"; the
  // filtered-noise + low square fundamental combo lands on the right side
  // of "rocky" without competing with bomb/explosion.
  rockBreak() {
    if (this.muted || !this.ctx) return;
    this.noise({ dur: 0.30, gain: 0.55, lp: 1600, hp: 200 });
    this.tone({ freq: 260, type: 'square', dur: 0.18, gain: 0.18, slide: -180 });
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

  // ---- Procedural ambient layers ----------------------------------------
  //
  // Each layer owns a single AudioBufferSourceNode that loops the shared
  // brown-noise buffer for the lifetime of the page. We modulate the
  // post-filter gain (and one biquad cutoff for wind) at frame-rate from
  // updateAmbient() — never recreating nodes — so the audio thread sees
  // a fixed graph with a handful of param updates per second.
  _buildAmbient() {
    if (!this.ctx || this._ambient) return;
    const ctx = this.ctx;
    const noise = shapedNoiseBuffer(ctx, AMBIENT_NOISE_SECONDS, 0.99, 0xC0FFEE);

    // Helper: looping noise source with a biquad → gain chain feeding ambBus.
    const layer = ({ filterType = 'lowpass', cutoff = 800, q = 0.6, baseGain = 0.0 } = {}) => {
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
      return { src, filt, gain };
    };

    this._ambient = {
      // Constant low-bandwidth wind across the meadow. Cutoff slowly drifts
      // 250 → 900 Hz so gusts feel like real moving air, not a static hiss.
      wind:    layer({ filterType: 'lowpass',  cutoff: 600,  q: 0.5,  baseGain: 0.0 }),
      // Pondside lapping — narrow bandpass on the brown noise (~350 Hz)
      // gives a wet, swishy character without needing a real sample.
      water:   layer({ filterType: 'bandpass', cutoff: 380,  q: 1.6,  baseGain: 0.0 }),
      // Forest hum — slightly higher cutoff so leaf rustle/insect chorus
      // sits over the wind without competing for the same band.
      forest:  layer({ filterType: 'bandpass', cutoff: 1500, q: 0.9,  baseGain: 0.0 }),
      // Campfire crackle — high passed brown noise for the bed, with a
      // separate `_scheduleCrackle` job firing tiny snaps on top.
      fire:    layer({ filterType: 'highpass', cutoff: 1200, q: 0.4,  baseGain: 0.0 }),
    };

    // Crackle scheduler. We don't want a setInterval — the audio thread
    // drifts off the 60 Hz timer when the tab is inactive. Instead we
    // walk forward in `ctx.currentTime` and queue the next crackle from
    // an onended callback off a tiny silent buffer source.
    this._fireCrackleStop = false;
    this._scheduleCrackle();

    // Cricket / bird chorus also runs on a recursive scheduler. Day/night
    // weight chooses which to emit (or nothing during dawn/dusk transition).
    this._dayNoctStop = false;
    this._scheduleDayNoct();

    this._ambSmooth = {
      wind: 0, water: 0, forest: 0, fire: 0, crickets: 0, birds: 0,
      // Targets get rewritten in updateAmbient(); here are sane idle values.
      windTarget: 0.10, waterTarget: 0, forestTarget: 0, fireTarget: 0,
      cricketsTarget: 0, birdsTarget: 0,
    };

    // LFO-on-cutoff for wind. We piggy-back on the noise buffer source's
    // playbackRate listener — no extra oscillators — by running a small
    // setInterval that pokes setTargetAtTime. Cheaper than an OscillatorNode
    // → ConstantSourceNode chain wired into BiquadFilter.frequency, and
    // imprecise jitter actually sounds better here than a perfect sine.
    this._windLfoTimer = setInterval(() => {
      if (!this.ctx || !this._ambient) return;
      const t = this.ctx.currentTime;
      // Cutoff 250..900 Hz wandering at 0.07 Hz.
      const c = 575 + Math.sin(t * 0.07 * 2 * Math.PI) * 325 + (Math.random() - 0.5) * 80;
      this._ambient.wind.filt.frequency.setTargetAtTime(c, t, 0.6);
    }, 250);
  }

  // Schedule one campfire crack at a random time in the next ~2.5s, then
  // recursively schedule the next one. Each crack is a tiny shaped noise
  // burst routed through the ambient bus so the master "campfire" gain
  // dampens it together with the bed.
  _scheduleCrackle() {
    if (!this.ctx || this._fireCrackleStop) return;
    const ctx = this.ctx;
    const wait = 0.15 + Math.random() * 2.3;
    const dummyBuf = ctx.createBuffer(1, Math.max(2, Math.floor(ctx.sampleRate * wait)), ctx.sampleRate);
    const dummy = ctx.createBufferSource();
    dummy.buffer = dummyBuf;
    dummy.connect(ctx.destination);
    dummy.start();
    dummy.onended = () => {
      try { dummy.disconnect(); } catch { /* already detached */ }
      this._fireCrack();
      this._scheduleCrackle();
    };
  }

  _fireCrack() {
    if (!this.ctx || !this._ambient) return;
    const fireGain = this._ambient.fire.gain.gain.value;
    if (fireGain < 0.005) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.04 + Math.random() * 0.05;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500 + Math.random() * 800;
    const g = ctx.createGain();
    g.gain.value = (0.18 + Math.random() * 0.18) * fireGain;
    src.connect(hp).connect(g).connect(this.ambBus);
    src.start(t);
    src.stop(t + dur + 0.02);
    src.onended = () => { try { src.disconnect(); hp.disconnect(); g.disconnect(); } catch { /* */ } };
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
    const species = [
      { f0: 2400, f1: 3200, dur: 0.10, gain: 0.05 },
      { f0: 1900, f1: 2600, dur: 0.14, gain: 0.05 },
      { f0: 3000, f1: 2200, dur: 0.12, gain: 0.04 },
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

    // Wind: always present, gusts louder during the day, dies at night.
    a.windTarget = 0.18 + dayWeight * 0.10;

    // Water: scan a small ring around the player for water cells. The
    // closer a water cell is, the louder the lap. Caps at ~12m radius.
    let waterDist = Infinity;
    if (world && typeof world.isWaterAt === 'function') {
      // 8 cardinal/diagonal probes at 4m & 10m. Quick + good enough — the
      // perceptual radius of "I can hear the pond" is much fuzzier than
      // any geometric one we'd compute.
      const RING = [
        [4, 0], [-4, 0], [0, 4], [0, -4],
        [3, 3], [-3, 3], [3, -3], [-3, -3],
        [10, 0], [-10, 0], [0, 10], [0, -10],
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
    if (waterDist < 12) {
      a.waterTarget = clamp01(1 - waterDist / 12) * 0.45;
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

    // Campfire: only audible near origin (where world.js plants the ring).
    const fireDist = Math.hypot(playerX, playerZ);
    a.fireTarget = fireDist < 14 ? clamp01(1 - fireDist / 14) * 0.55 : 0;

    // Day/night chorus.
    a.birdsTarget = dayWeight * dayWeight * 0.20;        // p(emit) per scheduler tick
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
