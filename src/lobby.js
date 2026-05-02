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
    this.onControllerJoined = null;    // (slot) => void
  }

  connect() {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.socket.on('connect', () => this.socket.emit('host:create'));
    this.socket.on('host:created', ({ code }) => this._renderCode(code));
    this.socket.on('controller:joined', ({ slot }) => {
      this.controllers[slot] = true;
      this._renderControllers();
      this.onControllerJoined && this.onControllerJoined(slot);
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

  sendToSlot(slot, event, payload) {
    if (!this.socket || !this.controllers[slot]) return;
    this.socket.emit('host:to-slot', { slot, event, payload });
  }

  broadcast(event, payload) {
    if (!this.socket) return;
    this.socket.emit('host:broadcast', { event, payload });
  }

  async _renderCode(code) {
    this.code = code;
    const codeEl = document.getElementById('lobby-code');
    if (codeEl) codeEl.textContent = code;

    // Build join URL: same origin, /controller?code=1234.
    // The host page is typically opened on localhost / desktop, but the iPhone
    // controller has to reach the server over the local network — and iOS Safari
    // requires HTTPS for camera-based QR scanning. So we ask the server (which
    // knows its own network interfaces and whether HTTPS is enabled) for the
    // join URL components. Override priority:
    //   1) ?host=...  query param on the host page (e.g. ?host=foo.local:3443)
    //   2) /api/lan-host JSON from the server (preferred)
    //   3) location.origin (works when host page is already on a routable IP)
    const params = new URLSearchParams(location.search);
    const overrideHost = params.get('host');
    let base = location.origin;
    if (overrideHost) {
      const proto = params.get('protocol') || (overrideHost.startsWith('https://') ? 'https' : location.protocol.replace(':', ''));
      base = `${proto.replace(/:$/, '')}://${overrideHost.replace(/^https?:\/\//, '')}`;
    } else {
      try {
        const r = await fetch('/api/lan-host', { cache: 'no-store' });
        if (r.ok) {
          const info = await r.json();
          if (info?.ip && info?.protocol && info?.port) {
            base = `${info.protocol}://${info.ip}:${info.port}`;
          }
        }
      } catch (err) {
        console.warn('lan-host lookup failed; falling back to location.origin', err);
      }
    }
    const joinUrl = `${base}/controller?code=${code}`;
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
