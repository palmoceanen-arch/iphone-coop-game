// Tiny math + helpers
export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

// ---------------------------------------------------------------------------
// Module-scoped deterministic RNG.
//
// Game runtime randomness (drop rolls, damage variance, particle direction
// for gameplay-affecting effects, AI wander, etc.) is routed through this
// shared RNG so that a given world seed produces a reproducible run. The
// seed is set once at game start via `setDefaultSeed(seed)` (see Game
// constructor); until then it falls back to a fixed seed so module-load
// time calls (e.g. constructors creating bobT phase offsets) still
// produce a stable sequence.
//
// Visual-only randomness (camera shake jitter, fire flicker) and IO/UI
// helpers (URL seed display, audio noise buffers) intentionally stay on
// `Math.random()` — they don't influence simulation state and salting
// them with the world seed would just couple unrelated subsystems
// together.
// ---------------------------------------------------------------------------

let _defaultState = 1 >>> 0;

// mulberry32 step. Returns float in [0, 1). Mutates `_defaultState`.
function _nextDefault() {
  _defaultState = (_defaultState + 0x6D2B79F5) | 0;
  let t = _defaultState;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function setDefaultSeed(seed) {
  _defaultState = ((seed | 0) || 1) >>> 0;
}

export function defaultRandom() {
  return _nextDefault();
}

// Drop-in replacements for the legacy `Math.random()`-backed helpers.
// Routing them through `_nextDefault()` keeps the seeded sequence in
// sync with the world generator without the caller having to thread an
// rng instance everywhere.
export function rand(a, b) { return a + _nextDefault() * (b - a); }
export function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
export function chance(p) { return _nextDefault() < p; }
export function pick(arr) { return arr[Math.floor(_nextDefault() * arr.length)]; }

// Deterministic RNG (mulberry32). Returns an object with .next() in [0,1) and helpers.
// Used for chunk-local generation streams keyed by chunk seed; independent
// of the module-scoped default RNG so chunk gen never advances the
// runtime sequence and vice versa.
export function makeRng(seed = 1) {
  let s = (seed | 0) || 1;
  function next() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    range(a, b) { return a + next() * (b - a); },
    int(a, b) { return Math.floor(a + next() * (b - a + 1)); },
    chance(p) { return next() < p; },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
  };
}

// Hash a string into a 32-bit seed for makeRng().
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// In-place equivalent of `arr = arr.filter(predicate)`. Used in the
// per-frame entity update loop to avoid allocating a fresh array (and
// the resulting GC pressure) every tick. Calls `onDrop(item)` for each
// element that the predicate rejects, which lets callers run cleanup
// hooks (mark spawn-position consumed, dispose meshes) without a
// second pass over the array.
export function compactInPlace(arr, predicate, onDrop) {
  let w = 0;
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (predicate(v)) {
      if (w !== i) arr[w] = v;
      w += 1;
    } else if (onDrop) {
      onDrop(v);
    }
  }
  arr.length = w;
}

export function approach(value, target, max) {
  const d = target - value;
  if (Math.abs(d) <= max) return target;
  return value + Math.sign(d) * max;
}

// 2D helpers operating in (x, z) plane (y is up in three.js)
export function v2(x = 0, z = 0) { return { x, z }; }
export function vlen(a) { return Math.hypot(a.x, a.z); }
export function vdist(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.hypot(dx, dz); }
export function vdist2(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }
export function vnorm(a) { const l = vlen(a) || 1; return { x: a.x / l, z: a.z / l }; }
export function vscale(a, s) { return { x: a.x * s, z: a.z * s }; }
export function vadd(a, b) { return { x: a.x + b.x, z: a.z + b.z }; }
export function vsub(a, b) { return { x: a.x - b.x, z: a.z - b.z }; }
export function vto(from, to) { return vsub(to, from); }
export function vdir(from, to) { return vnorm(vto(from, to)); }
