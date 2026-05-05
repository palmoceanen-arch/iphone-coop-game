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
// the Knight and the Skeleton variants. The full Knight.glb (KayKit Adventurers
// 1.0 source) ships with 76 animations; the older Skeleton GLBs only include
// a small subset, so the loader silently drops slots that aren't present in
// the source clip list.
const ANIM_MAP = {
  idle: 'Idle',
  run: 'Running_A',
  walk: 'Walking_A',
  // 1H melee variants
  attack_1h_chop:     '1H_Melee_Attack_Chop',
  attack_1h_slice:    '1H_Melee_Attack_Slice_Diagonal',
  attack_1h_horiz:    '1H_Melee_Attack_Slice_Horizontal',
  attack_1h_stab:     '1H_Melee_Attack_Stab',
  // 2H melee variants — bigger reach + impact
  attack_2h_chop:     '2H_Melee_Attack_Chop',
  attack_2h_slice:    '2H_Melee_Attack_Slice',
  attack_2h_spin:     '2H_Melee_Attack_Spin',
  attack_2h_stab:     '2H_Melee_Attack_Stab',
  // dual-wield, ranged, magic
  attack_dual_chop:   'Dualwield_Melee_Attack_Chop',
  attack_dual_slice:  'Dualwield_Melee_Attack_Slice',
  attack_dual_stab:   'Dualwield_Melee_Attack_Stab',
  attack_ranged:      '1H_Ranged_Shoot',
  attack_spell:       'Spellcast_Shoot',
  attack_spell_long:  'Spellcast_Long',
  attack_throw:       'Throw',
  attack_unarmed:     'Unarmed_Melee_Attack_Punch_A',
  // legacy aliases — keep `attack_melee` and `attack_melee_heavy` working for
  // any callsite that hasn't been migrated to the per-weapon map yet.
  attack_melee:       '1H_Melee_Attack_Slice_Diagonal',
  attack_melee_heavy: '2H_Melee_Attack_Slice',
  hit:    'Hit_A',
  hit_b:  'Hit_B',
  block:  'Block',
  death:  'Death_A',
};

// Bones that drive the *upper* half of the KayKit Rig_Medium skeleton. Used to
// strip lower-body tracks from attack clips so the legs keep playing whatever
// locomotion (idle/run) is active underneath, instead of snapping to whatever
// pose the attack clip authors for the legs.
//
// Hierarchy (from public/models/Knight.glb, raw glTF node names):
//   root → Rig → hips → upperleg.{l,r} → lowerleg → foot → toes
//                     → spine → chest → upperarm.{l,r} → lowerarm → wrist → hand → handslot
//                                     → head
// IK helpers (kneeIK, heelIK, handIK, elbowIK, control-*-roll) are direct
// children of root and we route arm IK to upper, leg IK to lower.
//
// IMPORTANT: GLTFLoader runs every node name through
// `PropertyBinding.sanitizeNodeName`, which *strips* reserved characters
// `[].:/` (it does not replace them). So at runtime the bone formerly known
// as `upperarm.l` is `upperarml`, and the matching track name is
// `upperarml.quaternion`. We sanitize each canonical name once at module
// load and match against the sanitized form when filtering tracks.
const _SANITIZE_RESERVED_RE = /[[\].:/]/g;
function _sanitizeBoneName(name) {
  return name.replace(/\s/g, '_').replace(_SANITIZE_RESERVED_RE, '');
}
const UPPER_BODY_BONES = new Set([
  'spine', 'chest', 'head',
  'upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l', 'handslot.l',
  'upperarm.r', 'lowerarm.r', 'wrist.r', 'hand.r', 'handslot.r',
  'elbowIK.l', 'elbowIK.r', 'handIK.l', 'handIK.r',
].map(_sanitizeBoneName));

// Slots whose clips should be filtered to upper-body-only at bind time.
// Spell-cast / throw / ranged are mostly arm gestures too, so the filter
// applies the same way; the legs reading idle/run underneath only ever
// looks better than a static pose.
const UPPER_BODY_SLOT_PREFIXES = ['attack_'];

// Per-slot clip trimming ratios. KayKit's `2H_Melee_Attack_Spin` is a 2.4s
// clip that has a wide ~270° arc but spends roughly the first third holding
// a wind-up pose — at any sane swing speed it reads as "attack pauses, then
// resumes". Trimming the lead-in keeps only the active sweep + follow-through.
// `start` and `end` are normalised positions (0..1) within the source clip.
const SLOT_TRIM = {
  attack_2h_spin: { start: 0.36, end: 1.00 },
};

// Trim a clip to a sub-range by re-sampling each track's keyframes within
// [startTime, endTime] and shifting them so the new clip starts at t=0.
// Mirrors what `THREE.AnimationUtils.subclip` does but in continuous time
// units instead of frames, so we don't depend on knowing the source FPS.
function trimClip(clip, startTime, endTime, name) {
  const t0 = Math.max(0, startTime);
  const t1 = Math.min(clip.duration, endTime);
  if (t1 <= t0 + 1e-3) return clip;
  const newTracks = clip.tracks.map((track) => {
    const times = track.times;
    const valueSize = track.getValueSize();
    const values = track.values;
    const keptTimes = [];
    const keptValues = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= t0 && times[i] <= t1) {
        keptTimes.push(times[i] - t0);
        for (let v = 0; v < valueSize; v++) keptValues.push(values[i * valueSize + v]);
      }
    }
    if (keptTimes.length === 0) {
      // No keyframes in range — keep at least one so the track is valid.
      keptTimes.push(0);
      const lastIdx = times.length - 1;
      for (let v = 0; v < valueSize; v++) keptValues.push(values[lastIdx * valueSize + v]);
    }
    return new track.constructor(track.name, keptTimes, keptValues);
  });
  return new THREE.AnimationClip(name, t1 - t0, newTracks, clip.blendMode);
}

// Build a copy of `clip` that only contains tracks whose bone is in
// `UPPER_BODY_BONES`. Track names look like `<sanitizedBoneName>.<property>`
// or `<sanitizedBoneName>.<property>[index]` — sanitized names cannot
// contain `.`, so the bone name is just the substring before the FIRST `.`.
function buildUpperBodyClip(clip) {
  const tracks = clip.tracks.filter((t) => {
    const dot = t.name.indexOf('.');
    if (dot < 0) return false;
    const bone = t.name.slice(0, dot);
    return UPPER_BODY_BONES.has(bone);
  });
  if (tracks.length === 0 || tracks.length === clip.tracks.length) {
    // Nothing to strip (clip already only animates upper body) or no tracks
    // matched at all — fall back to the original so we never end up with an
    // empty clip that does nothing.
    return clip;
  }
  return new THREE.AnimationClip(clip.name + '_upper', clip.duration, tracks, clip.blendMode);
}

// Stand-alone weapon meshes that get parented to the character's `handslot.r`
// bone at runtime. Only weapons that aren't already baked into a character GLB
// live here (the Knight already includes 1H_Sword / 2H_Sword as named child
// meshes, so they're toggled instead of attached). All sources are CC0
// KayKit Adventurers Pack 1.0 — see `public/models/weapons/CREDITS.md`.
const WEAPON_MANIFEST = {
  axe_1h:    { url: 'models/weapons/axe_1handed.glb' },
  axe_2h:    { url: 'models/weapons/axe_2handed.glb' },
  staff:     { url: 'models/weapons/staff.glb' },
  wand:      { url: 'models/weapons/wand.glb' },
  dagger:    { url: 'models/weapons/dagger.glb' },
  spellbook: { url: 'models/weapons/spellbook_closed.glb' },
};

const cache = {};
const propCache = {};
const breakableCache = {};
const weaponCache = {};
let loaderPromise = null;
let weaponLoaderPromise = null;

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
// Walk up a mesh's parent chain to figure out which "slot" it belongs to —
// body (default), cape (the Knight_Cape rig node), helmet, or weapon (any
// of the built-in 1H/2H sword and shield meshes parented to handslot.r/.l).
// Used by spawnCharacter() / applyCharacterTint() so callers can tint the
// cape independently from the rest of the character without affecting
// weapons or shields.
function classifyMeshRole(meshNode) {
  let cur = meshNode;
  while (cur) {
    const name = cur.name || '';
    if (name.includes('Cape')) return 'cape';
    if (name.includes('Sword') || name.includes('Shield')) return 'weapon';
    if (name.includes('Helmet')) return 'helmet';
    cur = cur.parent;
  }
  return 'body';
}

export function spawnCharacter(kind, { tint = null, capeTint = null, scale = 1, hueShift = 0 } = {}) {
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
      const role = classifyMeshRole(obj);
      if (role === 'weapon') {
        // Leave swords/shields with their atlas-driven colour so the user's
        // body tint doesn't bleed into the equipment.
      } else if (role === 'cape') {
        const capeHex = (capeTint !== null) ? capeTint : tint;
        if (capeHex !== null) {
          _tmpColor.setHex(capeHex);
          applyTint(obj.material, _tmpColor);
        } else if (hueShift !== 0) {
          applyHueShift(obj.material, hueShift);
        }
      } else if (tint !== null) {
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
    const sourceClip = entry.animations.find(c => c.name === animName);
    if (!sourceClip) continue;
    let clip = sourceClip;
    const trim = SLOT_TRIM[slot];
    if (trim) {
      const t0 = trim.start * clip.duration;
      const t1 = trim.end * clip.duration;
      clip = trimClip(clip, t0, t1, `${animName}_trim`);
    }
    const isUpperOnly = UPPER_BODY_SLOT_PREFIXES.some(p => slot.startsWith(p));
    if (isUpperOnly) clip = buildUpperBodyClip(clip);
    const action = mixer.clipAction(clip);
    actions[slot] = action;
  }

  // Sensible defaults
  actions.idle?.setLoop(THREE.LoopRepeat).play();
  if (actions.run) actions.run.setLoop(THREE.LoopRepeat);
  if (actions.walk) actions.walk.setLoop(THREE.LoopRepeat);
  for (const k of [
    'attack_1h_chop', 'attack_1h_slice', 'attack_1h_horiz', 'attack_1h_stab',
    'attack_2h_chop', 'attack_2h_slice', 'attack_2h_spin', 'attack_2h_stab',
    'attack_dual_chop', 'attack_dual_slice', 'attack_dual_stab',
    'attack_ranged', 'attack_spell', 'attack_spell_long', 'attack_throw',
    'attack_unarmed', 'attack_melee', 'attack_melee_heavy',
    'hit', 'hit_b', 'block',
  ]) {
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

// Re-tint a previously spawned character in-place (used by the start-menu
// preview to react to swatch clicks without rebuilding the whole mesh).
// `bodyHex` colours body + helmet; `capeHex` colours just the cape. Pass
// `null` for either to leave that part alone.
export function applyCharacterTint(character, { body = null, cape = null } = {}) {
  if (!character || !character.root) return;
  character.root.traverse((obj) => {
    if (!obj.isMesh) return;
    const role = classifyMeshRole(obj);
    if (role === 'weapon') return;
    let hex = null;
    if (role === 'cape') hex = (cape !== null) ? cape : body;
    else hex = body;
    if (hex === null) return;
    _tmpColor.setHex(hex);
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) applyTint(m, _tmpColor);
    } else {
      applyTint(obj.material, _tmpColor);
    }
  });
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

// =============================================================================
// Weapon system
// =============================================================================
//
// The Knight character (KayKit Adventurers, Rig_Medium) has named weapon and
// shield meshes baked in as direct children of `handslot.r` / `handslot.l`:
//
//     1H_Sword, 2H_Sword, 1H_Sword_Offhand,
//     Round_Shield, Rectangle_Shield, Spike_Shield, Badge_Shield
//
// We expose a single `setEquippedWeapon(character, weaponKind)` entry point
// that handles two cases uniformly:
//
//   1. *Built-in* weapons — toggle visibility of the relevant child node(s).
//   2. *External* weapons — clone a weapon GLB once and re-parent it to the
//      character's `handslot.r` bone.
//
// Each weapon advertises a gameplay profile in `WEAPONS`:
//   - `attackAnim`  : ANIM_MAP slot to play on swing
//   - `swing`       : total animation length we want on screen (sec)
//   - `impactAt`    : 0..1 — point in the swing where damage is dealt
//   - `range` / `arc`: hit volume (m / radians)
//   - `cooldown`    : time between swings (sec, before attackSpeed upgrades)
//   - `damageMult`  : multiplier on the player's base damage stat
//   - `showNodes`   : built-in child meshes to make visible (others are hidden)
//   - `attach`      : key into WEAPON_MANIFEST for an external mesh, or null
//   - `slash`       : optional swing-arc VFX spec (`{ color, height }`); omit
//                     for non-slash weapons (e.g. wand jab) so no arc spawns
//
// Weapon profiles intentionally tune *swing length* and *impactAt* together
// so the gameplay damage window (in `Player.update`) lands at the exact frame
// the animation looks like it's hitting — this is what makes the swing feel
// like it has weight, instead of registering as soon as the button is pressed.
//
// Tuning rule of thumb: KayKit attacks are baked at ~1.0–1.7s with a real
// windup. We don't want to compress them under ~0.85× of their natural length
// or the windup vanishes and the swing reads as a quick poke. `cooldown` can
// (and should) be shorter than `swing` — the next press fades into the next
// clip, so cooldown drives "how often you can swing" while swing drives
// "how long the visible motion lasts".
export const WEAPONS = {
  // Default: knight's built-in 1H sword + round shield. Wide horizontal
  // slice — reads as a much bigger swipe than the old overhead chop and
  // covers a generous front arc so positioning still matters but glancing
  // blows are forgiving. Damage window lands at the midpoint of the swipe.
  sword_1h: {
    label: 'Sword',
    showNodes: ['1H_Sword', 'Round_Shield'],
    attach: null,
    attackAnim: 'attack_1h_horiz',  // 1H horizontal slice (~1.0s baked)
    swing: 0.85,
    impactAt: 0.50,
    range: 2.3,
    arc: Math.PI * 0.85,   // ~153° — wide horizontal sweep
    cooldown: 0.55,
    damageMult: 1.0,
    slash: { color: 0xdfeaff, height: 1.05 },
  },
  // Heavy two-hander — wider arc, more reach, more wind-up. Uses the 2H
  // *spin* clip with the wind-up hold trimmed off (see SLOT_TRIM in
  // models.js): the trimmed clip is ~1.5s of pure horizontal sweep, no
  // mid-swing freeze. Arc widened to match the visual reach of the spin.
  sword_2h: {
    label: 'Greatsword',
    showNodes: ['2H_Sword'],
    attach: null,
    attackAnim: 'attack_2h_spin',  // 2H wide spin sweep, lead-in trimmed
    swing: 1.30,
    impactAt: 0.55,
    range: 2.7,
    arc: Math.PI * 1.05,   // ~189° — full follow-through to the right
    cooldown: 0.75,
    damageMult: 1.6,
    slash: { color: 0xc8d6ff, height: 1.10 },
  },
  // 1H axe — shares the 1H horizontal slice clip with the sword. Slightly
  // slower swing and tighter arc on the rebuild because an axe head feels
  // weightier than a sword tip; a warm-steel slash colour to read distinct
  // from the sword in coop play.
  axe_1h: {
    label: 'Axe',
    showNodes: ['Round_Shield'],   // axe in main hand, shield offhand
    attach: 'axe_1h',
    attackAnim: 'attack_1h_horiz',  // 1H horizontal slice
    swing: 0.92,
    impactAt: 0.52,
    range: 2.3,
    arc: Math.PI * 0.80,   // ~144°
    cooldown: 0.65,
    damageMult: 1.2,
    slash: { color: 0xffd28a, height: 1.05 },
  },
  // 2H battle axe — same trimmed spin sweep as the great-sword but with a
  // slightly longer swing window because the axe head is heavier; the
  // follow-through reads as more committed.
  axe_2h: {
    label: 'Battle Axe',
    showNodes: [],
    attach: 'axe_2h',
    attackAnim: 'attack_2h_spin',  // 2H wide spin sweep, lead-in trimmed
    swing: 1.45,
    impactAt: 0.55,
    range: 2.7,
    arc: Math.PI * 1.05,   // ~189°
    cooldown: 0.85,
    damageMult: 1.8,
    slash: { color: 0xffae6a, height: 1.05 },
  },
  staff: {
    label: 'Staff',
    showNodes: [],
    attach: 'staff',
    attackAnim: 'attack_2h_slice',  // 1.10s baked — wide horizontal sweep
    swing: 0.95,
    impactAt: 0.55,
    range: 2.4,
    arc: Math.PI * 0.70,
    cooldown: 0.60,
    damageMult: 1.1,
    slash: { color: 0x9adfff, height: 1.15 },
  },
  // Wand — spell jab. No swing arc VFX (it's a forward cast, not a slash).
  wand: {
    label: 'Wand',
    showNodes: [],
    attach: 'wand',
    attackAnim: 'attack_spell',     // 0.93s baked — short cast + jab
    swing: 0.75,
    impactAt: 0.50,
    range: 2.2,
    arc: Math.PI * 0.5,
    cooldown: 0.45,
    damageMult: 0.9,
  },
};

// All weapon meshes that need to be toggled or attached. Hiding everything in
// this list first lets us pick exactly which subset to show without having to
// know what the previous loadout was.
const KNIGHT_TOGGLEABLE_NODES = [
  '1H_Sword', '2H_Sword', '1H_Sword_Offhand',
  'Round_Shield', 'Rectangle_Shield', 'Spike_Shield', 'Badge_Shield',
];

// Loads weapon GLBs that aren't baked into the character. Lazy: only fires
// the first time someone actually equips an external weapon, so the initial
// game load isn't blocked on weapons the player may never use.
export function preloadWeapons() {
  if (weaponLoaderPromise) return weaponLoaderPromise;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const entries = Object.entries(WEAPON_MANIFEST);
  const promises = entries.map(([key, { url }]) =>
    new Promise((resolve, reject) => {
      loader.load(url, (gltf) => {
        // Toon-shade weapons so they match the rest of the cel-shaded world.
        gltf.scene.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = false;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            const replaced = mats.map((m) => m ? toToonMaterial(m) : m);
            obj.material = Array.isArray(obj.material) ? replaced : replaced[0];
          }
        });
        weaponCache[key] = gltf.scene;
        resolve();
      }, undefined, (err) => {
        console.error('[models] failed to load weapon', url, err);
        reject(err);
      });
    })
  );
  weaponLoaderPromise = Promise.all(promises).then(() => weaponCache);
  return weaponLoaderPromise;
}

// Equip a weapon on the given character handle (the value returned by
// `spawnCharacter`). Toggles built-in weapon/shield meshes and, if the
// weapon profile has an `attach` external mesh, parents a clone of it to
// the character's `handslot.r` bone.
//
// Designed to be safe to call repeatedly — each call removes any previously
// attached external mesh and resets the visibility of all toggleable nodes.
export function setEquippedWeapon(character, weaponKind) {
  const profile = WEAPONS[weaponKind];
  if (!profile) {
    console.warn('[models] unknown weapon kind', weaponKind);
    return null;
  }
  const root = character?.root;
  if (!root) return null;

  // 1) Toggle the built-in mesh nodes — hide everything first, then show
  //    only the ones requested by the weapon profile.
  const showSet = new Set(profile.showNodes || []);
  root.traverse((obj) => {
    if (KNIGHT_TOGGLEABLE_NODES.includes(obj.name)) {
      obj.visible = showSet.has(obj.name);
    }
  });

  // 2) Remove any previously-attached external mesh.
  if (character._equippedAttachment) {
    character._equippedAttachment.parent?.remove(character._equippedAttachment);
    character._equippedAttachment = null;
  }

  // 3) Attach the new external mesh to handslot.r if requested.
  //
  // Three.js's GLTFLoader pipes node names through
  // `PropertyBinding.sanitizeNodeName`, which *strips* reserved characters
  // (`[`, `]`, `.`, `:`, `/`) instead of replacing them. So the bone the
  // KayKit GLB calls `handslot.r` ends up named `handslotr` on the cloned
  // skeleton. Keep both spellings as fallbacks so the helper works whether
  // a future three.js version re-introduces the dot or not.
  if (profile.attach) {
    const src = weaponCache[profile.attach];
    if (!src) {
      console.warn('[models] weapon mesh not loaded yet:', profile.attach,
        '— call preloadWeapons() before equipping external weapons');
    } else {
      const candidates = ['handslotr', 'handslot.r', 'handslot_r'];
      let slot = null;
      for (const n of candidates) {
        slot = root.getObjectByName(n);
        if (slot) break;
      }
      if (slot) {
        const inst = src.clone(true);
        // The KayKit weapon GLBs are authored to be parented in place of the
        // built-in `1H_Sword` / `2H_Sword` nodes — not directly to
        // `handslot.r`. Those built-in weapon nodes carry a small upward
        // translation and a 180° Y rotation that orient the grip correctly
        // in the hand. Mirror that transform here so external weapons sit in
        // the same pose as the built-in swords.
        inst.position.set(0, 0.033, 0);
        inst.quaternion.set(0, -1, 0, 0);
        slot.add(inst);
        character._equippedAttachment = inst;
      } else {
        console.warn('[models] right-hand slot bone not found on character');
      }
    }
  }

  character._equippedWeapon = weaponKind;
  return profile;
}

export function getEquippedWeapon(character) {
  return character?._equippedWeapon || null;
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
