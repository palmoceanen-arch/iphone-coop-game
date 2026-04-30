// Authoritative game simulation. Runs server-side at WORLD.tickHz using Matter.js.
import Matter from 'matter-js';
import { FIELD, PLAYER, BALL, WORLD, TEAMS } from '../shared/constants.js';

const { Engine, World, Bodies, Body, Events } = Matter;

const WALL_OPTS = { isStatic: true, restitution: 0.6, friction: 0 };

function buildArenaBodies() {
  const { width: W, height: H, goalHeight: GH, goalDepth: GD, wallThickness: WT } = FIELD;
  const sideH = (H - GH) / 2;
  const bodies = [];

  // Top & bottom walls (span the full pitch including the pocket mouths).
  bodies.push(Bodies.rectangle(W / 2, -WT / 2, W + 2 * GD, WT, WALL_OPTS));
  bodies.push(Bodies.rectangle(W / 2, H + WT / 2, W + 2 * GD, WT, WALL_OPTS));

  // Left & right side walls, split into two segments to leave the goal opening.
  // Left
  bodies.push(Bodies.rectangle(-WT / 2, sideH / 2, WT, sideH, WALL_OPTS));
  bodies.push(Bodies.rectangle(-WT / 2, H - sideH / 2, WT, sideH, WALL_OPTS));
  // Right
  bodies.push(Bodies.rectangle(W + WT / 2, sideH / 2, WT, sideH, WALL_OPTS));
  bodies.push(Bodies.rectangle(W + WT / 2, H - sideH / 2, WT, sideH, WALL_OPTS));

  // Goal pockets (closed on three sides so the ball stays inside after scoring).
  // Left pocket
  bodies.push(Bodies.rectangle(-GD - WT / 2, H / 2, WT, GH + 2 * WT, WALL_OPTS)); // back
  bodies.push(Bodies.rectangle(-GD / 2, (H - GH) / 2 - WT / 2, GD + WT, WT, WALL_OPTS)); // top
  bodies.push(Bodies.rectangle(-GD / 2, (H + GH) / 2 + WT / 2, GD + WT, WT, WALL_OPTS)); // bottom
  // Right pocket
  bodies.push(Bodies.rectangle(W + GD + WT / 2, H / 2, WT, GH + 2 * WT, WALL_OPTS));
  bodies.push(Bodies.rectangle(W + GD / 2, (H - GH) / 2 - WT / 2, GD + WT, WT, WALL_OPTS));
  bodies.push(Bodies.rectangle(W + GD / 2, (H + GH) / 2 + WT / 2, GD + WT, WT, WALL_OPTS));

  for (const b of bodies) b.label = 'wall';
  return bodies;
}

function kickoffSpot(team) {
  // Home spawn point for a given team (x close to their side, y mid-field).
  const { width: W, height: H } = FIELD;
  const xRed = W * 0.28;
  const xBlue = W * 0.72;
  return team === TEAMS.RED ? { x: xRed, y: H / 2 } : { x: xBlue, y: H / 2 };
}

function randomSpawnForTeam(team, index) {
  const { height: H } = FIELD;
  const base = kickoffSpot(team);
  // Stagger by index so multiple teammates don't stack on the kickoff spot.
  const offsets = [0, -80, 80, -160, 160, -40, 40, -120, 120];
  const off = offsets[index % offsets.length];
  return { x: base.x, y: Math.max(80, Math.min(H - 80, H / 2 + off)) };
}

export class Room {
  constructor(id = 'main') {
    this.id = id;
    this.engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
    this.world = this.engine.world;
    this.engine.enableSleeping = false;

    this.walls = buildArenaBodies();
    World.add(this.world, this.walls);

    this.ball = Bodies.circle(FIELD.width / 2, FIELD.height / 2, BALL.radius, {
      label: 'ball',
      restitution: BALL.restitution,
      frictionAir: BALL.friction,
      friction: 0,
      density: 0.0008,
    });
    World.add(this.world, this.ball);

    /** @type {Map<string, {id:string, name:string, team:string, body:Matter.Body, input:{dx:number,dy:number,kick:boolean}, kickUntil:number, joinedAt:number}>} */
    this.players = new Map();
    this.score = { red: 0, blue: 0 };
    this.phase = 'playing'; // 'playing' | 'celebration' | 'ended'
    this.celebrateUntil = 0;
    this.winner = null;
    this.tickCount = 0;

    // Broadcast state at a lower rate than physics tick.
    this._lastBroadcast = 0;

    Events.on(this.engine, 'collisionStart', (evt) => this._onCollision(evt));
  }

  _onCollision(/* evt */) {
    // reserved for future sfx hooks (e.g., wall/ball hits)
  }

  playerCount() {
    return this.players.size;
  }

  pickTeamForNewPlayer() {
    let red = 0;
    let blue = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAMS.RED) red++;
      else blue++;
    }
    if (red === blue) return Math.random() < 0.5 ? TEAMS.RED : TEAMS.BLUE;
    return red < blue ? TEAMS.RED : TEAMS.BLUE;
  }

  addPlayer(id, name) {
    const team = this.pickTeamForNewPlayer();
    const teammates = [...this.players.values()].filter((p) => p.team === team).length;
    const spawn = randomSpawnForTeam(team, teammates);
    const body = Bodies.circle(spawn.x, spawn.y, PLAYER.radius, {
      label: 'player',
      restitution: 0.35,
      frictionAir: PLAYER.friction,
      friction: 0,
      density: 0.002,
    });
    World.add(this.world, body);
    const player = {
      id,
      name: (name || 'Player').slice(0, 16),
      team,
      body,
      input: { dx: 0, dy: 0, kick: false },
      kickUntil: 0,
      joinedAt: Date.now(),
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    World.remove(this.world, p.body);
    this.players.delete(id);
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    const dx = clamp(Number(input?.dx) || 0, -1, 1);
    const dy = clamp(Number(input?.dy) || 0, -1, 1);
    const len = Math.hypot(dx, dy);
    const ndx = len > 1 ? dx / len : dx;
    const ndy = len > 1 ? dy / len : dy;
    p.input.dx = ndx;
    p.input.dy = ndy;
    p.input.kick = Boolean(input?.kick);
  }

  reset(lastGoalBy = null) {
    Body.setVelocity(this.ball, { x: 0, y: 0 });
    Body.setAngularVelocity(this.ball, 0);
    Body.setPosition(this.ball, { x: FIELD.width / 2, y: FIELD.height / 2 });

    // Give a tiny nudge toward the team that conceded, to vary kickoff.
    if (lastGoalBy === TEAMS.RED) {
      Body.setVelocity(this.ball, { x: -0.6, y: (Math.random() - 0.5) * 0.4 });
    } else if (lastGoalBy === TEAMS.BLUE) {
      Body.setVelocity(this.ball, { x: 0.6, y: (Math.random() - 0.5) * 0.4 });
    }

    // Respawn players on their kickoff lines.
    const redPlayers = [...this.players.values()].filter((p) => p.team === TEAMS.RED);
    const bluePlayers = [...this.players.values()].filter((p) => p.team === TEAMS.BLUE);
    redPlayers.forEach((p, i) => this._respawn(p, i));
    bluePlayers.forEach((p, i) => this._respawn(p, i));
  }

  _respawn(player, index) {
    const spawn = randomSpawnForTeam(player.team, index);
    Body.setVelocity(player.body, { x: 0, y: 0 });
    Body.setAngularVelocity(player.body, 0);
    Body.setPosition(player.body, spawn);
  }

  restartMatch() {
    this.score = { red: 0, blue: 0 };
    this.winner = null;
    this.phase = 'playing';
    this.reset(null);
  }

  step(dtMs) {
    const now = Date.now();

    // Handle celebration phase: freeze inputs until reset delay elapses.
    if (this.phase === 'celebration') {
      if (now >= this.celebrateUntil) {
        if (this.score.red >= WORLD.scoreToWin || this.score.blue >= WORLD.scoreToWin) {
          this.phase = 'ended';
          this.winner = this.score.red > this.score.blue ? TEAMS.RED : TEAMS.BLUE;
        } else {
          this.phase = 'playing';
        }
        this.reset(this._lastGoalBy || null);
      }
    }

    if (this.phase === 'playing') {
      // Apply inputs: target velocity, lerp current velocity toward it for snappy but smooth motion.
      for (const p of this.players.values()) {
        const { dx, dy, kick } = p.input;
        const targetVx = dx * PLAYER.maxSpeed;
        const targetVy = dy * PLAYER.maxSpeed;
        const v = p.body.velocity;
        const nvx = v.x + (targetVx - v.x) * PLAYER.accel;
        const nvy = v.y + (targetVy - v.y) * PLAYER.accel;
        Body.setVelocity(p.body, { x: nvx, y: nvy });

        if (kick && now >= p.kickUntil) {
          const bx = this.ball.position.x;
          const by = this.ball.position.y;
          const px = p.body.position.x;
          const py = p.body.position.y;
          const dist = Math.hypot(bx - px, by - py);
          const reach = PLAYER.radius + BALL.radius + PLAYER.kickRange;
          if (dist <= reach && dist > 0.0001) {
            const nx = (bx - px) / dist;
            const ny = (by - py) / dist;
            // Blend in a bit of the player's input direction to allow curved shots.
            const ix = dx || nx;
            const iy = dy || ny;
            const ilen = Math.hypot(ix, iy) || 1;
            const mix = 0.7;
            const fx = (nx * (1 - mix) + (ix / ilen) * mix);
            const fy = (ny * (1 - mix) + (iy / ilen) * mix);
            const flen = Math.hypot(fx, fy) || 1;
            const impulse = PLAYER.kickImpulse;
            this.ball.force.x += (fx / flen) * impulse;
            this.ball.force.y += (fy / flen) * impulse;
            p.kickUntil = now + PLAYER.kickCooldownMs;
          }
        }
      }

      Engine.update(this.engine, dtMs);

      // Goal detection (ball center fully past the goal line).
      const bx = this.ball.position.x;
      if (bx < -BALL.radius) {
        this._scoreGoal(TEAMS.BLUE);
      } else if (bx > FIELD.width + BALL.radius) {
        this._scoreGoal(TEAMS.RED);
      }
    }

    this.tickCount++;
  }

  _scoreGoal(team) {
    if (team === TEAMS.RED) this.score.red++;
    else this.score.blue++;
    this._lastGoalBy = team;
    this.phase = 'celebration';
    this.celebrateUntil = Date.now() + WORLD.goalResetDelayMs;
    Body.setVelocity(this.ball, { x: 0, y: 0 });
  }

  snapshot() {
    return {
      t: Date.now(),
      tick: this.tickCount,
      phase: this.phase,
      winner: this.winner,
      score: { ...this.score },
      lastGoalBy: this._lastGoalBy || null,
      ball: {
        x: round2(this.ball.position.x),
        y: round2(this.ball.position.y),
        vx: round2(this.ball.velocity.x),
        vy: round2(this.ball.velocity.y),
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        x: round2(p.body.position.x),
        y: round2(p.body.position.y),
        vx: round2(p.body.velocity.x),
        vy: round2(p.body.velocity.y),
        kick: p.input.kick,
      })),
    };
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
