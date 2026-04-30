// Tiny math + helpers
export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function rand(a, b) { return a + Math.random() * (b - a); }
export function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
export function chance(p) { return Math.random() < p; }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
