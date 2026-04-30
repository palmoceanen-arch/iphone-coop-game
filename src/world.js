import * as THREE from 'three';
import { rand, randInt, chance, vdist } from './utils.js';

export const WORLD_SIZE = 80; // world spans -WORLD_SIZE..+WORLD_SIZE

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = []; // { x, z, r } circles for trees/rocks
    this.props = [];
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._scatterProps();
    this._buildCampfire();
    this.dayTime = 0.25; // 0=midnight, 0.25=morning, 0.5=noon, 0.75=evening
    this.dayLength = 180; // seconds for full cycle
    this.update(0);
  }

  _buildSky() {
    const sky = new THREE.Color(0x6cb6ff);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 50, 130);
  }

  _buildLights() {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff4d8, 1.1);
    this.sun.position.set(30, 50, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const d = 60;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 150;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.moonHelper = new THREE.HemisphereLight(0x7aa6ff, 0x202830, 0.0);
    this.scene.add(this.moonHelper);
  }

  _buildGround() {
    const size = WORLD_SIZE * 2;
    const seg = 96;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    // small height variation for visual interest
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = Math.sin(x * 0.07) * 0.18 + Math.cos(z * 0.09) * 0.15 + (Math.random() - 0.5) * 0.05;
      pos.setY(i, h);
    }
    geo.computeVertexNormals();
    // vertex colors for grass variation
    const colors = new Float32Array(pos.count * 3);
    const c1 = new THREE.Color(0x6db050);
    const c2 = new THREE.Color(0x4a8a3a);
    const c3 = new THREE.Color(0x88c562);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const t = (Math.sin(x * 0.13) + Math.cos(z * 0.17) + Math.random() * 0.6) * 0.2 + 0.5;
      const c = (t < 0.4) ? c2 : (t > 0.7) ? c3 : c1;
      colors[i*3] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // Stylized water ponds
    for (let i = 0; i < 3; i++) {
      const r = rand(4, 7);
      const pondGeo = new THREE.CircleGeometry(r, 32);
      pondGeo.rotateX(-Math.PI / 2);
      const pondMat = new THREE.MeshPhongMaterial({ color: 0x3aa6ff, shininess: 80, transparent: true, opacity: 0.85 });
      const pond = new THREE.Mesh(pondGeo, pondMat);
      const x = rand(-WORLD_SIZE * 0.7, WORLD_SIZE * 0.7);
      const z = rand(-WORLD_SIZE * 0.7, WORLD_SIZE * 0.7);
      pond.position.set(x, 0.06, z);
      this.scene.add(pond);
      this.colliders.push({ x, z, r: r * 0.85 });
    }

    // Stone walkway / paths (decorative)
    const pathMat = new THREE.MeshLambertMaterial({ color: 0xb8a587 });
    for (let i = 0; i < 24; i++) {
      const stone = new THREE.Mesh(new THREE.BoxGeometry(rand(0.6, 1.4), 0.12, rand(0.6, 1.4)), pathMat);
      const a = (i / 24) * Math.PI * 2;
      stone.position.set(Math.cos(a) * 14 + rand(-1,1), 0.1, Math.sin(a) * 14 + rand(-1,1));
      stone.rotation.y = rand(0, Math.PI);
      stone.receiveShadow = true;
      this.scene.add(stone);
    }
  }

  _scatterProps() {
    const { scene, colliders } = this;
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b3f1c });
    const leafMats = [
      new THREE.MeshLambertMaterial({ color: 0x2f6f2a }),
      new THREE.MeshLambertMaterial({ color: 0x418f33 }),
      new THREE.MeshLambertMaterial({ color: 0x589f3b }),
    ];
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x8a8e95 });
    const bushMat = new THREE.MeshLambertMaterial({ color: 0x4f9a3a });

    const tries = 220;
    for (let i = 0; i < tries; i++) {
      const x = rand(-WORLD_SIZE + 4, WORLD_SIZE - 4);
      const z = rand(-WORLD_SIZE + 4, WORLD_SIZE - 4);
      // keep a clearing near the spawn / campfire
      if (Math.hypot(x, z) < 8) continue;
      // avoid placing on ponds / existing colliders
      let ok = true;
      for (const c of colliders) { if (vdist({x,z}, {x:c.x, z:c.z}) < c.r + 1.5) { ok = false; break; } }
      if (!ok) continue;
      const r = chance(0.6) ? 'tree' : chance(0.5) ? 'rock' : 'bush';
      if (r === 'tree') {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2.2, 8), trunkMat);
        trunk.position.set(x, 1.1, z);
        trunk.castShadow = true; trunk.receiveShadow = true;
        scene.add(trunk);
        const top = new THREE.Mesh(new THREE.ConeGeometry(rand(1.2, 2.0), rand(2.4, 3.4), 8), leafMats[randInt(0, leafMats.length-1)]);
        top.position.set(x, 3.2 + rand(-0.2, 0.4), z);
        top.castShadow = true;
        scene.add(top);
        colliders.push({ x, z, r: 1.0 });
      } else if (r === 'rock') {
        const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.7, 1.4)), rockMat);
        rk.position.set(x, 0.6, z);
        rk.rotation.y = rand(0, Math.PI);
        rk.castShadow = true; rk.receiveShadow = true;
        scene.add(rk);
        colliders.push({ x, z, r: 1.0 });
      } else {
        const bs = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.6, 1.0), 0), bushMat);
        bs.position.set(x, 0.5, z);
        bs.castShadow = true;
        scene.add(bs);
        // bushes are decorative, no collider
      }
    }

    // Outer fence (low stone wall)
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x7d756a });
    const segs = 60;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = Math.cos(a) * (WORLD_SIZE - 1.5);
      const z = Math.sin(a) * (WORLD_SIZE - 1.5);
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.4, 1.0), wallMat);
      m.position.set(x, 0.7, z);
      m.lookAt(0, 0.7, 0);
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  _buildCampfire() {
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x6e6862 });
    const ring = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3), stoneMat);
      s.position.set(Math.cos(a) * 0.9, 0.18, Math.sin(a) * 0.9);
      s.castShadow = true;
      ring.add(s);
    }
    // wood
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8), new THREE.MeshLambertMaterial({ color: 0x4d2f17 }));
    log.position.y = 0.3; log.rotation.z = Math.PI / 2;
    ring.add(log);
    const log2 = log.clone(); log2.rotation.z = Math.PI / 2; log2.rotation.y = Math.PI / 3;
    ring.add(log2);
    // fire (animated)
    this.fire = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.0, 12), new THREE.MeshBasicMaterial({ color: 0xff8a30, transparent: true, opacity: 0.9 }));
    this.fire.position.y = 0.9;
    ring.add(this.fire);
    this.fireLight = new THREE.PointLight(0xff8a30, 1.5, 14, 1.6);
    this.fireLight.position.y = 1.1;
    ring.add(this.fireLight);
    ring.position.set(0, 0, 6);
    this.scene.add(ring);
    this.campfire = ring;
  }

  // 0..1 sun angle proxy: 0=noon, 0.5=midnight
  isNight() { return this.dayTime < 0.22 || this.dayTime > 0.78; }

  update(dt) {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
    // sun position based on dayTime
    const a = (this.dayTime - 0.25) * Math.PI * 2; // 0.25 -> 0 (noon zenith)
    const sunY = Math.cos(a);
    const sunX = Math.sin(a);
    this.sun.position.set(sunX * 50, Math.max(-10, sunY * 50 + 5), 25);
    this.sun.intensity = Math.max(0, sunY) * 1.15;

    // Color shifts
    const t = (Math.sin(this.dayTime * Math.PI * 2 - Math.PI / 2) + 1) / 2; // 0 night, 1 day
    const dayCol = new THREE.Color(0x6cb6ff);
    const nightCol = new THREE.Color(0x0a1126);
    const sunset = new THREE.Color(0xff9a55);
    const tt = Math.max(0, Math.min(1, t));
    const sunsetMix = Math.max(0, 1 - Math.abs((this.dayTime - 0.78) * 6)) + Math.max(0, 1 - Math.abs((this.dayTime - 0.22) * 6));
    const skyCol = new THREE.Color().copy(nightCol).lerp(dayCol, tt).lerp(sunset, Math.min(0.5, sunsetMix * 0.5));
    this.scene.background.copy(skyCol);
    this.scene.fog.color.copy(skyCol);
    this.ambient.intensity = 0.25 + tt * 0.4;
    this.moonHelper.intensity = (1 - tt) * 0.45;

    // animate fire flicker
    if (this.fire) {
      this.fire.scale.setScalar(0.85 + Math.sin(performance.now() * 0.012) * 0.1 + Math.random() * 0.08);
      this.fireLight.intensity = 1.4 + Math.random() * 0.3;
    }
  }

  // Resolve circle vs static colliders (in-place pos mutation)
  resolveCollisions(pos, radius) {
    // bounds
    const lim = WORLD_SIZE - 2 - radius;
    if (pos.x > lim) pos.x = lim;
    if (pos.x < -lim) pos.x = -lim;
    if (pos.z > lim) pos.z = lim;
    if (pos.z < -lim) pos.z = -lim;
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d2 = dx*dx + dz*dz;
      const r = c.r + radius;
      if (d2 < r * r && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const f = (r - d) / d;
        pos.x += dx * f;
        pos.z += dz * f;
      }
    }
  }

  // sample-clear: is point free of any obstacle?
  isClear(x, z, radius) {
    if (Math.abs(x) > WORLD_SIZE - 2 - radius) return false;
    if (Math.abs(z) > WORLD_SIZE - 2 - radius) return false;
    for (const c of this.colliders) {
      const dx = x - c.x, dz = z - c.z;
      const r = c.r + radius;
      if (dx*dx + dz*dz < r*r) return false;
    }
    return true;
  }

  randomClearPoint(minDistFromOrigin = 14, radius = 1) {
    for (let i = 0; i < 80; i++) {
      const x = rand(-WORLD_SIZE + 4, WORLD_SIZE - 4);
      const z = rand(-WORLD_SIZE + 4, WORLD_SIZE - 4);
      if (Math.hypot(x, z) < minDistFromOrigin) continue;
      if (this.isClear(x, z, radius)) return { x, z };
    }
    return { x: 0, z: 0 };
  }
}
