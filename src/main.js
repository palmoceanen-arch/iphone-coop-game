import { ABILITY_BY_ID } from './abilities.js';
import { Game } from './game.js';
import { ITEMS } from './items.js';
import { Lobby } from './lobby.js';
import { preloadModels, preloadWeapons } from './models.js';
import { PauseMenu } from './pause.js';
import { getSettings } from './settings.js';
import { StartMenu } from './startMenu.js';

window.addEventListener('DOMContentLoaded', async () => {
  window.addEventListener('error', (e) => {
    console.error('[fatal]', e.error || e.message);
  });

  // The host page renders a 3D world and is intended for the desktop/laptop
  // running the game. On iPhone/Android, redirect to the controller page so
  // players don't accidentally hit the WebGL canvas (which struggles on
  // mobile Safari memory).
  const ua = (navigator.userAgent || '').toLowerCase();
  const isMobile = /iphone|ipad|ipod|android|mobile/.test(ua);
  const params = new URLSearchParams(window.location.search);
  if (isMobile && !params.has('host')) {
    const url = new URL('controller', window.location.href);
    // forward seed code if present so /controller?code=... still works
    for (const [k, v] of params.entries()) url.searchParams.set(k, v);
    window.location.replace(url.toString());
    return;
  }

  const loadingEl = document.getElementById('loading');
  const fillEl = document.getElementById('loading-fill');
  const statEl = document.getElementById('loading-stat');

  let game;
  let lobby;
  try {
    await preloadModels((done, total, key) => {
      if (fillEl) fillEl.style.width = `${Math.round(100 * done / total)}%`;
      if (statEl) statEl.textContent = `${done} / ${total} · ${key}`;
    });
    // Also preload the standalone weapon meshes so the start-menu preview
    // can equip axes / staves / wands — the in-game flow lazily preloads
    // these on first setWeapon() call but the menu shows them up-front.
    await preloadWeapons();
    if (loadingEl) {
      loadingEl.classList.add('hidden');
      setTimeout(() => loadingEl.remove(), 250);
    }

    // Wire Settings + PauseMenu *before* the start menu so its "Настройки"
    // button opens the same overlay used in-game. Settings.attach() is a
    // no-op until a renderer/world exists, so values picked here just sit in
    // localStorage and apply when Game finally builds. Game then reuses the
    // same PauseMenu instance via opts.pauseMenu (no double-binding).
    const settings = getSettings();
    const pauseMenu = new PauseMenu(settings);

    // Start menu collects { seed, players[].color, players[].weapon } before
    // the heavy Game constructor runs. We defer Game creation here on
    // purpose — picking a seed up-front means the World terrain is generated
    // from the chosen seed, not the URL fallback.
    const startMenu = new StartMenu({ pauseMenu });
    startMenu.open();
    const config = await new Promise((resolve) => { startMenu.onStart = resolve; });

    // Reflect the chosen seed in the URL so a refresh keeps the same world,
    // and so the rest of the app (already URL-driven) sees a consistent
    // value. We use replaceState to avoid creating a back-button entry that
    // returns to the menu mid-run.
    const url = new URL(window.location.href);
    url.searchParams.set('seed', config.seed);
    window.history.replaceState({}, '', url.toString());

    game = new Game({ seed: config.seed, players: config.players, pauseMenu });
    window.__game = game;
    if (params.get('testInventory') === '1') {
      for (const player of game.players) {
        for (let i = 0; i < ITEMS.length; i++) {
          const item = ITEMS[i];
          player.items[item.id] = (i % 3) + 1;
        }
      }
      game.players[0].setAbility(Object.keys(ABILITY_BY_ID)[0]);
      game.players[1].setAbility(Object.keys(ABILITY_BY_ID)[1] || Object.keys(ABILITY_BY_ID)[0]);
    }

    // Reveal the lobby/QR overlay now that the world is built. Game's own
    // `_waitingForStart` flag still freezes the simulation until the user
    // clicks one of the lobby start buttons below.
    const introEl = document.getElementById('intro');
    if (introEl) introEl.style.display = 'flex';

    lobby = new Lobby();
    lobby.connect();
    window.__lobby = lobby;
    game.lobby = lobby;

    // Mobile controllers feed remote state straight into the game's Input.
    lobby.onInputState = (slot, state) => {
      if (game && game.input) game.input.setRemoteState(slot, state);
    };
    // Edge events (attack/dash/shop/buy) routed through Game so it can also
    // handle gamepad-driven shop & purchases.
    lobby.onInputEvent = (slot, event) => {
      if (game) game.handleRemoteEvent(slot, event);
    };
    lobby.onControllerJoined = (slot) => {
      if (game) game._pushPlayerState(slot);
    };

    const startBtn = document.getElementById('lobby-start');
    if (startBtn) startBtn.addEventListener('click', () => {
      lobby.startGame();
      game._startGame();
    });
    const kbBtn = document.getElementById('start-keyboard');
    if (kbBtn) kbBtn.addEventListener('click', () => {
      lobby.startGame();
      game._startGame();
    });
  } catch (err) {
    console.error(err);
    if (loadingEl) loadingEl.remove();
    const intro = document.getElementById('intro');
    if (intro) {
      intro.innerHTML = `<div class="panel"><h1>Failed to start</h1><pre style="white-space:pre-wrap;text-align:left;">${String(err && err.stack || err)}</pre></div>`;
    }
  }
});
