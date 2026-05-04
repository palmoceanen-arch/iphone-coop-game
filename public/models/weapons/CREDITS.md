# Weapon Attachment Models

All weapon models are licensed **CC0** (Creative Commons Zero — no
attribution required, but credit appreciated). They were authored by
**Kay Lousberg** (<https://kaylousberg.com>) and ship as part of his open
KayKit Adventurers character pack.

These weapons are designed to be parented to the `handslot.r` bone of any
KayKit medium-rig character (Knight, Mage, Rogue, Barbarian) so the same
universal humanoid can wield any of them with the matching swing/cast
animation. That's what makes weapon swapping in the upgrade tree possible
without touching the underlying character mesh.

## Source

- Source pack: **KayKit — Character Pack: Adventurers 1.0**
- License: Creative Commons Zero (CC0 1.0)
- Pack home: <https://kaylousberg.itch.io/kaykit-adventurers>
- GitHub mirror: <https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0>

## Files

| File | Original | Texture atlas |
|------|----------|---------------|
| `axe_1handed.glb`   | `Assets/gltf/axe_1handed.gltf`     | barbarian |
| `axe_2handed.glb`   | `Assets/gltf/axe_2handed.gltf`     | barbarian |
| `staff.glb`         | `Assets/gltf/staff.gltf`           | mage      |
| `wand.glb`          | `Assets/gltf/wand.gltf`            | mage      |
| `dagger.glb`        | `Assets/gltf/dagger.gltf`          | rogue     |
| `spellbook_closed.glb` | `Assets/gltf/spellbook_closed.gltf` | mage   |

Each weapon was repacked with `gltfpack -cc` (EXT_meshopt_compression) so
the runtime decode path matches the rest of the project. Texture atlases
are embedded in each GLB so weapons stay self-contained.

The Knight's swords (1H_Sword, 2H_Sword) and four shield variants are
already baked into `../Knight.glb` as named child meshes; they're toggled
on/off via visibility instead of being loaded as separate files.
