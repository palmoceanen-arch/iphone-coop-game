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
const btnShop = document.getElementById('btnShop');
const btnAbility = document.getElementById('btnAbility');
const btnInteract = document.getElementById('btnInteract');
const interactLabelEl = document.getElementById('interactLabel');
const itemBarEl = document.getElementById('itemBar');
const shopOverlay = document.getElementById('shopOverlay');
const shopList = document.getElementById('shopList');
const shopClose = document.getElementById('shopClose');

// Pre-cache cooldown circle circumference (radius=44 → C ≈ 276.46)
const ABILITY_CD_CIRC = 2 * Math.PI * 44;

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

// Shop button: toggle (no held-state). Tap → emit 'shop' event.
btnShop.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  btnShop.classList.add('pressed');
  btnShop.setPointerCapture(e.pointerId);
  if (navigator.vibrate) navigator.vibrate(10);
  if (assignedSlot >= 0) socket.emit('input:event', { type: 'shop' });
});
const shopRelease = () => btnShop.classList.remove('pressed');
btnShop.addEventListener('pointerup', shopRelease);
btnShop.addEventListener('pointercancel', shopRelease);
btnShop.addEventListener('pointerleave', shopRelease);

// Ability button: tap → emit 'cast' event (host enforces cooldown).
btnAbility.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (btnAbility.classList.contains('empty') || btnAbility.classList.contains('cooling')) return;
  btnAbility.classList.add('pressed');
  btnAbility.setPointerCapture(e.pointerId);
  if (navigator.vibrate) navigator.vibrate(20);
  if (assignedSlot >= 0) socket.emit('input:event', { type: 'cast' });
});
const abilityRelease = () => btnAbility.classList.remove('pressed');
btnAbility.addEventListener('pointerup', abilityRelease);
btnAbility.addEventListener('pointercancel', abilityRelease);
btnAbility.addEventListener('pointerleave', abilityRelease);

// Interact button: only visible when host says something is nearby.
btnInteract.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!btnInteract.classList.contains('show')) return;
  btnInteract.classList.add('pressed');
  btnInteract.setPointerCapture(e.pointerId);
  if (navigator.vibrate) navigator.vibrate(20);
  if (assignedSlot >= 0) socket.emit('input:event', { type: 'interact' });
});
const interactRelease = () => btnInteract.classList.remove('pressed');
btnInteract.addEventListener('pointerup', interactRelease);
btnInteract.addEventListener('pointercancel', interactRelease);
btnInteract.addEventListener('pointerleave', interactRelease);

shopClose.addEventListener('click', (e) => {
  e.preventDefault();
  if (assignedSlot >= 0) socket.emit('input:event', { type: 'closeShop' });
});

// ----------------------------------------------------------------------
// Player-state push from host: render HUD + shop list.
// ----------------------------------------------------------------------
let _itemBarSig = '';
function renderItemBar(items) {
  items = items || [];
  const sig = items.map(it => `${it.id}:${it.count}`).join('|');
  if (sig === _itemBarSig) return;
  _itemBarSig = sig;
  itemBarEl.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('span');
    el.className = 'item-icon';
    if (it.rarity) el.dataset.rar = it.rarity;
    el.title = it.name || it.id;
    el.innerHTML = `<span class="ico">${it.icon || '?'}</span><span class="count">×${it.count}</span>`;
    itemBarEl.appendChild(el);
  }
}

let _abilitySig = '';
const abilityIconEl = btnAbility.querySelector('.ab-icon');
const abilityCdTextEl = btnAbility.querySelector('.ab-cd-text');
const abilityCdCircle = btnAbility.querySelector('.ab-cd-svg circle');
abilityCdCircle.setAttribute('stroke-dasharray', String(ABILITY_CD_CIRC));
abilityCdCircle.setAttribute('stroke-dashoffset', String(ABILITY_CD_CIRC));

// Server pushes state at ~4Hz; we tick the cooldown locally for a smooth UI.
let _abilityState = null; // { id, color, icon, cd, cdMax, lastSyncT }

function renderAbility(ab) {
  const sig = ab ? `${ab.id}:${ab.color}` : '';
  if (sig !== _abilitySig) {
    _abilitySig = sig;
    if (ab) {
      abilityIconEl.textContent = ab.icon || '✦';
      btnAbility.classList.remove('empty');
      btnAbility.style.background = `linear-gradient(180deg, ${hexToRgba(ab.color, 0.55)} 0%, ${hexToRgba(ab.color, 0.35)} 100%)`;
      btnAbility.style.borderColor = hexToRgba(ab.color, 0.8);
    } else {
      abilityIconEl.textContent = '·';
      btnAbility.classList.add('empty');
      btnAbility.style.background = '';
      btnAbility.style.borderColor = '';
    }
  }
  if (!ab) {
    _abilityState = null;
    abilityCdTextEl.textContent = '';
    abilityCdCircle.setAttribute('stroke-dashoffset', String(ABILITY_CD_CIRC));
    btnAbility.classList.remove('cooling');
    return;
  }
  _abilityState = {
    cd: Math.max(0, ab.cd || 0),
    cdMax: Math.max(0.01, ab.cdMax || 1),
    lastSyncT: performance.now() / 1000,
  };
}

function tickAbilityCd() {
  if (_abilityState) {
    const now = performance.now() / 1000;
    const elapsed = now - _abilityState.lastSyncT;
    const cd = Math.max(0, _abilityState.cd - elapsed);
    const ratio = Math.min(1, cd / _abilityState.cdMax);
    abilityCdCircle.setAttribute('stroke-dashoffset', String(ABILITY_CD_CIRC * (1 - ratio)));
    if (cd > 0.05) {
      abilityCdTextEl.textContent = cd >= 1 ? Math.ceil(cd).toString() : cd.toFixed(1);
      btnAbility.classList.add('cooling');
    } else {
      abilityCdTextEl.textContent = '';
      btnAbility.classList.remove('cooling');
    }
  }
  requestAnimationFrame(tickAbilityCd);
}
requestAnimationFrame(tickAbilityCd);

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${a})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

function renderInteract(prompt) {
  if (prompt && prompt.label) {
    interactLabelEl.textContent = prompt.label;
    btnInteract.classList.add('show');
    btnInteract.style.borderColor = prompt.color || '#ffd166';
  } else {
    btnInteract.classList.remove('show');
  }
}

socket.on('state:player', (s) => {
  if (!s || typeof s.slot !== 'number') return;
  document.getElementById('stHp').textContent = s.hp;
  document.getElementById('stMaxHp').textContent = s.maxHp;
  document.getElementById('stGold').textContent = s.gold;
  document.getElementById('stDmg').textContent = s.damage;
  document.getElementById('shopHp').textContent = s.hp;
  document.getElementById('shopMaxHp').textContent = s.maxHp;
  document.getElementById('shopGold').textContent = s.gold;
  shopOverlay.classList.toggle('open', !!s.shopOpen);
  renderItemBar(s.items);
  renderAbility(s.ability);
  renderInteract(s.interact);
  // Render upgrades list
  shopList.innerHTML = '';
  for (const u of (s.upgrades || [])) {
    const can = s.gold >= u.price;
    const row = document.createElement('div');
    row.className = 'upg-row' + (can ? '' : ' locked');
    row.innerHTML = `
      <div>
        <div class="name">${u.name} <span class="lvl">Lv ${u.level}</span></div>
        <div class="desc">${u.desc}</div>
      </div>
      <button class="price-btn" data-id="${u.id}">⛁ ${u.price}</button>
    `;
    shopList.appendChild(row);
  }
});

shopList.addEventListener('click', (e) => {
  const btn = e.target.closest('.price-btn');
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.id;
  if (id && assignedSlot >= 0) {
    if (navigator.vibrate) navigator.vibrate(20);
    socket.emit('input:event', { type: 'buy', id });
  }
});

// Send state at ~30Hz
setInterval(() => {
  if (assignedSlot < 0) return;
  socket.volatile.emit('input:state', state);
}, 1000 / 30);

// ----------------------------------------------------------------------
// Aggressively suppress iOS Safari gestures: pinch-zoom, double-tap-zoom,
// swipe-back, pull-to-refresh, long-press context menu, callouts.
// ----------------------------------------------------------------------
function isInteractive(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return true;
  // Allow scrolling inside the shop overlay
  if (el.closest && el.closest('.shop-overlay')) return true;
  return false;
}

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// Block multi-touch (pinch) and any non-interactive touch from scrolling/zooming.
document.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) { e.preventDefault(); return; }
  if (!isInteractive(e.target)) e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', (e) => {
  if (!isInteractive(e.target)) e.preventDefault();
}, { passive: false });
document.addEventListener('touchend', (e) => {
  if (!isInteractive(e.target)) e.preventDefault();
}, { passive: false });

// Manual double-tap-zoom guard for older iOS that ignores user-scalable=no.
let _lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - _lastTouchEnd < 350) e.preventDefault();
  _lastTouchEnd = now;
}, { passive: false });

window.addEventListener('beforeunload', () => { try { socket.disconnect(); } catch { /* ignore */ } });

// Visual: started flag could be used to reduce hint visibility
void started;
