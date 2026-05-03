// Shared character model loading & instancing.
//
// All character meshes are loaded once from CC0 GLB files (KayKit Adventurers
// / KayKit Skeletons), then cloned per entity via SkeletonUtils so each
// instance can be tinted / animated independently without re-uploading mesh
// data. Animations are baked into the source GLBs; we expose a small subset
// (idle / run / attack / death / hit) as `AnimationAction`s on each clone.
//
// Asset license: Creative Commons Zero (CC0) — no attribution required.
// Source: https://kaylousberg.itch.io/kaykit-adventurers
//         https://kaylousberg.itch.io/kaykit-skeletons

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { TOON_GRADIENT, toToonMaterial } from './shading.js';
// silence unused import warning when only the side-effect of building the
// shared gradient texture is needed.
void TOON_GRADIENT;

const MANIFEST = {
  knight: { url: 'models/Knight.glb' },
  skel_warrior: { url: 'models/Skeleton_Warrior.glb' },
  skel_rogue: { url: 'models/Skeleton_Rogue.glb' },
  skel_mage: { url: 'models/Skeleton_Mage.glb' },
  skel_minion: { url: 'models/Skeleton_Minion.glb' },
};

// Static nature props (Kenney Nature Kit, CC0 — kenney.nl/assets/nature-kit).
// Loaded once and cloned cheaply for each placed instance.
const NATURE_MANIFEST = {
  tree_pine_a: { url: 'models/nature/tree_pineTallA.glb' },
  tree_pine_b: { url: 'models/nature/tree_pineTallB.glb' },
  tree_pine_c: { url: 'models/nature/tree_pineTallC.glb' },
  tree_default: { url: 'models/nature/tree_default.glb' },
  tree_oak: { url: 'models/nature/tree_oak.glb' },
  rock_largeA: { url: 'models/nature/rock_largeA.glb' },
  rock_largeB: { url: 'models/nature/rock_largeB.glb' },
  rock_largeC: { url: 'models/nature/rock_largeC.glb' },
  rock_smallA: { url: 'models/nature/rock_smallA.glb' },
  rock_smallB: { url: 'models/nature/rock_smallB.glb' },
  bush: { url: 'models/nature/plant_bush.glb' },
  bush_large: { url: 'models/nature/plant_bushLarge.glb' },
};

// Destructible props. Both source GLBs are CC0 by Kay Lousberg — see
// `public/models/breakables/CREDITS.md` for full attribution.
//   pot   — KayKit "Dungeon Remastered" bottle_C_brown (pot-bellied pitcher
//           with a corked neck — the classic "кувшин" silhouette)
//   crate — KayKit "Dungeon Remastered" box_small (sealed wooden crate)
// Both ship with the same gradient colormap atlas as the rest of the KayKit
// characters in the project, so we just toon-ify the materials and let the
// atlas drive the colour — no recolouring is needed.
const BREAKABLE_MANIFEST = {
  pot: { url: 'models/breakables/pot.glb' },
  crate: { url: 'models/breakables/crate.glb' },
};

// Animation aliases — pick the closest baked animation for each gameplay slot.
// All KayKit models share the same naming convention so this map works for both
// the Knight and the Skeleton variants.
const ANIM_MAP = {
  idle: 'Idle',
  run: 'Running_A',
  walk: 'Running_B',
  attack_melee: '1H_Melee_Attack_Slice_Diagonal',
  attack_melee_heavy: '2H_Melee_Attack_Slice',
  attack_ranged: '1H_Ranged_Shoot',
  attack_spell: 'Spellcast_Shoot',
  attack_throw: 'Throw',
  attack_unarmed: 'Unarmed_Melee_Attack_Punch_A',
  hit: 'Hit_A',
  death: 'Death_A',
};

const cache = {};
const propCache = {};
const breakableCache = {};
let loaderPromise = null;

export function preloadModels(onProgress) {
  if (loaderPromise) return loaderPromise;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  const charEntries = Object.entries(MANIFEST);
  const propEntries = Object.entries(NATURE_MANIFEST);
  const breakableEntries = Object.entries(BREAKABLE_MANIFEST);
  const total = charEntries.length + propEntries.length + breakableEntries.length;
  let done = 0;
  const charPromises = charEntries.map(([key, { url }]) =>
    new Promise((resolve, reject) => {
      loader.load(url, (gltf) => {
        cache[key] = {
          scene: gltf.scene,
          animations: gltf.animations || [],
        };
        done += 1;
        onProgress?.(done, total, key);
        resolve();
      }, undefined, (err) => {
        console.error('[models] failed to load', url, err);
        reject(err);
      });
    })
  );
  const propPromises = propEntries.map(([key, { url }]) =>
    new Promise((resolve, reject) => {
      loader.load(url, (gltf) => {
        // Convert each PBR material into a toon material (cel-shaded), and
        // remap Kenney's stylised teal/pink palette to a conventional
        // green/brown forest palette. Material names in Kenney's Nature Kit
        // are inconsistent (sometimes "stone", sometimes "_defaultMat", etc.),
        // so we additionally key off the prop's filename: any prop whose
        // identifier starts with "rock" gets forced to a gray rock palette.
        const isRockProp = key.startsWith('rock');
        gltf.scene.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            const replaced = mats.map((m) => {
              if (!m) return m;
              let color;
              if (isRockProp) {
                color = new THREE.Color(0x8a8e95);
              } else {
                color = remapNatureColor(m.name || '', m.color);
              }
              const fakeSrc = {
                color,
                map: m.map || null,
                transparent: !!m.transparent,
                opacity: m.opacity ?? 1,
                side: THREE.FrontSide,
                name: m.name,
              };
              return toToonMaterial(fakeSrc);
            });
            obj.material = Array.isArray(obj.material) ? replaced : replaced[0];
          }
        });
        propCache[key] = gltf.scene;
        done += 1;
        onProgress?.(done, total, key);
        resolve();
      }, undefined, (err) => {
        console.error('[models] failed to load', url, err);
        reject(err);
      });
    })
  );
  // Load destructible props (pots, crates). These are auto-fitted to a
  // unit-height bounding box so each model lines up with a 1m gameplay
  // collider regardless of its native source scale.
  const breakablePromises = breakableEntries.map(([key, { url }]) =>
    new Promise((resolve, reject) => {
      loader.load(url, (gltf) => {
        const root = gltf.scene;
        // KayKit's models ship with a single shared colormap atlas plus per-
        // vertex colours; toon-ify each material in place so the atlas tones
        // are preserved (terracotta jug, weathered wooden crate) but the
        // shading matches the rest of the cel-shaded world.
        root.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            const replaced = mats.map((m) => m ? toToonMaterial(m) : m);
            obj.material = Array.isArray(obj.material) ? replaced : replaced[0];
          }
        });
        // Normalize source scale by the model's largest horizontal extent
        // (max of X/Z bbox). Pots want a footprint around 0.55m so they read
        // as knee-high jugs, crates want 0.85m so they look like a crouching
        // sealed box. Y is left to follow whatever aspect the source authored
        // (a tall jar stays tall).
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const target = (key === 'pot') ? 0.55 : 0.85;
        const refDim = Math.max(size.x, size.z, 1e-4);
        const baseScale = target / refDim;
        breakableCache[key] = {
          scene: root,
          baseScale,
          // Y-offset between model origin and floor in source units; needed
          // when the source mesh isn't centered on its own base.
          baseY: -box.min.y,
        };
        done += 1;
        onProgress?.(done, total, key);
        resolve();
      }, undefined, (err) => {
        console.error('[models] failed to load', url, err);
        reject(err);
      });
    })
  );
  loaderPromise = Promise.all([...charPromises, ...propPromises, ...breakablePromises])
    .then(() => ({ cache, propCache, breakableCache }));
  return loaderPromise;
}

// Map Kenney Nature Kit material names to natural forest colors. Falls back
// to the source material's color so unknown materials still render reasonably.
function remapNatureColor(name, srcColor) {
  const n = name.toLowerCase();
  if (n.includes('leaf')) {
    // pick variant: dark/light to keep some variation across models
    if (n.includes('dark')) return new THREE.Color(0x2c5d22);
    if (n.includes('light')) return new THREE.Color(0x6cb850);
    return new THREE.Color(0x4a8f3a);
  }
  if (n.includes('wood') || n.includes('bark') || n.includes('trunk')) {
    return new THREE.Color(0x6b3f1c);
  }
  if (n.includes('grass') || n.includes('foliage')) {
    return new THREE.Color(0x4f9a3a);
  }
  if (n.includes('stone') || n.includes('rock') || n.includes('cliff')) {
    return new THREE.Color(0x8a8e95);
  }
  if (n.includes('dirt') || n.includes('ground') || n.includes('earth')) {
    return new THREE.Color(0x6b5430);
  }
  return srcColor ? srcColor.clone() : new THREE.Color(0xffffff);
}

// Clone a static nature prop. Materials are shared between instances since
// they're never tinted/animated individually — keeps GPU memory low.
export function spawnProp(kind, { scale = 1, rotationY = 0 } = {}) {
  const src = propCache[kind];
  if (!src) {
    throw new Error(`[models] unknown prop kind "${kind}"`);
  }
  const root = src.clone(true);
  root.scale.setScalar(scale);
  root.rotation.y = rotationY;
  return root;
}

export function getPropKinds() {
  return Object.keys(propCache);
}

// Returns true if the breakable prop GLBs have been loaded. Breakables fall
// back to procedural primitives in `Breakable._buildFallbackMesh()` until the
// cache is populated, so a first-frame breakable can still render before the
// preload finishes.
export function isBreakableLoaded(kind) {
  return !!breakableCache[kind];
}

// Clone a breakable prop. Returns null if the source GLB hasn't loaded yet
// (caller should fall back to a procedural mesh in that case). The returned
// scene is auto-scaled so its bounding box height matches the target chosen
// at preload time, then multiplied by the caller's `scale` for final size.
export function spawnBreakable(kind, { scale = 1, rotationY = 0 } = {}) {
  const src = breakableCache[kind];
  if (!src) return null;
  const root = src.scene.clone(true);
  const finalScale = src.baseScale * scale;
  root.scale.setScalar(finalScale);
  root.rotation.y = rotationY;
  // Lift the model so its bounding-box bottom touches y=0 even after scale.
  root.position.y = src.baseY * finalScale;
  return root;
}

// Reusable color buffer to convert hex tints into linear-space color (matches
// renderer's default working color space for MeshLambertMaterial).
const _tmpColor = new THREE.Color();

// Clone a character model and return a small handle exposing the root Object3D,
// an AnimationMixer, and named AnimationActions. Caller is responsible for
// driving the mixer with `mixer.update(dt)` each frame and for adding the root
// to a parent scene.
//
// `tint` (hex int) is optional — if provided, every mesh's material is cloned
// and multiplied by the tint color so different instances of the same model
// can have distinct colors without affecting siblings.
export function spawnCharacter(kind, { tint = null, scale = 1, hueShift = 0 } = {}) {
  const entry = cache[kind];
  if (!entry) {
    throw new Error(`[models] unknown kind "${kind}" — did preloadModels() resolve?`);
  }

  const root = cloneSkeleton(entry.scene);
  root.scale.setScalar(scale);

  // Walk the cloned hierarchy: enable shadows, replace each material with a
  // toon variant (per-instance, so per-instance tints / flashes don't leak).
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = false;
      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map(m => toToonMaterial(m));
      } else if (obj.material) {
        obj.material = toToonMaterial(obj.material);
      }
      if (tint !== null) {
        _tmpColor.setHex(tint);
        applyTint(obj.material, _tmpColor);
      } else if (hueShift !== 0) {
        applyHueShift(obj.material, hueShift);
      }
    }
  });

  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const [slot, animName] of Object.entries(ANIM_MAP)) {
    const clip = entry.animations.find(c => c.name === animName);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    actions[slot] = action;
  }

  // Sensible defaults
  actions.idle?.setLoop(THREE.LoopRepeat).play();
  if (actions.run) actions.run.setLoop(THREE.LoopRepeat);
  if (actions.walk) actions.walk.setLoop(THREE.LoopRepeat);
  for (const k of ['attack_melee', 'attack_melee_heavy', 'attack_ranged', 'attack_spell', 'attack_throw', 'attack_unarmed', 'hit']) {
    if (actions[k]) {
      actions[k].setLoop(THREE.LoopOnce);
      actions[k].clampWhenFinished = true;
    }
  }
  if (actions.death) {
    actions.death.setLoop(THREE.LoopOnce);
    actions.death.clampWhenFinished = true;
  }

  return { root, mixer, actions };
}

function applyTint(material, color) {
  if (!material) return;
  // MeshLambertMaterial / MeshStandardMaterial both expose `color` and
  // optionally `emissive`. Multiply the texture's albedo via base color.
  if (material.color) {
    material.color.copy(color);
  }
  if (material.map) {
    // Keep the texture but tint via base color — KayKit uses a single gradient
    // atlas, so multiplying gives a recognisable team-color effect without
    // losing the shading detail in the atlas.
  }
}

function applyHueShift(material, shift) {
  if (!material || !material.color) return;
  const hsl = { h: 0, s: 0, l: 0 };
  material.color.getHSL(hsl);
  hsl.h = (hsl.h + shift) % 1;
  if (hsl.h < 0) hsl.h += 1;
  material.color.setHSL(hsl.h, hsl.s, hsl.l);
}

// Cross-fade helper — fades from current playing animations to `target` over
// `duration` seconds, then plays target. Useful for switching between idle/run
// states without snapping. Other actions are faded out but kept on the mixer
// so they can be faded back in later.
export function crossFadeTo(actions, target, duration = 0.18) {
  if (!actions || !target) return null;
  const next = actions[target];
  if (!next) return null;
  let didFade = false;
  for (const [slot, a] of Object.entries(actions)) {
    if (slot === target || !a) continue;
    if (a.isRunning() && a.weight > 0.001) {
      a.fadeOut(duration);
      didFade = true;
    }
  }
  next.reset();
  if (didFade) next.fadeIn(duration);
  next.play();
  return next;
}
