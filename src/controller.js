import jsQR from 'jsqr';
import { io } from 'socket.io-client';
import { iconHTML } from './icons.js';

const PLAYER_COLORS = ['#6ad0ff', '#ff8a8a'];
const PLAYER_NAMES = ['Cyan', 'Coral'];

const lobby = document.getElementById('lobby');
const controllerEl = document.getElementById('controller');
const statusEl = document.getElementById('status');
const errEl = document.getElementById('err');
const codeInput = document.getElementById('code');
const joinBtn = document.getElementById('join');
const scanQrBtn = document.getElementById('scanQr');
const scanPanel = document.getElementById('scanPanel');
const scanVideo = document.getElementById('scanVideo');
const scanStatus = document.getElementById('scanStatus');
const scanFileBtn = document.getElementById('scanFileBtn');
const scanFileInput = document.getElementById('scanFile');
const scanCloseBtn = document.getElementById('scanClose');
const detailModal = document.getElementById('detailModal');
const detailCard = document.getElementById('detailCard');
const detailIconEl = document.getElementById('detailIcon');
const detailNameEl = document.getElementById('detailName');
const detailMetaEl = document.getElementById('detailMeta');
const detailCountEl = document.getElementById('detailCount');
const detailDescEl = document.getElementById('detailDesc');
const detailCloseBtn = document.getElementById('detailClose');
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
const inventoryDrawer = document.getElementById('inventoryDrawer');
const inventoryBody = document.getElementById('inventoryBody');
const inventoryClose = document.getElementById('inventoryClose');
const shopOverlay = document.getElementById('shopOverlay');
const shopList = document.getElementById('shopList');
const shopInventory = document.createElement('div');
shopInventory.id = 'shopInventory';
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
let currentPlayerState = null;
let itemBarLimit = 12;
let inventoryOpen = false;
let scanStream = null;
let barcodeDetector = null;
let scanning = false;
let scanStarting = false;
let scanFrameHandle = 0;
const RARITY_LABELS = {
  common: 'Обычный',
  uncommon: 'Необычный',
  rare: 'Редкий',
  legendary: 'Легендарный',
};

const formatter = new Intl.NumberFormat('ru-RU');

function safeText(value) {
  return value == null ? '' : String(value);
}

function escapeHtml(s) {
  return safeText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Pre-fill code from URL ?code=XXXX
const initialCode = new URLSearchParams(location.search).get('code');
if (initialCode) {
  codeInput.value = initialCode.replace(/\D/g, '').slice(0, 4);
}
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4);
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
joinBtn.addEventListener('click', tryJoin);

function tryJoin() {
  const code = (codeInput.value || '').replace(/\D/g, '').slice(0, 4);
  if (code.length !== 4) {
    errEl.textContent = 'Код состоит из 4 цифр';
    return;
  }
  errEl.textContent = '';
  joinBtn.disabled = true;
  socket.emit('controller:join', { code });
}

function codeFromText(text) {
  if (!text) return '';
  try {
    const url = new URL(text);
    const queryCode = url.searchParams.get('code');
    if (queryCode) return queryCode.replace(/\D/g, '').slice(0, 4);
  } catch {
    // Plain QR text is also supported.
  }
  const match = text.match(/\b\d{4}\b/);
  return match ? match[0] : '';
}

function applyScannedCode(value) {
  codeInput.value = value;
  scanStatus.textContent = `Код ${value} найден, подключаемся…`;
  stopQrScanner();
  tryJoin();
}

function stopQrScanner({ keepPanel = false } = {}) {
  scanning = false;
  scanStarting = false;
  if (scanStream) {
    for (const track of scanStream.getTracks()) track.stop();
    scanStream = null;
  }
  if (scanVideo) scanVideo.srcObject = null;
  if (scanFrameHandle) {
    cancelAnimationFrame(scanFrameHandle);
    scanFrameHandle = 0;
  }
  if (!keepPanel) {
    scanPanel?.classList.remove('open');
    scanPanel?.setAttribute('aria-hidden', 'true');
  }
  if (scanQrBtn) scanQrBtn.disabled = false;
}

function detectQrFromCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(image.data, image.width, image.height);
  return codeFromText(result?.data || '');
}

function detectQrFromVideo() {
  if (!scanVideo.videoWidth || !scanVideo.videoHeight) return '';
  const canvas = document.createElement('canvas');
  canvas.width = scanVideo.videoWidth;
  canvas.height = scanVideo.videoHeight;
  canvas.getContext('2d')?.drawImage(scanVideo, 0, 0, canvas.width, canvas.height);
  return detectQrFromCanvas(canvas);
}

async function scanLoop() {
  if (!scanning || !scanVideo) return;
  try {
    let value = '';
    if (barcodeDetector) {
      try {
        const codes = await barcodeDetector.detect(scanVideo);
        value = codes.map(code => code.rawValue).map(codeFromText).find(Boolean) || '';
      } catch {
        // Some platforms claim BarcodeDetector support but throw at runtime.
        // Disable it for the rest of the session and fall back to jsQR.
        barcodeDetector = null;
      }
    }
    value = value || detectQrFromVideo();
    if (value) {
      applyScannedCode(value);
      return;
    }
  } catch {
    // Ignore frame-level decode errors; the next frame will retry.
  }
  if (scanning) scanFrameHandle = requestAnimationFrame(scanLoop);
}

function openScanPanel() {
  scanPanel.classList.add('open');
  scanPanel.setAttribute('aria-hidden', 'false');
}

async function startQrScanner() {
  // Prevent double-start while getUserMedia is still resolving.
  if (scanStarting || scanning) return;
  scanStarting = true;
  if (scanQrBtn) scanQrBtn.disabled = true;
  openScanPanel();
  scanStatus.textContent = 'Запрашиваем доступ к камере…';
  if (!navigator.mediaDevices?.getUserMedia) {
    scanStatus.textContent = 'Камера недоступна на этой странице. Загрузи фото QR или введи 4 цифры.';
    scanStarting = false;
    if (scanQrBtn) scanQrBtn.disabled = false;
    return;
  }
  // Modern Safari requires a secure context (HTTPS or localhost) for camera access.
  if (window.isSecureContext === false) {
    scanStatus.textContent = 'Камера доступна только на HTTPS или localhost. Загрузи фото QR или введи 4 цифры.';
    scanStarting = false;
    if (scanQrBtn) scanQrBtn.disabled = false;
    return;
  }
  try {
    if (!barcodeDetector && 'BarcodeDetector' in window) {
      try {
        barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        barcodeDetector = null;
      }
    }
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    scanVideo.srcObject = scanStream;
    try { await scanVideo.play(); } catch { /* iOS sometimes throws even on success */ }
    scanning = true;
    scanStarting = false;
    if (scanQrBtn) scanQrBtn.disabled = false;
    scanStatus.textContent = 'Наведи камеру на QR-код комнаты.';
    scanFrameHandle = requestAnimationFrame(scanLoop);
  } catch (err) {
    stopQrScanner({ keepPanel: true });
    const name = String(err?.name || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      scanStatus.textContent = 'Доступ к камере запрещён. Загрузи фото QR или введи 4 цифры.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      scanStatus.textContent = 'Камера не найдена. Загрузи фото QR или введи 4 цифры.';
    } else {
      scanStatus.textContent = 'Камера недоступна. Загрузи фото QR или введи 4 цифры.';
    }
  }
}

scanQrBtn?.addEventListener('click', () => {
  if (scanning || scanStarting) stopQrScanner();
  else startQrScanner();
});
scanCloseBtn?.addEventListener('click', () => stopQrScanner());
scanFileBtn?.addEventListener('click', () => scanFileInput?.click());
scanFileInput?.addEventListener('change', async () => {
  const file = scanFileInput.files?.[0];
  if (!file) return;
  try {
    scanStatus.textContent = 'Распознаём QR на фото…';
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const value = detectQrFromCanvas(canvas);
    if (value) applyScannedCode(value);
    else scanStatus.textContent = 'QR на фото не найден. Попробуй другое фото или введи код.';
  } catch {
    scanStatus.textContent = 'Не удалось прочитать фото QR. Введи код вручную.';
  } finally {
    scanFileInput.value = '';
  }
});

socket.on('connect_error', () => {
  errEl.textContent = 'Не удалось подключиться к серверу';
  joinBtn.disabled = false;
});

socket.on('controller:rejected', ({ reason }) => {
  joinBtn.disabled = false;
  errEl.textContent = reason === 'no-room' ? 'Комната не найдена' : reason === 'full' ? 'Комната уже заполнена' : 'Не удалось подключиться';
});

socket.on('controller:assigned', ({ slot, code }) => {
  stopQrScanner();
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

function closeShop(e) {
  e.preventDefault();
  e.stopPropagation();
  if (assignedSlot >= 0) socket.emit('input:event', { type: 'closeShop' });
}
shopClose.addEventListener('click', closeShop);
shopClose.addEventListener('pointerdown', closeShop);

function setInventoryOpen(open) {
  inventoryOpen = !!open;
  inventoryDrawer.classList.toggle('open', inventoryOpen);
  inventoryDrawer.setAttribute('aria-hidden', inventoryOpen ? 'false' : 'true');
  controllerEl.classList.toggle('inventory-open', inventoryOpen);
  btnShop.classList.toggle('inventory-alert', inventoryOpen);
  if (inventoryOpen) renderInventory(inventoryBody, currentPlayerState);
}

itemBarEl.addEventListener('click', () => {
  if (!currentPlayerState || currentPlayerState.shopOpen) return;
  setInventoryOpen(true);
});
inventoryClose.addEventListener('click', (e) => {
  e.preventDefault();
  setInventoryOpen(false);
});

// ----------------------------------------------------------------------
// Player-state push from host: render HUD + shop list.
// ----------------------------------------------------------------------
let _itemBarSig = '';
function renderItemBar(items) {
  items = items || [];
  const visible = items.slice(0, itemBarLimit);
  const hiddenCount = Math.max(0, items.length - visible.length);
  const sig = `${itemBarLimit}|${items.map(it => `${it.id}:${it.count}`).join('|')}`;
  if (sig === _itemBarSig) return;
  _itemBarSig = sig;
  itemBarEl.innerHTML = '';
  for (const it of visible) {
    const el = document.createElement('span');
    el.className = 'item-icon';
    if (it.rarity) el.dataset.rar = it.rarity;
    el.title = `${safeText(it.name || it.id)} ×${formatter.format(it.count || 0)}`;
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.innerHTML = iconHTML(it.icon, { size: 16 });
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `×${formatter.format(it.count || 0)}`;
    el.append(ico, count);
    itemBarEl.appendChild(el);
  }
  if (hiddenCount > 0) {
    const el = document.createElement('span');
    el.className = 'item-icon more';
    el.textContent = `+${hiddenCount}`;
    el.title = 'Открыть полный инвентарь';
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
      abilityIconEl.innerHTML = iconHTML(ab.icon || 'sparkle', { size: 28 });
      btnAbility.classList.remove('empty');
      btnAbility.style.background = `linear-gradient(180deg, ${hexToRgba(ab.color, 0.55)} 0%, ${hexToRgba(ab.color, 0.35)} 100%)`;
      btnAbility.style.borderColor = hexToRgba(ab.color, 0.8);
    } else {
      abilityIconEl.innerHTML = iconHTML('dot', { size: 22 });
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

// ----------------------------------------------------------------------
// Detail popup: shown when the player taps an item or ability row in the
// shop or the inventory drawer. Closes on the × button or any tap outside
// the card. Background is dimmed and blurred via CSS.
// ----------------------------------------------------------------------
function openDetailModal({ icon, name, meta, desc, count, rarity }) {
  if (!detailModal) return;
  detailIconEl.innerHTML = iconHTML(icon || 'sparkle', { size: 40 });
  detailNameEl.textContent = name || '';
  detailMetaEl.textContent = meta || '';
  detailMetaEl.style.display = meta ? '' : 'none';
  if (count != null && count !== '') {
    detailCountEl.textContent = `×${formatter.format(count)}`;
    detailCountEl.style.display = '';
  } else {
    detailCountEl.style.display = 'none';
  }
  detailDescEl.textContent = desc || '';
  if (rarity) detailCard.dataset.rar = rarity;
  else delete detailCard.dataset.rar;
  detailModal.classList.add('open');
  detailModal.setAttribute('aria-hidden', 'false');
}

function closeDetailModal() {
  if (!detailModal) return;
  detailModal.classList.remove('open');
  detailModal.setAttribute('aria-hidden', 'true');
}

detailCloseBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeDetailModal();
});
detailModal?.addEventListener('click', (e) => {
  // Tap outside the card (i.e. on the dimmed/blurred backdrop) closes the popup.
  if (e.target === detailModal) closeDetailModal();
});

function showAbilityDetail(ab) {
  if (!ab) return;
  openDetailModal({
    icon: ab.icon || 'sparkle',
    name: ab.name || 'Способность',
    meta: 'Способность',
    desc: ab.desc || 'Активная способность. Нажми фиолетовую кнопку, чтобы применить.',
    rarity: null,
  });
}

function showItemDetail(it) {
  if (!it) return;
  openDetailModal({
    icon: it.icon || 'sparkle',
    name: it.name || it.id || 'Предмет',
    meta: it.rarity ? RARITY_LABELS[it.rarity] || it.rarity : '',
    count: it.count,
    desc: it.desc || '',
    rarity: it.rarity || null,
  });
}

function appendInventoryRows(container, s) {
  const ah = document.createElement('div');
  ah.className = 'inv-header';
  ah.textContent = 'Способность';
  container.appendChild(ah);
  if (s.ability) {
    const d = document.createElement('div');
    d.className = 'inv-row';
    const name = document.createElement('span');
    name.className = 'inv-name';
    name.innerHTML = `<span class="inv-ico" style="display:inline-flex;align-items:center;margin-right:6px;">${iconHTML(s.ability.icon || 'sparkle', { size: 18 })}</span><span class="inv-text">${escapeHtml(s.ability.name || '')}</span>`;
    d.append(name);
    const ab = s.ability;
    d.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showAbilityDetail(ab);
    });
    container.appendChild(d);
  } else {
    const e = document.createElement('div');
    e.className = 'inv-row';
    const name = document.createElement('span');
    name.className = 'inv-name';
    name.style.opacity = '0.4';
    name.style.fontStyle = 'italic';
    name.textContent = 'Нет способности';
    e.appendChild(name);
    container.appendChild(e);
  }

  const ih = document.createElement('div');
  ih.className = 'inv-header';
  ih.textContent = 'Предметы';
  container.appendChild(ih);
  const items = (s.items || []).filter(it => it.count > 0);
  if (items.length === 0) {
    const e = document.createElement('div');
    e.className = 'inv-row';
    const name = document.createElement('span');
    name.className = 'inv-name';
    name.style.opacity = '0.4';
    name.style.fontStyle = 'italic';
    name.textContent = 'Нет предметов';
    e.appendChild(name);
    container.appendChild(e);
  } else {
    const itemContainer = container === shopInventory ? document.createElement('div') : container;
    if (container === shopInventory) itemContainer.className = 'shop-items-grid';
    for (const it of items) {
      const d = document.createElement('div');
      d.className = 'inv-row';
      if (it.rarity) d.dataset.rar = it.rarity;
      const name = document.createElement('span');
      name.className = 'inv-name';
      const label = document.createElement('span');
      label.innerHTML = `<span class="inv-ico" style="display:inline-flex;align-items:center;margin-right:6px;">${iconHTML(it.icon || 'sparkle', { size: 18 })}</span><span class="inv-text">${escapeHtml(it.name || it.id || '')}</span>`;
      const count = document.createElement('span');
      count.className = 'inv-count';
      count.textContent = `×${formatter.format(it.count || 0)}`;
      name.append(label, count);
      d.append(name);
      const itemRef = it;
      d.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showItemDetail(itemRef);
      });
      itemContainer.appendChild(d);
    }
    if (container === shopInventory) container.appendChild(itemContainer);
  }
}

function renderInventory(container, s) {
  container.innerHTML = '';
  if (!s) return;
  appendInventoryRows(container, s);
}

function renderShopInventory(s) {
  renderInventory(shopInventory, s);
}

function computeItemBarLimit() {
  const height = window.innerHeight || 0;
  const width = window.innerWidth || 0;
  if (height <= 430 && width > height) return width < 740 ? 8 : 10;
  return 12;
}

function refreshItemBarLimit() {
  const next = computeItemBarLimit();
  if (next === itemBarLimit) return;
  itemBarLimit = next;
  _itemBarSig = '';
  if (currentPlayerState) renderItemBar(currentPlayerState.items);
}
window.addEventListener('resize', refreshItemBarLimit);
window.addEventListener('orientationchange', refreshItemBarLimit);
refreshItemBarLimit();

// Cached signatures used to skip rebuilding sub-DOMs that haven't changed
// across the ~4Hz state push. This avoids destroying the DOM mid-tap, which
// is the root cause of "every other tap doesn't register" on iOS.
let _upgradesSig = '';
let _shopInventorySig = '';
let _inventoryBodySig = '';

function inventorySig(s) {
  const ab = s?.ability;
  const abSig = ab ? `${ab.id || ab.name}|${ab.icon || ''}|${ab.desc || ''}` : 'none';
  const items = (s?.items || []).filter(it => it.count > 0);
  const itemsSig = items.map(it => `${it.id}:${it.count}:${it.rarity || ''}`).join('|');
  return `${abSig}#${itemsSig}`;
}

function upgradesSig(s) {
  const gold = s?.gold ?? 0;
  return `${gold}|${(s?.upgrades || []).map(u => `${u.id}:${u.level}:${u.price}`).join('|')}`;
}

socket.on('state:player', (s) => {
  if (!s || typeof s.slot !== 'number') return;
  currentPlayerState = s;
  document.getElementById('stHp').textContent = s.hp;
  document.getElementById('stMaxHp').textContent = s.maxHp;
  document.getElementById('stGold').textContent = s.gold;
  document.getElementById('stDmg').textContent = s.damage;
  document.getElementById('shopHp').textContent = s.hp;
  document.getElementById('shopMaxHp').textContent = s.maxHp;
  document.getElementById('shopGold').textContent = s.gold;
  const wasShopOpen = shopOverlay.classList.contains('open');
  shopOverlay.classList.toggle('open', !!s.shopOpen);
  if (s.shopOpen && inventoryOpen) setInventoryOpen(false);
  renderItemBar(s.items);
  renderAbility(s.ability);
  renderInteract(s.interact);

  // Inventory drawer body: only rebuild when contents actually change.
  if (inventoryOpen) {
    const sig = inventorySig(s);
    if (sig !== _inventoryBodySig) {
      _inventoryBodySig = sig;
      renderInventory(inventoryBody, s);
    }
  } else {
    _inventoryBodySig = '';
  }

  // Upgrades list: only rebuild when prices/levels/gold change.
  const upSig = upgradesSig(s);
  if (upSig !== _upgradesSig || (!s.shopOpen && wasShopOpen)) {
    _upgradesSig = upSig;
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
        <button class="price-btn" data-id="${u.id}"><span class="price-ico">${iconHTML('coin', { size: 14 })}</span>${u.price}</button>
      `;
      shopList.appendChild(row);
    }
    // shopInventory was detached when shopList was cleared — invalidate its
    // signature so it re-renders into the fresh DOM tree below.
    _shopInventorySig = '';
  }

  // Shop inventory section: only rebuild when items/ability change.
  if (s.shopOpen) {
    const invSig = inventorySig(s);
    if (invSig !== _shopInventorySig || shopInventory.parentNode !== shopList) {
      _shopInventorySig = invSig;
      shopInventory.innerHTML = '';
      if (shopInventory.parentNode !== shopList) shopList.appendChild(shopInventory);
      renderShopInventory(s);
    }
  } else {
    _shopInventorySig = '';
    if (shopInventory.parentNode) shopInventory.parentNode.removeChild(shopInventory);
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
  if (!el.closest) return false;
  if (el.closest('.inventory-drawer')) return true;
  // Allow scrolling inside the shop overlay
  if (el.closest('.shop-overlay')) return true;
  // Detail popup must receive its own clicks to dismiss / close.
  if (el.closest('.detail-modal')) return true;
  // Lobby form (code input, scan panel, file picker, buttons) must work freely.
  if (el.closest('#lobby')) return true;
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
// Only fires on non-interactive parts of the page so it can't accidentally
// swallow a synthetic click on shop/inventory rows or popup buttons.
let _lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  if (isInteractive(e.target)) return;
  const now = Date.now();
  if (now - _lastTouchEnd < 350) e.preventDefault();
  _lastTouchEnd = now;
}, { passive: false });

window.addEventListener('beforeunload', () => { try { socket.disconnect(); } catch { /* ignore */ } });

// Visual: started flag could be used to reduce hint visibility
void started;
