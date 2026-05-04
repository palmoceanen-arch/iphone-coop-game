import * as THREE from 'three';
import { rand } from './utils.js';

// Pool of small particle bursts and a few helpers for hit feedback.
export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.particles = []; // { mesh, vx, vy, vz, life, ttl, scale }
    this.flashes = []; // { mesh, ttl }
    this.shake = 0;
    this.shakeMax = 0;
    this.hitStop = 0; // seconds of slow-mo
    this._floats = []; // { el, ttl, x, y, vy }
    this._floatRoot = document.createElement('div');
    this._floatRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    document.getElementById('ui-root').appendChild(this._floatRoot);
    // 1.0 = full particle density. Lowered by the Settings module when the
    // player picks a lower-quality preset; 0 disables bursts entirely.
    this.particleScale = 1.0;
  }

  setParticleScale(s) { this.particleScale = Math.max(0, Math.min(2, Number(s) || 0)); }

  burst(x, y, z, color = 0xffe28a, count = 12, speed = 6, life = 0.45) {
    count = Math.max(0, Math.round(count * this.particleScale));
    if (count === 0) return;
    // Share geometry across particles in this burst; clone the material per
    // particle so each fades independently.
    const geo = new THREE.SphereGeometry(0.12, 6, 6);
    const baseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const refs = { count: 0, geo };
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, baseMat.clone());
      m.position.set(x, y, z);
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      const s = rand(speed * 0.4, speed);
      this.particles.push({
        mesh: m, refs,
        vx: Math.cos(a) * s, vy: rand(2, 5), vz: Math.sin(a) * s,
        life: 0, ttl: life * (0.7 + Math.random() * 0.6),
        scale: 1.0,
      });
      refs.count++;
    }
    baseMat.dispose();
  }

  ring(x, y, z, color = 0xffffff, radius = 1.5, life = 0.35) {
    const geo = new THREE.RingGeometry(radius * 0.6, radius * 0.7, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.scene.add(m);
    this.flashes.push({ mesh: m, ttl: life, life: 0, growTo: radius * 2.2 });
  }

  flashSphere(x, y, z, color = 0xffffff, radius = 1.0, life = 0.18) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    m.position.set(x, y, z);
    this.scene.add(m);
    this.flashes.push({ mesh: m, ttl: life, life: 0, growTo: radius * 1.4 });
  }

  // Lazy-built slash texture used by `slashArc`. 256×64 grayscale alpha:
  // a sharp horizontal blade core with a soft glow above and below, uniform
  // along U. The arc-aligned envelope (leading edge, trailing fade) is
  // produced at runtime by the slash shader, not baked into the texture, so
  // a single texture can serve every weapon and every swing direction.
  _buildSlashTexture() {
    if (this._slashTex) return this._slashTex;
    const w = 256, h = 64;
    const cnv = document.createElement('canvas');
    cnv.width = w; cnv.height = h;
    const ctx = cnv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1);
      const dy = (v - 0.5) * 2;       // -1..1 across thickness
      // Sharp horizontal blade core (very thin bright band).
      const core = Math.exp(-dy * dy * 38);
      // Soft outer glow falling off either side of the core.
      const glow = Math.exp(-dy * dy * 4.5);
      const a = Math.max(core, glow * 0.5);
      const alphaByte = Math.round(Math.min(1, a) * 255);
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        data[idx]     = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = alphaByte;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this._slashTex = tex;
    return tex;
  }

  // ShaderMaterial that draws a sword-trail-style slash: the leading edge
  // sweeps along the arc as `uProgress` advances 0→1, leaving a bright hot
  // peak at the leading edge and an exponentially-fading tail behind it.
  // Pixels ahead of the leading edge are transparent (no "all-at-once"
  // crescent). `uDir` flips the U axis so we can drive the same shader for
  // either swing direction without rebuilding the geometry.
  _buildSlashMaterial(tex, color, direction, trailLen) {
    return new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      uniforms: {
        uTex: { value: tex },
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: 0 },
        uProgress: { value: 0 },
        uDir: { value: direction > 0 ? 1.0 : 0.0 },
        uTrailLen: { value: trailLen },
      },
      vertexShader: `
        varying vec2 vUv;
        uniform float uDir;
        void main() {
          vUv = vec2(uDir > 0.5 ? uv.x : 1.0 - uv.x, uv.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTex;
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uProgress;
        uniform float uTrailLen;
        void main() {
          float lead = uProgress;
          // Soft front-of-blade window: the head gaussian is allowed to
          // bleed slightly ahead of the leading edge before the strip fades
          // to zero further forward. Without this, the natural glow tip
          // gets sliced off at the reveal boundary and reads as a hard
          // pencil-line cutoff.
          float reveal = 1.0 - smoothstep(lead + 0.02, lead + 0.09, vUv.x);
          // Soft fade at the very start of the arc so the trail tail
          // never terminates with a visible vertical seam.
          float tailFade = smoothstep(0.0, 0.05, vUv.x);
          // Soften strip silhouette across thickness (in case the texture
          // edges still carry residual alpha at v = 0 / v = 1).
          float vFade = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
          // Comet-tail: brightness decays exponentially with distance behind
          // the leading edge (in UV units along the arc).
          float behind = max(0.0, lead - vUv.x);
          float trail = exp(-behind / max(0.0001, uTrailLen));
          // Hot peak at the leading edge so the blade tip reads sharp.
          float head = exp(-pow((vUv.x - lead) / 0.055, 2.0));
          vec4 t = texture2D(uTex, vUv);
          float a = t.a * (trail + head * 0.6) * reveal * tailFade * vFade * uOpacity;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
  }

  // Build a curved strip that follows a swing arc, with UVs ready for the
  // slash texture (u runs along the arc, v runs across thickness from inner
  // to outer). The arc is centred on +Z so the caller can orient it with
  // `mesh.rotation.y = yaw`. Returns a fresh BufferGeometry per call —
  // disposed when the flash expires.
  _buildArcStripGeometry(arc, inner, outer, segments) {
    const seg = Math.max(8, Math.ceil(segments));
    const pos = new Float32Array((seg + 1) * 2 * 3);
    const uv = new Float32Array((seg + 1) * 2 * 2);
    const idx = new Uint16Array(seg * 6);
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const theta = -arc / 2 + u * arc;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const innerOff = i * 2 * 3;
      const outerOff = innerOff + 3;
      pos[innerOff]     = sinT * inner;
      pos[innerOff + 1] = 0;
      pos[innerOff + 2] = cosT * inner;
      pos[outerOff]     = sinT * outer;
      pos[outerOff + 1] = 0;
      pos[outerOff + 2] = cosT * outer;
      const uvOff = i * 2 * 2;
      uv[uvOff]     = u; uv[uvOff + 1] = 0;
      uv[uvOff + 2] = u; uv[uvOff + 3] = 1;
    }
    for (let i = 0; i < seg; i++) {
      const off = i * 6;
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      idx[off]     = a;
      idx[off + 1] = c;
      idx[off + 2] = b;
      idx[off + 3] = b;
      idx[off + 4] = c;
      idx[off + 5] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  // Sword-trail slash. The arc paints itself along its length as the swing
  // progresses (uniform `uProgress` 0→1 driven from the flash update loop)
  // — bright hot leading edge with an exponentially-fading tail behind it,
  // nothing visible ahead of it. Single layer; geometry/material disposed
  // on expiry; the slash texture is shared and lives for the page lifetime.
  //
  // Args:
  //   x,y,z  — world position of the swinging character (y typically near 0)
  //   yaw    — facing yaw (radians); same convention as Player.yaw
  //   opts   — { range, arc, duration, color, height, thickness, direction, trailLen }
  //     range     : outer radius of the arc (default 2.0m)
  //     arc       : total angular width of the wedge in radians (default ~120°)
  //     duration  : seconds before the arc fully fades (default 0.32)
  //     color     : hex tint (default 0xeaffff) — multiplied with the texture
  //     height    : vertical offset above the input y (default 1.0m)
  //     thickness : strip thickness as a fraction of range (default 0.55)
  //     direction : -1 (default) sweeps the leading edge in the same
  //                 direction the KayKit horizontal-slice clips swing the
  //                 blade — flip to +1 for backhand-style clips that come
  //                 the other way.
  //     trailLen  : tail decay length in UV units (default 0.40)
  slashArc(x, y, z, yaw, opts = {}) {
    if (this.particleScale <= 0) return;
    const {
      range = 2.0,
      arc = Math.PI * 0.7,
      duration = 0.32,
      color = 0xeaffff,
      height = 1.0,
      thickness = 0.55,
      direction = -1,
      trailLen = 0.40,
    } = opts;
    const outer = range * 1.05;
    const inner = Math.max(0.15, outer * (1 - thickness));
    const segments = Math.max(28, Math.ceil(arc * 22));
    const tex = this._buildSlashTexture();

    const geo = this._buildArcStripGeometry(arc, inner, outer, segments);
    const mat = this._buildSlashMaterial(tex, color, direction, trailLen);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + height, z);
    m.rotation.y = yaw;
    m.renderOrder = 5;
    this.scene.add(m);
    this.flashes.push({
      mesh: m,
      ttl: duration,
      life: 0,
      _kind: 'arc',
      _yaw: yaw,
      _alphaScale: 1.0,
    });
  }

  shakeCamera(amt) { this.shakeMax = Math.max(this.shakeMax, amt); }
  doHitStop(secs) { this.hitStop = Math.max(this.hitStop, secs); }

  damageNumber(worldPos, value, color = '#ffe28a') {
    const el = document.createElement('div');
    el.textContent = String(Math.max(1, Math.round(value)));
    el.style.cssText = `position:absolute;color:${color};font-weight:800;font-size:18px;text-shadow:0 2px 6px rgba(0,0,0,0.7),0 0 1px rgba(0,0,0,0.9);transform:translate(-50%,-50%);transition:none;`;
    this._floatRoot.appendChild(el);
    this._floats.push({ el, ttl: 0.7, life: 0, world: worldPos.clone() });
  }

  toast(text, color = '#fff') {
    const t = document.getElementById('toast');
    t.textContent = text;
    t.style.color = color;
    t.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1300);
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        if (p.refs) {
          p.refs.count--;
          if (p.refs.count <= 0) p.refs.geo.dispose();
        }
        this.particles.splice(i, 1);
        continue;
      }
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy -= 12 * dt; // gravity
      p.vx *= 0.94; p.vz *= 0.94;
      p.mesh.material.opacity = 1 - t;
      const s = 1 - t * 0.6;
      p.mesh.scale.setScalar(s);
    }
    // flashes (rings/spheres)
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += dt;
      const t = f.life / f.ttl;
      if (t >= 1) {
        this.scene.remove(f.mesh);
        f.mesh.material.dispose();
        f.mesh.geometry.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      if (f._kind === 'arc') {
        // The slash paints itself along its length: progress 0→1 over the
        // first 70% of life (ease-in-out cubic so the swing accelerates and
        // settles like a real arm motion), then holds while the trailing
        // brightness fades to zero over the remaining 30%.
        const sweep = 0.70;
        let progress;
        if (t < sweep) {
          const p = t / sweep;
          progress = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        } else {
          progress = 1;
        }
        // Quick attack to full alpha, then ease-out fade once the sweep is
        // complete so the painted arc dissipates cleanly.
        let opacity;
        if (t < sweep) {
          opacity = Math.min(1, t / 0.05);
        } else {
          const fade = (t - sweep) / (1 - sweep);
          opacity = 1 - fade * fade;
        }
        const u = f.mesh.material.uniforms;
        u.uProgress.value = progress;
        u.uOpacity.value = opacity * 1.15 * (f._alphaScale || 1.0);
        // Spawned at the impact frame, so the strip starts at full reach
        // and only blooms a few percent for energy expansion. A bigger
        // blow-out here would look like the arc is *growing* after the
        // strike, which fights the impact read.
        f.mesh.scale.setScalar(1.0 + t * 0.06);
        f.mesh.rotation.y = f._yaw + t * 0.18;
      } else {
        f.mesh.material.opacity = 0.85 * (1 - t);
        const s = 1 + t * (f.growTo - 1);
        f.mesh.scale.setScalar(s);
      }
    }
    // damage numbers
    for (let i = this._floats.length - 1; i >= 0; i--) {
      const f = this._floats[i];
      f.life += dt;
      if (f.life >= f.ttl) {
        f.el.remove();
        this._floats.splice(i, 1);
        continue;
      }
      f.world.y += dt * 1.6;
      const proj = f.world.clone().project(this.camera);
      const sx = (proj.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-proj.y * 0.5 + 0.5) * window.innerHeight;
      f.el.style.left = sx + 'px';
      f.el.style.top = sy + 'px';
      f.el.style.opacity = String(1 - f.life / f.ttl);
    }
    // shake decay handled externally (camera reads shakeMax)
    this.shake = this.shakeMax;
    this.shakeMax = Math.max(0, this.shakeMax - 8 * dt);
    if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
  }
}
