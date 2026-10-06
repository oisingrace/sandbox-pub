import * as THREE from 'three';

// Crash damage. Bodywork is built from boxes split into panels about a
// hand wide (panelBox, panelTapered), so a hit can push in the panels
// around where it lands: the nose folds in a head-on crash, a door caves
// in when someone T-bones you, the roof sags after landing upside down.
// Every vertex keeps its undamaged position, so a repair is instant.
// Hits near a wheel bend it, hard hits at either end put the lights out,
// and a badly damaged car smokes from the engine and loses power.
//
// Directions and points are in the vehicle frame (x = left, y = up,
// z = forward, origin on the ground under the CG).

const PANEL = 0.34;        // m: how finely bodywork is split so it can dent
const MAX_DENT = 0.5;      // m: furthest any part of the body gets pushed in
const CAPACITY = 3.2;      // total dent (m) that counts as fully wrecked
const panelSegs = (size) => Math.max(1, Math.min(14, Math.round(size / PANEL)));

/** A box split into panels (same shape as THREE.BoxGeometry). */
export function panelBox(w, h, d) {
  return new THREE.BoxGeometry(w, h, d, panelSegs(w), panelSegs(h), panelSegs(d));
}

/**
 * A box whose top is narrowed to topW × topD and slid forward by
 * topOffsetZ (the tapered cabin and bonnet shapes), split into panels.
 */
export function panelTapered(w, h, d, topW, topD, topOffsetZ = 0) {
  const geo = new THREE.BoxGeometry(w, h, d, panelSegs(w), panelSegs(h), panelSegs(d));
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / h + 0.5; // 0 at the bottom, 1 at the top
    pos.setX(i, pos.getX(i) * (1 + (topW / w - 1) * t));
    pos.setZ(i, pos.getZ(i) * (1 + (topD / d - 1) * t) + topOffsetZ * t);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A repeatable 0..1 value for a point, so the crumple is the same for vertices that share a corner. */
function dmgHash(x, y, z, k = 0) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 19.3) * 43758.5453;
  return s - Math.floor(s);
}

export class CarDamage {
  /** @param {import('./carModel.js').CarModel} model */
  constructor(model) {
    this.model = model;
    this.meshes = [];
    const skip = new Set(model.flames);
    for (const m of model.body.children) {
      if (!m.isMesh || skip.has(m)) continue;
      const pos = m.geometry.attributes.position;
      this.meshes.push({ mesh: m, pos, orig: pos.array.slice(), dent: new Float32Array(pos.array.length) });
    }
    // The body's extent, for where things are (front, sides, roof).
    const box = new THREE.Box3();
    for (const { mesh } of this.meshes) {
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox);
    }
    this.bounds = box;
    this.zones = { front: 0, rear: 0, left: 0, right: 0, roof: 0 };
    this.total = 0;
    this.dirty = false;
    this.smokeT = 0;
  }

  /** 0 (like new) .. 1 (wrecked). */
  get level() {
    return Math.min(1, this.total / CAPACITY);
  }

  /**
   * A hit at a point on the car, pushing the bodywork in along `dir`
   * (unit, pointing into the car) by up to `amount` metres.
   */
  hit(p, dir, amount) {
    if (!(amount > 0.01)) return;
    amount = Math.min(amount, MAX_DENT);
    const R = Math.min(1.5, 0.6 + amount * 1.8);
    const R2 = R * R;
    const crumple = 0.35;
    for (const m of this.meshes) {
      const { orig, dent } = m;
      let touched = false;
      for (let i = 0; i < orig.length; i += 3) {
        const ox = orig[i], oy = orig[i + 1], oz = orig[i + 2];
        const dx = ox - p.x, dy = oy - p.y, dz = oz - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R2) continue;
        const f = 1 - Math.sqrt(d2) / R;
        const push = amount * f * f * (0.7 + 0.6 * dmgHash(ox, oy, oz));
        // Mostly straight in, with a little sideways buckle so it reads as crumpled metal.
        let nx = dent[i] + dir.x * push + (dmgHash(ox, oy, oz, 1) - 0.5) * push * crumple;
        let ny = dent[i + 1] + dir.y * push + (dmgHash(ox, oy, oz, 2) - 0.5) * push * crumple * 0.5;
        let nz = dent[i + 2] + dir.z * push + (dmgHash(ox, oy, oz, 3) - 0.5) * push * crumple;
        const len = Math.hypot(nx, ny, nz);
        if (len > MAX_DENT) { const k = MAX_DENT / len; nx *= k; ny *= k; nz *= k; }
        ny = Math.max(ny, Math.min(0, 0.16 - oy)); // nothing sags below the sills onto the road
        dent[i] = nx; dent[i + 1] = ny; dent[i + 2] = nz;
        touched = true;
      }
      if (touched) m.touched = true;
    }
    this.dirty = true;

    // Where it was: count it against that part of the car.
    const b = this.bounds;
    const midZ = (b.min.z + b.max.z) / 2, halfL = (b.max.z - b.min.z) / 2;
    const z = this.zones;
    if (dir.y < -0.6) z.roof += amount;
    else if (p.z > midZ + halfL * 0.45) z.front += amount;
    else if (p.z < midZ - halfL * 0.45) z.rear += amount;
    else if (p.x > 0) z.left += amount;
    else z.right += amount;
    this.total += amount;

    // A hit next to a wheel knocks it out of line.
    for (const w of this.model.wheels) {
      const d = Math.hypot(w.x - p.x, w.z - p.z);
      if (d < 1.1 && amount > 0.08 && dir.y > -0.6) {
        w.bent = Math.max(-0.3, Math.min(0.3, (w.bent || 0) + Math.sign(w.x) * amount * 0.5 * (1 - d / 1.1)));
      }
    }
    // Smashed lights.
    this.model.lightsOut = { head: z.front > 0.35, tail: z.rear > 0.35 };
    this.model.applyLights?.();
  }

  /** Back to new. */
  repair() {
    for (const m of this.meshes) {
      m.dent.fill(0);
      m.touched = true;
    }
    for (const k of Object.keys(this.zones)) this.zones[k] = 0;
    this.total = 0;
    for (const w of this.model.wheels) w.bent = 0;
    this.model.lightsOut = { head: false, tail: false };
    this.model.applyLights?.();
    this.dirty = true;
  }

  /** Write the dents into the meshes (once a frame at most). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const m of this.meshes) {
      if (!m.touched) continue;
      m.touched = false;
      const a = m.pos.array;
      for (let i = 0; i < a.length; i++) a[i] = m.orig[i] + m.dent[i];
      m.pos.needsUpdate = true;
      m.mesh.geometry.computeVertexNormals();
    }
  }

  /**
   * How much the damage pulls the steering (rad): a bent front wheel
   * toes the car toward that side.
   */
  get pull() {
    let p = 0;
    for (const w of this.model.wheels) if (w.front) p += (w.bent || 0) * 0.12;
    return p;
  }

  /** Where the engine is (car frame), for smoke. */
  enginePoint() {
    const b = this.bounds;
    return { x: 0, y: b.max.y * 0.7, z: b.max.z - (b.max.z - b.min.z) * 0.2 };
  }
}

const _dmgV = new THREE.Vector3();
const _dmgQ = new THREE.Quaternion();
const _dmgE = new THREE.Euler();

/** World point/direction <-> a car's frame (its heading, pitch and roll, as CarModel draws it). */
export function carQuat(car, out = _dmgQ) {
  _dmgE.set(-(car.pitch || 0), car.heading, car.roll || 0, 'YXZ');
  return out.setFromEuler(_dmgE);
}

export function toCarFrame(car, x, y, z, out = { x: 0, y: 0, z: 0 }, isDir = false) {
  _dmgV.set(isDir ? x : x - car.x, isDir ? y : y - (car.y || 0), isDir ? z : z - car.z);
  _dmgV.applyQuaternion(carQuat(car).invert());
  out.x = _dmgV.x; out.y = _dmgV.y; out.z = _dmgV.z;
  return out;
}

export function toWorld(car, p, out = new THREE.Vector3(), isDir = false) {
  out.set(p.x, p.y, p.z).applyQuaternion(carQuat(car));
  if (!isDir) out.add(_dmgV.set(car.x, car.y || 0, car.z));
  return out;
}

/**
 * Bits of bodywork and glass thrown off in a crash: small tumbling chips
 * that bounce, settle and fade. One shared pool of instances.
 */
export class CrashBits {
  constructor(scene, count = 220) {
    this.count = count;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.4 });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.bits = [];
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) {
      this.mesh.setMatrixAt(i, hide);
      this.mesh.setColorAt(i, new THREE.Color(0xffffff));
      this.bits.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: new THREE.Vector3() });
    }
    this.next = 0;
    this.live = 0;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._dq = new THREE.Quaternion();
    this._c = new THREE.Color();
  }

  /**
   * Throw `n` bits from `pos` outward along `out` (unit, world) at about
   * `speed`, in `color`; glass bits are thin and pale.
   */
  spawn(pos, out, speed, n, color, glass = false) {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      const b = this.bits[i];
      b.life = 3 + Math.random() * 3;
      b.p.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + Math.random() * 0.3, pos.z + (Math.random() - 0.5) * 0.4);
      const sp = speed * (0.3 + Math.random() * 0.7);
      b.v.set(out.x * sp + (Math.random() - 0.5) * speed * 0.6, 1.5 + Math.random() * speed * 0.45, out.z * sp + (Math.random() - 0.5) * speed * 0.6);
      b.w.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
      b.q.random();
      if (glass) b.s.set(0.05 + Math.random() * 0.08, 0.012, 0.05 + Math.random() * 0.08);
      else b.s.set(0.08 + Math.random() * 0.2, 0.03 + Math.random() * 0.04, 0.06 + Math.random() * 0.16);
      this.mesh.setColorAt(i, this._c.set(glass ? 0xbfd6e6 : color));
      b.rest = false;
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.live = Math.max(this.live, 1);
  }

  update(dt, terrain) {
    if (!this.live) return;
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      const b = this.bits[i];
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) {
        this.mesh.setMatrixAt(i, this._m.makeScale(0, 0, 0));
        continue;
      }
      live++;
      if (!b.rest) {
        b.v.y -= 9.81 * dt;
        b.p.addScaledVector(b.v, dt);
        this._dq.setFromEuler(_dmgE.set(b.w.x * dt, b.w.y * dt, b.w.z * dt));
        b.q.multiply(this._dq);
        const ground = (terrain ? terrain.heightAt(b.p.x, b.p.z) : 0) + b.s.y / 2;
        if (b.p.y < ground) {
          b.p.y = ground;
          if (b.v.y < -1.5) {
            b.v.y *= -0.3;
            b.v.x *= 0.6; b.v.z *= 0.6;
            b.w.multiplyScalar(0.5);
          } else {
            b.rest = true; // lies flat where it landed
            b.q.setFromEuler(_dmgE.set(0, Math.random() * 6.3, 0));
          }
        }
      }
      // Shrink away at the end.
      const k = Math.min(1, b.life / 0.6);
      this.mesh.setMatrixAt(i, this._m.compose(b.p, b.q, _dmgV.copy(b.s).multiplyScalar(k)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = live;
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this.bits[i].life = 0;
      this.mesh.setMatrixAt(i, this._m.makeScale(0, 0, 0));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
  }
}
