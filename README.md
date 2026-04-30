# PhysBall Arena

Casual 2D multiplayer physics football for the browser. Server-authoritative Matter.js simulation, Socket.IO transport, plain HTML5 Canvas client — runs on desktop and mobile out of the box.

![gameplay](docs/preview.png)

- **Open arena:** no login, pick a nickname, hit **Play**, you're auto-assigned to the smaller team.
- **Controls:** WASD / Arrows to move, Space / X / Enter to kick. Mobile gets a virtual joystick + kick button.
- **Goal:** push the ball into the opposing goal. First team to 5 wins. Press **R** for a rematch.

## Market research (why this concept)

I scanned the casual physics-multiplayer space across web and mobile before picking a design. Summary:

| Game | Platform | Mechanic | Scale | Takeaway for MVP |
| --- | --- | --- | --- | --- |
| [HaxBall](https://www.haxball.com/) | Web (WebRTC) | 2D physics football, 1v1–4v4 | ~4M visits / month ([Semrush, Jan 2026](https://www.semrush.com/website/haxball.com/overview/)) | Minimalist physics football is a **proven, long-running** formula (15+ years, still top in Argentina / Turkey / Brazil). |
| [Stumble Guys](https://stumbleguys.com/) / [Fall Dudes 3D](https://play.google.com/store/apps/details?id=fall.dude.sandbox.guys.simulator) | Mobile / Web | 3D physics party-royale, 32 players, obstacle courses | Hundreds of millions of installs | Huge genre, but content-heavy (levels, models). Overkill for a single-session MVP. |
| Basket / Volley / Soccer Random | Web (io games) | 1-button physics ragdoll sports | Millions of plays on io portals | Shows that unpredictable physics + one-touch input is very sticky — **but it's local co-op / vs bot, no online**. Gap to fill. |
| [agar.io](https://agar.io), [diep.io](https://diep.io), [stug.io](https://stug.io) | Web | .io arena shooters | Massive | Instant-join, no-account, shared room pattern is table stakes for browser multiplayer today. |

**Decision.** Build a HaxBall-inspired 2D physics football arena with modern architecture (server-authoritative, mobile-first touch controls). It hits the sweet spot between "works in one session" and "genuinely fun to play with others", and fills a real gap — most of the sticky physics sports games on io portals are single-device only.

## Tech stack

- **Server:** Node.js 20+, Express (static), [Socket.IO](https://socket.io/), [Matter.js](https://brm.io/matter-js/) for 2D rigid-body physics.
- **Client:** Plain ES modules, HTML5 Canvas 2D, Socket.IO client (ESM build). No bundler, no framework — ships as-is.
- **Simulation:** authoritative on the server at 60 Hz, broadcast to clients at 30 Hz, client interpolates ~100 ms in the past for smooth motion.
- **Input:** keyboard (WASD/Arrows + Space) on desktop; virtual joystick + kick button on touch devices (auto-detected via `@media (hover: none) and (pointer: coarse)`).

```
┌──────────────┐   state @30Hz   ┌──────────────┐
│ server/      │ ───────────────▶│ client/      │
│  Matter.js   │                 │  Canvas      │
│  game.js     │◀─── inputs ─────│  interp.     │
└──────────────┘                 └──────────────┘
       60 Hz fixed tick                RAF render
```

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Optional: `npm run dev` starts with `node --watch` for auto-reload on file changes.

### Multiple test players

Open `http://localhost:3000` in two browser tabs (or one desktop + one phone on the same Wi-Fi using your LAN IP) — players are auto-balanced onto the red and blue teams.

## Docker

```bash
docker build -t physball-arena .
docker run --rm -p 3000:3000 physball-arena
```

## Project layout

```
physball-arena/
├── server/
│   ├── index.js       # Express + Socket.IO wiring, tick and broadcast loops
│   └── game.js        # Room, Matter.js world, players, ball, scoring
├── client/
│   ├── public/        # index.html, style.css, favicon (static)
│   └── src/app.js     # menu, input, socket client, render / interpolation
├── shared/
│   └── constants.js   # field / player / ball / world constants shared by both sides
├── Dockerfile
└── package.json
```

## Controls cheatsheet

| Action | Desktop | Mobile |
| --- | --- | --- |
| Move | WASD or Arrow keys | Left-side virtual joystick |
| Kick | Space, X, or Enter | Right-side KICK button |
| Rematch (after a win) | R | Reload tab |

## Roadmap ideas

- Multiple concurrent rooms + matchmaking
- Stamina / dash mechanic
- Custom stadiums (brackets of walls behind the goals, circular arenas)
- Spectator mode when the room is full
- Persistent stats (wins/goals/assists) via a lightweight KV store

## License

MIT. See [LICENSE](LICENSE).
