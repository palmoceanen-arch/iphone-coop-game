import * as THREE from 'three';
import { vdist, makeRng } from './utils.js';
import { spawnProp } from './models.js';

export const WORLD_SIZE = 80; // world spans -WORLD_SIZE..+WORLD_SIZE

export class World {
  constructor(scene, seed = 1) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed);
    this.colliders = []; // { x, z, r } circles for trees/rocks
    this.props = [];
    this.enemySpawns = []; // { kind, x, z, level }
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._scatterProps();
    this._buildCampfire();
    this._planEnemySpawns();
    this.dayTime = 0.25; // 0=midnight, 0.25=morning, 0.5=noon, 0.75=evening
    this.dayLength = 240; // seconds for full cycle
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
    const r = this.rng;
    const size = WORLD_SIZE * 2;
    const seg = 96;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = Math.sin(x * 0.07) * 0.18 + Math.cos(z * 0.09) * 0.15 + (r.next() - 0.5) * 0.05;
      pos.setY(i, h);
    }
    geo.computeVertexNormals();
    const colors = new Float32Array(pos.count * 3);
    const c1 = new THREE.Color(0x6db050);
    const c2 = new THREE.Color(0x4a8a3a);
    const c3 = new THREE.Color(0x88c562);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const t = (Math.sin(x * 0.13) + Math.cos(z * 0.17) + r.next() * 0.6) * 0.2 + 0.5;
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
      const rad = r.range(4, 7);
      const pondGeo = new THREE.CircleGeometry(rad, 32);
      pondGeo.rotateX(-Math.PI / 2);
      const pondMat = new THREE.MeshPhongMaterial({ color: 0x3aa6ff, shininess: 80, transparent: true, opacity: 0.85 });
      const pond = new THREE.Mesh(pondGeo, pondMat);
      const x = r.range(-WORLD_SIZE * 0.7, WORLD_SIZE * 0.7);
      const z = r.range(-WORLD_SIZE * 0.7, WORLD_SIZE * 0.7);
      pond.position.set(x, 0.06, z);
      this.scene.add(pond);
      this.colliders.push({ x, z, r: rad * 0.85 });
    }

    // Stone walkway / paths (decorative)
    const pathMat = new THREE.MeshLambertMaterial({ color: 0xb8a587 });
    for (let i = 0; i < 24; i++) {
      const stone = new THREE.Mesh(new THREE.BoxGeometry(r.range(0.6, 1.4), 0.12, r.range(0.6, 1.4)), pathMat);
      const a = (i / 24) * Math.PI * 2;
      stone.position.set(Math.cos(a) * 14 + r.range(-1,1), 0.1, Math.sin(a) * 14 + r.range(-1,1));
      stone.rotation.y = r.range(0, Math.PI);
      stone.receiveShadow = true;
      this.scene.add(stone);
    }
  }

  _scatterProps() {
    const r = this.rng;
    const { scene, colliders } = this;

    // Variant pools — Kenney Nature Kit GLBs. Trees and rocks have collider
    // radii roughly matching the model footprint.
    const treeKinds = ['tree_pine_a', 'tree_pine_b', 'tree_pine_c', 'tree_default', 'tree_oak'];
    const rockLargeKinds = ['rock_largeA', 'rock_largeB', 'rock_largeC'];
    const rockSmallKinds = ['rock_smallA', 'rock_smallB'];
    const bushKinds = ['bush', 'bush_large'];

    const tries = 240;
    for (let i = 0; i < tries; i++) {
      const x = r.range(-WORLD_SIZE + 4, WORLD_SIZE - 4);
      const z = r.range(-WORLD_SIZE + 4, WORLD_SIZE - 4);
      // keep a clearing near the spawn / campfire
      if (Math.hypot(x, z) < 9) continue;
      let ok = true;
      for (const c of colliders) { if (vdist({x,z}, {x:c.x, z:c.z}) < c.r + 1.5) { ok = false; break; } }
      if (!ok) continue;

      const kind = r.chance(0.55) ? 'tree' : r.chance(0.55) ? 'rock' : 'bush';
      const yaw = r.range(0, Math.PI * 2);
      let mesh;
      if (kind === 'tree') {
        const id = treeKinds[r.int(0, treeKinds.length - 1)];
        const scale = r.range(2.4, 3.6);
        mesh = spawnProp(id, { scale, rotationY: yaw });
        mesh.position.set(x, 0, z);
        colliders.push({ x, z, r: 1.0 });
      } else if (kind === 'rock') {
        const big = r.chance(0.55);
        const id = (big ? rockLargeKinds : rockSmallKinds)[r.int(0, (big ? rockLargeKinds : rockSmallKinds).length - 1)];
        const scale = big ? r.range(1.4, 2.0) : r.range(0.8, 1.2);
        mesh = spawnProp(id, { scale, rotationY: yaw });
        mesh.position.set(x, 0, z);
        if (big) colliders.push({ x, z, r: 0.9 });
      } else {
        const id = bushKinds[r.int(0, bushKinds.length - 1)];
        const scale = r.range(1.2, 2.0);
        mesh = spawnProp(id, { scale, rotationY: yaw });
        mesh.position.set(x, 0, z);
      }
      scene.add(mesh);
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
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8), new THREE.MeshLambertMaterial({ color: 0x4d2f17 }));
    log.position.y = 0.3; log.rotation.z = Math.PI / 2;
    ring.add(log);
    const log2 = log.clone(); log2.rotation.z = Math.PI / 2; log2.rotation.y = Math.PI / 3;
    ring.add(log2);
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

  // Plan a small number of scattered enemy encampments / wandering creatures.
  // Deterministic from seed. Every entry: { kind, x, z, level }.
  _planEnemySpawns() {
    const r = this.rng;
    // Total ~20-26 enemies, grouped into ~6-9 camps spread around the world.
    const camps = r.int(6, 9);
    const placed = [];
    const minDistFromSpawn = 18;
    const minDistBetweenCamps = 14;
    let attempts = 0;
    while (placed.length < camps && attempts < 200) {
      attempts++;
      const a = r.range(0, Math.PI * 2);
      const radius = r.range(minDistFromSpawn, WORLD_SIZE - 8);
      const cx = Math.cos(a) * radius;
      const cz = Math.sin(a) * radius;
      // not on top of a collider
      if (!this.isClear(cx, cz, 2.5)) continue;
      // not too close to another camp
      let ok = true;
      for (const p of placed) {
        if (Math.hypot(cx - p.x, cz - p.z) < minDistBetweenCamps) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push({ x: cx, z: cz });
    }

    // Define camp templates
    const templates = [
      { kinds: ['slime', 'slime', 'slime'], levelBoost: 0 },
      { kinds: ['slime', 'slime'], levelBoost: 0 },
      { kinds: ['archer', 'slime', 'slime'], levelBoost: 0 },
      { kinds: ['archer', 'archer'], levelBoost: 0 },
      { kinds: ['bomber', 'slime'], levelBoost: 0 },
      { kinds: ['wisp', 'wisp'], levelBoost: 0 },
      { kinds: ['ogre'], levelBoost: 1 },
      { kinds: ['ogre', 'slime'], levelBoost: 1 },
    ];
    // Lone wanderers (single slimes and wisps far apart)
    const loners = ['slime', 'slime', 'slime', 'wisp'];

    for (const camp of placed) {
      const tpl = r.pick(templates);
      const lvl = 1 + tpl.levelBoost + Math.floor(Math.hypot(camp.x, camp.z) / 30);
      for (const k of tpl.kinds) {
        const ox = r.range(-2.5, 2.5);
        const oz = r.range(-2.5, 2.5);
        const x = camp.x + ox, z = camp.z + oz;
        if (!this.isClear(x, z, 1.0)) continue;
        this.enemySpawns.push({ kind: k, x, z, level: lvl, homeX: camp.x, homeZ: camp.z });
      }
    }
    // Add loners
    for (const k of loners) {
      let x, z;
      let placedOk = false;
      for (let i = 0; i < 30; i++) {
        const a = r.range(0, Math.PI * 2);
        const radius = r.range(20, WORLD_SIZE - 6);
        x = Math.cos(a) * radius;
        z = Math.sin(a) * radius;
        if (!this.isClear(x, z, 1.0)) continue;
        // not on top of another camp
        const tooClose = this.enemySpawns.some(e => Math.hypot(e.x - x, e.z - z) < 8);
        if (tooClose) continue;
        placedOk = true; break;
      }
      if (!placedOk) continue;
      const lvl = 1 + Math.floor(Math.hypot(x, z) / 35);
      this.enemySpawns.push({ kind: k, x, z, level: lvl, homeX: x, homeZ: z });
    }
  }

  isNight() { return this.dayTime < 0.22 || this.dayTime > 0.78; }

  update(dt) {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
    const a = (this.dayTime - 0.25) * Math.PI * 2;
    const sunY = Math.cos(a);
    const sunX = Math.sin(a);
    this.sun.position.set(sunX * 50, Math.max(-10, sunY * 50 + 5), 25);
    this.sun.intensity = Math.max(0, sunY) * 1.15;

    const t = (Math.sin(this.dayTime * Math.PI * 2 - Math.PI / 2) + 1) / 2;
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

    if (this.fire) {
      this.fire.scale.setScalar(0.85 + Math.sin(performance.now() * 0.012) * 0.1 + Math.random() * 0.08);
      this.fireLight.intensity = 1.4 + Math.random() * 0.3;
    }
  }

  resolveCollisions(pos, radius) {
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
}
