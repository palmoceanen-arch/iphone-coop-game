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
  // Player-pickable characters from the KayKit Adventurers pack — all
  // share the same `Rig_Medium` skeleton and ship with the same 76
  // animation clips, so the player picker can swap any of them in
  // without re-targeting animation or rebuilding actions.
  knight: { url: 'models/Knight.glb' },
  barbarian: { url: 'models/Barbarian.glb' },
  mage: { url: 'models/Mage.glb' },
  rogue: { url: 'models/Rogue.glb' },
  // Enemy-only models from the KayKit Skeletons pack. Not surfaced in
  // the player character picker; spawned by `enemy.js` via
  // `spawnCharacter('skel_*', …)`.
  skel_warrior: { url: 'models/Skeleton_Warrior.glb' },
  skel_rogue: { url: 'models/Skeleton_Rogue.glb' },
  skel_mage: { url: 'models/Skeleton_Mage.glb' },
  skel_minion: { url: 'models/Skeleton_Minion.glb' },
};

// Player-pickable characters surfaced in the start-menu picker. All five
// rows are KayKit Adventurers (Rig_Medium) so animation clips are
// identical across them — only the body / cosmetic meshes and the
// built-in weapon set differ.
//
//   `id`           — stable key used in saves / Player opts.
//   `kind`         — MANIFEST key passed into `spawnCharacter()`.
//   `label`        — Russian display name shown in the picker.
//   `skinAware`    — true ⇒ route the body tint through
//                    `_attachSkinAwareTintShader` so the warm-toned
//                    face / hand atlas pixels keep their natural
//                    colour. All Adventurers share the same atlas
//                    with skin pixels in face / hand regions, so the
//                    flag is on for every entry.
//   `defaultWeapon`— starter weapon to pre-select when the user picks
//                    this character.
//   `toggleable`   — built-in weapon / shield / prop child meshes that
//                    must be hidden by default at equip time. Knight
//                    ships swords + four shield variants; Barbarian
//                    ships axes + a Mug + their own shield; Mage ships
//                    wand / staff / spellbook; Rogue / Rogue_Hooded
//                    ship knives + crossbows + a throwable. Hiding
//                    them all first lets `setEquippedWeapon` show only
//                    the subset matching the active weapon.
//   `weaponNodes`  — { weaponKind: string[] } — per-character override
//                    of the showNodes list for a weapon. When present
//                    the WEAPONS profile's `attach` (external GLB) is
//                    skipped and the listed built-in meshes are shown
//                    instead — e.g. Barbarian's `axe_1h` shows the
//                    baked `1H_Axe` mesh rather than attaching the
//                    external `axe_1h.glb` to handslot.r.
//                    Weapons not in this map fall back to the WEAPONS
//                    profile (Knight defaults), so picking a sword on
//                    Mage just attaches nothing visible — they're not
//                    armed for that weapon class.
//
// Asset license: Creative Commons Zero (CC0) — no attribution required.
// Source: https://kaylousberg.itch.io/kaykit-adventurers
// Multiplier applied by `_onPlayerHitsEnemy` to a swing's outgoing damage
// when the equipped weapon matches one of the listed kinds. 1.25 (+25%)
// is the standard "this is your class' weapon" bonus — enough to feel
// the upside on the right pick, not so large that off-class loadouts
// feel punished. Each character covers two related weapon kinds so the
// player isn't forced into a single specific weapon to feel optimal.
const CLASS_AFFINITY = 1.25;

export const CHARACTERS = [
  {
    id: 'knight', kind: 'knight', label: 'Рыцарь',
    skinAware: true, defaultWeapon: 'sword_1h',
    toggleable: [
      '1H_Sword', '2H_Sword', '1H_Sword_Offhand',
      'Round_Shield', 'Rectangle_Shield', 'Spike_Shield', 'Badge_Shield',
    ],
    // Knight uses its baked-in 1H_Sword/2H_Sword meshes for the sword
    // slots; the override forces `setEquippedWeapon` down the built-in
    // path so the donor (Knight’s own sword, extracted at preload
    // time and used as the external mesh for the other Adventurers)
    // isn't double-attached on top of itself.
    weaponNodes: {
      sword_1h: ['1H_Sword', 'Round_Shield'],
      sword_2h: ['2H_Sword'],
    },
    weaponAffinity: { sword_1h: CLASS_AFFINITY, sword_2h: CLASS_AFFINITY },
    // Knight's 1H sword + shield charges into a Block_Attack — a stunning
    // shield bash that also halves incoming damage for the duration of
    // its swing animation, so the player can deliberately tank a hit
    // they see coming. See player.js `_triggerCharSuper`.
    charSuper: {
      sword_1h: { kind: 'shieldBash' },
    },
  },
  {
    id: 'barbarian', kind: 'barbarian', label: 'Варвар',
    skinAware: true, defaultWeapon: 'axe_1h',
    toggleable: [
      '1H_Axe', '2H_Axe', '1H_Axe_Offhand',
      'Mug', 'Barbarian_Round_Shield',
    ],
    weaponNodes: {
      // Barbarian wields two axes when holding the 1H slot — no shield.
      // The off-hand axe is always visible (not just during the dual-
      // wield charge attack); the right-hand main axe drives the normal
      // slice and the left-hand axe joins in for the Dualwield_Slice
      // charge attack.
      axe_1h: ['1H_Axe', '1H_Axe_Offhand'],
      axe_2h: ['2H_Axe'],
    },
    // Dual-wield offhand attachments for weapons the Barbarian doesn't
    // ship a baked offhand mesh for. The primary sword is still attached
    // via the WEAPONS profile's `attach` to handslot.r (Knight donor);
    // this list adds the second sword onto handslot.l so the Barbarian
    // visibly carries one in each hand.
    extraAttach: {
      sword_1h: [{ slot: 'handslotl', cacheKey: 'sword_1h_offhand_donor' }],
    },
    weaponAffinity: { axe_1h: CLASS_AFFINITY, axe_2h: CLASS_AFFINITY, sword_1h: CLASS_AFFINITY },
    // Per-character charge attack overrides. When the player holds the
    // attack button past the charge threshold while wielding the keyed
    // weapon, this kind-handler is invoked instead of the weapon's
    // generic `superAttack`. See player.js `_triggerCharSuper` for the
    // per-kind implementations. The dual-slice spin attack covers all
    // 1H weapons the Barbarian dual-wields.
    charSuper: {
      axe_1h:   { kind: 'dualSlice' },
      sword_1h: { kind: 'dualSlice' },
    },
  },
  {
    id: 'mage', kind: 'mage', label: 'Маг',
    skinAware: true, defaultWeapon: 'staff',
    toggleable: [
      '1H_Wand', '2H_Staff', 'Spellbook', 'Spellbook_open',
    ],
    weaponNodes: {
      staff: ['2H_Staff'],
      wand: ['1H_Wand'],
    },
    weaponAffinity: { staff: CLASS_AFFINITY, wand: CLASS_AFFINITY },
    // Mage's charge attack enchants a melee weapon with the player's
    // currently-slotted ability element so the very next swing carries
    // an elemental on-hit effect (one charge → one empowered swing).
    // Staff and wand are intentionally NOT enchantable — when the Mage
    // wields a caster weapon, holding the attack button falls through
    // to the WEAPONS profile's melee fallback (a strong close-range
    // bonk) instead of binding an enchant.
    charSuper: {
      sword_1h: { kind: 'enchant' },
      sword_2h: { kind: 'enchant' },
      axe_1h:   { kind: 'enchant' },
      axe_2h:   { kind: 'enchant' },
    },
  },
  {
    id: 'rogue', kind: 'rogue', label: 'Разбойник',
    skinAware: true, defaultWeapon: 'wand',
    toggleable: [
      'Knife', 'Knife_Offhand', '1H_Crossbow', '2H_Crossbow', 'Throwable',
    ],
    // Rogue has a knife built into handslot.r — re-use it as the
    // visible mesh for the 1H sword slot so picking sword_1h shows
    // their own dagger instead of the knight donor sword.
    weaponNodes: {
      sword_1h: ['Knife'],
    },
    // Rogue's identity is light/quick weapons — give them the
    // damage bonus on the 1H sword (their dagger) and the wand,
    // both of which sit at the fast end of the cooldown table.
    weaponAffinity: { sword_1h: CLASS_AFFINITY, wand: CLASS_AFFINITY },
    // Knife charge: lunge dash with a stab during the dash (not after) —
    // forced crit, brief i-frames and a small gold steal per hit.
    // Axe_1h reuses the same dash-strike mechanic but tuned for a
    // heavier weapon: longer cooldown so it can't be spammed and a
    // bigger damage multiplier so the commitment pays off. Wand keeps
    // the generic mage-style spell+melee flow from WEAPONS.
    charSuper: {
      sword_1h: { kind: 'dashStrike' },
      axe_1h:   { kind: 'dashStrike', damageMult: 2.4, cooldown: 1.40 },
    },
  },
];

export const CHARACTER_BY_ID = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));

// Resolve a character's damage multiplier for a given weapon kind. Returns
// 1.0 (no bonus) when the character row doesn't list the weapon. Used both
// at runtime by game.js to scale damage and by the start-menu picker to
// surface the bonus in chip tooltips, so the multiplication value lives
// in exactly one place.
export function weaponAffinityFor(charDef, weaponKind) {
  return charDef?.weaponAffinity?.[weaponKind] ?? 1.0;
}

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
  // Player-built structures that use an authored .glb instead of a
  // procedural three.js mesh built in `structure.js`. The `wall_`
  // prefix is what the prop loader keys off to force the source
  // material onto the natural-rock toon palette regardless of how
  // the DCC tool named it (the wall.glb shipped with a default white
  // MeshStandardMaterial; without the recolour pass it'd render
  // bright white).
  wall_basic: { url: 'models/structures/wall.glb' },
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
  attack_2h_spinning: '2H_Melee_Attack_Spinning',  // 0.67s clean continuous rotation
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
  // Per-character charge attack clips (see CHARACTERS.charSuper):
  attack_block:       'Block_Attack',         // Knight shield bash
  attack_block_hit:   'Block_Hit',            // (reserved for later: hit while blocking)
  attack_blocking:    'Blocking',             // (reserved for later: held block stance)
  attack_spell_raise: 'Spellcast_Raise',      // Mage weapon enchant
  dodge_forward:      'Dodge_Forward',        // Rogue dash strike body motion
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

// Slots that should be exempt from the upper-body filter — their clips
// drive the *whole body* (e.g. a spinning attack rotates the whole rig
// from the root, not just the arms; filtering it to upper-body strips
// out the actual rotation and leaves a static pose).
const FULL_BODY_SLOTS = new Set([
  'attack_2h_spinning',
  // Rogue's dash strike — the dodge clip drives the legs forward as
  // the actual lunge motion, so filtering it to upper-body would strip
  // the dash itself out and the character would just stand still and
  // stab.
  'dodge_forward',
]);

// Per-slot clip trimming ratios. KayKit's `2H_Melee_Attack_Spin` is a 2.4s
// clip that has a wide ~270° arc, but the last ~35% of the clip is a recovery
// pose that visually reads as "second wind-up" right after the strike — it
// looks like the character is about to swing again. Trim the tail off so the
// clip ends right after the follow-through. `start` and `end` are normalised
// positions (0..1) within the source clip.
const SLOT_TRIM = {
  attack_2h_spin: { start: 0.00, end: 0.65 },
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
        // Pre-classify the body atlas's skin pixels once per character
        // kind. Cheap (<100ms even on 1024×1024 atlases) and the mask
        // is then shared by every clone — see _attachSkinAwareTintShader.
        const skinMask = _findAndBuildSkinMask(gltf.scene);
        cache[key] = {
          scene: gltf.scene,
          animations: gltf.animations || [],
          skinMask,
        };
        // The Knight ships with the only sword/shield meshes in the
        // pack — stash a toon-shaded clone of each blade so the other
        // Adventurers can wear them when the player picks sword_1h /
        // sword_2h. (Round_Shield isn't donated for now: handslot.l
        // attachment isn't wired and a one-handed loadout without a
        // shield reads fine on Mage/Barbarian/Rogue.)
        if (key === 'knight') {
          _stashKnightSwordDonors(gltf.scene);
        }
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
        // identifier starts with "rock" gets forced to a gray rock palette,
        // and any prop starting with "wall" gets the same stone palette so
        // a player-built wall reads as the same material as the boulders
        // they mined the stone from regardless of what the DCC source
        // material was called.
        const isRockProp = key.startsWith('rock');
        const isWallProp = key.startsWith('wall');
        gltf.scene.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            const replaced = mats.map((m) => {
              if (!m) return m;
              let color;
              if (isRockProp || isWallProp) {
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
    // KayKit Adventurers split head-cover meshes between several
    // names: Knight uses `Knight_Helmet`, Barbarian / Mage use
    // `Hat`, Rogue_Hooded uses `Rogue_Head_Hooded`. Treat them all
    // the same (atlas-mix shader so the picked tint dominates while
    // a hint of atlas detail still reads).
    if (name.includes('Helmet') || name.endsWith('_Hat') || name.includes('_Hooded')) return 'helmet';
    if (name.includes('Sword') || name.includes('Shield')) return 'weapon';
    // Catch *any* mesh parented under a hand-slot bone — the built-in
    // sword/shield meshes are caught by the names above, but external
    // attached weapons (axe_1h, axe_2h, staff, wand …) come from
    // separate GLBs and use their own arbitrary mesh names. Their one
    // common ancestor after `setEquippedWeapon` adds them is the
    // `handslotr` / `handslot.r` bone, so any mesh whose parent chain
    // walks through that bone is treated as a weapon and skipped by
    // the tinter. Three.js's PropertyBinding strips dots, so the
    // sanitised name on cloned skeletons is `handslotr`; the original
    // unsanitised `handslot.r` shows up on first-load before cloning.
    if (name.toLowerCase().includes('handslot')) return 'weapon';
    cur = cur.parent;
  }
  return 'body';
}

// -- Skin-mask precomputation -------------------------------------------------
//
// KayKit ships every character as a single skinned mesh sharing one atlas
// texture, where face/hands "skin" pixels sit alongside armour and cloth
// pixels. The simplest tinting approach (multiply `material.color` by the
// atlas) ends up colouring the skin too — pick "cyan" and the face goes
// teal — which is exactly the issue the user reported.
//
// To suppress tinting on skin pixels without splitting the geometry, we
// pre-classify every atlas pixel as skin / non-skin once at preload time
// and bake the result into a same-size single-channel "skin mask"
// DataTexture. That texture is later sampled inside a custom fragment
// shader (see `_attachSkinAwareTintShader`) which only multiplies the
// user's tint into non-skin pixels — skin always reads through at its
// natural atlas colour.
function _isSkinPixel(r, g, b) {
  // Heuristic tuned against KayKit's tan / orange-pink skin ramps:
  //   r > g + 12, r > b + 25, g > b + 2  → red dominates (warm tone)
  //   80 ≤ r ≤ 250                       → not pitch-black, not pure white
  // Hits ranges like (178, 112, 82), (155, 90, 69), (248, 203, 171) without
  // catching cool-toned cloth or weathered wood props that share the atlas.
  return r >= 80 && r <= 250
    && r > g + 12
    && r > b + 25
    && g > b + 2;
}
function _buildSkinMaskFromImage(image) {
  if (!image || !image.width || !image.height) return null;
  const w = image.width;
  const h = image.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // Cross-origin image — `getImageData` will throw a SecurityError. We
    // serve the atlases from the same origin so this shouldn't happen,
    // but bail gracefully to "no mask = legacy uniform tinting" if it
    // ever does.
    return null;
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    if (_isSkinPixel(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2])) {
      mask[i] = 255;
    }
  }
  const tex = new THREE.DataTexture(mask, w, h, THREE.RedFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // GLTF textures use V-up sampling (flipY=false). The canvas drawImage
  // result above is already in canvas-orientation (V-down), which matches
  // what `texture2D(map, vMapUv)` returns for GLTF maps — both samplers
  // see the same pixel for the same UV.
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// Find the body mesh's diffuse map on a GLB scene and convert it into a
// skin mask texture. Called once per character kind, then the same shared
// mask is reused by every clone of that character.
function _findAndBuildSkinMask(scene) {
  let bodyTexture = null;
  scene.traverse((obj) => {
    if (bodyTexture || !obj.isMesh) return;
    if (classifyMeshRole(obj) !== 'body') return;
    const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (m && m.map && m.map.image) bodyTexture = m.map;
  });
  if (!bodyTexture) return null;
  return _buildSkinMaskFromImage(bodyTexture.image);
}

// Fraction (0..1) of the atlas's contribution to the final tinted body /
// helmet colour. 0.0 = pure tint (flat, melts into adjacent pieces),
// 1.0 = legacy `tint × atlas` (steel-grey atlas muddies user colours).
// 0.35 keeps the picked colour dominant while leaving enough atlas
// shadow/detail to read as a distinct armoured piece. Body and helmet
// have separate constants so they can be retuned independently if one
// reads heavier than the other under the toon gradient.
const BODY_ATLAS_MIX = 0.35;
const HELMET_ATLAS_MIX = 0.35;

// Inject a fragment shader hook into a MeshToonMaterial so that the
// body splits cleanly into two regions:
//   - skin pixels (face, hands) → keep the natural atlas RGB
//   - everything else (armour, cloth, etc) → tint × (1 - mix) + tint × atlas × mix,
//     i.e. mostly the user-picked tint with a small atlas modulation
//     contributing shadow/detail. A pure-tint path here made the
//     armour read as flat plastic; full `tint × atlas` muddied it.
// Toon gradient still applies on top, so cel-shaded lit/shadow bands
// come through unchanged.
function _attachSkinAwareTintShader(material, skinMaskTex) {
  if (!material || !skinMaskTex) return;
  const mix = BODY_ATLAS_MIX.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.skinMaskTexture = { value: skinMaskTex };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform sampler2D skinMaskTexture;\nvoid main() {',
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        // \`diffuseColor.rgb\` enters this chunk equal to uniform
        // "diffuse" = material.color (the user-picked tint).
        //   armourColor: tint scaled by mix(1, atlas, BODY_ATLAS_MIX)
        //                — picked colour dominates, atlas adds detail.
        //   skinColor:   the natural atlas RGB, no tint multiplication
        //                so face / hands stay at their warm-toned source.
        vec3 armourColor = diffuseColor.rgb * mix(vec3(1.0), sampledDiffuseColor.rgb, ${mix});
        float skinAmount = texture2D( skinMaskTexture, vMapUv ).r;
        diffuseColor.rgb = mix( armourColor, sampledDiffuseColor.rgb, skinAmount );
        diffuseColor.a *= sampledDiffuseColor.a;
        #endif`,
      );
  };
  // Share one compiled program across every clone — same uniforms layout,
  // only `material.color` and the per-instance mask binding differ. Bump
  // the cache key when the shader logic itself changes so cached programs
  // from previous sessions don't leak in.
  material.customProgramCacheKey = () => `tinted-skin-aware-v3-${mix}`;
  material.needsUpdate = true;
}

// Inject a fragment shader hook into a MeshToonMaterial so the helmet
// keeps its atlas detail but only at `HELMET_ATLAS_MIX` strength. The
// final per-pixel colour (before toon banding) becomes:
//
//     diffuseColor.rgb = material.color.rgb
//                      * mix(vec3(1.0), atlasSample.rgb, HELMET_ATLAS_MIX)
//
// so a typical mid-grey atlas pixel (~0.5) only darkens the picked tint
// by ~12.5% rather than halving it.
function _attachHelmetAtlasMixShader(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const m of material) _attachHelmetAtlasMixShader(m);
    return;
  }
  const mix = HELMET_ATLAS_MIX.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        diffuseColor.rgb *= mix(vec3(1.0), sampledDiffuseColor.rgb, ${mix});
        diffuseColor.a *= sampledDiffuseColor.a;
      #endif`,
    );
  };
  // Every helmet shares the same shader logic + atlas, so they can share
  // a compiled program; only `material.color` differs per instance.
  material.customProgramCacheKey = () => `helmet-atlas-mix-${mix}`;
  material.needsUpdate = true;
}

export function spawnCharacter(kind, {
  tint = null,
  capeTint = null,
  scale = 1,
  hueShift = 0,
  skinAware = false,
  characterDef = null,
} = {}) {
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
        // Cape gets a flat tint with no atlas multiplication: drop the
        // shared map so `material.color` shows clean (white = white cape,
        // crimson = crimson cape). The KayKit cape region of the atlas
        // ships in a saturated red that would otherwise muddy every
        // user-picked colour. Toon shading via the gradient map still
        // gives the cape its cel-shaded lit/shadow bands.
        _stripMapForFlatColor(obj.material);
        const capeHex = (capeTint !== null) ? capeTint : tint;
        if (capeHex !== null) {
          _tmpColor.setHex(capeHex);
          applyTint(obj.material, _tmpColor);
        } else if (hueShift !== 0) {
          applyHueShift(obj.material, hueShift);
        }
      } else if (role === 'helmet') {
        // Helmet shares the atlas with the body. Two extremes both
        // looked wrong:
        //   - Default `tint × atlas`  → atlas's darkened steel-grey
        //     pixels muddied every user-picked colour (white→grey,
        //     red→maroon).
        //   - Pure tint (atlas dropped) → helmet became flat and
        //     visually melted into the body, losing the contrast
        //     and texture the atlas detailing provided.
        // Compromise: keep the atlas but scale its contribution down
        // to ~25%, so the user-picked colour stays clean while the
        // atlas still contributes a touch of shadow/contrast detail.
        // Toon shading via the gradient map still applies on top.
        _attachHelmetAtlasMixShader(obj.material);
        if (tint !== null) {
          _tmpColor.setHex(tint);
          applyTint(obj.material, _tmpColor);
        } else if (hueShift !== 0) {
          applyHueShift(obj.material, hueShift);
        }
      } else if (role === 'body') {
        // Body keeps the atlas (so face / armour detail stays) but
        // when `skinAware` is requested it routes tint through a
        // shader hook so the face and hands aren't recoloured along
        // with the clothing. Only enabled for the player Knight —
        // enemy atlases (skeletons etc.) ship with warm-toned bones
        // the heuristic would mis-classify, so we leave their
        // tinting on the simple uniform path.
        if (skinAware && entry.skinMask) {
          _attachSkinAwareTintShader(obj.material, entry.skinMask);
        }
        if (tint !== null) {
          _tmpColor.setHex(tint);
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
    const isUpperOnly = UPPER_BODY_SLOT_PREFIXES.some(p => slot.startsWith(p))
      && !FULL_BODY_SLOTS.has(slot);
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
    'attack_2h_chop', 'attack_2h_slice', 'attack_2h_spin', 'attack_2h_spinning', 'attack_2h_stab',
    'attack_dual_chop', 'attack_dual_slice', 'attack_dual_stab',
    'attack_ranged', 'attack_spell', 'attack_spell_long', 'attack_throw',
    'attack_unarmed', 'attack_melee', 'attack_melee_heavy',
    // Per-character charge attacks — these all fire once per press and
    // need to clamp on the followthrough pose, otherwise LoopRepeat
    // would re-trigger the windup mid-swing.
    'attack_block', 'attack_block_hit', 'attack_blocking',
    'attack_spell_raise', 'dodge_forward',
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

  // `def` is consumed by `setEquippedWeapon` to know which built-in
  // child meshes to toggle and which weapons should swap to a baked
  // mesh instead of attaching an external GLB. Enemies (skel_*) leave
  // it null — they fall back to the legacy Knight toggleable list,
  // which is harmless on skeleton GLBs that don't contain those node
  // names anyway.
  return { root, mixer, actions, def: characterDef };
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

// Drop the diffuse map so `material.color` shows directly without being
// multiplied by atlas pixels — used for cape tinting where the source
// atlas region ships with a saturated colour that muddies every user-
// picked tint.
function _stripMapForFlatColor(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const m of material) _stripMapForFlatColor(m);
    return;
  }
  if (material.map !== null) {
    material.map = null;
    material.needsUpdate = true;
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
  //
  // `attach: 'sword_1h_donor'` makes non-Knight Adventurers (whose
  // bodies don't ship with a `1H_Sword` mesh) attach a clone of the
  // Knight's own sword to handslot.r when this slot is picked. Knight
  // itself opts out of the donor via its per-character `weaponNodes`
  // override (toggling the built-in mesh wins), so the donor never
  // double-stacks for Knight.
  sword_1h: {
    label: 'Sword',
    showNodes: ['1H_Sword', 'Round_Shield'],
    attach: 'sword_1h_donor',
    attackAnim: 'attack_1h_horiz',  // 1H horizontal slice (~1.0s baked)
    swing: 0.85,
    impactAt: 0.50,
    range: 2.3,
    arc: Math.PI * 0.85,   // ~153° — wide horizontal sweep
    cooldown: 0.55,
    damageMult: 1.0,
    slash: { color: 0xdfeaff, height: 1.05 },
  },
  // Heavy two-hander — wide horizontal sweep on tap. Holding the attack
  // button charges a 360° spin super (see `superAttack` below) that uses a
  // different clip + AOE collider + ring VFX.
  sword_2h: {
    label: 'Greatsword',
    showNodes: ['2H_Sword'],
    attach: 'sword_2h_donor',
    attackAnim: 'attack_2h_slice',  // 2H horizontal sweep (~1.1s baked)
    swing: 1.00,
    impactAt: 0.55,
    range: 2.7,
    arc: Math.PI * 0.95,   // ~171° — sweeps almost shoulder to shoulder
    cooldown: 0.75,
    damageMult: 1.6,
    slash: { color: 0xc8d6ff, height: 1.10 },
    // Charge attack — hold attack button to wind up a 360° spin sweep that
    // hits everything around the player. Uses the dedicated continuous
    // rotation clip (no anticipation or recovery), a much wider damage
    // arc, and a longer cooldown so it can't be spammed.
    superAttack: {
      attackAnim: 'attack_2h_spinning',
      swing: 0.65,
      impactAt: 0.50,
      range: 3.2,            // slightly longer reach than tap
      arc: Math.PI * 2,      // full circle
      cooldown: 1.30,        // ~1.7× the tap cooldown
      damageMult: 2.4,       // 1.5× the tap (1.6×) damage
      ringColor: 0xc8d6ff,
    },
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
  // 2H battle axe — wide horizontal sweep on tap. Same charge-to-spin
  // super as the great-sword but heavier numbers since the axe head is
  // weightier (slower swing, higher damage, longer cooldown).
  axe_2h: {
    label: 'Battle Axe',
    showNodes: [],
    attach: 'axe_2h',
    attackAnim: 'attack_2h_slice',  // 2H horizontal sweep
    swing: 1.10,
    impactAt: 0.55,
    range: 2.7,
    arc: Math.PI * 0.95,   // ~171°
    cooldown: 0.85,
    damageMult: 1.8,
    slash: { color: 0xffae6a, height: 1.05 },
    superAttack: {
      attackAnim: 'attack_2h_spinning',
      swing: 0.75,
      impactAt: 0.50,
      range: 3.2,
      arc: Math.PI * 2,
      cooldown: 1.50,
      damageMult: 2.7,
      ringColor: 0xffae6a,
    },
  },
  // Staff — Mage's signature 2H weapon. Tap fires a small auto-aimed
  // spell bolt in the player's cape colour (the `rangedAttack` profile
  // below). Long-press past `CHARGE_THRESHOLD` (see player.js) falls
  // through to the melee horizontal sweep defined here, so close-range
  // brawls still work without swapping weapons.
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
    // Tap-fire spell bolt — homes in on the closest real enemy within
    // 12m (auto-aim mirrors the icebolt ability) and travels until it
    // either lands, expires or hits a wall. Smaller hitbox / smaller
    // visual than icebolt by design (staff is a basic attack, not an
    // ability). Damage flows through the same per-hit pipeline the
    // melee swing uses, so onAttack/onHit items (crit, echo, leech,
    // berserk, …) still apply at the moment of impact.
    rangedAttack: {
      attackAnim: 'attack_spell',
      swing: 0.55,
      cooldown: 0.55,
      speed: 18,
      life: 0.65,            // ~11.7m max range
      radius: 0.18,          // smaller than icebolt's 0.25
      damageMult: 1.0,
      knockback: 4,
    },
  },
  // Wand — Mage / Rogue's spell-jab one-hander. Tap fires a fast, tiny
  // spell bolt in the player's cape colour. Long-press triggers the
  // forward jab profile below — same melee feel the wand had before
  // the ranged attack was added.
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
    rangedAttack: {
      attackAnim: 'attack_spell',
      swing: 0.45,
      cooldown: 0.42,
      speed: 22,
      life: 0.55,            // ~12.1m max range
      radius: 0.14,          // smallest projectile in the game
      damageMult: 0.75,
      knockback: 3,
    },
  },
};

// All weapon meshes that need to be toggled or attached. Hiding everything in
// this list first lets us pick exactly which subset to show without having to
// know what the previous loadout was.
const KNIGHT_TOGGLEABLE_NODES = [
  '1H_Sword', '2H_Sword', '1H_Sword_Offhand',
  'Round_Shield', 'Rectangle_Shield', 'Spike_Shield', 'Badge_Shield',
];

// Pulled from Knight.glb at preload time and stashed under these keys in
// `weaponCache` so the WEAPONS sword_1h / sword_2h profiles can attach
// the Knight's sword mesh to non-Knight Adventurers as an external
// donor. Kept as a constant so a typo here would break loudly instead of
// silently dropping the donor at runtime.
const SWORD_DONOR_KEYS = {
  '1H_Sword': 'sword_1h_donor',
  '2H_Sword': 'sword_2h_donor',
  // Knight's left-hand sword mesh, donated to Barbarian when he
  // dual-wields a 1H sword (handslot.l side).
  '1H_Sword_Offhand': 'sword_1h_offhand_donor',
};

// Pull standalone weapon donors out of the Knight scene so non-Knight
// Adventurers can attach the same blade meshes when picking sword_1h /
// sword_2h. Both built-in nodes are authored in handslot.r local space,
// so re-parenting the clone to a different character's handslot.r
// preserves the in-hand position/rotation perfectly — the
// `inst.position.set(0, 0.033, 0); inst.quaternion.set(0, -1, 0, 0)`
// reset that setEquippedWeapon applies to external attaches happens to
// match the values that were already baked into these donor nodes, so
// the donor path produces the exact same pose Knight has natively.
function _stashKnightSwordDonors(scene) {
  for (const [nodeName, cacheKey] of Object.entries(SWORD_DONOR_KEYS)) {
    const node = scene.getObjectByName(nodeName);
    if (!node) {
      console.warn('[models] Knight donor weapon mesh missing:', nodeName);
      continue;
    }
    const donor = node.clone(true);
    donor.visible = true;
    donor.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        const replaced = mats.map((m) => m ? toToonMaterial(m) : m);
        obj.material = Array.isArray(obj.material) ? replaced : replaced[0];
      }
    });
    weaponCache[cacheKey] = donor;
  }
}

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

  // Per-character override: characters from the start-menu picker carry
  // a `CHARACTERS` entry whose `toggleable` list names every built-in
  // weapon / shield mesh on that body, and whose `weaponNodes` map
  // overrides the default WEAPONS profile when the character has its
  // own baked-in mesh for that weapon class (Barbarian's `1H_Axe`,
  // Mage's `2H_Staff`, etc.). If `def` is missing (legacy callers —
  // enemies, etc.) fall back to the Knight defaults.
  const def = character.def || null;
  const toggleable = (def && def.toggleable) || KNIGHT_TOGGLEABLE_NODES;
  const builtinNodes = (def && def.weaponNodes && def.weaponNodes[weaponKind]) || null;
  const useBuiltin = !!builtinNodes;

  // 1) Toggle the built-in mesh nodes — hide everything first, then show
  //    only the ones requested by the weapon profile (or the per-char
  //    override, when the character ships its own baked weapon mesh).
  const showList = useBuiltin ? builtinNodes : (profile.showNodes || []);
  const showSet = new Set(showList);
  root.traverse((obj) => {
    if (toggleable.includes(obj.name)) {
      obj.visible = showSet.has(obj.name);
    }
  });

  // 2) Remove any previously-attached external mesh.
  if (character._equippedAttachment) {
    character._equippedAttachment.parent?.remove(character._equippedAttachment);
    character._equippedAttachment = null;
  }

  // 3) Attach the new external mesh to handslot.r if requested.
  //    Skipped when the character has a per-character override that
  //    activates a built-in mesh instead — we don't want to stack the
  //    external axe on top of the built-in axe.
  //
  // Three.js's GLTFLoader pipes node names through
  // `PropertyBinding.sanitizeNodeName`, which *strips* reserved characters
  // (`[`, `]`, `.`, `:`, `/`) instead of replacing them. So the bone the
  // KayKit GLB calls `handslot.r` ends up named `handslotr` on the cloned
  // skeleton. Keep both spellings as fallbacks so the helper works whether
  // a future three.js version re-introduces the dot or not.
  if (profile.attach && !useBuiltin) {
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

  // 4) Per-character extra attachments — used by characters that
  //    dual-wield a weapon they don't have baked-in offhand meshes
  //    for (e.g. Barbarian wielding sword_1h gets a Knight donor sword
  //    in both hands, with the offhand donor going to handslot.l).
  if (character._equippedExtras) {
    for (const inst of character._equippedExtras) inst.parent?.remove(inst);
    character._equippedExtras = null;
  }
  const extras = (def && def.extraAttach && def.extraAttach[weaponKind]) || null;
  if (extras && Array.isArray(extras)) {
    const list = [];
    for (const ext of extras) {
      const src = weaponCache[ext.cacheKey];
      if (!src) {
        console.warn('[models] extra attach mesh not loaded:', ext.cacheKey);
        continue;
      }
      const slotCandidates = [ext.slot, ext.slot.replace('.', ''), ext.slot.replace('.', '_')];
      let extSlot = null;
      for (const n of slotCandidates) {
        extSlot = root.getObjectByName(n);
        if (extSlot) break;
      }
      if (!extSlot) {
        console.warn('[models] extra attach slot not found:', ext.slot);
        continue;
      }
      const inst = src.clone(true);
      // Donor's local transform was authored in its source bone slot's
      // local space (handslot.l for the offhand sword), so re-parenting
      // to the same slot type on another Adventurer preserves the in-
      // hand pose without needing the position/quaternion overrides the
      // main `attach` branch applies for external GLBs.
      extSlot.add(inst);
      list.push(inst);
    }
    character._equippedExtras = list;
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
//
// `setEffectiveWeight(1)` is mandatory before the fadeIn: any prior code path
// (including the enemy pool's `_resetVisualState`, which zeroes every action's
// weight to give the next acquire a clean baseline) may have left `weight` at
// 0. Three.js evaluates `_effectiveWeight = weight * fadeInterpolant`, so
// without forcing weight back to 1 here, the target action would fade in to
// `0 * 1 = 0` and never contribute. Once the previous locomotion action
// completes its fadeOut and disables itself, the bone bindings would have
// total weight 0 → PropertyMixer falls back to bind pose → enemies render in
// T-pose while still walking/running.
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
  next.reset().setEffectiveWeight(1.0);
  if (didFade) next.fadeIn(duration);
  next.play();
  return next;
}
