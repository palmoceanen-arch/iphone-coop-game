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

// Distance from the player at which the ghost preview floats. Combined
// with grid snapping this keeps the cursor consistently a tile-or-two
// in front of the character regardless of facing.
const CURSOR_DISTANCE = 1.5;

// Yaw step when the player presses interact. 90° matches a 1m grid wall
// orientation (axis-aligned looks tidy; finer angles risk visible
// collider-vs-mesh mismatches).
const YAW_STEP = Math.PI / 2;

// Minimum spacing between two structures' centres so the placement check
// doesn't allow stacking. Roughly the union of any two recipe radii plus
// a small tolerance, but expressed as a single conservative number to
// keep the check cheap.
const MIN_STRUCT_SPACING = 0.85;

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
    this.cursor = { x: 0, z: 0 };
    this.ghost = null;
    this.ghostKind = null;
    this.ghostAffordable = true;
    // Cooldown so a single attack-press doesn't both place a structure and
    // immediately drop a second one on the same frame's cursor (rare, but
    // possible on high-DPI inputs that emit repeated edge events).
    this._placeCooldown = 0;
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
    this.active = true;
    this.recipeIdx = clamped;
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

  // Compute the target tile in front of the player, snapped to a 1m grid.
  _computeCursor() {
    const f = this.player.facing || { x: 0, z: -1 };
    const fl = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / fl, fz = f.z / fl;
    const cx = Math.round(this.player.pos.x + fx * CURSOR_DISTANCE);
    const cz = Math.round(this.player.pos.z + fz * CURSOR_DISTANCE);
    this.cursor.x = cx;
    this.cursor.z = cz;
    return this.cursor;
  }

  // True if (x,z) is free of other player-placed structures (avoid stacking
  // / z-fighting) AND of world colliders (avoid burying a wall inside a
  // tree). Both checks use a conservative radius so the player notices the
  // ghost going red rather than spawning a wall that overlaps geometry.
  _spotFree(x, z) {
    const chunkKey = this.world.chunkKeyOf(x, z);
    const arr = this.world.placedStructures.get(chunkKey);
    if (arr) {
      for (const d of arr) {
        const dx = d.x - x, dz = d.z - z;
        if (dx * dx + dz * dz < MIN_STRUCT_SPACING * MIN_STRUCT_SPACING) return false;
      }
    }
    // World colliders are aggregated each frame from all active chunks
    // (trees, rocks, world props). Using them directly keeps this check
    // chunk-agnostic — a wall placed near a chunk seam still sees colliders
    // from the neighbour chunk.
    const cols = this.world.colliders;
    if (cols && cols.length) {
      for (const c of cols) {
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
    const c = this._computeCursor();
    const recipe = RECIPES[this.currentRecipe()];
    const affordable = canAfford(this.world.resources, this.currentRecipe()) && this._spotFree(c.x, c.z);
    this._setGhostAffordable(affordable);
    if (this.ghost) {
      // Ground-snap so the ghost sits on the terrain plane.
      this.ghost.position.set(c.x, 0, c.z);
      this.ghost.rotation.y = this.yaw;
    }
    // Place — attack press, gated by affordability and spacing check.
    if (intent.attack && this._placeCooldown <= 0) {
      if (affordable) {
        spendCost(this.world.resources, this.currentRecipe());
        this.world.placeStructure(c.x, c.z, this.currentRecipe(), this.yaw, recipe.hp);
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
}
