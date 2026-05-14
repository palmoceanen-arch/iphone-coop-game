// Yandex Games SDK facade.
//
// This module is the single place that talks to `window.YaGames`. Every other
// module (game.js, the integration overlay, etc.) calls these helpers without
// caring whether the host is real Yandex Games, a local preview, or another
// browser portal — when the SDK isn't available all calls degrade to
// `false`/no-ops so the game still runs.
//
// Build flag: `import.meta.env.VITE_PLATFORM === 'yandex'` is set by Vite via
// `vite build --mode yandex` (see vite.config.js). The web/default build
// strips the Yandex code paths entirely.

const SDK_URL = '/sdk.js';

let sdkScriptPromise = null;
let ysdkPromise = null;
let _lastInterstitialAt = 0;
// Yandex's policy is a 60s minimum between interstitials. Pad to 65s so a
// slightly clock-skewed runtime never triggers their server-side rejection.
const INTERSTITIAL_COOLDOWN_MS = 65_000;

export function isYandexBuild() {
  return import.meta.env.VITE_PLATFORM === 'yandex';
}

// Returns true when developer-mode mock ads are explicitly enabled via
// `?devAdMock=1`. We use this to preview the ad UI flow locally without
// linking against the real SDK — it's gated behind a URL param so a real
// production load never falls into mock mode by accident.
export function isMockMode() {
  if (typeof window === 'undefined') return false;
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get('devAdMock') === '1';
  } catch {
    return false;
  }
}

function loadSdkScript() {
  if (!isYandexBuild()) return Promise.resolve(false);
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (sdkScriptPromise) return sdkScriptPromise;
  sdkScriptPromise = new Promise((resolve) => {
    if (window.YaGames) { resolve(true); return; }
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => resolve(!!window.YaGames);
    s.onerror = () => {
      console.warn('[yandex] failed to load SDK script — running unmonetised');
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return sdkScriptPromise;
}

export function initYandexSDK() {
  if (!isYandexBuild()) return Promise.resolve(null);
  if (ysdkPromise) return ysdkPromise;
  ysdkPromise = (async () => {
    const ok = await loadSdkScript();
    if (!ok || !window.YaGames) return null;
    try {
      const ysdk = await window.YaGames.init();
      console.log('[yandex] ysdk initialised');
      return ysdk;
    } catch (err) {
      console.warn('[yandex] init failed', err);
      return null;
    }
  })();
  return ysdkPromise;
}

// Tell Yandex the game has rendered the first interactive frame so it can
// hide the platform's own loading spinner. Safe no-op if the SDK isn't
// loaded or the feature isn't available on the user's runtime.
export async function gameReady() {
  if (!isYandexBuild()) return;
  const ysdk = await initYandexSDK();
  try { ysdk?.features?.LoadingAPI?.ready?.(); } catch (e) {
    console.warn('[yandex] LoadingAPI.ready failed', e);
  }
}

export async function gameplayStart() {
  if (!isYandexBuild()) return;
  const ysdk = await initYandexSDK();
  try { ysdk?.features?.GameplayAPI?.start?.(); } catch (e) {
    console.warn('[yandex] GameplayAPI.start failed', e);
  }
}

export async function gameplayStop() {
  if (!isYandexBuild()) return;
  const ysdk = await initYandexSDK();
  try { ysdk?.features?.GameplayAPI?.stop?.(); } catch (e) {
    console.warn('[yandex] GameplayAPI.stop failed', e);
  }
}

// Reset the interstitial cooldown — call after any rewarded video, since
// Yandex counts both ad kinds against the same "ad shown recently" pacing.
function _markInterstitialShown() {
  _lastInterstitialAt = Date.now();
}

// Returns true if an interstitial was actually shown to the user. False if
// we're still inside the cooldown window or the SDK failed to play one.
export async function showInterstitial(reason = 'unknown') {
  if (isMockMode()) {
    if (Date.now() - _lastInterstitialAt < INTERSTITIAL_COOLDOWN_MS) return false;
    _markInterstitialShown();
    return _mockOverlay(`Межстраничная реклама (${reason})`, 1500);
  }
  if (!isYandexBuild()) return false;
  if (Date.now() - _lastInterstitialAt < INTERSTITIAL_COOLDOWN_MS) {
    return false;
  }
  const ysdk = await initYandexSDK();
  if (!ysdk?.adv?.showFullscreenAdv) return false;
  return new Promise((resolve) => {
    let shown = false;
    ysdk.adv.showFullscreenAdv({
      callbacks: {
        onOpen: () => { shown = true; _markInterstitialShown(); },
        onClose: (wasShown) => resolve(shown || !!wasShown),
        onError: (err) => {
          console.warn('[yandex] interstitial error', err);
          resolve(false);
        },
        onOffline: () => resolve(false),
      },
    });
  });
}

// Returns true if the user watched the ad to completion (reward earned).
// False if they dismissed early, the network failed, or the SDK reported
// any kind of error. Call sites MUST gate the reward on this return value.
export async function showRewardedAd(reason = 'unknown') {
  if (isMockMode()) {
    const ok = await _mockOverlay(`Реклама за награду (${reason})`, 2000);
    if (ok) _markInterstitialShown();
    return ok;
  }
  if (!isYandexBuild()) return false;
  const ysdk = await initYandexSDK();
  if (!ysdk?.adv?.showRewardedVideo) return false;
  return new Promise((resolve) => {
    let rewarded = false;
    ysdk.adv.showRewardedVideo({
      callbacks: {
        onOpen: () => { _markInterstitialShown(); },
        onRewarded: () => { rewarded = true; },
        onClose: () => resolve(rewarded),
        onError: (err) => {
          console.warn('[yandex] rewarded error', err);
          resolve(false);
        },
      },
    });
  });
}

// Optional: persist run state to Yandex cloud saves (best-effort, never
// blocks gameplay). Not wired up yet — leave as a stub call site for the
// save-system to opt into later.
export async function saveCloud(blob) {
  if (!isYandexBuild()) return false;
  const ysdk = await initYandexSDK();
  try {
    const player = await ysdk?.getPlayer?.();
    if (!player) return false;
    await player.setData(blob);
    return true;
  } catch (e) {
    console.warn('[yandex] cloud save failed', e);
    return false;
  }
}

export async function loadCloud() {
  if (!isYandexBuild()) return null;
  const ysdk = await initYandexSDK();
  try {
    const player = await ysdk?.getPlayer?.();
    if (!player) return null;
    return await player.getData();
  } catch (e) {
    console.warn('[yandex] cloud load failed', e);
    return null;
  }
}

// Minimal full-screen "fake ad" overlay used only when `?devAdMock=1` is
// set. Resolves true after `durationMs` (simulating a watched ad), or
// false if the user clicks Skip. No-op outside the browser.
function _mockOverlay(label, durationMs) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:999999',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.92)', 'color:#fff', 'font-family:sans-serif',
      'flex-direction:column', 'gap:14px', 'padding:24px',
    ].join(';');
    const title = document.createElement('div');
    title.textContent = `[ТЕСТ] ${label}`;
    title.style.cssText = 'font-size:18px;opacity:0.9;';
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;opacity:0.6;';
    const skip = document.createElement('button');
    skip.textContent = 'Пропустить без награды';
    skip.style.cssText = 'margin-top:8px;padding:8px 14px;background:#2a313b;color:#fff;border:1px solid #ffffff22;border-radius:8px;cursor:pointer;';
    skip.onclick = () => { cleanup(); resolve(false); };
    root.appendChild(title);
    root.appendChild(sub);
    root.appendChild(skip);
    document.body.appendChild(root);
    let remaining = Math.ceil(durationMs / 1000);
    const update = () => { sub.textContent = `Завершится через ${remaining}с — пропусти, чтобы не получить награду`; };
    update();
    const interval = setInterval(() => {
      remaining -= 1;
      update();
      if (remaining <= 0) {
        clearInterval(interval);
        cleanup();
        resolve(true);
      }
    }, 1000);
    const cleanup = () => {
      clearInterval(interval);
      root.remove();
    };
  });
}
