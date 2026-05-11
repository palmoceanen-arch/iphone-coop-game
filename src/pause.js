// Pause-menu controller. Owns the DOM nodes inside #pause and translates
// player interactions into Settings mutations. The actual `applyVideo` /
// `applyAudio` work happens inside Settings; this module only handles the
// UI side: tabs, segmented controls, sliders, toggles, presets, and the
// open/close state.
import { createGamepadNavState, readFirstGamepadNav } from './gamepadNav.js';

export class PauseMenu {
  constructor(settings) {
    this.settings = settings;
    this.root = document.getElementById('pause');
    if (!this.root) return;
    this.isOpen = false;
    this.onToggle = null; // optional, set by Game
    // Set by Game so the "Сбросить прогресс" footer button can clear
    // the persistent save and rebuild the world from scratch. Pause
    // menu only owns the DOM wiring; the actual reset logic lives in
    // Game._resetProgress.
    this.onResetProgress = null;

    this._bindTabs();
    this._bindControls();
    this._bindFooter();
    this._unsubscribe = settings.onChange(() => this.refresh());
    this.refresh();

    // Standalone gamepad nav state — independent of in-game `Input` so the
    // overlay works whether it was opened from the start menu (no Game
    // instance yet) or in-game via pause. The Game side already guards
    // against double-firing because `update()` early-returns on dt<=0
    // while paused.
    this._gpNavState = createGamepadNavState();
    this._gpFocus = 0;
    this._gpRaf = null;
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
    this._stopGamepadLoop();
  }

  open() {
    if (!this.root || this.isOpen) return;
    this.isOpen = true;
    this.root.classList.add('open');
    this.refresh();
    this._gpFocus = 0;
    this._startGamepadLoop();
  }

  close() {
    if (!this.root || !this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this._stopGamepadLoop();
  }

  toggle() {
    if (this.isOpen) this.close(); else this.open();
  }

  // ---- Gamepad navigation ----------------------------------------------

  _startGamepadLoop() {
    if (this._gpRaf !== null) return;
    const tick = () => {
      if (!this.isOpen) {
        this._gpRaf = null;
        return;
      }
      this._handleGamepadNav();
      this._gpRaf = requestAnimationFrame(tick);
    };
    this._gpRaf = requestAnimationFrame(tick);
  }

  _stopGamepadLoop() {
    if (this._gpRaf !== null) {
      cancelAnimationFrame(this._gpRaf);
      this._gpRaf = null;
    }
    this.root?.querySelectorAll('.gp-focus').forEach((el) => el.classList.remove('gp-focus'));
  }

  // Visible, enabled interactive elements in the currently-active tab
  // (Видео or Звук) plus the footer buttons. Order matches the DOM, so
  // up/down walks the menu top-to-bottom and left/right cycles between
  // siblings inside a segmented row.
  _gamepadTargets() {
    if (!this.root) return [];
    const sel = 'button:not(:disabled), .toggle[data-key], input[type=range]:not(:disabled)';
    return [...this.root.querySelectorAll(sel)].filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      // Hide elements that live in an inactive tab pane.
      const pane = el.closest('.pause-tab');
      if (pane && !pane.classList.contains('active')) return false;
      return true;
    });
  }

  _refreshGamepadFocus(targets = this._gamepadTargets()) {
    this.root?.querySelectorAll('.gp-focus').forEach((el) => el.classList.remove('gp-focus'));
    if (!targets.length) return;
    this._gpFocus = Math.max(0, Math.min(this._gpFocus, targets.length - 1));
    const el = targets[this._gpFocus];
    el.classList.add('gp-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _adjustSlider(input, dir) {
    const step = Number(input.step) || 1;
    const min = Number(input.min);
    const max = Number(input.max);
    const cur = Number(input.value);
    const next = Math.max(
      Number.isFinite(min) ? min : -Infinity,
      Math.min(Number.isFinite(max) ? max : Infinity, cur + dir * step),
    );
    if (next === cur) return false;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  _handleGamepadNav() {
    if (!this.isOpen) return;
    const targets = this._gamepadTargets();
    if (targets.length === 0) return;
    const nav = readFirstGamepadNav(this._gpNavState);
    if (!nav) {
      this._refreshGamepadFocus(targets);
      return;
    }
    if (nav.back) {
      this.close();
      this.onToggle?.(false);
      return;
    }
    if (nav.tab) {
      // Cycle the Видео / Звук tabs.
      const videoBtn = document.getElementById('pause-tab-video');
      const audioBtn = document.getElementById('pause-tab-audio');
      if (videoBtn?.classList.contains('active')) audioBtn?.click();
      else videoBtn?.click();
      this._gpFocus = 0;
      this._refreshGamepadFocus();
      return;
    }
    const cur = targets[Math.min(this._gpFocus, targets.length - 1)];
    const isSlider = cur && cur.tagName === 'INPUT' && cur.type === 'range';
    if (isSlider && (nav.left || nav.right)) {
      this._adjustSlider(cur, nav.left ? -1 : 1);
    } else {
      if (nav.up || nav.left || nav.shoulderLeft) this._gpFocus = Math.max(0, this._gpFocus - 1);
      if (nav.down || nav.right || nav.shoulderRight) {
        this._gpFocus = Math.min(targets.length - 1, this._gpFocus + 1);
      }
    }
    this._refreshGamepadFocus(targets);
    if (nav.confirm) {
      const el = targets[Math.min(this._gpFocus, targets.length - 1)];
      if (el && typeof el.click === 'function' && !el.disabled) el.click();
    }
  }

  // ---- Wiring -----------------------------------------------------------

  _bindTabs() {
    const videoBtn = document.getElementById('pause-tab-video');
    const audioBtn = document.getElementById('pause-tab-audio');
    const videoPane = document.getElementById('pause-pane-video');
    const audioPane = document.getElementById('pause-pane-audio');
    const select = (which) => {
      videoBtn?.classList.toggle('active', which === 'video');
      audioBtn?.classList.toggle('active', which === 'audio');
      videoPane?.classList.toggle('active', which === 'video');
      audioPane?.classList.toggle('active', which === 'audio');
    };
    videoBtn?.addEventListener('click', () => select('video'));
    audioBtn?.addEventListener('click', () => select('audio'));
  }

  _bindFooter() {
    document.getElementById('pause-resume')?.addEventListener('click', () => {
      this.close();
      this.onToggle?.(false);
    });
    document.getElementById('pause-reset')?.addEventListener('click', () => {
      if (window.confirm('Сбросить настройки графики и звука к стандартным?')) {
        this.settings.reset();
      }
    });
    document.getElementById('pause-progress-reset')?.addEventListener('click', () => {
      if (!this.onResetProgress) return;
      const ok = window.confirm(
        'Сбросить весь прогресс? Это вернёт мир в исходное состояние, удалит все собранные предметы, золото, постройки и грядки. Действие необратимо.',
      );
      if (!ok) return;
      this.onResetProgress();
      this.close();
      this.onToggle?.(false);
    });
    // Preset row
    document.querySelectorAll('#preset-row button[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-preset');
        if (p) this.settings.applyPreset(p);
      });
    });
  }

  _bindControls() {
    // Segmented controls (string values)
    document.querySelectorAll('.seg[data-key][data-type="seg"]').forEach((seg) => {
      const key = seg.getAttribute('data-key');
      seg.querySelectorAll('button[data-val]').forEach((b) => {
        b.addEventListener('click', () => {
          const v = b.getAttribute('data-val');
          this._setVideoOrAudio(key, v);
        });
      });
    });
    // Segmented controls (numeric values, e.g. resolutionScale)
    document.querySelectorAll('.seg[data-key][data-type="seg-num"]').forEach((seg) => {
      const key = seg.getAttribute('data-key');
      seg.querySelectorAll('button[data-val]').forEach((b) => {
        b.addEventListener('click', () => {
          const v = parseFloat(b.getAttribute('data-val'));
          if (!Number.isNaN(v)) this._setVideoOrAudio(key, v);
        });
      });
    });
    // Toggles
    document.querySelectorAll('.toggle[data-key][data-type="toggle"]').forEach((tog) => {
      const key = tog.getAttribute('data-key');
      tog.addEventListener('click', () => {
        const cur = !!this._readVideoOrAudio(key);
        this._setVideoOrAudio(key, !cur);
      });
    });
    // Sliders 50..80 (raw int)
    document.querySelectorAll('input[type=range][data-type="slider"]').forEach((inp) => {
      const key = inp.getAttribute('data-key');
      inp.addEventListener('input', () => {
        this._setVideoOrAudio(key, parseInt(inp.value, 10));
      });
    });
    // Sliders 0..100 → 0..1 (volume)
    document.querySelectorAll('input[type=range][data-type="slider-pct"]').forEach((inp) => {
      const key = inp.getAttribute('data-key');
      inp.addEventListener('input', () => {
        const v = Math.max(0, Math.min(1, parseInt(inp.value, 10) / 100));
        this._setVideoOrAudio(key, v);
      });
    });
  }

  // Audio keys are the ones declared in settings.DEFAULTS.audio. Everything
  // else lives under video.
  _isAudioKey(key) {
    return key === 'masterVolume' || key === 'sfxVolume' || key === 'ambientVolume' || key === 'muted';
  }

  _readVideoOrAudio(key) {
    return this._isAudioKey(key)
      ? this.settings.values.audio[key]
      : this.settings.values.video[key];
  }

  _setVideoOrAudio(key, value) {
    if (this._isAudioKey(key)) this.settings.setAudio(key, value);
    else this.settings.setVideo(key, value);
  }

  // ---- Refresh ----------------------------------------------------------

  refresh() {
    if (!this.root) return;
    const v = this.settings.values.video;

    // Preset highlight
    const preset = this.settings.currentPreset();
    document.querySelectorAll('#preset-row button[data-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === preset);
    });

    // String segmented controls
    document.querySelectorAll('.seg[data-key][data-type="seg"]').forEach((seg) => {
      const key = seg.getAttribute('data-key');
      const cur = String(this._readVideoOrAudio(key));
      seg.querySelectorAll('button[data-val]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-val') === cur);
      });
    });
    // Numeric segmented controls
    document.querySelectorAll('.seg[data-key][data-type="seg-num"]').forEach((seg) => {
      const key = seg.getAttribute('data-key');
      const cur = Number(this._readVideoOrAudio(key));
      seg.querySelectorAll('button[data-val]').forEach((b) => {
        const bv = parseFloat(b.getAttribute('data-val'));
        b.classList.toggle('active', !Number.isNaN(bv) && Math.abs(bv - cur) < 1e-6);
      });
    });
    // Toggles
    document.querySelectorAll('.toggle[data-key][data-type="toggle"]').forEach((tog) => {
      const key = tog.getAttribute('data-key');
      tog.classList.toggle('on', !!this._readVideoOrAudio(key));
    });
    // Sliders
    document.querySelectorAll('input[type=range][data-type="slider"]').forEach((inp) => {
      const key = inp.getAttribute('data-key');
      inp.value = String(this._readVideoOrAudio(key));
      const lab = document.querySelector(`.val[data-for="${key}"]`);
      if (lab) lab.textContent = `${inp.value}°`;
    });
    document.querySelectorAll('input[type=range][data-type="slider-pct"]').forEach((inp) => {
      const key = inp.getAttribute('data-key');
      const pct = Math.round((Number(this._readVideoOrAudio(key)) || 0) * 100);
      inp.value = String(pct);
      const lab = document.querySelector(`.val[data-for="${key}"]`);
      if (lab) lab.textContent = `${pct}%`;
    });

    // Side-effect: surface the FPS counter when enabled (used as visual
    // confirmation that the toggle is wired even before the next frame
    // tick).
    const fpsEl = document.getElementById('fps');
    if (fpsEl) fpsEl.classList.toggle('show', !!v.showFps);
  }
}
