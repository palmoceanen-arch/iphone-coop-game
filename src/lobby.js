// Host-side lobby: requests a room code, displays it + a QR code for iPhone
// controllers to join, and waits for both slots before starting the game.
import { io } from 'socket.io-client';
import QRCode from 'qrcode';

export class Lobby {
  constructor() {
    this.socket = null;
    this.code = null;
    this.controllers = [false, false]; // slot 0 / 1 connected
    this.onInputState = null;          // (slot, state) => void
    this.onInputEvent = null;          // (slot, event) => void
    this.onStart = null;               // () => void
  }

  connect() {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.socket.on('connect', () => this.socket.emit('host:create'));
    this.socket.on('host:created', ({ code }) => this._renderCode(code));
    this.socket.on('controller:joined', ({ slot }) => {
      this.controllers[slot] = true;
      this._renderControllers();
    });
    this.socket.on('controller:left', ({ slot }) => {
      this.controllers[slot] = false;
      this._renderControllers();
    });
    this.socket.on('input:state', ({ slot, state }) => { this.onInputState && this.onInputState(slot, state); });
    this.socket.on('input:event', ({ slot, event }) => { this.onInputEvent && this.onInputEvent(slot, event); });
  }

  startGame() {
    this.socket && this.socket.emit('host:start');
    this.onStart && this.onStart();
  }

  endGame() { this.socket && this.socket.emit('host:end'); }

  async _renderCode(code) {
    this.code = code;
    const codeEl = document.getElementById('lobby-code');
    if (codeEl) codeEl.textContent = code;

    // Build join URL: same origin, /controller.html?code=XXXX
    const joinUrl = `${location.origin}/controller.html?code=${code}`;
    const urlEl = document.getElementById('lobby-url');
    if (urlEl) {
      urlEl.textContent = joinUrl.replace(/^https?:\/\//, '');
      urlEl.href = joinUrl;
    }

    const qrEl = document.getElementById('lobby-qr');
    if (qrEl) {
      try {
        const svg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, width: 200, color: { dark: '#0a0d15', light: '#e0e6f3' } });
        qrEl.innerHTML = svg;
      } catch (err) {
        console.warn('QR render failed', err);
      }
    }
    this._renderControllers();
  }

  _renderControllers() {
    const both = this.controllers[0] && this.controllers[1];
    for (let i = 0; i < 2; i++) {
      const dot = document.getElementById(`lobby-slot-${i + 1}`);
      if (dot) dot.classList.toggle('on', this.controllers[i]);
    }
    const startBtn = document.getElementById('lobby-start');
    if (startBtn) {
      startBtn.disabled = !both;
      startBtn.textContent = both
        ? 'Начать приключение'
        : `Ждём игроков… (${this.controllers.filter(Boolean).length}/2)`;
    }
  }
}
