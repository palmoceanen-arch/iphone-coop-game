// Player-facing graphics + audio settings.
//
// Loaded from localStorage on boot and re-applied whenever the player tweaks
// a control in the pause menu. Each setting is wired through the
// `applyVideo*` / `applyAudio*` helpers so the change is reflected
// immediately on the live renderer / scene / sound output without forcing a
// full page reload.

import * as THREE from 'three';

const STORAGE_KEY = 'twinhearts.settings.v1';

// Shadow map size per quality bucket. 0 = shadows disabled.
const SHADOW_SIZE = {
  off: 0,
  low: 1024,
  medium: 2048,
  high: 4096,
  ultra: 8192,
};

const SHADOW_TYPE_MAP = {
  hard: THREE.BasicShadowMap,
  pcf: THREE.PCFShadowMap,
  soft: THREE.PCFSoftShadowMap,
};

// Preset bundles applied to every video field at once. "Custom" is the
// implicit bucket the UI shows when the live values don't match any preset.
// (Anti-aliasing is intentionally not in here: it is a fixed-at-boot
// renderer attribute and is negotiated downward by createRenderer() for
// older GPUs.)
export const VIDEO_PRESETS = {
  low: {
    shadows: 'off',
    shadowType: 'hard',
    resolutionScale: 0.75,
    fog: true,
    particles: 'low',
    water: 'low',
    terrainQuality: 'low',
    fov: 60,
  },
  medium: {
    shadows: 'medium',
    shadowType: 'pcf',
    resolutionScale: 1.0,
    fog: true,
    particles: 'medium',
    water: 'medium',
    terrainQuality: 'medium',
    fov: 60,
  },
  high: {
    shadows: 'high',
    shadowType: 'pcf',
    resolutionScale: 1.0,
    fog: true,
    particles: 'high',
    water: 'high',
    terrainQuality: 'high',
    fov: 60,
  },
  ultra: {
    shadows: 'ultra',
    shadowType: 'soft',
    resolutionScale: 1.25,
    fog: true,
    particles: 'high',
    water: 'high',
    terrainQuality: 'high',
    fov: 60,
  },
};

const PARTICLE_MULTIPLIER = {
  off: 0,
  low: 0.4,
  medium: 0.75,
  high: 1.0,
};

export const DEFAULTS = {
  video: { ...VIDEO_PRESETS.high, showFps: false },
  audio: {
    masterVolume: 0.5,
    sfxVolume: 1.0,
    ambientVolume: 0.6,
    muted: false,
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function deepMerge(target, source) {
  const out = Array.isArray(target) ? target.slice() : { ...target };
  for (const k of Object.keys(source || {})) {
    const a = out[k];
    const b = source[k];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      out[k] = deepMerge(a, b);
    } else if (b !== undefined) {
      out[k] = b;
    }
  }
  return out;
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return deepMerge(clone(DEFAULTS), parsed);
  } catch {
    return clone(DEFAULTS);
  }
}

export class Settings {
  constructor() {
    this.values = loadFromStorage();
    this.listeners = new Set();
    // Wired in via attach(); kept null until the Game has constructed its
    // renderer / world / sound stack.
    this.renderer = null;
    this.world = null;
    this.scene = null;
    this.sound = null;
    this.followCam = null;
  }

  attach({ renderer, world, scene, sound, followCam, effects }) {
    this.renderer = renderer;
    this.world = world;
    this.scene = scene;
    this.sound = sound;
    this.followCam = followCam;
    this.effects = effects;
    this.applyAll();
  }

  // ---- Persistence ------------------------------------------------------

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch { /* quota / private mode */ }
  }

  reset() {
    this.values = clone(DEFAULTS);
    this.save();
    this.applyAll();
    this._emit();
  }

  // ---- Listeners --------------------------------------------------------

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this.values); } catch { /* ignore */ } } }

  // ---- Setters ----------------------------------------------------------

  setVideo(key, value) {
    if (this.values.video[key] === value) return;
    this.values.video = { ...this.values.video, [key]: value };
    this.save();
    this.applyVideo();
    this._emit();
  }

  setAudio(key, value) {
    if (this.values.audio[key] === value) return;
    this.values.audio = { ...this.values.audio, [key]: value };
    this.save();
    this.applyAudio();
    this._emit();
  }

  applyPreset(name) {
    const preset = VIDEO_PRESETS[name];
    if (!preset) return;
    this.values.video = { ...this.values.video, ...preset };
    this.save();
    this.applyVideo();
    this._emit();
  }

  // The preset label the UI shows: 'low'|'medium'|'high'|'ultra'|'custom'.
  currentPreset() {
    for (const [name, preset] of Object.entries(VIDEO_PRESETS)) {
      let match = true;
      for (const k of Object.keys(preset)) {
        if (this.values.video[k] !== preset[k]) { match = false; break; }
      }
      if (match) return name;
    }
    return 'custom';
  }

  // ---- Apply ------------------------------------------------------------

  applyAll() {
    this.applyVideo();
    this.applyAudio();
  }

  applyVideo() {
    if (!this.renderer) return;
    const v = this.values.video;
    const enabled = v.shadows !== 'off';
    this.renderer.shadowMap.enabled = enabled;
    if (enabled) {
      this.renderer.shadowMap.type = SHADOW_TYPE_MAP[v.shadowType] ?? THREE.PCFShadowMap;
    }
    if (this.world && this.world.sun) {
      const sun = this.world.sun;
      sun.castShadow = enabled;
      const size = SHADOW_SIZE[v.shadows] || 1024;
      if (size > 0 && (sun.shadow.mapSize.x !== size || sun.shadow.mapSize.y !== size)) {
        sun.shadow.mapSize.set(size, size);
        // Force the shadow map texture to be reallocated on the next render
        // — Three.js keeps an internal RenderTarget that has to be disposed
        // when mapSize changes mid-flight.
        if (sun.shadow.map) {
          sun.shadow.map.dispose();
          sun.shadow.map = null;
        }
      }
      // Soft shadow type benefits from a slightly larger PCF radius;
      // hard/PCF stay crisp at radius=1 (matches the world.js comment).
      sun.shadow.radius = v.shadowType === 'soft' ? 4 : 1;
    }
    // Render resolution scale (clamped to a reasonable max so we don't blow
    // up the GPU on 4K displays).
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.max(0.25, Math.min(2.0, Number(v.resolutionScale) || 1));
    this.renderer.setPixelRatio(dpr * scale);
    // Fog toggle — keep the configured fog object intact so we can restore it.
    if (this.scene) {
      if (v.fog) {
        if (this._savedFog) {
          this.scene.fog = this._savedFog;
          this._savedFog = null;
        }
      } else if (this.scene.fog) {
        this._savedFog = this.scene.fog;
        this.scene.fog = null;
      }
    }
    if (this.followCam && this.followCam.cam && typeof v.fov === 'number') {
      if (this.followCam.cam.fov !== v.fov) {
        this.followCam.cam.fov = v.fov;
        this.followCam.cam.updateProjectionMatrix();
      }
    }
    if (this.effects && typeof this.effects.setParticleScale === 'function') {
      this.effects.setParticleScale(this.particleMultiplier());
    }
    if (this.world && typeof this.world.setWaterQuality === 'function') {
      this.world.setWaterQuality(v.water);
    }
    if (this.world && typeof this.world.setTerrainQuality === 'function') {
      this.world.setTerrainQuality(v.terrainQuality);
    }
  }

  applyAudio() {
    if (!this.sound) return;
    const a = this.values.audio;
    if (typeof this.sound.setMasterVolume === 'function') this.sound.setMasterVolume(a.masterVolume);
    if (typeof this.sound.setSfxVolume === 'function') this.sound.setSfxVolume(a.sfxVolume);
    if (typeof this.sound.setAmbientVolume === 'function') this.sound.setAmbientVolume(a.ambientVolume);
    if (typeof this.sound.setMuted === 'function') this.sound.setMuted(a.muted);
  }

  // ---- Read helpers consumed by the rest of the engine -------------------

  particleMultiplier() {
    return PARTICLE_MULTIPLIER[this.values.video.particles] ?? 1.0;
  }

  showFps() { return !!this.values.video.showFps; }
}

// Module-level singleton: simpler than threading a Settings instance through
// every effects helper / sound call site. Game.constructor wires the
// renderer/world/sound into this.
let _instance = null;
export function getSettings() {
  if (!_instance) _instance = new Settings();
  return _instance;
}
