// Save / load system for Twin Hearts.
//
// Persistence is currently localStorage-only but the on-disk shape is a
// plain JSON object so the same payload can be POSTed to a server later.
// `version` lets us migrate older saves without nuking them.
//
// Scope (covers the user's checklist):
//   • Player state — hp, pos, gold, level, xp, items, ability, weapon,
//     upgradeLevels, stats, selectedCropKind, alive
//   • World state — dayTime, shared resources (wood / stone / seeds),
//     totalKills, elapsed
//   • Built structures + planted beds — already persisted in
//     world.placedStructures (with `farm`/`hp`/`openDir` per descriptor),
//     so we just stringify the Map
//   • Consumed entities — chests, pots/crates, altars (existing Sets)
//   • Per-chunk entity overrides — HP/state of damaged trees, rocks,
//     alive enemy snapshots, altar charges. Captured on chunk unload
//     and replayed on chunk reload, so when the player walks away and
//     comes back the world isn't reset to its initial state.
//
// Performance:
//   • saves are debounced (`SAVE_DEBOUNCE_MS`) so a chunk-streaming
//     spike doesn't hammer JSON.stringify on every frame.
//   • Stringify happens off the hot path (idle callback when supported)
//     so chunk load/unload doesn't drop frames.
//   • Per-chunk overrides are kept as plain JSON-clean objects in the
//     World (`chunkOverrides` Map) so capture is just shallow object
//     mutation; serialization of the whole save runs at most once per
//     debounce window.

const STORAGE_KEY = 'twinhearts.save.v1';
const SCHEMA_VERSION = 1;

// Time we wait after a markDirty() before flushing to localStorage.
// Long enough to coalesce a burst of "player picked up 7 coins / chest
// opened / chunk streamed" events into one stringify; short enough that
// a sudden tab close keeps almost all the progress.
const SAVE_DEBOUNCE_MS = 1500;

// Cap so a runaway loop can't write to localStorage every frame.
const MIN_SAVE_INTERVAL_MS = 750;

// Schedule a function on idle when supported; otherwise setTimeout 0.
// Keeps the JSON.stringify off the input/render frame on browsers that
// expose requestIdleCallback (Chrome, Edge). Safari/Firefox fall back
// to setTimeout — still off-frame, just no idle scheduling.
function scheduleIdle(fn) {
  const w = (typeof window !== 'undefined') ? window : null;
  if (w && typeof w.requestIdleCallback === 'function') {
    return w.requestIdleCallback(fn, { timeout: 250 });
  }
  return setTimeout(fn, 0);
}

// Stable rounded position key — same shape as world.spawnKey() but
// without the chunkKey prefix (keys here are scoped to a chunk).
function posKey(x, z) {
  return `${x.toFixed(1)},${z.toFixed(1)}`;
}

// JSON-clean copy of player state. Skips the live three.js refs and
// transient timers (attackTimer, dashTimer, etc.) — only progression
// fields are persisted. Re-applying the snapshot on load goes via
// applyPlayerState() below.
//
// `character`, `color` and `capeColor` are cosmetic constructor-time
// fields — they're decided when the Player is built (the start-menu
// resolves them or they default per-slot) and can't be changed after
// the skinned mesh has been instantiated. The load path therefore
// reads these out of the save *before* `Game` constructs Players, then
// `applyPlayerState` below restores the runtime/progression fields on
// top. We still snapshot them here so the same JSON blob carries
// everything a future "Загрузить" needs.
function snapshotPlayer(p) {
  return {
    pos: { x: p.pos.x, z: p.pos.z },
    hp: Math.max(0, p.hp),
    maxHP: p.maxHP,
    gold: p.gold,
    level: p.level,
    xp: p.xp,
    items: { ...(p.items || {}) },
    ability: p.ability || null,
    abilityCd: p.abilityCd || 0,
    upgradeLevels: { ...(p.upgradeLevels || {}) },
    stats: { ...(p.stats || {}) },
    weaponKind: p._weaponKind || null,
    selectedCropKind: p.selectedCropKind || null,
    foods: { ...(p.foods || {}) },
    cookedFoods: { ...(p.cookedFoods || {}) },
    selectedFood: p.selectedFood || null,
    selectedRecipe: p.selectedRecipe || null,
    alive: !!p.alive,
    character: p._characterId || null,
    color: (typeof p._colorHex === 'number') ? p._colorHex : null,
    capeColor: (typeof p._capeColorHex === 'number') ? p._capeColorHex : null,
  };
}

// Apply a previously-saved player snapshot in-place. Mirrors the field
// list in snapshotPlayer; missing fields fall back to the player's
// current value so an older save still loads without crashing.
function applyPlayerState(p, s) {
  if (!p || !s) return;
  if (s.pos && typeof s.pos.x === 'number' && typeof s.pos.z === 'number') {
    p.pos.x = s.pos.x;
    p.pos.z = s.pos.z;
    if (p.smoothPos) { p.smoothPos.x = s.pos.x; p.smoothPos.z = s.pos.z; }
    p._renderPrev = { x: s.pos.x, z: s.pos.z };
    p._renderPos = { x: s.pos.x, z: s.pos.z };
  }
  if (typeof s.maxHP === 'number') p.maxHP = s.maxHP;
  if (typeof s.hp === 'number') p.hp = Math.max(0, Math.min(p.maxHP, s.hp));
  if (typeof s.gold === 'number') p.gold = s.gold;
  if (typeof s.level === 'number') p.level = s.level;
  if (typeof s.xp === 'number') p.xp = s.xp;
  if (s.items && typeof s.items === 'object') p.items = { ...s.items };
  if (typeof s.ability === 'string' || s.ability === null) {
    if (s.ability) p.setAbility(s.ability);
    else { p.ability = null; p.abilityCd = 0; }
  }
  if (typeof s.abilityCd === 'number') p.abilityCd = s.abilityCd;
  if (s.upgradeLevels && typeof s.upgradeLevels === 'object') {
    p.upgradeLevels = { ...p.upgradeLevels, ...s.upgradeLevels };
  }
  if (s.stats && typeof s.stats === 'object') {
    p.stats = { ...p.stats, ...s.stats };
  }
  if (typeof s.weaponKind === 'string' && s.weaponKind && p.setWeapon) {
    p.setWeapon(s.weaponKind);
  }
  if (typeof s.selectedCropKind === 'string') p.selectedCropKind = s.selectedCropKind;
  if (s.foods && typeof s.foods === 'object') p.foods = { ...s.foods };
  if (s.cookedFoods && typeof s.cookedFoods === 'object') p.cookedFoods = { ...s.cookedFoods };
  if (typeof s.selectedFood === 'string' || s.selectedFood === null) p.selectedFood = s.selectedFood;
  if (typeof s.selectedRecipe === 'string') p.selectedRecipe = s.selectedRecipe;
  if (typeof s.alive === 'boolean') {
    if (s.alive && !p.alive) p.revive();
    else if (!s.alive && p.alive) p.die?.();
  }
}

// Serialise placedStructures Map<chunkKey, descriptor[]>. The descriptor
// is already JSON-clean (numbers + short strings), so a shallow copy is
// enough.
function snapshotPlacedStructures(map) {
  const out = {};
  if (!map) return out;
  for (const [key, arr] of map) {
    if (!arr || arr.length === 0) continue;
    out[key] = arr.map(d => ({ ...d }));
  }
  return out;
}

// Serialise chunkOverrides Map<chunkKey, override>. We deep-copy each
// override so the saved snapshot is decoupled from any subsequent
// in-memory mutation between save windows.
function snapshotChunkOverrides(map) {
  const out = {};
  if (!map) return out;
  for (const [key, ov] of map) {
    if (!ov) continue;
    const entry = {};
    if (ov.resources) {
      entry.resources = {};
      for (const k of Object.keys(ov.resources)) entry.resources[k] = { ...ov.resources[k] };
    }
    if (ov.altars) {
      entry.altars = {};
      for (const k of Object.keys(ov.altars)) entry.altars[k] = { ...ov.altars[k] };
    }
    if (ov.enemies) {
      entry.enemies = ov.enemies.map(e => ({
        ...e,
        pos: e.pos ? { ...e.pos } : null,
        home: e.home ? { ...e.home } : null,
      }));
    }
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return out;
}

// Inverse of snapshotChunkOverrides — rehydrates the World's
// chunkOverrides Map from the JSON blob.
function loadChunkOverrides(map, blob) {
  if (!map || !blob || typeof blob !== 'object') return;
  for (const key of Object.keys(blob)) {
    const ov = blob[key];
    if (!ov) continue;
    const entry = {};
    if (ov.resources && typeof ov.resources === 'object') {
      entry.resources = {};
      for (const k of Object.keys(ov.resources)) entry.resources[k] = { ...ov.resources[k] };
    }
    if (ov.altars && typeof ov.altars === 'object') {
      entry.altars = {};
      for (const k of Object.keys(ov.altars)) entry.altars[k] = { ...ov.altars[k] };
    }
    if (Array.isArray(ov.enemies)) {
      entry.enemies = ov.enemies.map(e => ({
        ...e,
        pos: e.pos ? { ...e.pos } : null,
        home: e.home ? { ...e.home } : null,
      }));
    }
    if (Object.keys(entry).length > 0) map.set(key, entry);
  }
}

// Restore a placedStructures snapshot back into the World map.
function loadPlacedStructures(map, blob) {
  if (!map || !blob || typeof blob !== 'object') return;
  for (const key of Object.keys(blob)) {
    const arr = blob[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    map.set(key, arr.map(d => ({ ...d })));
  }
}

export class SaveSystem {
  constructor(game) {
    this.game = game;
    this._dirty = false;
    this._timer = null;
    this._lastSaveAt = 0;
    this._suspended = false;
    // beforeunload flush so a tab-close keeps the session intact even
    // when the user wasn't expecting a save tick.
    this._unloadHandler = () => {
      try { this.flushNow(); } catch { /* ignore quota / private mode */ }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._unloadHandler);
      window.addEventListener('pagehide', this._unloadHandler);
      // Also flush when the tab goes to the background — phone Safari /
      // many embedded webviews never fire beforeunload, only visibility
      // change. Cheap to listen to and the inner branch is a no-op when
      // nothing is dirty.
      document.addEventListener?.('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._unloadHandler();
      });
    }
  }

  // Pause auto-saves for the duration of a load/restart sequence. Avoids
  // a half-applied snapshot getting written back over the original save
  // while we're still wiring things up.
  suspend() { this._suspended = true; }
  resume()  { this._suspended = false; }

  destroy() {
    if (typeof window !== 'undefined' && this._unloadHandler) {
      window.removeEventListener('beforeunload', this._unloadHandler);
      window.removeEventListener('pagehide', this._unloadHandler);
    }
  }

  // Read whatever is currently in localStorage. Returns the parsed
  // object or null if empty / unparseable / wrong schema. The caller
  // is responsible for matching the seed before applying.
  static read() {
    if (typeof localStorage === 'undefined') return null;
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.version !== SCHEMA_VERSION) {
        // Future-proofing: a v1 reader can choose to either drop or
        // migrate older payloads. For now we drop silently — the player
        // will start fresh next session and the bad blob gets
        // overwritten by the next save.
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  // True if the save in storage matches `seedDisplay` (or has no seed).
  // Lets the start menu surface a "продолжить" affordance when the
  // player picks the same seed as last time.
  static hasSaveForSeed(seedDisplay) {
    const blob = SaveSystem.read();
    if (!blob) return false;
    if (!blob.seed) return true; // legacy / seedless save
    return String(blob.seed) === String(seedDisplay);
  }

  // Wipe the saved game. Called from the pause-menu "сбросить
  // прогресс" button, and from the load path when the player picks a
  // different seed than the saved one.
  static clear() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  // Mark the save as dirty. Schedules a debounced write — multiple
  // markDirty() calls within SAVE_DEBOUNCE_MS coalesce into one
  // localStorage write. Hot-path callers (chunk unload, item pickup)
  // can call this freely without worrying about cost.
  markDirty() {
    if (this._suspended) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      // Run the actual stringify in an idle slot so we don't add
      // milliseconds to a render frame.
      scheduleIdle(() => this._flushIfDirty());
    }, SAVE_DEBOUNCE_MS);
  }

  // Force a synchronous save right now. Used on tab-close / unload
  // where idle callbacks won't fire in time.
  flushNow() {
    if (this._suspended) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._dirty = true;
    this._flushIfDirty(true);
  }

  // ---- internal ----------------------------------------------------

  _flushIfDirty(force = false) {
    if (this._suspended) return;
    if (!this._dirty) return;
    const now = Date.now();
    if (!force && (now - this._lastSaveAt) < MIN_SAVE_INTERVAL_MS) {
      // Minimum gap between writes. We re-arm the timer so the next
      // save lands on schedule instead of drifting forever.
      this._timer = setTimeout(() => {
        this._timer = null;
        scheduleIdle(() => this._flushIfDirty());
      }, MIN_SAVE_INTERVAL_MS);
      return;
    }
    // Optional pre-serialise hook — Game wires this up so chunks
    // currently loaded around the player get their entity state
    // snapshotted into world.chunkOverrides before we walk it. Without
    // this, only chunks that have been streamed *out* would carry
    // up-to-date state and a tab-close mid-game would lose recent
    // damage to enemies / resources still inside the active ring.
    if (typeof this._beforeSerialize === 'function') {
      try { this._beforeSerialize(); } catch (err) {
        console.warn('[save] beforeSerialize failed', err);
      }
    }
    let payload = null;
    try { payload = this._serialize(); } catch (err) {
      console.warn('[save] serialise failed', err);
      return;
    }
    if (!payload) return;
    try {
      const json = JSON.stringify(payload);
      localStorage.setItem(STORAGE_KEY, json);
      this._dirty = false;
      this._lastSaveAt = now;
    } catch (err) {
      // Quota exceeded / private mode / disabled storage. Keep the
      // dirty flag set so a future call still tries again, but don't
      // crash the game.
      if (typeof console !== 'undefined') {
        console.warn('[save] localStorage write failed', err && err.message);
      }
    }
  }

  // Build the JSON-clean save payload from the live game state. Keep
  // this method side-effect free so a future server-side save can call
  // it directly.
  _serialize() {
    const g = this.game;
    if (!g || !g.world) return null;
    const w = g.world;
    return {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      seed: g.seedDisplay || null,
      seedHash: w.seed >>> 0,
      world: {
        dayTime: typeof w.dayTime === 'number' ? w.dayTime : 0,
        resources: w.resources ? { ...w.resources } : { wood: 0, stone: 0, seeds: 0 },
        totalKills: g.totalKills | 0,
        elapsed: g.elapsed || 0,
      },
      players: (g.players || []).map(p => snapshotPlayer(p)),
      placedStructures: snapshotPlacedStructures(w.placedStructures),
      consumedChests: w._consumedChests ? Array.from(w._consumedChests) : [],
      consumedBreakables: w._consumedBreakables ? Array.from(w._consumedBreakables) : [],
      consumedAltars: w._consumedAltars ? Array.from(w._consumedAltars) : [],
      chunkOverrides: snapshotChunkOverrides(w.chunkOverrides),
    };
  }

  // Apply a previously-loaded blob to the live game. Caller must
  // confirm the seed already matches; otherwise loaded chunk overrides
  // would correspond to a different terrain layout. Order matters:
  // World-level state (consumed sets, placedStructures, chunkOverrides)
  // first so any subsequent chunk drain reads the freshly-restored
  // tables; then player snapshots; then mark the position so the next
  // _streamChunks call rebuilds chunks around the restored player pos.
  apply(blob) {
    if (!blob) return false;
    const g = this.game;
    if (!g || !g.world) return false;
    const w = g.world;
    this.suspend();
    try {
      // Consumed sets — replace contents in-place so the existing
      // references on the World object stay valid.
      if (Array.isArray(blob.consumedChests)) {
        w._consumedChests.clear();
        for (const k of blob.consumedChests) w._consumedChests.add(k);
      }
      if (Array.isArray(blob.consumedBreakables)) {
        w._consumedBreakables.clear();
        for (const k of blob.consumedBreakables) w._consumedBreakables.add(k);
      }
      if (Array.isArray(blob.consumedAltars)) {
        w._consumedAltars.clear();
        for (const k of blob.consumedAltars) w._consumedAltars.add(k);
      }
      // Placed structures — fully replace.
      if (w.placedStructures) {
        w.placedStructures.clear();
        loadPlacedStructures(w.placedStructures, blob.placedStructures || {});
      }
      // Per-chunk natural-spawn overrides.
      if (w.chunkOverrides) {
        w.chunkOverrides.clear();
        loadChunkOverrides(w.chunkOverrides, blob.chunkOverrides || {});
      }
      // World-level scalars.
      if (blob.world) {
        if (typeof blob.world.dayTime === 'number') {
          w.dayTime = blob.world.dayTime;
          if (typeof w._refreshDayTimeDerived === 'function') {
            w._refreshDayTimeDerived();
          }
        }
        if (blob.world.resources && w.resources) {
          for (const k of Object.keys(blob.world.resources)) {
            const v = blob.world.resources[k];
            if (typeof v === 'number') w.resources[k] = v;
          }
        }
        if (typeof blob.world.totalKills === 'number') g.totalKills = blob.world.totalKills;
        if (typeof blob.world.elapsed === 'number') g.elapsed = blob.world.elapsed;
      }
      // Players. We tolerate save↔runtime player count mismatches:
      // saves with fewer entries leave extra players at constructor
      // defaults; saves with extra entries simply ignore the overflow.
      if (Array.isArray(blob.players)) {
        const n = Math.min(g.players.length, blob.players.length);
        for (let i = 0; i < n; i++) applyPlayerState(g.players[i], blob.players[i]);
      }
    } finally {
      this.resume();
    }
    return true;
  }
}

export { SCHEMA_VERSION, STORAGE_KEY, posKey };
