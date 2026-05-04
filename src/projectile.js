import * as THREE from 'three';
import { vdist } from './utils.js';

export class Projectile {
  constructor(scene, opts) {
    this.scene = scene;
    this.fromX = opts.fromX; this.fromZ = opts.fromZ;
    this.pos = { x: opts.fromX, z: opts.fromZ };
    this.dir = { x: opts.dirX, z: opts.dirZ };
    this.speed = opts.speed;
    this.damage = opts.damage;
    this.life = opts.life;
    this.alive = true;
    this.color = opts.color || 0xffaa00;
    this.ownerEnemy = opts.ownerEnemy || null;
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshBasicMaterial({ color: this.color })
    );
    this.mesh.position.set(this.pos.x, 1.2, this.pos.z);
    scene.add(this.mesh);
  }
  update(dt, players, world) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) { this._destroy(); return; }
    this.pos.x += this.dir.x * this.speed * dt;
    this.pos.z += this.dir.z * this.speed * dt;
    // wall bounds
    if (!world.isClear(this.pos.x, this.pos.z, 0.18)) { this._destroy(); return; }
    this.mesh.position.set(this.pos.x, 1.2, this.pos.z);
    for (const p of players) {
      if (!p.alive) continue;
      if (vdist(this.pos, p.pos) < p.radius + 0.25) {
        if (p.takeDamage(this.damage, this.pos.x, this.pos.z)) {
          this._destroy(); return;
        }
      }
    }
  }
  _destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}
