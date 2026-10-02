import * as THREE from 'three';

// Burn effect for the Ember GT. A burned object is replaced by voxels that
// fill its shape. Ignition spreads out from the side the car touched: each
// voxel flares white-hot, cools through orange and red to dark ash, and
// shrinks away while drifting upward as an ember. Everything is one
// InstancedMesh with an unlit, non-tone-mapped material so the hot colours
// read as genuinely bright.

const SPREAD_SPEED = 9; // m/s the burn front travels across an object
const HEAT_TIME = 0.14; // seconds to flare up
const HOT = [4.0, 3.2, 2.2]; // white-hot (HDR, clips to near white)
const COOL = [
  [3.0, 1.15, 0.2], // bright orange
  [1.4, 0.25, 0.04], // red
  [0.12, 0.04, 0.03], // ash
];

const _burnQ = new THREE.Quaternion();
const _burnV = new THREE.Vector3();
const _burnC = new THREE.Color();

export class BurnEffect {
  constructor(scene, capacity = 6000) {
    this.capacity = capacity;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _burnC.set(0, 0, 0));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    const n = capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.base = new Float32Array(n * 3);
    this.start = new Float32Array(n); // ignition time
    this.life = new Float32Array(n); // seconds after ignition
    this.size = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.next = 0;
    this.high = 0; // one past the highest slot ever used
    this.active = 0;
    this.time = 0;
    this.maxPerObject = 150;
    this.shapes = new Map();

    // Two pooled lights flash where things ignite. Point lights cost shading
    // time on every lit pixel even at zero intensity, so they're only in
    // the scene at the high effects setting.
    this.scene = scene;
    this.lights = [0, 1].map(() => ({ light: new THREE.PointLight(0xff7a2a, 0, 14, 2), t: 0 }));
    this.lightIndex = 0;
    this.lightsOn = false;
  }

  setDetail(maxPerObject, lights) {
    this.maxPerObject = maxPerObject;
    if (lights !== this.lightsOn) {
      for (const l of this.lights) {
        if (lights) this.scene.add(l.light);
        else this.scene.remove(l.light);
      }
      this.lightsOn = lights;
    }
  }

  /** Replace a burned object with voxels. `info` comes from Destruction's burn event. */
  ignite(info) {
    const { cells, size } = this.shapeFor(info.kind);
    const color = info.color ? info.color : _burnC.set(0xffffff);
    const centre = info.pos;
    _burnQ.copy(info.quat);
    // The burn starts at the point nearest the car and spreads from there.
    let nearest = Infinity;
    for (const cell of cells) {
      _burnV.set(cell.x, cell.y, cell.z).applyQuaternion(_burnQ).add(centre);
      nearest = Math.min(nearest, _burnV.distanceTo(info.from));
    }
    for (const cell of cells) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      if (!this.alive[i]) this.active++;
      this.alive[i] = 1;
      this.high = Math.max(this.high, i + 1);
      _burnV.set(cell.x, cell.y, cell.z).applyQuaternion(_burnQ).add(centre);
      this.pos.set([_burnV.x, _burnV.y, _burnV.z], i * 3);
      const dist = Math.hypot(_burnV.x - info.from.x, _burnV.y - info.from.y, _burnV.z - info.from.z);
      this.start[i] = this.time + (dist - nearest) / SPREAD_SPEED + Math.random() * 0.06;
      this.life[i] = 0.9 + Math.random() * 0.9;
      this.size[i] = size * (0.85 + Math.random() * 0.2);
      // Embers rise and scatter a little.
      this.vel.set([(Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 1.4, (Math.random() - 0.5) * 0.8], i * 3);
      const c = cell.color ?? color;
      this.base.set([c.r, c.g, c.b], i * 3);
    }
    this.mesh.count = this.high;

    const flash = this.lights[this.lightIndex];
    this.lightIndex = (this.lightIndex + 1) % this.lights.length;
    flash.light.position.copy(centre).setY(centre.y + 0.8);
    flash.t = 0.7;
  }

  /** Fuel-drum fireball: a burst of white-hot voxels flung outward. */
  fireball(centre) {
    const n = Math.round(this.maxPerObject * 1.6);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      if (!this.alive[i]) this.active++;
      this.alive[i] = 1;
      this.high = Math.max(this.high, i + 1);
      // Random direction, biased upward; faster near the core.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dir = [r * Math.cos(a), Math.abs(u) * 0.8 + 0.2, r * Math.sin(a)];
      const speed = 3 + Math.random() * 9;
      const start = Math.random() * 0.5;
      this.pos.set([centre.x + dir[0] * start, centre.y + 0.3 + dir[1] * start, centre.z + dir[2] * start], i * 3);
      this.vel.set([dir[0] * speed, dir[1] * speed, dir[2] * speed], i * 3);
      this.start[i] = this.time + Math.random() * 0.05;
      this.life[i] = 0.5 + Math.random() * 0.9;
      this.size[i] = 0.18 + Math.random() * 0.32;
      this.base.set([1, 0.6, 0.2], i * 3);
    }
    this.mesh.count = this.high;
    const flash = this.lights[this.lightIndex];
    this.lightIndex = (this.lightIndex + 1) % this.lights.length;
    flash.light.position.copy(centre).setY(centre.y + 1.5);
    flash.t = 1.1;
  }

  /** Voxel cells filling a kind's shape, cached per kind and detail level. */
  shapeFor(kind) {
    const key = `${kind.name}:${this.maxPerObject}`;
    if (this.shapes.has(key)) return this.shapes.get(key);
    const result = voxelize(kind, this.maxPerObject);
    this.shapes.set(key, result);
    return result;
  }

  update(dt) {
    this.time += dt;
    for (const f of this.lights) {
      f.t = Math.max(0, f.t - dt);
      f.light.intensity = f.t > 0 ? 40 * (f.t / 0.7) ** 2 : 0;
    }
    if (!this.active) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const m = this.mesh.instanceMatrix.array;
    const col = this.mesh.instanceColor.array;
    const now = this.time;
    let highest = 0;
    for (let i = 0; i < this.high; i++) {
      const o = i * 16;
      if (!this.alive[i]) {
        m[o] = m[o + 5] = m[o + 10] = 0;
        continue;
      }
      highest = i + 1;
      const age = now - this.start[i];
      const p = i * 3;
      let s = this.size[i];
      let r = this.base[p], g = this.base[p + 1], b = this.base[p + 2];
      if (age > 0) {
        const life = this.life[i];
        if (age >= HEAT_TIME + life) {
          this.alive[i] = 0;
          this.active--;
          m[o] = m[o + 5] = m[o + 10] = 0;
          continue;
        }
        if (age < HEAT_TIME) {
          const k = age / HEAT_TIME;
          r += (HOT[0] - r) * k; g += (HOT[1] - g) * k; b += (HOT[2] - b) * k;
        } else {
          // Cool along HOT -> orange -> red -> ash.
          const k = (age - HEAT_TIME) / life;
          const stops = [HOT, ...COOL];
          const x = Math.min(0.999, k) * (stops.length - 1);
          const a = stops[Math.floor(x)];
          const c = stops[Math.floor(x) + 1];
          const f = x - Math.floor(x);
          r = a[0] + (c[0] - a[0]) * f; g = a[1] + (c[1] - a[1]) * f; b = a[2] + (c[2] - a[2]) * f;
          // Air drag slows fast voxels; heat makes them rise.
          const drag = Math.exp(-dt * 2.2);
          this.vel[p] *= drag;
          this.vel[p + 1] = this.vel[p + 1] * drag + 1.2 * dt;
          this.vel[p + 2] *= drag;
          // Drift and shrink over the second half of its life.
          this.pos[p] += this.vel[p] * dt;
          this.pos[p + 1] += this.vel[p + 1] * dt;
          this.pos[p + 2] += this.vel[p + 2] * dt;
          if (k > 0.45) s *= 1 - (k - 0.45) / 0.55;
        }
      }
      m[o] = s; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = s; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = s; m[o + 11] = 0;
      m[o + 12] = this.pos[p]; m[o + 13] = this.pos[p + 1]; m[o + 14] = this.pos[p + 2]; m[o + 15] = 1;
      col[p] = r; col[p + 1] = g; col[p + 2] = b;
    }
    // Shrink the draw range as the oldest voxels finish.
    if (highest < this.high && this.next <= highest) this.high = highest;
    if (!this.active) { this.high = 0; this.next = 0; }
    this.mesh.count = this.high;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.active = 0;
    this.high = 0;
    this.next = 0;
    this.mesh.count = 0;
  }
}

// --- Voxelizing object kinds ----------------------------------------------

const BROWN = new THREE.Color(0x6b4a2f);
const LEAF = new THREE.Color(0x4a8a42);
const CONE_ORANGE = new THREE.Color(0xff5a1f);
const CONE_WHITE = new THREE.Color(0xf5f5f5);
const STEEL = new THREE.Color(0x9a9da3);
const LAMP = new THREE.Color(0xfff2c4);

/**
 * Fill a kind's shape with at most `max` cubic cells. Returns cell centres
 * in the object's local frame (optionally with their own colour) and the
 * cube size.
 */
function voxelize(kind, max) {
  const inside = shapeTest(kind);
  const [sx, sy, sz] = bounds(kind);
  // Pick a cell size so the filled volume lands near `max` cells.
  let size = Math.cbrt((sx * sy * sz * inside.fill) / max);
  size = Math.max(size, 0.12);
  let cells;
  for (let attempt = 0; attempt < 8; attempt++) {
    cells = [];
    const nx = Math.max(1, Math.round(sx / size));
    const ny = Math.max(1, Math.round(sy / size));
    const nz = Math.max(1, Math.round(sz / size));
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const x = ((ix + 0.5) / nx - 0.5) * sx;
          const y = ((iy + 0.5) / ny - 0.5) * sy;
          const z = ((iz + 0.5) / nz - 0.5) * sz;
          const hit = inside.test(x, y, z);
          if (hit) cells.push({ x, y: y + (inside.offsetY || 0), z, color: hit === true ? undefined : hit });
        }
      }
    }
    if (cells.length <= max) break;
    size *= 1.15;
  }
  return { cells, size };
}

function bounds(kind) {
  if (kind.shape === 'cyl') return [kind.size[0] * 2, kind.size[1], kind.size[0] * 2];
  if (kind.shape === 'tree') return [3.2, 5.6, 3.2];
  return kind.size;
}

/** Point-in-shape tests; may return a colour to override the object's. */
function shapeTest(kind) {
  if (kind.name === 'tree') {
    // Trunk from y=-1.5..1.5 (body centre), foliage cone from ~0.7 to 4.0.
    return {
      fill: 0.3,
      offsetY: 1.2, // the body origin is mid-trunk; the canopy sits above it
      test(x, y, z) {
        const yy = y + 1.2; // bounds are centred; shift into body space
        const r = Math.hypot(x, z);
        if (yy >= 0.7 && yy <= 4.1 && r <= 1.6 * (1 - (yy - 0.7) / 3.4)) return LEAF;
        if (yy >= -1.5 && yy <= 1.5 && r <= 0.24) return BROWN;
        return false;
      },
    };
  }
  if (kind.name === 'cone') {
    return {
      fill: 0.4,
      test(x, y, z) {
        const r = Math.hypot(x, z);
        const t = (y + 0.3) / 0.6; // 0 at base, 1 at tip
        if (r > 0.2 * (1 - t) + 0.03) return false;
        return t > 0.45 && t < 0.72 ? CONE_WHITE : CONE_ORANGE;
      },
    };
  }
  if (kind.name === 'pole') {
    return {
      fill: 0.8,
      test(x, y, z) {
        if (Math.hypot(x, z) <= kind.size[0] + 0.02) return y > 3.1 ? LAMP : STEEL;
        return false;
      },
    };
  }
  if (kind.shape === 'cyl') {
    const r = kind.size[0];
    return { fill: 0.785, test: (x, y, z) => Math.hypot(x, z) <= r + 1e-6 };
  }
  return { fill: 1, test: () => true };
}
