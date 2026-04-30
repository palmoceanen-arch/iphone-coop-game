import { Game } from './game.js';

window.addEventListener('DOMContentLoaded', () => {
  // Surface fatal errors to the user
  window.addEventListener('error', (e) => {
    console.error('[fatal]', e.error || e.message);
  });
  try {
    window.__game = new Game();
  } catch (err) {
    console.error(err);
    const intro = document.getElementById('intro');
    if (intro) {
      intro.innerHTML = `<div class="panel"><h1>Failed to start</h1><pre style="white-space:pre-wrap;text-align:left;">${String(err && err.stack || err)}</pre></div>`;
    }
  }
});
