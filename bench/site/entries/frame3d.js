import * as THREE from "three";

// Simulates the per-frame JS of a 3D site (vibey-clover is a three.js game):
// a scene graph whose nodes move every frame, updateMatrixWorld traversal,
// and a vertex cloud re-projected through node matrices — math, objects, and
// typed access patterns rather than rendering.
const NODES = 300;
const VERTS = 1500;
const FRAMES = 4;

globalThis.Benchmark = class Benchmark {
  setup() {
    this.root = new THREE.Object3D();
    this.nodes = [];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < NODES; i++) {
      const o = new THREE.Object3D();
      o.position.set(rnd() * 10 - 5, rnd() * 10 - 5, rnd() * 10 - 5);
      o.rotation.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
      o.scale.setScalar(0.5 + rnd());
      const parent = i === 0 ? this.root : this.nodes[(i * 7) % this.nodes.length];
      parent.add(o);
      this.nodes.push(o);
    }
    this.verts = [];
    for (let i = 0; i < VERTS; i++)
      this.verts.push(new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1));
    this.q = new THREE.Quaternion();
    this.q2 = new THREE.Quaternion();
    this.acc = 0;
    this.frame = 0;
  }
  runIteration() {
    let acc = this.acc;
    const tmp = new THREE.Vector3();
    for (let f = 0; f < FRAMES; f++) {
      const t = (this.frame * FRAMES + f) * 0.016;
      for (let i = 0; i < this.nodes.length; i++) {
        const o = this.nodes[i];
        o.rotation.y += 0.01 + (i % 5) * 0.001;
        o.rotation.x += (i % 3) * 0.002;
        o.position.y = Math.sin(t * 2 + i * 0.1) * 2;
        this.q.setFromAxisAngle(tmp.set(0, 1, 0), t * (1 + (i % 4) * 0.2));
        this.q2.setFromAxisAngle(tmp.set(1, 0, 0), Math.sin(t + i) * 0.5);
        o.quaternion.slerpQuaternions(o.quaternion, this.q2, 0.1).multiply(this.q);
      }
      this.root.updateMatrixWorld(true);
      const m = this.nodes.length;
      for (let i = 0; i < this.verts.length; i++) {
        const v = this.verts[i];
        tmp.copy(v).applyMatrix4(this.nodes[i % m].matrixWorld);
        acc += tmp.x * 1000 + tmp.y * 100 + tmp.z * 10;
      }
    }
    this.frame++;
    this.acc = acc;
  }
  result() { return Math.round(Math.abs(this.acc)) | 0; }
};
