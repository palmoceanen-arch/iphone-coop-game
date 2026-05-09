// Generic free-list pools for visual handles (THREE.Object3D mesh trees,
// SkeletonUtils-cloned characters with their AnimationMixer + actions, etc.).
//
// Why this exists:
// During combat the game allocates and disposes a small zoo of throwaway
// objects every second — gold piles and food drops on every kill, pots and
// crates as the players smash them, and skeleton/wisp/bomber instances as
// chunks stream in and out around the players. Each spawn means
//   • a fresh THREE.Group / Mesh tree
//   • cloned BufferGeometries (for procedural pickups) or a deep-cloned GLB
//     scene graph (for breakables) or a SkeletonUtils-cloned skinned mesh
//     plus a brand-new THREE.AnimationMixer with N clipActions (for enemies)
//   • cloned MeshToonMaterials with a per-instance tint applied
// and each death disposes the lot. V8's young-generation GC pauses become
// noticeable on weaker hardware after ~30s of play because so many short-lived
// objects are churning through.
//
// HandlePool is a per-string-key free list with a hard cap. Callers shard by
// whatever combination of attributes determines visual identity (enemy kind +
// elite, food sub-kind, breakable kind) so two acquired handles for the same
// key are visually interchangeable.
//
// The pool deliberately doesn't dispose the GPU resources on overflow either:
// callers that build cheap handles (a single Mesh + Material) accept the
// slightly-leaked materials in exchange for never paying a dispose+upload
// round-trip on the hot spawn path. The cap makes worst-case memory bounded.

export class HandlePool {
  constructor(maxPerKey = 64) {
    this._byKey = new Map();
    this._cap = maxPerKey;
  }

  // Pull a previously-released handle for `key`, or null if the bucket is
  // empty. Caller is responsible for re-attaching the handle to the scene
  // and resetting any per-instance state (position, rotation, animation
  // time, material flash residue, ...).
  acquire(key) {
    const list = this._byKey.get(key);
    if (!list || list.length === 0) return null;
    return list.pop();
  }

  // Park a handle back in the pool. Returns false if the bucket is at cap;
  // the caller should fall back to its own "really destroy" path (dispose
  // geometries / materials, or just drop the reference to GC) in that case.
  release(key, handle) {
    let list = this._byKey.get(key);
    if (!list) {
      list = [];
      this._byKey.set(key, list);
    }
    if (list.length >= this._cap) return false;
    list.push(handle);
    return true;
  }

  size(key) {
    const list = this._byKey.get(key);
    return list ? list.length : 0;
  }

  totalSize() {
    let total = 0;
    for (const list of this._byKey.values()) total += list.length;
    return total;
  }

  clear() {
    this._byKey.clear();
  }
}
