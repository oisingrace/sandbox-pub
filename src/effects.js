import * as THREE from 'three';

// Skid marks: a ring buffer of ground quads, one strip per wheel.
export class SkidMarks {
  constructor(scene, maxSegments = 4000) {
    this.max = maxSegments;
    this.positions = new Float32Array(maxSegments * 6 * 3);
    this.alphas = new Float32Array(maxSegments * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      vertexShader: `
        attribute float alpha; varying float vA;
        void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying float vA;
        void main() { gl_FragColor = vec4(0.06, 0.06, 0.07, vA); }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.cursor = 0;
    this.last = []; // per-wheel last point (or null when not skidding)
    this.width = 0.24;
  }

  /** Extend wheel i's mark to point p with given intensity (0 ends the strip). */
  add(i, p, intensity) {
    if (intensity <= 0.02) {
      this.last[i] = null;
      return;
    }
    const prev = this.last[i];
    if (!prev) {
      this.last[i] = { p: p.clone(), a: intensity };
      return;
    }
    const dx = p.x - prev.p.x;
    const dz = p.z - prev.p.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.25) return;
    if (len > 3) {
      prev.p.copy(p);
      return;
    }
    const nx = (-dz / len) * this.width * 0.5;
    const nz = (dx / len) * this.width * 0.5;
    const y = (p.y || 0) + 0.025;
    const quad = [
      prev.p.x - nx, y, prev.p.z - nz,
      prev.p.x + nx, y, prev.p.z + nz,
      p.x + nx, y, p.z + nz,
      prev.p.x - nx, y, prev.p.z - nz,
      p.x + nx, y, p.z + nz,
      p.x - nx, y, p.z - nz,
    ];
    const a0 = Math.min(0.75, prev.a * 0.75);
    const a1 = Math.min(0.75, intensity * 0.75);
    const alphas = [a0, a0, a1, a0, a1, a1];
    const base = this.cursor * 18;
    this.positions.set(quad, base);
    this.alphas.set(alphas, this.cursor * 6);
    this.cursor = (this.cursor + 1) % this.max;
    prev.p.copy(p);
    prev.a = intensity;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.alpha.needsUpdate = true;
  }

  clear() {
    this.positions.fill(0);
    this.alphas.fill(0);
    this.last = [];
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.alpha.needsUpdate = true;
  }
}

// Tire smoke: pooled billboard sprites.
export class Smoke {
  constructor(scene, count = 140, color = 0xe8e8e8) {
    const tex = makePuffTexture();
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, opacity: 0 });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.pool.push({ sprite: s, life: 0, maxLife: 1, vel: new THREE.Vector3(), size: 1 });
    }
    this.next = 0;
  }

  emit(pos, carVel, strength, y = 0.3) {
    const p = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    p.sprite.position.set(pos.x + (Math.random() - 0.5) * 0.3, y, pos.z + (Math.random() - 0.5) * 0.3);
    p.vel.set(carVel.x * 0.25 + (Math.random() - 0.5), 0.6 + Math.random() * 0.8, carVel.z * 0.25 + (Math.random() - 0.5));
    p.maxLife = p.life = 1.2 + Math.random() * 1.2;
    p.size = 0.8 + strength * 0.8;
    p.peak = 0.25 + strength * 0.35;
    p.sprite.visible = true;
  }

  update(dt) {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      const t = 1 - p.life / p.maxLife;
      p.vel.multiplyScalar(Math.exp(-dt * 1.5));
      p.sprite.position.addScaledVector(p.vel, dt);
      const scale = p.size * (1 + t * 3.5);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = p.peak * Math.min(1, t * 6) * (1 - t);
      p.sprite.material.rotation += dt * 0.3;
    }
  }
}

function makePuffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
