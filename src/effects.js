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
  // a sharp horizontal blade core with a soft glow above and below, plus a
  // symmetric bell envelope along U so the highlight tapers to a point at
  // both ends of the arc. Color comes from the material `color` field at
  // call time so a single texture can serve every weapon.
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
      const baseAlpha = Math.max(core, glow * 0.45);
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1);
        const du = (u - 0.5) * 2;     // -1..1 along arc
        // Symmetric bell along the arc — brightest in the middle, tapering
        // to sharp points at both ends. Reads as a slash regardless of
        // whether the blade swings left-to-right or right-to-left.
        const envU = Math.exp(-du * du * 3.6);
        // Extra inner-blade highlight that's even sharper to give the slash
        // a hot "reflection" streak in the middle.
        const innerStreak = core * Math.exp(-du * du * 1.6) * 0.6;
        const a = Math.min(1, baseAlpha * envU + innerStreak);
        const idx = (y * w + x) * 4;
        data[idx]     = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.round(a * 255);
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

  // Texture-mapped slash crescent with a layered "echo" trail behind the
  // main arc to fake motion blur. Both layers fade out via the flash update
  // loop and dispose their geometry/material on expiry; the slash texture
  // is shared and lives for the page lifetime.
  //
  // Args:
  //   x,y,z  — world position of the swinging character (y typically near 0)
  //   yaw    — facing yaw (radians); same convention as Player.yaw
  //   opts   — { range, arc, duration, color, height, thickness }
  //     range     : outer radius of the arc (default 2.0m)
  //     arc       : total angular width of the wedge in radians (default ~120°)
  //     duration  : seconds before the arc fully fades (default 0.32)
  //     color     : hex tint (default 0xeaffff) — multiplied with the texture
  //     height    : vertical offset above the input y (default 1.0m)
  //     thickness : strip thickness as a fraction of range (default 0.55)
  slashArc(x, y, z, yaw, opts = {}) {
    if (this.particleScale <= 0) return;
    const {
      range = 2.0,
      arc = Math.PI * 0.7,
      duration = 0.32,
      color = 0xeaffff,
      height = 1.0,
      thickness = 0.55,
    } = opts;
    const outer = range * 1.05;
    const inner = Math.max(0.15, outer * (1 - thickness));
    const segments = Math.max(28, Math.ceil(arc * 22));
    const tex = this._buildSlashTexture();

    // Spawn a single slash-strip layer with its own size / alpha / lifetime
    // / yaw offset. Used twice below (main + echo) for a layered look.
    const spawnLayer = (rIn, rOut, alphaScale, ttl, yawOffset) => {
      const geo = this._buildArcStripGeometry(arc, rIn, rOut, segments);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y + height, z);
      m.rotation.y = yaw + yawOffset;
      m.renderOrder = 5;
      this.scene.add(m);
      this.flashes.push({
        mesh: m,
        ttl,
        life: 0,
        _kind: 'arc',
        _yaw: yaw + yawOffset,
        _alphaScale: alphaScale,
      });
    };

    // Main slash — full thickness, full alpha, full duration.
    spawnLayer(inner, outer, 1.0, duration, 0);
    // Echo / motion-blur ghost — slightly larger, dimmer, shorter, rotated
    // back a few degrees so it reads as the trailing edge of the swing.
    spawnLayer(inner * 0.92, outer * 1.06, 0.40, duration * 0.85, -0.10);

    // Hot leading-edge highlight at the front of the arc — a small additive
    // sphere parked at the outer-radius midpoint of the swing. Reuses the
    // existing `flashSphere` so it auto-cleans through the flash pipeline.
    const fwdX = x + Math.sin(yaw) * outer * 0.85;
    const fwdZ = z + Math.cos(yaw) * outer * 0.85;
    this.flashSphere(fwdX, y + height, fwdZ, color, range * 0.18, duration * 0.55);
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
        // Sharp attack (~10% of life) then ease-out cubic fade so the slash
        // lingers visually while the next swing's animation begins.
        const attack = 0.10;
        const inT = Math.min(1, t / attack);
        const outT = Math.max(0, (t - attack) / (1 - attack));
        const fade = 1 - outT * outT * outT;
        const peak = 1.15;             // additive overdrive at the peak
        f.mesh.material.opacity = inT * fade * peak * (f._alphaScale || 1.0);
        // Sqrt-eased outward blow-out: 0.55 → ~1.20 with a fast initial punch.
        const s = 0.55 + Math.sqrt(t) * 0.65;
        f.mesh.scale.setScalar(s);
        // Follow-through rotation: ~14° over the lifetime.
        f.mesh.rotation.y = f._yaw + t * 0.24;
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
