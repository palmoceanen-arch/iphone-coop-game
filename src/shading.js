// Shared cel-shading helpers.
//
// We use three.js MeshToonMaterial driven by a custom 1-D gradient map that
// quantises lighting into 3 bands:
//   shadow band  — ~10% of the lit hemisphere (darkest)
//   midtone band — ~30%
//   light band   — ~60%
//
// The texture is a tiny 16-pixel grayscale ramp sampled with NearestFilter so
// transitions are crisp. The luminance values per band map [0..1] lighting
// down to a colour scale that gets multiplied with the material's `color`,
// giving a flat 3-tone look in the spirit of Untitled Goose Game / cel-shaded
// indie games. Toon materials are also notably cheaper than Standard PBR
// because they skip BRDF / IBL evaluation.

import * as THREE from 'three';

function buildToonGradient() {
  // 16 pixels: 2 shadow + 5 midtone + 9 light  ≈ 12% / 31% / 56% — close to
  // the requested 10/30/60 split. Higher contrast between bands so the cel
  // effect is clearly visible even with some ambient fill.
  const data = new Uint8Array(16);
  const SHADOW = Math.round(0.22 * 255);
  const MID    = Math.round(0.58 * 255);
  const LIGHT  = 255;
  for (let i = 0; i < 16; i++) {
    if (i < 2) data[i] = SHADOW;
    else if (i < 7) data[i] = MID;
    else data[i] = LIGHT;
  }
  const tex = new THREE.DataTexture(data, 16, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export const TOON_GRADIENT = buildToonGradient();

// Roof-specific toon gradient. Pitched roof slopes (~45°) keep the
// surface normal close to vertical, which drags every visible slope
// into the high (lit) range of dotNL with the sun. Reusing the
// global TOON_GRADIENT we'd see all visible slopes land in the same
// LIGHT band → no perceptible cel-shading contrast between adjacent
// slopes (the user complaint: «на крыше не видно эффект от cel
// shading»).
//
// This 4-band version splits the lit hemisphere into LIGHT and
// BRIGHT, so e.g. a south-facing slope (dotNL ~0.85) reads BRIGHT
// and an east/west-facing slope (dotNL ~0.45) reads LIGHT — same
// crisp banding the walls already get from the global gradient,
// but pushed into the dot-product range that pitched surfaces
// actually produce. SHADOW and MID stay tonally close to the global
// gradient so a roof slope that DOES drop below the sun still
// matches the rest of the scene.
function buildRoofToonGradient() {
  const data = new Uint8Array(16);
  const SHADOW = Math.round(0.22 * 255);
  const MID    = Math.round(0.55 * 255);
  const LIGHT  = Math.round(0.80 * 255);
  const BRIGHT = 255;
  for (let i = 0; i < 16; i++) {
    if (i < 2) data[i] = SHADOW;          // 0..2/16 = 0..0.125 dotNL
    else if (i < 6) data[i] = MID;        // 2..6/16 = 0.125..0.375
    else if (i < 12) data[i] = LIGHT;     // 6..12/16 = 0.375..0.75
    else data[i] = BRIGHT;                // 12..16/16 = 0.75..1.0
  }
  const tex = new THREE.DataTexture(data, 16, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export const ROOF_TOON_GRADIENT = buildRoofToonGradient();

// Convert a three.js material (Standard / Phong / Lambert / Basic) into a
// MeshToonMaterial that preserves the source colour, optional texture map,
// and transparency. Returns the new material; the caller should swap it on
// to the mesh.
export function toToonMaterial(src) {
  const params = {
    gradientMap: TOON_GRADIENT,
  };
  if (src?.color) params.color = src.color.clone();
  if (src?.map) params.map = src.map;
  if (src?.transparent) {
    params.transparent = true;
    params.opacity = src.opacity ?? 1;
  }
  if (src?.alphaTest) params.alphaTest = src.alphaTest;
  if (src?.side !== undefined) params.side = src.side;
  if (src?.vertexColors) params.vertexColors = true;
  const m = new THREE.MeshToonMaterial(params);
  m.name = src?.name ?? '';
  return m;
}

// Walk an Object3D and replace every mesh's material with a toon variant.
// Mutates in place. Materials are NOT shared between meshes — each gets its
// own clone so per-instance tints / flashes still work.
export function toonifyTree(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map(m => toToonMaterial(m));
    } else if (obj.material) {
      obj.material = toToonMaterial(obj.material);
    }
  });
}
