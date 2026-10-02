import * as THREE from 'three';

// The Inferno pickup's mounted flamethrower. A stream of fire arcs out of a
// turret over the cab; anything it washes over heats up and, once hot
// enough (heavier things take longer), burns away as glowing voxels through
// the same burn effect the Ember GT uses (see Destruction.flameSweep).

export const FLAME = {
  speed: 24,        // m/s out of the nozzle
  drop: 0.012,      // the stream sags this much per metre², like a real arc of fuel
  range: 15,        // metres the fire reaches
  tank: 7,          // seconds of fire on a full tank
  refill: 9,        // seconds to refill from empty while not firing
  aimDown: 0.07,    // rad below the car's nose the turret points
};

const _flameQ = new THREE.Quaternion();
const _flameE = new THREE.Euler();
const _flameV = new THREE.Vector3();

/**
 * Nozzle position and direction in the world for a car state (anything
 * with x, y, z, heading, pitch, roll) and the vehicle's turret mount.
 */
export function nozzle(car, mount, out = { pos: new THREE.Vector3(), dir: new THREE.Vector3() }) {
  _flameE.set(-(car.pitch || 0), car.heading, car.roll || 0, 'YXZ');
  _flameQ.setFromEuler(_flameE);
  out.pos.set(mount[0], mount[1], mount[2]).applyQuaternion(_flameQ);
  out.pos.x += car.x;
  out.pos.y += car.y || 0;
  out.pos.z += car.z;
  out.dir.set(0, -Math.sin(FLAME.aimDown), Math.cos(FLAME.aimDown)).applyQuaternion(_flameQ);
  return out;
}

/** Fuel for the flamethrower, drained while firing and refilled after. */
export class FlameTank {
  constructor() {
    this.level = 1;
    this.firing = false;
    this.empty = false; // ran dry: must refill a bit before firing again
  }

  update(dt, wantFire) {
    if (this.empty && this.level > 0.25) this.empty = false;
    this.firing = wantFire && !this.empty && this.level > 0;
    if (this.firing) {
      this.level = Math.max(0, this.level - dt / FLAME.tank);
      if (this.level === 0) this.empty = true;
    } else {
      this.level = Math.min(1, this.level + dt / FLAME.refill);
    }
    return this.firing;
  }
}

/** The flames themselves: additive glowing particles with a soft falloff. */
export class FlameFX {
  constructor(scene, capacity = 700) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity).fill(1);
    this.life = new Float32Array(capacity).fill(1);
    this.next = 0;
    this.rate = 220; // particles per second per nozzle
    this.carry = new Map(); // emitter key -> fractional particles owed

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setAttribute('size', this.sizeAttr);
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (420.0 / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c) * 4.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(vColor * (1.0 - d) * (1.0 - d), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // A flickering light at each active nozzle (only one, pooled).
    this.light = new THREE.PointLight(0xff8a2a, 0, 18, 1.6);
    scene.add(this.light);
    this.lightLevel = 0;
  }

  /** Spray fire from `pos` along `dir` for `dt` seconds; `vel` is the car's velocity. */
  emit(key, pos, dir, vel, dt) {
    let owed = (this.carry.get(key) || 0) + this.rate * dt;
    while (owed >= 1) {
      owed -= 1;
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const spread = 0.09;
      const t = Math.random() * dt; // spread births over the frame so the stream is continuous
      const sx = dir.x + (Math.random() - 0.5) * spread * 2;
      const sy = dir.y + (Math.random() - 0.5) * spread * 2;
      const sz = dir.z + (Math.random() - 0.5) * spread * 2;
      const speed = FLAME.speed * (0.85 + Math.random() * 0.3);
      this.vel[i * 3] = sx * speed + vel.x;
      this.vel[i * 3 + 1] = sy * speed;
      this.vel[i * 3 + 2] = sz * speed + vel.z;
      this.pos[i * 3] = pos.x + this.vel[i * 3] * t;
      this.pos[i * 3 + 1] = pos.y + this.vel[i * 3 + 1] * t;
      this.pos[i * 3 + 2] = pos.z + this.vel[i * 3 + 2] * t;
      this.age[i] = t;
      this.life[i] = (FLAME.range / FLAME.speed) * (0.75 + Math.random() * 0.5);
    }
    this.carry.set(key, owed);
    this.lightTarget = Math.max(this.lightTarget || 0, 1);
    this.light.position.copy(pos).addScaledVector(dir, 5);
  }

  update(dt) {
    const g = 2 * FLAME.drop * FLAME.speed * FLAME.speed; // matches the stream's sag
    const P = this.posAttr.array, C = this.colAttr.array, S = this.sizeAttr.array;
    for (let i = 0; i < this.capacity; i++) {
      const life = this.life[i];
      let a = this.age[i];
      if (a >= life) { S[i] = 0; continue; }
      a += dt;
      this.age[i] = a;
      const k = a / life;
      const j = i * 3;
      this.vel[j + 1] -= g * dt * (1 - k * 0.8); // late flame stops falling and lifts
      if (k > 0.6) this.vel[j + 1] += 6 * dt;
      // Drag slows the stream as it burns out.
      const drag = Math.exp(-dt * 1.4);
      this.vel[j] *= drag; this.vel[j + 2] *= drag;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      // Fire hitting the ground splashes out along it.
      if (this.pos[j + 1] < 0.15) {
        this.pos[j + 1] = 0.15;
        if (this.vel[j + 1] < 0) {
          this.vel[j] *= 1.1; this.vel[j + 2] *= 1.1;
          this.vel[j + 1] = Math.abs(this.vel[j + 1]) * 0.15;
        }
      }
      P[j] = this.pos[j]; P[j + 1] = this.pos[j + 1]; P[j + 2] = this.pos[j + 2];
      // White-yellow core, orange body, dark red smoky tail.
      const heat = 1 - k;
      C[j] = 1.6 * Math.min(1, heat * 2.2 + 0.25);
      C[j + 1] = 1.25 * heat * heat + 0.12 * heat;
      C[j + 2] = 0.45 * Math.max(0, heat - 0.7) * 3;
      S[i] = 0.25 + k * 2.4;
    }
    this.posAttr.needsUpdate = this.colAttr.needsUpdate = this.sizeAttr.needsUpdate = true;
    // Light flickers while anyone is firing.
    this.lightLevel += ((this.lightTarget || 0) - this.lightLevel) * Math.min(1, dt * 12);
    this.light.intensity = this.lightLevel * (22 + Math.random() * 14);
    this.lightTarget = 0;
  }

  clear() {
    this.age.fill(1);
    this.life.fill(1);
    this.sizeAttr.array.fill(0);
    this.sizeAttr.needsUpdate = true;
  }
}

/** Where the stream is `d` metres along, for the burn query (matches the particles' arc). */
export function streamPoint(pos, dir, d, out = _flameV) {
  return out.set(pos.x + dir.x * d, pos.y + dir.y * d - FLAME.drop * d * d, pos.z + dir.z * d);
}
