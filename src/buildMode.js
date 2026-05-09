// Per-player build-mode controller. Owns a ghost preview mesh, a recipe
// pointer (index into RECIPE_ORDER), a target yaw, and the per-frame logic
// that snaps the cursor to a 1m grid in front of the player and either
// places the recipe (consume from world.resources, call world.placeStructure)
// or cancels.
//
// Each Game.Player gets one of these on demand; the controller is created
// lazily the first time the player presses a build-select key. While
// active, it suppresses the player's normal attack/dash so the swing
// doesn't fire mid-build, and intercepts the same input edges to drive
// place / rotate / cancel.
//
// Exit conditions:
//   - player presses dash (cancel)
//   - player presses the same recipe key while already on it (toggle off)
//   - player dies
//   - player walks too far (currently no leash)

import { RECIPES, RECIPE_ORDER, canAfford, spendCost, makeGhostMesh } from './structure.js';

// Initial distance from the player at which the ghost preview spawns when
// the player first enters build mode. After that the cursor is freely
// driven by WASD/stick (player movement is muted while build is active),
// so this value only matters as a non-zero starting offset.
const CURSOR_INIT_DISTANCE = 1.5;

// Max chebyshev distance (tiles) from the player at which the ghost can
// roam. Sized so the player can comfortably wall off a 9x9 area around
// themselves without leaving build mode, but small enough that they
// can't sneak a wall into a chunk they're not standing in.
const MAX_REACH_TILES = 4;

// Speed (m/s) at which holding WASD / pushing the stick advances the
// floating cursor offset. Matches the player's base walk speed (6 m/s)
// so the cursor's tile-to-tile rhythm reads as familiar.
const CURSOR_MOVE_SPEED = 6.0;

// Vertical step (m) between two stacked stone walls. The wall mesh is a
// 1.05 m × ~0.95 sy ≈ 1.0 m tall block sitting flush on the ground, so
// stacking by exactly 1.0 m lands the upper block's base on the lower
// block's top with no visible gap. (`RECIPES.wall.height` reads 1.6 m
// because that's the *gameplay* height used for vision/collider sizing
// elsewhere; the visible mesh is shorter.)
const WALL_STACK_STEP = 1.0;

// Manual vertical layer (m) the player drives via Shift / Ctrl while in
// build mode. STEP_Y matches WALL_STACK_STEP so a layer-1 ghost lands
// flush on top of a layer-0 wall. MAX_LAYER caps the cursor at 8
// storeys — high enough that the procedural roof apex (which grows
// max(w,d)/2 above the corner y) clears any reasonable building, while
// still keeping a finite ceiling so the top-down camera doesn't have
// to chase a runaway ghost off-screen.
const STEP_Y = 1.0;
const MAX_LAYER = 8;

// Yaw step when the player presses interact. 90° matches a 1m grid wall
// orientation (axis-aligned looks tidy; finer angles risk visible
// collider-vs-mesh mismatches).
const YAW_STEP = Math.PI / 2;

// Minimum spacing between two structures' centres so the placement check
// doesn't allow stacking. The 1m grid snap already keeps placements at
// >=1.0m apart for the cardinal-neighbour case (or sqrt(2) for diagonals),
// so this is the deepest *overlap* we forbid — basically just "no two
// structures on the exact same tile". A small slack is left to absorb
// float drift from the round() in _computeCursor.
const MIN_STRUCT_SPACING = 0.55;

export class BuildController {
  constructor(scene, world, player) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.active = false;
    this.recipeIdx = 0;            // index into RECIPE_ORDER
    this.yaw = 0;
    // Cached cursor position so the HUD readout and the place check use
    // the same value the ghost was last drawn at.
    this.cursor = { x: 0, z: 0, y: 0 };
    // Floating offset (m) from the player at which the cursor currently
    // sits. WASD / stick advances this each tick; the snapped
    // `this.cursor` is recomputed from `player.pos + cursorOffset` so
    // the cursor stays anchored relative to the (frozen, while building)
    // player. Re-initialised each time build mode is freshly entered.
    this.cursorOffset = { x: 0, z: 0 };
    this.ghost = null;
    this.ghostKind = null;
    this.ghostAffordable = true;
    // Cooldown so a single attack-press doesn't both place a structure and
    // immediately drop a second one on the same frame's cursor (rare, but
    // possible on high-DPI inputs that emit repeated edge events).
    this._placeCooldown = 0;
    // Manual vertical layer (0..MAX_LAYER). Player nudges this with Shift
    // (up) / Ctrl (down) while in build mode so they can drop a wall on
    // top of an existing one or skip a row when building stairs.
    this.cursorLayer = 0;
  }

  // Enter build mode (or switch recipe if already active). Public entry
  // for the game-side input router.
  selectRecipe(idx) {
    const clamped = Math.max(0, Math.min(RECIPE_ORDER.length - 1, idx | 0));
    if (this.active && this.recipeIdx === clamped) {
      // Same key pressed again — toggle off.
      this.exit();
      return;
    }
    const wasActive = this.active;
    this.active = true;
    this.recipeIdx = clamped;
    // First-time activation: seed the cursor one tile ahead of the player
    // in their current facing so the ghost spawns somewhere visible
    // instead of right under the player's feet. Switching recipe while
    // already active keeps the cursor where the player parked it.
    if (!wasActive) {
      const f = this.player.facing || { x: 0, z: -1 };
      const fl = Math.hypot(f.x, f.z) || 1;
      this.cursorOffset.x = (f.x / fl) * CURSOR_INIT_DISTANCE;
      this.cursorOffset.z = (f.z / fl) * CURSOR_INIT_DISTANCE;
    }
    this._rebuildGhost();
  }

  exit() {
    this.active = false;
    this._destroyGhost();
  }

  _destroyGhost() {
    if (!this.ghost) return;
    if (this.ghost.parent) this.ghost.parent.remove(this.ghost);
    this.ghost.traverse((c) => {
      if (c.isMesh && c.material) c.material.dispose?.();
    });
    this.ghost = null;
    this.ghostKind = null;
  }

  _rebuildGhost() {
    const kind = RECIPE_ORDER[this.recipeIdx];
    if (this.ghost && this.ghostKind === kind) return;
    this._destroyGhost();
    this.ghost = makeGhostMesh(kind, true);
    this.ghostKind = kind;
    this.scene.add(this.ghost);
  }

  // Recolour the ghost between green (affordable, free spot) and red
  // (blocked or can't afford). Cheaper than rebuilding the geometry.
  _setGhostAffordable(yes) {
    if (this.ghostAffordable === yes || !this.ghost) return;
    this.ghostAffordable = yes;
    const tint = yes ? 0x6cf28a : 0xff5b5b;
    this.ghost.traverse((c) => {
      if (c.isMesh && c.material && 'color' in c.material) {
        c.material.color.setHex(tint);
      }
    });
  }

  currentRecipe() {
    return RECIPE_ORDER[this.recipeIdx];
  }

  // Advance the floating cursor offset by `(dx, dz) * dt * speed`, clamp
  // it to the per-axis reach limit, then snap the world target to the
  // integer 1m grid. The clamp uses chebyshev (per-axis abs) so a
  // straight WASD push and a diagonal push reach the same row/col limit.
  _computeCursor(dt, dx, dz) {
    if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
      const len = Math.hypot(dx, dz) || 1;
      const step = CURSOR_MOVE_SPEED * dt;
      this.cursorOffset.x += (dx / len) * step;
      this.cursorOffset.z += (dz / len) * step;
    }
    // Clamp the floating offset to a square reach window. Doing this on
    // the float (not the snapped grid) keeps the offset stable when the
    // player switches direction at the edge — otherwise the cursor would
    // "stick" one tile inside the limit because the grid round'd in.
    const lim = MAX_REACH_TILES;
    if (this.cursorOffset.x > lim) this.cursorOffset.x = lim;
    else if (this.cursorOffset.x < -lim) this.cursorOffset.x = -lim;
    if (this.cursorOffset.z > lim) this.cursorOffset.z = lim;
    else if (this.cursorOffset.z < -lim) this.cursorOffset.z = -lim;
    this.cursor.x = Math.round(this.player.pos.x + this.cursorOffset.x);
    this.cursor.z = Math.round(this.player.pos.z + this.cursorOffset.z);
    return this.cursor;
  }

  // True if (x,z) is free of other player-placed structures (avoid stacking
  // / z-fighting) AND of natural world colliders (avoid burying a wall
  // inside a tree). The two cases use different spacing rules:
  //   - structure-vs-structure: only reject *exact same tile* (overlap).
  //     The grid snap to 1m already separates adjacent placements, so any
  //     check tighter than ~0.6m is the right "no stacking" gate.
  //   - structure-vs-natural: keep a generous buffer (recipe radius +
  //     terrain radius + tolerance) so the player can't place a wall on
  //     top of / inside a tree trunk.
  // We also walk the centre tile's eight 1m neighbours' `placedStructures`
  // entries so a build at a chunk seam isn't blind to a neighbouring
  // chunk's already-placed structures.
  _spotFree(x, z, y = 0, kind = null) {
    const eps2 = MIN_STRUCT_SPACING * MIN_STRUCT_SPACING;
    const placingFloor = (kind === 'floor_wood');
    const ck0 = this.world.chunkKeyOf(x, z);
    // Floor-span of the placement, in integer floor indices. Most
    // recipes occupy one floor; door_full is two-blocks tall so it
    // reserves both its base floor and the floor directly above.
    const placeBase = Math.round((y || 0) / STEP_Y);
    const placeTop = placeBase + ((kind === 'door_full') ? 1 : 0);
    // Collect placed-structure descriptors from the centre + 4 cardinal
    // neighbours so a wall on the chunk seam is also seen.
    const seamOffsets = [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    for (const [ox, oz] of seamOffsets) {
      const ck = this.world.chunkKeyOf(x + ox, z + oz);
      if (ck === ck0 && (ox !== 0 || oz !== 0)) continue;
      const arr = this.world.placedStructures.get(ck);
      if (!arr) continue;
      for (const d of arr) {
        const dx = d.x - x, dz = d.z - z;
        if (dx * dx + dz * dz >= eps2) continue;
        const dBase = Math.round((d.y || 0) / STEP_Y);
        const dTop = dBase + ((d.kind === 'door_full') ? 1 : 0);
        // Reject only if the two floor-spans overlap. door_full at
        // floor 0 occupies [0,1], so a Shift-placed wall trying to
        // claim floor 1 in the same cell is rejected here even
        // though descriptor.y == 0.
        if (placeTop < dBase || placeBase > dTop) continue;
        // Two floors on the same tile + same y would z-fight and waste
        // resources, so reject that even though either side alone is
        // a "floor".
        const otherIsFloor = (d.kind === 'floor_wood');
        if (placingFloor && otherIsFloor) return false;
        // A wood floor is a thin walkable tile — players can drop walls
        // on top of it, and they can drop a floor under any existing
        // non-floor structure. So allow same-tile coexistence when
        // exactly one side of the conflict is a floor.
        if (otherIsFloor || placingFloor) continue;
        return false;
      }
    }
    // Natural world colliders only — anything tagged `placed: true` was
    // pushed by a structure and is already covered by the loop above.
    // For elevated layers (y > 0) we skip this check entirely: trees and
    // rocks live on the ground and don't reach 1m+ up, so a 2nd-storey
    // wall placed "inside" a tree's canopy is fine. The +0.55 buffer
    // here is sized for tree/rock radii so a ground wall doesn't overlap
    // a trunk; structures don't need that buffer because we *want* them
    // flush on adjacent grid cells.
    if (y >= 0.5) return true;
    const cols = this.world.colliders;
    if (cols && cols.length) {
      for (const c of cols) {
        if (c.placed) continue;
        const dx = c.x - x, dz = c.z - z;
        const r = (c.r || 0.5) + 0.55;
        if (dx * dx + dz * dz < r * r) return false;
      }
    }
    return true;
  }

  // Per-frame update. Reads `intent` (already-extracted edge events from
  // game.js) so the build mode and the player swing don't double-consume.
  // Returns true if intent was consumed (placement / cancel / rotate);
  // game.js then suppresses the swing-attack path for this player this tick.
  update(dt, intent) {
    if (this._placeCooldown > 0) this._placeCooldown -= dt;
    if (!this.active || !this.player.alive) {
      if (this.active) this.exit();
      return false;
    }
    // Cancel — dash press exits build without placing.
    if (intent.dash) {
      this.exit();
      return true;
    }
    // Rotate ghost on interact.
    if (intent.interact) {
      this.yaw = (this.yaw + YAW_STEP) % (Math.PI * 2);
      if (this.ghost) this.ghost.rotation.y = this.yaw;
    }
    // Layer up / down — Shift / Ctrl edges from input.intent. Clamped to
    // [0, MAX_LAYER]; floors / planters / campfires / torches snap back
    // to the ground because they're conceptually 1-storey ground props.
    if (intent.buildLayerUp) this.cursorLayer = Math.min(MAX_LAYER, this.cursorLayer + 1);
    if (intent.buildLayerDown) this.cursorLayer = Math.max(0, this.cursorLayer - 1);
    const c = this._computeCursor(dt, intent.moveX || 0, intent.moveZ || 0);
    const kind = this.currentRecipe();
    const recipe = RECIPES[kind];
    // Single-storey ground props (planter / campfire / torch) ignore the
    // manual layer — they're conceptually outdoor decorations and a
    // floating campfire would be confusing. floor_wood, in contrast,
    // is the *flooring* of upper storeys, so it MUST honour the layer
    // (a 2nd-storey building needs a 2nd-storey plank floor).
    const groundOnly = (kind === 'planter' || kind === 'campfire' || kind === 'torch');
    let layerY = groundOnly ? 0 : (this.cursorLayer * STEP_Y);
    // Auto-stack support for the legacy stone wall recipe — preserved so
    // a stone wall placed on an existing tower keeps its old "tap to
    // stack" feel. New wall kinds (wood / glass) rely on the manual
    // Shift/Ctrl layer instead so the player has explicit control.
    let stackY = layerY;
    let stackBase = null;
    if (kind === 'wall' && this.cursorLayer === 0) {
      stackBase = this._topWallAt(c.x, c.z);
      if (stackBase) stackY = (stackBase.y || 0) + WALL_STACK_STEP;
    }
    const spotOK = stackBase
      ? true
      : this._spotFree(c.x, c.z, stackY, kind);
    const affordable = canAfford(this.world.resources, kind) && spotOK;
    this._setGhostAffordable(affordable);
    if (this.ghost) {
      // Ground-snap so the ghost sits on the terrain plane (or stacked
      // on top of an existing wall when targeting one).
      this.ghost.position.set(c.x, stackY, c.z);
      this.ghost.rotation.y = this.yaw;
    }
    this.cursor.y = stackY;
    // Place — attack press, gated by affordability and spacing check.
    if (intent.attack && this._placeCooldown <= 0) {
      if (affordable) {
        spendCost(this.world.resources, kind);
        this.world.placeStructure(c.x, c.z, kind, this.yaw, recipe.hp, stackY);
        this._placeCooldown = 0.12;
        return true;
      } else {
        // Visual nudge: one hard pulse of the red ghost so the player sees
        // the rejection without a popup. Already red — no-op needed.
        this._placeCooldown = 0.05;
        return true;
      }
    }
    return true;            // active build mode always consumes the tick
  }

  // Find the highest-y wall descriptor at (x,z), or null if no wall sits
  // there. Used for the stack-walls feature: a new wall placed on the
  // same tile lands on top of this base. Only `wall` is stackable —
  // wood structures (fence/gate/planter) can't carry weight.
  _topWallAt(x, z) {
    const ck = this.world.chunkKeyOf(x, z);
    const arr = this.world.placedStructures.get(ck);
    if (!arr) return null;
    const eps = 0.15;
    let top = null;
    for (const d of arr) {
      if (d.kind !== 'wall') continue;
      if (Math.abs(d.x - x) >= eps || Math.abs(d.z - z) >= eps) continue;
      const y = d.y || 0;
      if (!top || y > (top.y || 0)) top = d;
    }
    return top;
  }
}


