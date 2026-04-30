import { Game } from './game.js';
import { Lobby } from './lobby.js';

window.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('error', (e) => {
    console.error('[fatal]', e.error || e.message);
  });
  let game;
  let lobby;
  try {
    game = new Game();
    window.__game = game;

    lobby = new Lobby();
    lobby.connect();
    window.__lobby = lobby;

    // Mobile controllers feed remote state straight into the game's Input.
    lobby.onInputState = (slot, state) => {
      if (game && game.input) game.input.setRemoteState(slot, state);
    };
    lobby.onInputEvent = (slot, event) => {
      if (game && game.input) game.input.remoteEvent(slot, event.type);
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
    const intro = document.getElementById('intro');
    if (intro) {
      intro.innerHTML = `<div class="panel"><h1>Failed to start</h1><pre style="white-space:pre-wrap;text-align:left;">${String(err && err.stack || err)}</pre></div>`;
    }
  }
});
