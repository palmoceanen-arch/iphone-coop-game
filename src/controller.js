import { io } from 'socket.io-client';

const PLAYER_COLORS = ['#6ad0ff', '#ff8a8a'];
const PLAYER_NAMES = ['Cyan', 'Coral'];

const lobby = document.getElementById('lobby');
const controllerEl = document.getElementById('controller');
const statusEl = document.getElementById('status');
const errEl = document.getElementById('err');
const codeInput = document.getElementById('code');
const joinBtn = document.getElementById('join');
const roomCodeEl = document.getElementById('roomcode');
const playerSpan = controllerEl.querySelector('.badge .p');
const hintEl = document.getElementById('hint');

const stick = document.getElementById('stick');
const knob = document.getElementById('knob');
const btnAttack = document.getElementById('btnAttack');
const btnDash = document.getElementById('btnDash');

const socket = io({ transports: ['websocket', 'polling'] });

let state = {
  moveX: 0,
  moveZ: 0,
  attack: false,
  dash: false,
};
let assignedSlot = -1;
let started = false;

// Pre-fill code from URL ?code=XXXX
const initialCode = new URLSearchParams(location.search).get('code');
if (initialCode) {
  codeInput.value = initialCode.toUpperCase().slice(0, 4);
}
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
joinBtn.addEventListener('click', tryJoin);

function tryJoin() {
  const code = (codeInput.value || '').trim().toUpperCase();
  if (code.length !== 4) {
    errEl.textContent = 'Код состоит из 4 символов';
    return;
  }
  errEl.textContent = '';
  joinBtn.disabled = true;
  socket.emit('controller:join', { code });
}

socket.on('connect_error', () => {
  errEl.textContent = 'Не удалось подключиться к серверу';
  joinBtn.disabled = false;
});

socket.on('controller:rejected', ({ reason }) => {
  joinBtn.disabled = false;
  errEl.textContent = reason === 'no-room' ? 'Комната не найдена' : reason === 'full' ? 'Комната уже заполнена' : 'Не удалось подключиться';
});

socket.on('controller:assigned', ({ slot, code }) => {
  assignedSlot = slot;
  lobby.style.display = 'none';
  controllerEl.style.display = 'block';
  controllerEl.classList.add(slot === 0 ? 'p1' : 'p2');
  playerSpan.textContent = PLAYER_NAMES[slot];
  playerSpan.style.color = PLAYER_COLORS[slot];
  roomCodeEl.textContent = code;
  hintEl.style.display = 'block';

  // Try to lock orientation to landscape on iOS — best effort, ignored if not supported.
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }
});

socket.on('host:started', () => {
  started = true;
  statusEl.textContent = 'Игра идёт';
  hintEl.style.display = 'none';
  // Vibrate for feedback
  if (navigator.vibrate) navigator.vibrate(60);
});

socket.on('host:disconnected', () => {
  started = false;
  statusEl.textContent = 'Хост отключился';
});

socket.on('host:ended', () => {
  started = false;
  statusEl.textContent = 'Игра окончена';
});

// ----------------------------------------------------------------------
// Joystick: track touch deltas inside the .joystick element.
// ----------------------------------------------------------------------
const STICK_RADIUS = 70; // pixels — knob travel
const stickState = { active: false, baseX: 0, baseY: 0, pointerId: -1 };

function setKnob(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len > STICK_RADIUS) {
    dx = (dx / len) * STICK_RADIUS;
    dy = (dy / len) * STICK_RADIUS;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  state.moveX = dx / STICK_RADIUS;
  state.moveZ = dy / STICK_RADIUS; // dy positive = down on screen = forward in world
}

stick.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  stickState.active = true;
  stickState.pointerId = e.pointerId;
  const rect = stick.getBoundingClientRect();
  stickState.baseX = rect.left + rect.width / 2;
  stickState.baseY = rect.top + rect.height / 2;
  setKnob(e.clientX - stickState.baseX, e.clientY - stickState.baseY);
  stick.setPointerCapture(e.pointerId);
});
stick.addEventListener('pointermove', (e) => {
  if (!stickState.active || e.pointerId !== stickState.pointerId) return;
  setKnob(e.clientX - stickState.baseX, e.clientY - stickState.baseY);
});
function endStick(e) {
  if (e.pointerId !== stickState.pointerId) return;
  stickState.active = false;
  stickState.pointerId = -1;
  setKnob(0, 0);
}
stick.addEventListener('pointerup', endStick);
stick.addEventListener('pointercancel', endStick);
stick.addEventListener('pointerleave', endStick);

// ----------------------------------------------------------------------
// Action buttons (attack, dash).
// ----------------------------------------------------------------------
function bindButton(el, key, eventName) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    state[key] = true;
    el.classList.add('pressed');
    el.setPointerCapture(e.pointerId);
    if (navigator.vibrate) navigator.vibrate(10);
    if (assignedSlot >= 0) socket.emit('input:event', { type: eventName });
  });
  const release = () => { state[key] = false; el.classList.remove('pressed'); };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}
bindButton(btnAttack, 'attack', 'attack');
bindButton(btnDash, 'dash', 'dash');

// Send state at ~30Hz
setInterval(() => {
  if (assignedSlot < 0) return;
  socket.volatile.emit('input:state', state);
}, 1000 / 30);

// Suppress iOS Safari pull-to-refresh / context menus
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('beforeunload', () => { try { socket.disconnect(); } catch { /* ignore */ } });

// Visual: started flag could be used to reduce hint visibility
void started;
