import * as THREE from 'three';
import { clamp, lerp } from './utils.js';

// A perspective camera that follows midpoint of two players, zooming out as they
// drift apart so both fit on screen.
export class FollowCamera {
  constructor(canvas) {
    this.cam = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 600);
    this.cam.position.set(0, 18, 18);
    this.cam.lookAt(0, 0, 0);
    this.minDistance = 16;
    this.maxDistance = 42;
    this.tilt = Math.PI * 0.18; // ~32° from straight down — much more top-down
    this.dist = 22;
    this.targetDist = 22;
    this.center = new THREE.Vector3();
    this.smoothCenter = new THREE.Vector3();
    this.canvas = canvas;
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
    // See the matching comment in `game.js#syncRendererSize`. iOS Safari
    // refines `visualViewport.height` for ~600ms after first paint as the
    // URL bar settles; without these listeners the camera aspect would
    // bake in the wrong landscape ratio and the renderer would leave a
    // black bar at the bottom until the user rotates the device.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.handleResize());
    }
    [50, 200, 600, 1200].forEach((ms) => setTimeout(() => this.handleResize(), ms));
  }

  handleResize() {
    const w = window.visualViewport?.width ?? window.innerWidth;
    const h = window.visualViewport?.height ?? window.innerHeight;
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  update(dt, p1, p2, shake = 0) {
    const a = p1.alive ? p1.pos : (p2.alive ? p2.pos : { x: 0, z: 0 });
    const b = p2.alive ? p2.pos : a;
    const cx = (a.x + b.x) * 0.5;
    const cz = (a.z + b.z) * 0.5;
    this.center.set(cx, 0, cz);
    const between = Math.hypot(a.x - b.x, a.z - b.z);
    // Required distance based on FOV/aspect to fit `between + margin` along the diagonal of the camera's view.
    const margin = 8;
    const fitWidth = between + margin;
    const halfFov = (this.cam.fov * Math.PI / 180) / 2;
    const aspect = this.cam.aspect;
    // Fit to whichever is the limiting axis.
    const requiredX = (fitWidth * 0.5) / Math.tan(halfFov) / aspect;
    const requiredZ = (fitWidth * 0.5) / Math.tan(halfFov);
    const needed = Math.max(requiredX, requiredZ);
    this.targetDist = clamp(needed, this.minDistance, this.maxDistance);
    // smoothing
    this.dist = lerp(this.dist, this.targetDist, 1 - Math.pow(0.001, dt));
    this.smoothCenter.lerp(this.center, 1 - Math.pow(0.0005, dt));
    // place camera
    const cam = this.cam;
    const dz = Math.sin(this.tilt) * this.dist;
    const dy = Math.cos(this.tilt) * this.dist;
    cam.position.set(this.smoothCenter.x + 0, this.smoothCenter.y + dy, this.smoothCenter.z + dz);
    cam.lookAt(this.smoothCenter.x, 0, this.smoothCenter.z);
    if (shake > 0) {
      cam.position.x += (Math.random() * 2 - 1) * shake;
      cam.position.y += (Math.random() * 2 - 1) * shake;
      cam.position.z += (Math.random() * 2 - 1) * shake;
    }
  }
}
