// Standalone exporter: serialise the procedural stone-wall mesh from
// `src/structure.js` to a `.glb` so it can be opened in Blender (File →
// Import → glTF 2.0). Run with `node tools/export_wall.mjs`. The output
// is intentionally one neutral block (no per-cell scale/yaw variation)
// at 1.00 × 1.05 × 1.00 m with the same 0.10 m chamfer the game uses,
// positioned so its bottom sits on y=0.
//
// Material colour matches the toon material (0x8a8e95) but exported as
// a vanilla MeshStandardMaterial because glTF 2.0 has no first-class
// toon shader — Blender will see a plain-grey PBR material that you
// can replace with whatever you like.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// GLTFExporter relies on browser-only globals (FileReader, Blob, etc.)
// when serialising textures / images. Node 22 has Blob globally but
// not FileReader, so we install a minimal shim *before* importing the
// exporter — just enough to satisfy `new FileReader().readAsArrayBuffer`
// and `.readAsDataURL` for the binary-export path.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.({ target: this });
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
        this.onloadend?.({ target: this });
      });
    }
  };
}

const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build the wall using the exact geometry constructor + dimensions that
// `structure.js` uses for kind === 'wall'. No scale/yaw variation here;
// the in-game `_stoneVariation()` jitter is per-cell and not part of
// the canonical block — Blender shouldn't get a slightly-squashed copy.
const geo = new RoundedBoxGeometry(1.00, 1.05, 1.00, 2, 0.10);
const mat = new THREE.MeshStandardMaterial({
  color: 0x8a8e95,
  roughness: 0.85,
  metalness: 0.0,
  name: 'stone',
});
const mesh = new THREE.Mesh(geo, mat);
mesh.name = 'StoneWall';
// Same lift the in-game placement applies, so the model's local origin
// matches the chunk-cell origin (bottom of block on y=0).
mesh.position.set(0, 0.525, 0);

const scene = new THREE.Scene();
scene.name = 'StoneWallExport';
scene.add(mesh);

const exporter = new GLTFExporter();
exporter.parse(
  scene,
  (result) => {
    // Binary path: GLTFExporter returns an ArrayBuffer when binary:true.
    const buffer = Buffer.from(result);
    const out = resolve(__dirname, '..', 'stone_wall.glb');
    writeFileSync(out, buffer);
    console.log(`wrote ${out} (${buffer.length} bytes)`);
  },
  (err) => {
    console.error('GLTFExporter failed', err);
    process.exit(1);
  },
  { binary: true, embedImages: true },
);
