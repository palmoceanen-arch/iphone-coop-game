// Shared between server and client. Must stay ES-module compatible.
export const FIELD = {
  width: 1200,
  height: 700,
  // Goals are cut into the left/right walls.
  goalHeight: 240,
  goalDepth: 40,
  wallThickness: 20,
};

export const PLAYER = {
  radius: 22,
  maxSpeed: 5.0,        // target speed (px/frame at 60 Hz)
  accel: 0.45,          // how fast the player reaches target speed
  friction: 0.08,       // linear damping when no input
  kickRange: 18,        // extra radius beyond player radius where ball can be kicked
  kickImpulse: 0.010,   // impulse magnitude applied to ball
  kickCooldownMs: 260,
};

export const BALL = {
  radius: 14,
  friction: 0.012,      // rolling friction (air friction in Matter: frictionAir)
  restitution: 0.72,
};

export const WORLD = {
  tickHz: 60,
  broadcastHz: 30,
  maxPlayersPerRoom: 10,
  scoreToWin: 5,
  goalResetDelayMs: 1600,
};

export const TEAMS = {
  RED: 'red',
  BLUE: 'blue',
};

export const COLORS = {
  red: '#e14b4b',
  blue: '#4b7ae1',
  ball: '#ffffff',
  field: '#2d6a4f',
  fieldStripe: '#31775a',
  wall: '#1b4332',
  goalLine: '#ffffff',
  redGoal: 'rgba(225, 75, 75, 0.22)',
  blueGoal: 'rgba(75, 122, 225, 0.22)',
};
