// Pause-menu controller. Owns the DOM nodes inside #pause and translates
// player interactions into Settings mutations. The actual `applyVideo` /
// `applyAudio` work happens inside Settings; this module only handles the
// UI side: tabs, segmented controls, sliders, toggles, presets, and the
// open/close state.

export class PauseMenu {
  constructor(settings) {
    this.settings = settings;
    this.root = document.getElementById('pause');
    if (!this.root) return;
    this.isOpen = false;
    this.onToggle = null; // optional, set by Game

    this._bindTabs();
    this._bindControls();
    this._bindFooter();
    this._unsubscribe = settings.onChange(() => this.refresh());
    this.refresh();
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
  }

  open() {
    if (!this.root || this.isOpen) return;
    this.isOpen = true;
    this.root.classList.add('open');
    this.refresh();
  }

  close() {
    if (!this.root || !this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  toggle() {
    if (this.isOpen) this.close(); else this.open();
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
