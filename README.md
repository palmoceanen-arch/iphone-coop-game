# Twin Hearts — Couch Co-op Web Adventure

A cozy-but-dangerous top-down adventure for **one or two local players**, built
with [Three.js](https://threejs.org/). Play on one keyboard, with gamepads, or
use iPhones as wireless QR controllers while the host screen runs the game.
Explore an open meadow, fight monsters with distinct attack patterns, gather
food and resources, build a camp, farm, cook, upgrade, and survive the night.

> **Invisible bond mechanic:** the heroes are linked by distance, not by a
> visible rope. Drift too far apart and the world fades to grey while your
> hearts begin to drain — run back together in time to survive.

## Features

- **Three.js + custom physics** for top-down movement, knockback, dash i-frames
  and collision against trees, rocks, ponds and the outer fence.
- **Dynamic split-aware camera** that smoothly zooms out as the players drift
  apart so both stay on screen.
- **Phone-as-controller lobby** with a QR code / 4-digit room code so iPhones
  can join as wireless couch-coop controllers over LAN.
- **Five enemy types** with distinct AI:
  | # | Name | Attack |
  |---|------|--------|
  | 1 | Slime | Walks toward the nearest hero and bumps for contact damage. |
  | 2 | Archer | Strafes to keep range and fires homing-aimed bolts. |
  | 3 | Bomber | Charges in, lights its fuse and explodes in an AoE. |
  | 4 | Wisp | Brief wind-up, then a fast lunge-dash through the player. |
  | 5 | Ogre | Slow, heavy. Tells then swings a club for huge damage + knockback. |
- **Combat impact**: hit-stop (slow-mo), screen shake, knockback, particle
  burst, damage numbers and CC0-sampled hit / swing / death / break sounds
  (Kenney) layered over a procedural day-aware ambient soundscape (wind,
  pondside lap, forest hum, campfire crackle, daytime birds, night-time
  crickets) — see "Notes on assets" below for sources.
- **Loot**: gold piles and food (apples, mushrooms, meat, berries) drop from
  enemies and gravitate to nearby heroes.
- **Upgrade shop** at the campfire (press `Tab`): each hero spends their own
  gold on permanent upgrades — Damage, Max HP, Move Speed, Attack Speed.
- **Day/night cycle** with sun/moon, fog and color shifts; nights spawn more
  enemies at higher levels.
- **No external assets required** — all geometry is procedural, all sounds are
  WebAudio-synthesized so the game runs offline and starts in milliseconds.

## Controls

| Action | Keyboard P1 (Cyan) | Keyboard P2 (Coral) | Standard gamepad |
|---|---|---|---|
| Move | `W` `A` `S` `D` | `↑` `←` `↓` `→` | Left stick / D-pad |
| Attack / place build | `F` | `L` | `A` / Cross |
| Dash / cancel build | `R` | `K` | `B` / Circle |
| Interact / rotate build | `E` | `J` | `X` / Square |
| Open build wheel | `B` | `N` | `Y` / Triangle |
| Cycle planter crop / food | `Q` | `U` | `LB` / `L1` |
| Cast ability | `G` | `H` | `RB` / `R1` |
| Build layer | `Shift` / `Ctrl` | `Shift` / `Ctrl` | `RT` / `R2` up, `LT` / `L2` down |
| Upgrade shop | `Tab` | `Tab` | Back / View / Select |
| Pause / start from lobby | `P` / `Esc` | `P` / `Esc` | Start / Menu |

| Global | |
|---|---|
| Open / close upgrade shop | `Tab` |
| P1 buy upgrades 1–4 | `1` `2` `3` `4` |
| P2 buy upgrades 1–4 | `7` `8` `9` `0` |
| Pause | `P` |

Physical controllers use the browser Web Gamepad API. The first connected gamepad
controls P1 and the second controls P2; 8BitDo pads work best in a standard /
XInput-compatible mode.

### Farming (M3)

Planters built in build-mode (`Грядка` recipe — slot `4` for P1, slot `0` for
P2) accept any seed from the shared `seeds` pool and grow whatever crop the
planting player has currently selected: **пшеница → морковь → тыква →
капуста**. The current pick + the cycle key sit inside the planter's interact
prompt — walk up to a tilled planter and the toast reads
`E: Посадить — морковь (Q: сменить · 12 сем.)`; press `Q` (P1) / `U`
(P2) to rotate. Each crop has its own grow time, food yield and seed return
on harvest; see `src/farming.js`'s `CROPS` map for the exact numbers.

## Running

```bash
npm install
npm run dev      # starts a Vite dev server on http://localhost:3000
npm run build    # builds a static bundle into dist/
npm run preview  # serves the built bundle
npm run lint     # eslint
```

### Phone controller — joining over LAN

The lobby page generates a 4-digit code and a QR pointing at
`/controller?code=XXXX`. The host page asks `GET /api/lan-host` for the right
LAN URL to embed in the QR — you don't need to hard-code your IP anymore.

iOS Safari only allows camera access (`getUserMedia`) over HTTPS or
`localhost`, so to actually scan the QR with the iPhone camera you need to
serve the game over HTTPS:

```bash
HTTPS=1 npm run dev
```

On first start the server auto-generates a self-signed cert under `./certs/`
and listens on both `http://0.0.0.0:3000` (desktop host) and
`https://0.0.0.0:3443` (iPhone). The QR code in the lobby will encode the
HTTPS URL automatically. The first time you open it on the phone, Safari will
warn about the cert — tap **Show details → visit this website**.

If you don't want HTTPS, the phone can still join via the **Загрузить фото QR**
button (pick a screenshot of the QR from the gallery) or by typing the
4-digit code manually.

## Project layout

```
index.html          UI overlay + canvas
vite.config.js      Vite static build config
src/
  main.js           bootstrap
  game.js           main loop, spawn director, leash logic
  world.js          terrain, props, day/night, ground colliders
  player.js         player controller, sword swing, dash
  enemy.js          base enemy + 5 archetypes
  projectile.js     archer arrows
  pickups.js        gold + food drops with magnet pickup
  upgrades.js       upgrade definitions + shop UI
  effects.js        particles, rings, hit-stop, screen shake, damage numbers
  camera.js         smooth follow camera that fits both players
  sound.js          WebAudio mixer: CC0 ogg samples + procedural ambient layers
  input.js          two-player keyboard input
  utils.js          tiny vector + math helpers
```

## Notes on assets

### Audio

One-shot SFX (sword swing, hits, damage, breakables, coins, tree creaks)
play short CC0 `.ogg` samples shipped under `public/sounds/`. They are
sourced from two free, public-domain Kenney audio packs:

- **RPG Audio** — https://kenney.nl/assets/rpg-audio
- **Impact Sounds** — https://kenney.nl/assets/impact-sounds

Both packs are released under [Creative Commons Zero (CC0
1.0)](http://creativecommons.org/publicdomain/zero/1.0/). The exact file
mapping is documented in `public/sounds/LICENSE.txt`.

Loading is **lazy** — the first call to a category kicks off a `fetch +
decodeAudioData` and emits a synthesised placeholder; every subsequent
trigger uses the decoded `AudioBuffer` with random pitch jitter and a
random variant pick so repeated combat hits never sound mechanical.

The ambient soundscape (wind, pondside lap, forest hum, campfire crackle,
day-time birds, night-time crickets) is **fully procedural** — generated
from one shared 8-second seeded noise buffer that loops forever, shaped
by per-layer biquad filters and slow LFOs, and modulated each frame by
the player's proximity to ponds / origin campfire and the world's
day-weight phase. This keeps the bundle small (~220 KB total for all
SFX, zero bytes for ambient) and lets the soundscape react to where the
players are without rebuilding the WebAudio graph.

### 3D Models

GLB models live in `public/models/`. To swap in additional CC0 GLBs (e.g.
from [Kenney](https://kenney.nl/) or [Quaternius](https://quaternius.com/)),
drop them in and load via `THREE.GLTFLoader` inside `models.js`.

### Adding more sounds

To add a new SFX category:

1. Drop `.ogg` files into `public/sounds/` (CC0 or compatible licence).
2. Add an entry to the `SAMPLES` map at the top of `src/sound.js` with
   the variant filenames.
3. Add a wrapper method (or call `_play('newCategory', opts)` directly).
4. Optionally add a `RATE_LIMIT` and `VOICE_CAP` entry to keep it from
   stacking on dense combat frames.

## License

MIT.
