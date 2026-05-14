// Yandex Games UI integration.
//
// Wires the SDK facade (./sdk.js) into the existing game UI without
// modifying the cross-platform code paths. Responsibilities:
//   • Inject a one-shot "Revive (Watch ad)" button on the death screen.
//   • Offer a "Double loot (Watch ad)" toast when a chest opens.
//   • Inject a "+50 gold (Watch ad)" button into the campfire shop.
//   • Show a full-screen interstitial on day→night transitions and after
//     game-over (rate-limited to one every 65s by the SDK facade).
//
// `installYandexIntegration(game)` is the only entry point. Call it once,
// after `new Game(...)` is constructed. It registers itself as
// `game.platform` so game.js can call back without knowing about Yandex.

import {
  isYandexBuild,
  isMockMode,
  showInterstitial,
  showRewardedAd,
  gameReady,
  gameplayStart,
  gameplayStop,
} from './sdk.js';
import { Rune } from '../runes.js';
import { pickRandomItemId } from '../items.js';
import { pickRandomAbilityId } from '../abilities.js';

const ACTIVE = () => isYandexBuild() || isMockMode();

// One revive per run is the typical roguelite balance — more would let the
// player effectively never lose, fewer feels stingy when the ad is right
// there. Reset on `restart()`.
const REVIVE_PER_RUN = 1;
const REVIVE_HP_FRACTION = 0.6;
const SHOP_AD_GOLD = 50;

export function installYandexIntegration(game) {
  if (!ACTIVE()) return null;

  const state = {
    revivesUsed: 0,
    shopAdUsedThisOpen: false,
    chestAdInFlight: false,
    deathObserver: null,
    shopObserver: null,
    wasNight: false,
    morningInterstitialArmed: false,
  };

  _injectStyles();
  _hookDeathScreen(game, state);
  _hookShopPanel(game, state);

  game.platform = {
    // Called from Game._refreshShopState() each time the shop overlay
    // toggles open/closed. We reset per-open guards so each new visit
    // gets a fresh ad opportunity.
    onShopOpen() {
      state.shopAdUsedThisOpen = false;
      _maybeInjectShopAdRow(game, state);
    },
    onShopClose() {
      state.shopAdUsedThisOpen = false;
    },
    // Called from the chest-open callback. `grantExtra` spawns one bonus
    // rune at the chest's position when the rewarded ad completes.
    onChestOpened(chest) {
      if (state.chestAdInFlight) return;
      _offerChestDoubleLoot(game, state, chest);
    },
    // Fires on the night→day boundary. Show one interstitial per morning,
    // rate-limited inside the SDK facade. Game.update wires this up.
    onMorning() {
      if (state.morningInterstitialArmed) return;
      state.morningInterstitialArmed = true;
      // Defer one frame so the visual transition doesn't overlap the
      // ad-loading flash; users associate the ad with the morning bell
      // sound rather than mid-action gameplay.
      setTimeout(() => {
        gameplayStop();
        showInterstitial('morning').finally(() => {
          gameplayStart();
          state.morningInterstitialArmed = false;
        });
      }, 800);
    },
    // Game.restart() calls this so we hand out a fresh revive on the next
    // run instead of locking the player out forever after one game-over.
    onRestart() {
      state.revivesUsed = 0;
      _removeReviveButton();
    },
  };

  // Wire the gameplay lifecycle once the player actually starts playing.
  // _startGame() flips _waitingForStart → false; poll for the transition
  // since hooking into that single internal function isn't worth a code
  // change in game.js.
  const startWatcher = setInterval(() => {
    if (!game._waitingForStart) {
      clearInterval(startWatcher);
      gameplayStart();
    }
  }, 200);

  return game.platform;
}

// ---------------------------------------------------------------------------
// Death screen — observe `#death.open` toggling and offer a one-shot revive.

function _hookDeathScreen(game, state) {
  const deathEl = document.getElementById('death');
  if (!deathEl) return;
  const obs = new MutationObserver(() => {
    if (deathEl.classList.contains('open')) {
      _onDeathShown(game, state);
    } else {
      _removeReviveButton();
    }
  });
  obs.observe(deathEl, { attributes: true, attributeFilter: ['class'] });
  state.deathObserver = obs;
}

function _onDeathShown(game, state) {
  // Trigger a game-over interstitial. Rate-limited inside the SDK facade
  // so morning + death within ~1 min won't both fire.
  gameplayStop();
  showInterstitial('death').catch(() => {});

  // The default panel copy ("You both fell. — the bond is your lifeline.")
  // reads as a bug in single-player. Replace it with solo-appropriate
  // text whenever the run is solo — covers both Yandex builds (always
  // solo) and existing solo mode in the multiplayer build.
  if (game.solo) _localiseDeathPanelForSolo();

  // Revive button is single-use per run. After the player consumes it
  // we just keep the regular "Restart" button as the only path forward,
  // which conveniently lines up with the post-restart interstitial slot.
  if (state.revivesUsed >= REVIVE_PER_RUN) return;
  _injectReviveButton(game, state);
}

function _localiseDeathPanelForSolo() {
  const panel = document.querySelector('#death .panel');
  if (!panel) return;
  const h1 = panel.querySelector('h1');
  const p = panel.querySelector('p');
  if (h1) h1.textContent = 'Вы пали.';
  if (p) p.textContent = 'Посмотрите рекламу, чтобы возродиться, или начните заново.';
}

function _injectReviveButton(game, state) {
  const panel = document.querySelector('#death .panel');
  if (!panel) return;
  if (panel.querySelector('#yandex-revive-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'yandex-revive-btn';
  btn.className = 'yandex-ad-btn';
  btn.innerHTML = _adIconSvg() + '<span>Возродиться</span>';
  btn.title = 'Посмотреть видеорекламу и возродиться с 60% HP';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const ok = await showRewardedAd('revive');
    if (!ok) {
      btn.disabled = false;
      _toast(game, 'Награда не получена. Попробуй ещё раз.', '#ff9b9b');
      return;
    }
    state.revivesUsed += 1;
    _revivePlayers(game);
    btn.remove();
  });
  const restartBtn = panel.querySelector('#restart');
  if (restartBtn) panel.insertBefore(btn, restartBtn);
  else panel.appendChild(btn);
}

function _removeReviveButton() {
  document.getElementById('yandex-revive-btn')?.remove();
}

function _revivePlayers(game) {
  // Bring every non-phantom dead hero back at REVIVE_HP_FRACTION of their
  // max HP. We deliberately don't teleport them — in solo mode the player
  // is alone, and in co-op they revive where they fell so the partner
  // can rally to them naturally.
  for (const p of game.players) {
    if (p._phantom || p.alive) continue;
    p.revive(REVIVE_HP_FRACTION);
    p.knockback = { x: 0, z: 0 };
    p.invuln = 2.5; // generous post-ad i-frames to avoid an instant re-death
    game.effects?.ring?.(p.pos.x, 0.2, p.pos.z, 0x7aff8a, 2.5, 0.6);
  }
  game.dead = false;
  document.getElementById('death')?.classList.remove('open');
  game.saveSystem?.markDirty?.();
  gameplayStart();
}

// ---------------------------------------------------------------------------
// Shop — inject a "Get +N gold" rewarded-ad row when the shop opens.

function _hookShopPanel(_game, _state) {
  // The shop UI is rebuilt from scratch each time it opens (see
  // upgrades.js `renderShop`). We re-inject our row inside
  // `onShopOpen` after that render, so nothing else to wire here.
}

function _maybeInjectShopAdRow(game, state) {
  // Defer one frame so renderShop() (which is called inside the same
  // _refreshShopState tick) finishes wiping `#shop-upgs-1` first.
  requestAnimationFrame(() => {
    const col = document.querySelector('#shop .shop-col.p1');
    if (!col) return;
    if (col.querySelector('#yandex-shop-ad')) return;
    const row = document.createElement('div');
    row.id = 'yandex-shop-ad';
    row.className = 'upg yandex-ad-row';
    row.innerHTML = `
      <div>
        <div>Бонус золота <span class="lvl">${SHOP_AD_GOLD}</span></div>
        <div style="opacity:0.65;font-size:11px;">Посмотри видеорекламу, чтобы получить золото.</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${_adIconSvg(14)}
      </div>`;
    row.addEventListener('click', async () => {
      if (state.shopAdUsedThisOpen) {
        _toast(game, 'Награда уже получена в этом визите.', '#ffd166');
        return;
      }
      row.style.pointerEvents = 'none';
      row.style.opacity = '0.5';
      const ok = await showRewardedAd('shop-gold');
      row.style.pointerEvents = '';
      row.style.opacity = '';
      if (!ok) {
        _toast(game, 'Награда не получена.', '#ff9b9b');
        return;
      }
      state.shopAdUsedThisOpen = true;
      const p = game.players[0];
      if (p && !p._phantom) {
        p.gold += SHOP_AD_GOLD;
        _toast(game, `+${SHOP_AD_GOLD} золота!`, '#ffd166');
        // Re-render the shop so the new gold total and unlocked upgrade
        // affordability state both refresh immediately.
        try {
          const mod = await import('../upgrades.js');
          mod.renderShop?.(game.players[0], game.players[1], (slot, idx) => game._tryBuy?.(slot, idx));
        } catch { /* ignore — UI will refresh on next open */ }
      }
    });
    col.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Chest — show a "Удвоить (реклама)" toast button for ~5s after a chest
// opens. If the player taps it and watches the ad, drop one more rune at
// the chest's position.

function _offerChestDoubleLoot(game, state, chest) {
  if (!chest || !chest.pos) return;
  // Snapshot the chest's world position now — the chest's THREE group is
  // about to fade & despawn over ~1.8s, but `chest.pos` is a plain
  // {x,z} record that remains valid after destroy.
  const pos = { x: chest.pos.x, z: chest.pos.z };
  state.chestAdInFlight = true;

  // Use the existing toast area for the prompt — the click target
  // is a styled overlay so we don't fight the toast's auto-hide.
  const overlay = document.createElement('div');
  overlay.className = 'yandex-chest-prompt';
  overlay.innerHTML = `
    <div class="yandex-chest-prompt-inner">
      ${_adIconSvg(18)}
      <span>Удвоить добычу</span>
    </div>
    <button class="yandex-chest-dismiss" aria-label="Закрыть">×</button>
  `;
  document.body.appendChild(overlay);

  const cleanup = () => {
    overlay.remove();
    state.chestAdInFlight = false;
  };
  const timer = setTimeout(cleanup, 6000);

  overlay.querySelector('.yandex-chest-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(timer);
    cleanup();
  });
  overlay.querySelector('.yandex-chest-prompt-inner')?.addEventListener('click', async () => {
    clearTimeout(timer);
    overlay.style.pointerEvents = 'none';
    overlay.style.opacity = '0.6';
    const ok = await showRewardedAd('chest-double');
    cleanup();
    if (!ok) return;
    _spawnBonusRune(game, pos);
    _toast(game, 'Награда удвоена!', '#ffd166');
  });
}

function _spawnBonusRune(game, pos) {
  // Mirror the chest's own 70/30 split between item-runes and ability-runes
  // so the bonus drop feels like the same loot table rather than a
  // duplicate of the original drop.
  const isAbility = Math.random() < 0.3;
  const id = isAbility ? pickRandomAbilityId() : pickRandomItemId();
  // Offset 0.6m on the opposite side from the chest's default rune drop
  // (chest.js spawns at +0.8x / +0.2z) so the two runes don't overlap.
  const rune = new Rune(game.scene, pos.x - 0.6, pos.z - 0.2, isAbility ? 'ability' : 'item', id);
  game.runes.push(rune);
  game.effects?.ring?.(pos.x, 0.05, pos.z, 0xffd166, 1.2, 0.35);
}

// ---------------------------------------------------------------------------
// Small helpers

function _toast(game, msg, color = '#ffd166') {
  // Prefer the game's own toast helper so the message animates in the
  // same place as native toasts. Fall back to plain console if effects
  // aren't ready yet (very early bootstrap).
  if (game?.effects?.toast) {
    game.effects.toast(msg, color);
  } else {
    console.log('[yandex toast]', msg);
  }
}

function _adIconSvg(size = 16) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
         style="vertical-align:middle;">
      <polygon points="9 6 19 12 9 18 9 6" fill="currentColor"></polygon>
      <rect x="2" y="4" width="20" height="16" rx="3"></rect>
    </svg>`;
}

function _injectStyles() {
  if (document.getElementById('yandex-integration-styles')) return;
  const style = document.createElement('style');
  style.id = 'yandex-integration-styles';
  style.textContent = `
    .yandex-ad-btn {
      display: inline-flex; align-items: center; gap: 8px;
      margin: 8px 6px 0;
      background: linear-gradient(180deg, #ffd166, #f0b830);
      color: #2a1a00; border: 1px solid #ffc233;
      padding: 10px 18px; border-radius: 10px;
      font-size: 15px; font-weight: 600;
      cursor: pointer;
    }
    .yandex-ad-btn:disabled { opacity: 0.5; cursor: wait; }
    .yandex-ad-btn:hover:not(:disabled) { filter: brightness(1.05); }
    .yandex-ad-row {
      background: linear-gradient(180deg, #2c2410, #1f1a0c) !important;
      border: 1px solid #ffd16633;
      cursor: pointer;
    }
    .yandex-ad-row:hover { background: linear-gradient(180deg, #3a3014, #2a2110) !important; }
    .yandex-ad-row .lvl { color: #ffd166; font-weight: 600; }
    .yandex-chest-prompt {
      position: absolute; left: 50%; bottom: 120px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 8px;
      background: rgba(20, 16, 8, 0.92);
      border: 1px solid #ffd16655; border-radius: 12px;
      padding: 4px 4px 4px 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      z-index: 100; pointer-events: auto;
      animation: yandex-chest-pop 220ms ease-out;
    }
    .yandex-chest-prompt-inner {
      display: flex; align-items: center; gap: 8px;
      color: #ffd166; font-size: 14px; font-weight: 600;
      padding: 8px 4px; cursor: pointer;
    }
    .yandex-chest-prompt-inner:hover { color: #fff; }
    .yandex-chest-dismiss {
      background: transparent; border: none; color: #ffffff77;
      font-size: 20px; line-height: 1; padding: 4px 10px;
      cursor: pointer;
    }
    .yandex-chest-dismiss:hover { color: #fff; }
    @keyframes yandex-chest-pop {
      from { transform: translate(-50%, 8px); opacity: 0; }
      to   { transform: translate(-50%, 0);   opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

// Re-export `gameReady` so main.js doesn't have to import from two places.
export { gameReady, gameplayStart, gameplayStop };
