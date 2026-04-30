// PhysBall Arena — browser client. Handles menu, input, socket, rendering.
import { io } from '/socket.io/socket.io.esm.min.js';
import { FIELD, PLAYER, BALL, COLORS, TEAMS } from '/shared/constants.js';

const INTERP_DELAY_MS = 100; // render 100ms in the past for smooth interpolation

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const screenMenu = $('screen-menu');
const screenGame = $('screen-game');
const nicknameInput = $('nickname');
const btnPlay = $('btn-play');
const btnLeave = $('btn-leave');
const menuHint = $('menu-hint');
const scoreRedEl = $('score-red');
const scoreBlueEl = $('score-blue');
const playersCountEl = $('players-count');
const pingEl = $('ping');
const canvas = /** @type {HTMLCanvasElement} */ ($('game'));
const ctx = canvas.getContext('2d');
const banner = $('banner');
const touchRoot = $('touch');
const stick = $('stick');
const stickThumb = $('stick-thumb');
const btnKick = $('btn-kick');

canvas.width = FIELD.width + FIELD.goalDepth * 2 + 40;
canvas.height = FIELD.height + 40;

// Persist nickname in localStorage for a nicer UX.
try {
  nicknameInput.value = localStorage.getItem('physball:name') || '';
} catch {
  /* ignore */
}

// ---------- State ----------
/** @type {ReturnType<typeof io> | null} */
let socket = null;
let selfId = null;

/** Buffer of recent server snapshots (oldest first). */
const snapshots = [];
const MAX_SNAPSHOTS = 30;
// Offset between Date.now() on client and snapshot .t from server.
let serverTimeOffset = 0;

// Latest HUD-only state (doesn't need interpolation).
let hudState = { score: { red: 0, blue: 0 }, phase: 'playing', winner: null, lastGoalBy: null };

// Input
const keys = new Set();
const touchInput = { active: false, dx: 0, dy: 0, kick: false };
let lastSentInput = { dx: 0, dy: 0, kick: false };
let lastInputSentAt = 0;



// ---------- Touch detection ----------
const isTouchDevice = matchMedia('(hover: none) and (pointer: coarse)').matches;
if (isTouchDevice) {
  touchRoot.classList.remove('hidden');
  touchRoot.classList.add('active');
}

// ---------- Menu wiring ----------
btnPlay.addEventListener('click', onPlay);
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onPlay();
});
btnLeave.addEventListener('click', () => {
  if (socket) socket.disconnect();
  showMenu('Left the match.');
});

function showMenu(hint = '') {
  screenGame.classList.add('hidden');
  screenMenu.classList.remove('hidden');
  banner.classList.add('hidden');
  menuHint.textContent = hint;
}

function showGame() {
  screenMenu.classList.add('hidden');
  screenGame.classList.remove('hidden');
}

function onPlay() {
  const name = (nicknameInput.value || '').trim() || 'Player';
  try {
    localStorage.setItem('physball:name', name);
  } catch {
    /* ignore */
  }
  btnPlay.disabled = true;
  menuHint.textContent = 'Connecting…';
  connect(name);
}

function connect(name) {
  socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
  });

  socket.on('connect', () => {
    socket.emit('join', { name });
  });

  socket.on('joined', (info) => {
    selfId = info.id;
    btnPlay.disabled = false;
    showGame();
    startGameLoop();
  });

  socket.on('join_rejected', (info) => {
    btnPlay.disabled = false;
    menuHint.textContent =
      info?.reason === 'room_full' ? 'Room is full — try again shortly.' : 'Could not join.';
    socket.disconnect();
  });

  socket.on('state', onState);

  socket.on('disconnect', () => {
    if (!screenMenu.classList.contains('hidden')) return;
    showMenu('Disconnected.');
  });

  socket.on('connect_error', () => {
    btnPlay.disabled = false;
    menuHint.textContent = 'Connection error. Retry?';
  });
}

function onState(snap) {
  const now = Date.now();
  serverTimeOffset = snap.t - now; // positive if server ahead

  snapshots.push(snap);
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

  hudState = {
    score: snap.score,
    phase: snap.phase,
    winner: snap.winner,
    lastGoalBy: snap.lastGoalBy,
  };

  scoreRedEl.textContent = String(snap.score.red);
  scoreBlueEl.textContent = String(snap.score.blue);
  playersCountEl.textContent = String(snap.players.length);
  pingEl.textContent = `${Math.max(0, Math.round(now - (snap.t - serverTimeOffset)))} ms`;

  updateBanner(snap);
}

function updateBanner(snap) {
  if (snap.phase === 'celebration') {
    const team = snap.lastGoalBy;
    banner.className = `banner win-${team}`;
    banner.textContent = team === TEAMS.RED ? 'GOAL — Red scores!' : 'GOAL — Blue scores!';
    banner.classList.remove('hidden');
  } else if (snap.phase === 'ended') {
    banner.className = `banner win-${snap.winner}`;
    banner.textContent = `${snap.winner === TEAMS.RED ? 'RED' : 'BLUE'} WINS — press R for rematch`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ---------- Input ----------
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys.add(e.key.toLowerCase());
  if (e.key.toLowerCase() === 'r' && socket && hudState.phase === 'ended') {
    socket.emit('restart');
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => keys.clear());

// Touch joystick
let stickTouchId = null;
let stickCenter = { x: 0, y: 0 };
const stickRadius = 60;

function setThumb(dx, dy) {
  stickThumb.style.transform = `translate(${dx}px, ${dy}px)`;
}

stick.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  stickTouchId = e.pointerId;
  const rect = stick.getBoundingClientRect();
  stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  touchInput.active = true;
  stick.setPointerCapture?.(e.pointerId);
});
stick.addEventListener('pointermove', (e) => {
  if (stickTouchId !== e.pointerId) return;
  const dx = e.clientX - stickCenter.x;
  const dy = e.clientY - stickCenter.y;
  const len = Math.hypot(dx, dy);
  const max = stickRadius;
  const clamped = len > max ? max : len;
  const ndx = len > 0 ? (dx / len) * clamped : 0;
  const ndy = len > 0 ? (dy / len) * clamped : 0;
  setThumb(ndx, ndy);
  // Dead zone at 10% of radius
  const dead = max * 0.1;
  if (len < dead) {
    touchInput.dx = 0;
    touchInput.dy = 0;
  } else {
    touchInput.dx = ndx / max;
    touchInput.dy = ndy / max;
  }
});
function endStick(e) {
  if (stickTouchId !== e.pointerId) return;
  stickTouchId = null;
  touchInput.active = false;
  touchInput.dx = 0;
  touchInput.dy = 0;
  setThumb(0, 0);
}
stick.addEventListener('pointerup', endStick);
stick.addEventListener('pointercancel', endStick);
stick.addEventListener('pointerleave', endStick);

// Touch kick
btnKick.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  touchInput.kick = true;
});
function releaseKick() {
  touchInput.kick = false;
}
btnKick.addEventListener('pointerup', releaseKick);
btnKick.addEventListener('pointercancel', releaseKick);
btnKick.addEventListener('pointerleave', releaseKick);

function readInput() {
  let dx = 0;
  let dy = 0;
  if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
  if (keys.has('arrowright') || keys.has('d')) dx += 1;
  if (keys.has('arrowup') || keys.has('w')) dy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) dy += 1;
  let kick = keys.has(' ') || keys.has('x') || keys.has('enter');

  // Touch overrides if active
  if (touchInput.active || Math.hypot(touchInput.dx, touchInput.dy) > 0.01) {
    dx = touchInput.dx;
    dy = touchInput.dy;
  }
  if (touchInput.kick) kick = true;

  // Normalize diagonal keyboard input to length 1.
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  return { dx, dy, kick };
}

function sendInputIfNeeded() {
  if (!socket || !socket.connected) return;
  const input = readInput();
  const now = performance.now();
  const changed =
    Math.abs(input.dx - lastSentInput.dx) > 0.02 ||
    Math.abs(input.dy - lastSentInput.dy) > 0.02 ||
    input.kick !== lastSentInput.kick;
  // Always send at least every 100ms to keep server happy.
  if (changed || now - lastInputSentAt > 100) {
    socket.emit('input', input);
    lastSentInput = input;
    lastInputSentAt = now;
  }
}

// ---------- Render loop ----------
let rafId = 0;
function startGameLoop() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    sendInputIfNeeded();
    render();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function interpolatedSnapshot() {
  if (snapshots.length === 0) return null;
  // renderTime is server time slightly in the past
  const renderT = Date.now() + serverTimeOffset - INTERP_DELAY_MS;
  // Find two snapshots straddling renderT
  let a = snapshots[0];
  let b = snapshots[snapshots.length - 1];
  for (let i = 0; i < snapshots.length - 1; i++) {
    if (snapshots[i].t <= renderT && snapshots[i + 1].t >= renderT) {
      a = snapshots[i];
      b = snapshots[i + 1];
      break;
    }
  }
  if (a === b || b.t === a.t) return b;
  const alpha = Math.max(0, Math.min(1, (renderT - a.t) / (b.t - a.t)));

  const byId = new Map();
  for (const p of a.players) byId.set(p.id, { a: p });
  for (const p of b.players) {
    const cur = byId.get(p.id) || {};
    cur.b = p;
    byId.set(p.id, cur);
  }
  const players = [];
  for (const [, v] of byId) {
    if (v.a && v.b) {
      players.push({
        id: v.b.id,
        name: v.b.name,
        team: v.b.team,
        x: lerp(v.a.x, v.b.x, alpha),
        y: lerp(v.a.y, v.b.y, alpha),
        kick: v.b.kick,
      });
    } else if (v.b) {
      players.push(v.b);
    }
  }
  const ball = {
    x: lerp(a.ball.x, b.ball.x, alpha),
    y: lerp(a.ball.y, b.ball.y, alpha),
  };
  return { t: renderT, phase: b.phase, players, ball };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Cached viewport transform (recomputed on resize).
function getTransform() {
  const ow = canvas.clientWidth;
  const oh = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(ow * ratio) || canvas.height !== Math.round(oh * ratio)) {
    canvas.width = Math.round(ow * ratio);
    canvas.height = Math.round(oh * ratio);
  }
  // World width includes goal pockets (+/- goalDepth).
  const worldW = FIELD.width + FIELD.goalDepth * 2 + 40;
  const worldH = FIELD.height + 40;
  const sx = canvas.width / worldW;
  const sy = canvas.height / worldH;
  const s = Math.min(sx, sy);
  const tx = (canvas.width - worldW * s) / 2;
  const ty = (canvas.height - worldH * s) / 2;
  return { s, tx, ty };
}

function render() {
  const snap = interpolatedSnapshot();
  const { s, tx, ty } = getTransform();
  ctx.save();
  ctx.fillStyle = '#0b1f16';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.translate(tx, ty);
  ctx.scale(s, s);
  // Shift origin so the pitch (0,0) starts after the left goal pocket + margin.
  ctx.translate(FIELD.goalDepth + 20, 20);

  drawPitch();

  if (snap) {
    drawBall(snap.ball);
    for (const p of snap.players) drawPlayer(p);
  }

  ctx.restore();
}

function drawPitch() {
  const { width: W, height: H, goalHeight: GH, goalDepth: GD } = FIELD;

  // Grass with stripes
  ctx.fillStyle = COLORS.field;
  ctx.fillRect(-GD, 0, W + 2 * GD, H);
  ctx.fillStyle = COLORS.fieldStripe;
  const stripe = 80;
  for (let x = 0; x < W; x += stripe * 2) {
    ctx.fillRect(x, 0, stripe, H);
  }

  // Center line + circle
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 80, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fill();

  // Penalty / goal box hints
  ctx.strokeRect(0, (H - GH - 100) / 2, 120, GH + 100);
  ctx.strokeRect(W - 120, (H - GH - 100) / 2, 120, GH + 100);

  // Goal pockets (tinted)
  ctx.fillStyle = COLORS.redGoal;
  ctx.fillRect(-GD, (H - GH) / 2, GD, GH);
  ctx.fillStyle = COLORS.blueGoal;
  ctx.fillRect(W, (H - GH) / 2, GD, GH);

  // Pocket outlines (simulate nets)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  drawNet(-GD, (H - GH) / 2, GD, GH);
  drawNet(W, (H - GH) / 2, GD, GH);

  // Outer pitch outline
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, W, H);

  // Goal lines
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, (H - GH) / 2);
  ctx.lineTo(0, (H + GH) / 2);
  ctx.moveTo(W, (H - GH) / 2);
  ctx.lineTo(W, (H + GH) / 2);
  ctx.stroke();
}

function drawNet(x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  const step = 10;
  for (let i = -h; i < w + h; i += step) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

function drawBall(ball) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL.radius, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.ball;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#222';
  ctx.stroke();
  // Pentagon hint
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(p) {
  const isSelf = p.id === selfId;
  const color = p.team === TEAMS.RED ? COLORS.red : COLORS.blue;
  ctx.save();
  // Shadow
  ctx.beginPath();
  ctx.arc(p.x + 2, p.y + 3, PLAYER.radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  // Body
  ctx.beginPath();
  ctx.arc(p.x, p.y, PLAYER.radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // Kicking flash
  if (p.kick) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER.radius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  // Self ring
  if (isSelf) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER.radius + 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Border
  ctx.beginPath();
  ctx.arc(p.x, p.y, PLAYER.radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Name
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(p.name || '', p.x, p.y - PLAYER.radius - 6);
  ctx.restore();
}

// Resize — canvas will re-fit via getTransform on each frame.
window.addEventListener('resize', () => {
  /* no-op: handled in render */
});

// Warn user if they leave the game screen
window.addEventListener('beforeunload', () => {
  if (socket) socket.disconnect();
});
