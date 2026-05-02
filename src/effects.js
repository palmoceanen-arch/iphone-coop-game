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
      f.mesh.material.opacity = 0.85 * (1 - t);
      const s = 1 + t * (f.growTo - 1);
      f.mesh.scale.setScalar(s);
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
