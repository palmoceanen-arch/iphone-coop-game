// Tiny math + helpers
export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function rand(a, b) { return a + Math.random() * (b - a); }
export function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
export function chance(p) { return Math.random() < p; }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Deterministic RNG (mulberry32). Returns an object with .next() in [0,1) and helpers.
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
