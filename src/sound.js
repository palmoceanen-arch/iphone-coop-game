// Procedurally synthesized sound via WebAudio. Free, zero-asset, but punchy.
//
// Volume routing:
//   oscillators / noise → sfx gain → master gain → ctx.destination
// `setMasterVolume` / `setSfxVolume` / `setMuted` are wired up by the
// Settings module in src/settings.js so the pause-menu sliders feed live
// volumes into the WebAudio graph without rebuilding it.
export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.muted = false;
    this.masterVolume = 0.5;
    this.sfxVolume = 1.0;
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.master.connect(this.ctx.destination);
    this._applyGains();
  }

  resume() { this.ensure(); if (this.ctx.state === 'suspended') this.ctx.resume(); }

  _applyGains() {
    if (!this.master || !this.sfx) return;
    this.master.gain.value = this.muted ? 0.0 : this.masterVolume;
    this.sfx.gain.value = this.sfxVolume;
  }

  setMuted(m) { this.muted = !!m; this._applyGains(); }
  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(1, Number(v) || 0));
    this._applyGains();
  }
  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, Number(v) || 0));
    this._applyGains();
  }

  // Tone / blip
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
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + release + 0.02);
    // Disconnect the whole chain when the oscillator finishes so the
    // WebAudio graph doesn't accumulate stopped nodes. Without this the
    // graph grows unbounded over a session (each swing/hit/pickup adds
    // a couple of nodes that stay forever) and the audio thread spends
    // measurably more time per buffer the longer you play — a
    // significant contributor to the slow FPS decay over 10+ minutes.
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already detached */ } };
  }

  // White noise burst
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
    const lpf = this.ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = lp;
    const hpf = this.ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hpf).connect(lpf).connect(g).connect(this.sfx);
    src.start(t);
    src.stop(t + dur + 0.02);
    // Same teardown story as `tone` — release the buffer source AND every
    // filter/gain node in the chain, otherwise the graph keeps the buffer
    // alive and the audio thread keeps walking 5 dead nodes per played
    // sound for the rest of the session.
    src.onended = () => {
      try { src.disconnect(); hpf.disconnect(); lpf.disconnect(); g.disconnect(); }
      catch { /* already detached */ }
    };
  }

  swing() { this.tone({ freq: 720, type: 'triangle', dur: 0.07, gain: 0.18, slide: -350 }); }
  hit() {
    this.noise({ dur: 0.12, gain: 0.55, lp: 2400, hp: 200 });
    this.tone({ freq: 220, type: 'square', dur: 0.06, gain: 0.18, slide: -120 });
  }
  enemyHit() { this.noise({ dur: 0.08, gain: 0.35, lp: 2000 }); this.tone({ freq: 320, type: 'sawtooth', dur: 0.05, gain: 0.15, slide: -160 }); }
  enemyDie() {
    this.noise({ dur: 0.32, gain: 0.5, lp: 1200 });
    this.tone({ freq: 180, type: 'sawtooth', dur: 0.22, gain: 0.18, slide: -130 });
  }
  pickupGold() { this.tone({ freq: 980, type: 'square', dur: 0.06, gain: 0.16, slide: 320 }); this.tone({ freq: 1320, type: 'square', dur: 0.08, gain: 0.14, slide: 200 }); }
  pickupFood() { this.tone({ freq: 540, type: 'triangle', dur: 0.1, gain: 0.18, slide: 220 }); this.tone({ freq: 720, type: 'sine', dur: 0.12, gain: 0.2, slide: 200 }); }
  hurt() { this.tone({ freq: 220, type: 'sawtooth', dur: 0.18, gain: 0.28, slide: -90 }); this.noise({ dur: 0.1, gain: 0.25 }); }
  dash() { this.noise({ dur: 0.18, gain: 0.3, lp: 1800, hp: 700 }); }
  buy() { this.tone({ freq: 660, type: 'square', dur: 0.06, gain: 0.18, slide: 180 }); this.tone({ freq: 880, type: 'square', dur: 0.08, gain: 0.16, slide: 200 }); }
  death() { this.tone({ freq: 220, type: 'sawtooth', dur: 0.5, gain: 0.3, slide: -150 }); }
  arrow() { this.tone({ freq: 1200, type: 'triangle', dur: 0.06, gain: 0.12, slide: -700 }); }
  bomb() {
    this.noise({ dur: 0.55, gain: 0.65, lp: 1100, hp: 80 });
    this.tone({ freq: 90, type: 'sawtooth', dur: 0.4, gain: 0.4, slide: -50 });
  }
  bell() { this.tone({ freq: 880, type: 'sine', dur: 0.4, gain: 0.18 }); this.tone({ freq: 1320, type: 'sine', dur: 0.3, gain: 0.12 }); }
}
