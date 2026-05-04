# Twin Hearts — Two-Player Local-Coop Adventure

A top-down action adventure for **two players on a single keyboard**, built with
[Three.js](https://threejs.org/). Inspired by *The Legend of Zelda*, *Don't Starve*
and *DotA*: a cozy open meadow, monsters with distinct attack patterns, food and
gold drops, an upgrade shop at the campfire, and a day/night cycle that ramps up
the danger after dark.

> **Bond mechanic:** the heroes share a magical leash. Drift too far apart and
> the world fades to grey and your hearts begin to drain — but if you can run
> back together in time, you survive.

## Features

- **Three.js + custom physics** for top-down movement, knockback, dash i-frames
  and collision against trees, rocks, ponds and the outer fence.
- **Dynamic split-aware camera** that smoothly zooms out as the players drift
  apart so both stay on screen.
- **Five enemy types** with distinct AI:
  | # | Name | Attack |
  |---|------|--------|
  | 1 | Slime | Walks toward the nearest hero and bumps for contact damage. |
  | 2 | Archer | Strafes to keep range and fires homing-aimed bolts. |
  | 3 | Bomber | Charges in, lights its fuse and explodes in an AoE. |
  | 4 | Wisp | Brief wind-up, then a fast lunge-dash through the player. |
  | 5 | Ogre | Slow, heavy. Tells then swings a club for huge damage + knockback. |
- **Combat impact**: hit-stop (slow-mo), screen shake, knockback, particle
  burst, damage numbers and procedurally synthesized hit/swing/death sounds.
- **Loot**: gold piles and food (apples, mushrooms, meat, berries) drop from
  enemies and gravitate to nearby heroes.
- **Upgrade shop** at the campfire (press `Tab`): each hero spends their own
  gold on permanent upgrades — Damage, Max HP, Move Speed, Attack Speed.
- **Day/night cycle** with sun/moon, fog and color shifts; nights spawn more
  enemies at higher levels.
- **No external assets required** — all geometry is procedural, all sounds are
  WebAudio-synthesized so the game runs offline and starts in milliseconds.

## Controls (one keyboard, two players)

| | Player 1 (Cyan) | Player 2 (Coral) |
|---|---|---|
| Move | `W` `A` `S` `D` | `↑` `←` `↓` `→` |
| Attack | `F` | `L` |
| Dash | `R` | `K` |

| Global | |
|---|---|
| Open / close upgrade shop | `Tab` |
| P1 buy upgrades 1–4 | `1` `2` `3` `4` |
| P2 buy upgrades 1–4 | `7` `8` `9` `0` |
| Pause | `P` |

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
  sound.js          WebAudio procedural SFX
  input.js          two-player keyboard input
  utils.js          tiny vector + math helpers
```

## Notes on assets

The game ships with **zero external assets** so it works in restricted
environments. To swap in CC0 GLB models (e.g. from
[Kenney](https://kenney.nl/) or [Quaternius](https://quaternius.com/)) and real
audio (e.g. [Freesound](https://freesound.org/)):

1. Drop GLB files into `public/models/` and load them via
   `THREE.GLTFLoader` inside `enemy.js` / `player.js`, replacing the procedural
   primitives.
2. Drop `.ogg` / `.mp3` files into `public/sounds/` and replace calls in
   `sound.js` with `new Audio()` or `THREE.Audio` instances.

## License

MIT.
