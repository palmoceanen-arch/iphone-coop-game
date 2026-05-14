// Mobile / touch HUD for Yandex Games.
//
// Yandex Games delivers the same single-player Vite bundle to phones,
// tablets, and desktop browsers (the platform iframe just resizes itself
// to fit). On a touch device the regular keyboard / gamepad controls
// aren't reachable, so this module injects an on-screen joystick + a
// diamond cluster of action buttons and wires them into the game's
// existing Input pipeline.
//
// `installMobileHUD(game)` is the only entry point. It is safe to call
// on desktop — the HUD only mounts when `shouldShowMobileHUD()` returns
// true (touch capability or `?mobile=1` override).

const STICK_SIZE = 168;
const STICK_RADIUS = STICK_SIZE / 2 - 14;

// `?mobile=1` force-enables the HUD on a desktop browser so testers can
// rehearse the layout without a physical phone. `?mobile=0` opts out
// even on a phone (used by Yandex moderators reviewing the build from a
// laptop in mobile device emulation).
export function shouldShowMobileHUD() {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('mobile');
    if (forced === '1') return true;
    if (forced === '0') return false;
  } catch { /* ignore */ }
  const hasTouch = ('ontouchstart' in window) ||
    (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0);
  if (!hasTouch) return false;
  // Treat small viewports as phone/tablet; desktops with touchscreens
  // (Surface, some laptops) keep the keyboard/gamepad HUD instead.
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  return Math.min(w, h) < 900;
}

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.id) node.id = opts.id;
  if (opts.cls) node.className = opts.cls;
  if (opts.html != null) node.innerHTML = opts.html;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) {
    for (const k of Object.keys(opts.attrs)) node.setAttribute(k, opts.attrs[k]);
  }
  return node;
}

function ensureStyles() {
  if (document.getElementById('mobile-hud-styles')) return;
  const style = document.createElement('style');
  style.id = 'mobile-hud-styles';
  style.textContent = `
    #mobile-hud {
      position: absolute; inset: 0; pointer-events: none; z-index: 30;
      touch-action: none; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    #mobile-hud * { box-sizing: border-box; touch-action: none; }
    #mobile-hud .mh-stick {
      position: absolute;
      left: calc(env(safe-area-inset-left, 0px) + 16px);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 20px);
      width: ${STICK_SIZE}px; height: ${STICK_SIZE}px;
      border-radius: 50%;
      background: rgba(255,255,255,0.06);
      border: 2px solid rgba(255,255,255,0.18);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      pointer-events: auto;
    }
    #mobile-hud .mh-stick .mh-knob {
      position: absolute; top: 50%; left: 50%;
      width: 70px; height: 70px;
      border-radius: 50%;
      margin: -35px 0 0 -35px;
      background: radial-gradient(circle at 35% 35%, #ffffff 0%, #b8c4dd 70%);
      box-shadow: 0 6px 14px rgba(0,0,0,0.45);
      pointer-events: none;
      transition: transform 0.05s linear;
    }
    #mobile-hud .mh-stick.mh-active {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.3);
    }
    /* Diamond cluster bottom-right: attack (BR), dash (top of attack),
       ability (left of attack), interact (top of ability). Mirrors
       Diablo-Immortal-style mobile layouts that put the primary action
       under the thumb and the rarer actions a stretch away. */
    #mobile-hud .mh-btn {
      position: absolute;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.22);
      background: linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 100%);
      color: #fff;
      font-weight: 800;
      letter-spacing: 0.4px;
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      cursor: pointer;
      transition: transform 0.06s ease-out, filter 0.06s ease-out;
    }
    #mobile-hud .mh-btn:active,
    #mobile-hud .mh-btn.mh-pressed {
      transform: scale(0.94);
      filter: brightness(1.18);
    }
    #mobile-hud .mh-btn.mh-attack {
      right: calc(env(safe-area-inset-right, 0px) + 18px);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);
      width: 96px; height: 96px;
      background: linear-gradient(180deg, rgba(255,138,138,0.55) 0%, rgba(220,80,80,0.4) 100%);
      border-color: rgba(255,138,138,0.6);
      font-size: 32px;
    }
    #mobile-hud .mh-btn.mh-dash {
      right: calc(env(safe-area-inset-right, 0px) + 28px);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 128px);
      width: 76px; height: 76px;
      font-size: 28px;
      background: linear-gradient(180deg, rgba(106,208,255,0.55) 0%, rgba(60,148,200,0.4) 100%);
      border-color: rgba(106,208,255,0.6);
    }
    #mobile-hud .mh-btn.mh-ability {
      right: calc(env(safe-area-inset-right, 0px) + 124px);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 30px);
      width: 84px; height: 84px;
      font-size: 28px;
      background: linear-gradient(180deg, rgba(173,138,255,0.55) 0%, rgba(126,86,212,0.4) 100%);
      border-color: rgba(173,138,255,0.6);
    }
    #mobile-hud .mh-btn.mh-interact {
      right: calc(env(safe-area-inset-right, 0px) + 134px);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 134px);
      width: 70px; height: 70px;
      font-size: 22px;
      background: linear-gradient(180deg, rgba(140,210,140,0.55) 0%, rgba(70,150,80,0.45) 100%);
      border-color: rgba(140,210,140,0.65);
    }
    /* Top-right toolbar: pause + shop + build menu. Compact so it doesn't
       eat into the HP bar territory on small phones. */
    #mobile-hud .mh-topbar {
      position: absolute;
      top: calc(env(safe-area-inset-top, 0px) + 8px);
      right: calc(env(safe-area-inset-right, 0px) + 12px);
      display: flex; gap: 8px;
      pointer-events: auto;
    }
    #mobile-hud .mh-topbar .mh-btn {
      position: static;
      width: 50px; height: 50px;
      font-size: 22px;
    }
    #mobile-hud .mh-btn.mh-shop {
      background: linear-gradient(180deg, rgba(255,209,102,0.55) 0%, rgba(212,160,42,0.4) 100%);
      border-color: rgba(255,209,102,0.6);
    }
    #mobile-hud .mh-btn.mh-build {
      background: linear-gradient(180deg, rgba(160,220,160,0.5) 0%, rgba(70,150,80,0.35) 100%);
      border-color: rgba(160,220,160,0.55);
    }
    #mobile-hud .mh-btn.mh-pause {
      background: linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 100%);
      border-color: rgba(255,255,255,0.28);
    }
    /* Q / seedCycle button — small puck sitting above the joystick so
       crop-cycle is reachable with the left thumb. */
    #mobile-hud .mh-btn.mh-seed {
      position: absolute;
      left: calc(env(safe-area-inset-left, 0px) + 188px);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 60px);
      width: 56px; height: 56px;
      font-size: 14px;
      background: linear-gradient(180deg, rgba(220,200,120,0.45) 0%, rgba(150,130,60,0.35) 100%);
      border-color: rgba(220,200,120,0.55);
    }
    /* Mobile-only shrunken HP bars so the player + co-op partner panels
       leave room for the on-screen controls and the iframe minimum size
       Yandex's mobile portal hands us. */
    body.mh-mobile .hud { padding: 6px 8px; border-radius: 9px; width: auto; max-width: 180px; }
    body.mh-mobile .hud .name { font-size: 11px; }
    body.mh-mobile .hud .meta { font-size: 10px; gap: 6px; margin-top: 4px; }
    body.mh-mobile .hud .hpbar { height: 12px; }
    body.mh-mobile .hud .hpbar > .text { font-size: 9px; }
    body.mh-mobile .hud .item-bar { display: none; }
    body.mh-mobile .hud .food-bar { display: none; }
    body.mh-mobile .hud .ability-slot { display: none; }
    body.mh-mobile #topbar { font-size: 10px; padding: 5px 8px; }
    body.mh-mobile #tutorial { left: auto; right: calc(env(safe-area-inset-right, 0px) + 12px); bottom: auto; top: calc(env(safe-area-inset-top, 0px) + 66px); }
    body.mh-mobile #tutorial-toggle { font-size: 11px; padding: 6px 10px; }
    body.mh-mobile #tutorial .tutorial-panel {
      left: auto; right: 0; top: 42px; bottom: auto;
      width: min(440px, calc(100vw - 24px));
      max-height: min(74vh, 520px);
    }
    body.mh-mobile .buildbar {
      bottom: calc(env(safe-area-inset-bottom, 0px) + 200px);
      font-size: 11px; padding: 6px 9px;
    }
    /* Start menu + pause/settings panels on mobile.
       Earlier we tried position:sticky on the footer + overflow-y:auto on
       the whole panel. On iOS Safari this combo is unreliable inside
       fixed-position parents — the scroll either no-ops or jitters,
       which is exactly what testers saw. The robust pattern is to make
       the panel itself non-scrolling (overflow:hidden), turn the panel
       into a flex column, and let one inner child be the scroll
       container. touch-action: pan-y then lives on a dedicated leaf
       element, and the footer becomes a static flex child instead of
       a sticky-positioned one (sticky is the part that jitters). */

    /* PAUSE / SETTINGS PANEL — flex column with internal scroll.
       The panel itself has overflow:hidden so touch panning can't escape
       to ancestors. The active tab is the only scroll container, so all
       touch panning happens on a dedicated element. min-height:0 lets
       the flex child shrink below its intrinsic size, which is what
       lets the overflow:auto actually clip+scroll. */
    body.mh-mobile .pause-panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      width: min(720px, calc(100vw - 12px));
      max-height: calc(100vh - 12px);
      max-height: calc(100dvh - 12px);
      padding: 10px 14px 0;
      box-sizing: border-box;
    }
    /* Hide "Пауза / Нажми Esc..." header — no Esc key on a phone, and
       the real estate matters. */
    body.mh-mobile .pause-panel > h1,
    body.mh-mobile .pause-panel > .sub { display: none; }
    body.mh-mobile .pause-tabs { flex-shrink: 0; margin: 0 0 8px; }
    body.mh-mobile .pause-tabs button { padding: 8px 12px; font-size: 12px; }
    body.mh-mobile .pause-tab.active {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      padding-right: 2px;
    }
    body.mh-mobile .pause-row { margin: 4px 0; padding: 8px 10px; }
    body.mh-mobile .pause-panel > .pause-footer {
      flex-shrink: 0;
      position: static;
      margin: 8px -14px 0;
      padding: 10px 14px;
      background: #161b22;
      border-top: 1px solid rgba(255,255,255,0.08);
    }

    /* START PANEL — only the newgame view needs internal scroll (its
       character pickers are the tall content). We DON'T flex-column the
       whole panel because that would force every view (main, load) to
       fill the screen with empty space.
       Instead: the panel stays auto-sized, max-height capped. The
       newgame view, when active, becomes the flex column with its own
       scroll on #start-slots and a pinned footer. Main + load views
       keep their natural block layout. */
    body.mh-mobile .start-panel {
      display: flex;
      flex-direction: column;
      width: min(720px, calc(100vw - 12px));
      max-height: calc(100vh - 12px);
      max-height: calc(100dvh - 12px);
      padding: 10px 14px 0;
      overflow: hidden;
      box-sizing: border-box;
    }
    /* The active newgame view fills the panel as a flex child. Without
       this, the panel could shrink (max-height hit) but the view would
       keep its own intrinsic height and #start-slots wouldn't get the
       overflow:auto kick-in. With flex: 1 1 auto + min-height: 0 the
       view tracks the panel and #start-slots can shrink to scroll. */
    body.mh-mobile .start-view[data-view="newgame"].active {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }
    body.mh-mobile .start-view[data-view="newgame"] > .start-seed-row,
    body.mh-mobile .start-view[data-view="newgame"] > .start-mode-row {
      flex-shrink: 0;
    }
    body.mh-mobile .start-view[data-view="newgame"] > #start-slots {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
    }
    body.mh-mobile .start-view[data-view="newgame"] > .start-footer {
      flex-shrink: 0;
      position: static;
      margin: 8px -14px 0;
      padding: 10px 14px;
      background: #161b22;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    body.mh-mobile .start-view[data-view="newgame"] > .start-gp-hint { display: none; }
    body.mh-mobile .start-preview { height: 120px; margin: 2px 0 6px; }
    body.mh-mobile .start-seed-row { padding: 6px 10px; margin: 0 0 6px; }
    body.mh-mobile .start-seed-row input[type=text] { padding: 6px 8px; font-size: 12px; }
    body.mh-mobile .start-seed-row .control button { padding: 6px 10px; font-size: 11px; }
    body.mh-mobile .start-mode-row { margin: 0 0 6px; }
    body.mh-mobile .start-mode-btn { padding: 6px 12px; font-size: 11px; }
    body.mh-mobile .start-slot { padding: 8px 10px 10px; }
    body.mh-mobile .start-slot-title { font-size: 13px; margin: 0 0 2px; }
    body.mh-mobile .start-section-label { margin: 4px 0 2px; font-size: 9px; }
    body.mh-mobile .start-color-row { gap: 4px; margin: 2px 0 6px; }
    body.mh-mobile .start-swatch { width: 22px; height: 22px; }
    body.mh-mobile .start-character-grid,
    body.mh-mobile .start-weapon-grid { gap: 3px; margin: 2px 0 6px; }
    body.mh-mobile .start-character-chip,
    body.mh-mobile .start-weapon-chip { padding: 5px 3px; font-size: 10.5px; }
    body.mh-mobile .start-main-actions { margin: 6px auto; gap: 10px; max-width: 320px; }
    body.mh-mobile .start-main-actions button { padding: 12px 16px; font-size: 14px; }
    /* Build wheel: re-centre on mobile so it doesn't overlap the joystick.
       Desktop coop positions the per-player wheels in the bottom corners
       since each player owns a half of the keyboard; in solo mobile we
       always pick from a single wheel and want it dead-centre under the
       thumb path. */
    body.mh-mobile .build-wheel.p1 .ring,
    body.mh-mobile .build-wheel.p2 .ring {
      left: 50%; right: auto; bottom: auto; top: 50%;
      width: 320px; height: 320px;
      transform: translate(-50%, -50%);
    }
    /* Shop overlay buttons need a bit more breathing room on small
       touch screens — bigger hit targets without restyling everything. */
    body.mh-mobile #shop .upg-row .price-btn { min-width: 64px; padding: 7px 9px; }
    body.mh-mobile #pause .menu-pane button { min-height: 38px; }
    /* Rotate prompt — shown when the iframe is taller than wide. The game
       still runs in portrait, but landscape is what Yandex's catalog screens
       are designed for and the diamond cluster + joystick spacing works
       best with the wider aspect. */
    #mobile-rotate-hint {
      position: fixed; inset: 0; display: none;
      align-items: center; justify-content: center;
      background: rgba(8,12,18,0.78); z-index: 80;
      color: #fff; font-size: 18px; font-weight: 700;
      text-align: center; padding: 24px;
      pointer-events: auto;
    }
    #mobile-rotate-hint.mh-show { display: flex; }
    #mobile-rotate-hint .mh-rotate-icon {
      font-size: 56px; margin-bottom: 14px;
      animation: mh-rotate 1.4s ease-in-out infinite alternate;
    }
    @keyframes mh-rotate {
      from { transform: rotate(-20deg); }
      to { transform: rotate(70deg); }
    }
  `;
  document.head.appendChild(style);
}

function buildHUD() {
  const root = el('div', { id: 'mobile-hud' });

  const stick = el('div', { cls: 'mh-stick' });
  const knob = el('div', { cls: 'mh-knob' });
  stick.appendChild(knob);
  root.appendChild(stick);

  const attack = el('button', { cls: 'mh-btn mh-attack', attrs: { type: 'button', 'aria-label': 'Атака' }, text: '⚔' });
  const dash = el('button', { cls: 'mh-btn mh-dash', attrs: { type: 'button', 'aria-label': 'Рывок' }, text: '⇢' });
  const ability = el('button', { cls: 'mh-btn mh-ability', attrs: { type: 'button', 'aria-label': 'Способность' }, text: '✦' });
  const interact = el('button', { cls: 'mh-btn mh-interact', attrs: { type: 'button', 'aria-label': 'Действие' }, text: 'E' });
  const seed = el('button', { cls: 'mh-btn mh-seed', attrs: { type: 'button', 'aria-label': 'Семена / Еда' }, text: 'Q' });
  root.appendChild(attack);
  root.appendChild(dash);
  root.appendChild(ability);
  root.appendChild(interact);
  root.appendChild(seed);

  const topbar = el('div', { cls: 'mh-topbar' });
  const buildBtn = el('button', { cls: 'mh-btn mh-build', attrs: { type: 'button', 'aria-label': 'Постройки' }, text: '⚒' });
  const shopBtn = el('button', { cls: 'mh-btn mh-shop', attrs: { type: 'button', 'aria-label': 'Магазин' }, text: '⌂' });
  const pauseBtn = el('button', { cls: 'mh-btn mh-pause', attrs: { type: 'button', 'aria-label': 'Меню' }, text: '☰' });
  topbar.appendChild(buildBtn);
  topbar.appendChild(shopBtn);
  topbar.appendChild(pauseBtn);
  root.appendChild(topbar);

  const rotate = el('div', { id: 'mobile-rotate-hint', html: `
    <div>
      <div class="mh-rotate-icon">📱</div>
      <div>Поверни телефон горизонтально</div>
      <div style="margin-top:8px; font-size:13px; opacity:0.75;">Игра удобнее в альбомной ориентации.</div>
    </div>
  ` });
  document.body.appendChild(rotate);

  return { root, stick, knob, attack, dash, ability, interact, seed, buildBtn, shopBtn, pauseBtn, rotate };
}

function clampStick(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len <= STICK_RADIUS) return { dx, dy, magnitude: len / STICK_RADIUS };
  const k = STICK_RADIUS / len;
  return { dx: dx * k, dy: dy * k, magnitude: 1 };
}

function wireStick(stick, knob, onMove) {
  const state = { active: false, pointerId: -1, baseX: 0, baseY: 0 };
  // Snap the joystick origin to wherever the player first touches down
  // inside the puck region — this matches mobile-game convention where
  // the stick is "floating": the centre follows the thumb the first
  // time it lands rather than being locked to the visual ring.
  const onDown = (e) => {
    if (state.active) return;
    e.preventDefault();
    state.active = true;
    state.pointerId = e.pointerId;
    const rect = stick.getBoundingClientRect();
    state.baseX = rect.left + rect.width / 2;
    state.baseY = rect.top + rect.height / 2;
    stick.classList.add('mh-active');
    try { stick.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const { dx, dy, magnitude } = clampStick(e.clientX - state.baseX, e.clientY - state.baseY);
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove(dx / STICK_RADIUS, dy / STICK_RADIUS, magnitude);
  };
  const onMovePtr = (e) => {
    if (!state.active || e.pointerId !== state.pointerId) return;
    e.preventDefault();
    const { dx, dy, magnitude } = clampStick(e.clientX - state.baseX, e.clientY - state.baseY);
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove(dx / STICK_RADIUS, dy / STICK_RADIUS, magnitude);
  };
  const onUp = (e) => {
    if (!state.active || e.pointerId !== state.pointerId) return;
    state.active = false;
    state.pointerId = -1;
    stick.classList.remove('mh-active');
    knob.style.transform = 'translate(0px, 0px)';
    onMove(0, 0, 0);
  };
  stick.addEventListener('pointerdown', onDown);
  stick.addEventListener('pointermove', onMovePtr);
  stick.addEventListener('pointerup', onUp);
  stick.addEventListener('pointercancel', onUp);
  stick.addEventListener('pointerleave', onUp);
}

function wireHoldButton(btn, { onDown, onUp }) {
  const state = { pointerId: -1 };
  const cleanup = () => {
    state.pointerId = -1;
    btn.classList.remove('mh-pressed');
    onUp?.();
  };
  btn.addEventListener('pointerdown', (e) => {
    if (state.pointerId !== -1) return;
    e.preventDefault();
    state.pointerId = e.pointerId;
    btn.classList.add('mh-pressed');
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    onDown?.();
  });
  const release = (e) => {
    if (e.pointerId !== state.pointerId) return;
    e.preventDefault();
    cleanup();
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
}

function wireTapButton(btn, onTap) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('mh-pressed');
  });
  const release = () => btn.classList.remove('mh-pressed');
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    onTap();
  });
}

function dispatchKey(code) {
  // The game's Input class listens on window for keydown/keyup. We
  // mirror a key tap so existing handlers (Tab → shop, digit keys → quick
  // build, etc.) keep working without per-action plumbing in game.js.
  try {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  } catch { /* ignore in non-DOM contexts */ }
}

// Set the body class + inject the stylesheet that the rest of the mobile UI
// keys off (start-panel paddings, sticky footer, shrunken HUD bars). Safe to
// call before the renderer / game object exists — used by main.js to apply
// the mobile menu styling _before_ StartMenu opens, since the full HUD only
// installs after `gameReady`.
export function prepareMobileUI() {
  if (typeof document === 'undefined') return;
  ensureStyles();
  document.body.classList.add('mh-mobile');
}

function watchOrientation(rotateEl) {
  const apply = () => {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    // Only nag if the viewport is conspicuously portrait. Square-ish
    // (Yandex's draft preview tab) shouldn't trigger the prompt.
    const portrait = h > w * 1.15 && Math.min(w, h) < 540;
    rotateEl.classList.toggle('mh-show', portrait);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
}

export function installMobileHUD(game) {
  if (!shouldShowMobileHUD()) return null;
  if (typeof document === 'undefined') return null;

  prepareMobileUI();

  // Bring the on-screen renderer in line with the smaller display + the
  // limited fill-rate budget of mobile GPUs. The game already caps to 2
  // by default but a phone GPU at 3x retina can spend half its frame
  // budget shading invisible sub-pixels.
  try {
    if (game?.renderer?.setPixelRatio) {
      game.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      game.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    if (game?.followCam?.cam) {
      // Yandex iframes on phones often shrink to ~360px wide; the desktop
      // 16m min distance leaves the avatar tiny. Pull the camera in so the
      // hero reads at thumb-sized resolution.
      game.followCam.minDistance = 13;
      game.followCam.maxDistance = 30;
      // Recompute next frame so the closer min applies immediately.
      game.followCam.targetDist = Math.min(game.followCam.targetDist, 16);
    }
  } catch { /* renderer / cam may not exist yet on hot reload */ }

  const hud = buildHUD();
  const uiRoot = document.getElementById('ui-root') || document.body;
  uiRoot.appendChild(hud.root);
  watchOrientation(hud.rotate);

  const input = game.input;

  // Movement stick — feeds the existing remote-state slot 0 channel that
  // the LAN iPhone controller uses, so the game-side code stays untouched.
  wireStick(hud.stick, hud.knob, (nx, ny) => {
    if (!input?.setRemoteState) return;
    input.setRemoteState(0, { moveX: nx, moveZ: ny });
  });

  // Attack — hold-to-charge. Edge fires the swing immediately; held flag
  // keeps player._chargeTime accumulating so releasing past the threshold
  // triggers the per-character super attack.
  wireHoldButton(hud.attack, {
    onDown: () => {
      input?.remoteEvent?.(0, 'attack');
      input?.setRemoteState?.(0, { attack: true });
    },
    onUp: () => input?.setRemoteState?.(0, { attack: false }),
  });

  // Dash — also hold-aware so the player can keep dash buffered through
  // a stagger frame, though most characters treat it as a single edge.
  wireHoldButton(hud.dash, {
    onDown: () => {
      input?.remoteEvent?.(0, 'dash');
      input?.setRemoteState?.(0, { dash: true });
    },
    onUp: () => input?.setRemoteState?.(0, { dash: false }),
  });

  wireTapButton(hud.interact, () => input?.remoteEvent?.(0, 'interact'));
  wireTapButton(hud.ability, () => game._tryCastAbility?.(0));
  wireTapButton(hud.buildBtn, () => input?.remoteEvent?.(0, 'buildMenu'));
  // Tab toggles the keyboard shop overlay. game.js polls
  // input.consumeGlobal('Tab') every frame, so dispatching a synthetic
  // keydown is the simplest path that exercises the same code path.
  wireTapButton(hud.shopBtn, () => dispatchKey('Tab'));
  wireTapButton(hud.pauseBtn, () => {
    if (game.tutorialPanel?.isOpen) { game.tutorialPanel.close(); return; }
    game._togglePauseMenu?.();
  });
  // Q is P1's seedCycle key. A short tap rotates the selected crop /
  // food; holding it (which we don't track here) would eat the food, but
  // the tutorial directs the player to use the Q button only for cycling
  // and to tap food icons on the HUD for actually consuming, so a
  // simple edge fires the cycle without confusing taste-of-food / cycle.
  wireTapButton(hud.seed, () => dispatchKey('KeyQ'));

  return {
    destroy() {
      hud.root.remove();
      hud.rotate.remove();
      document.body.classList.remove('mh-mobile');
    },
  };
}
