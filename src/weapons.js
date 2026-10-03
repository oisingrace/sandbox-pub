import * as THREE from 'three';

// Versus weapons: what each one does, the turrets that show them on the
// cars' roofs, and the things they put in the world (tracers, rockets,
// mines, muzzle flashes, sparks). The rules (who gets hurt, by how much)
// live in versus.js; this file is the hardware.

/**
 * Weapons. `ammo` is what a Versus pickup gives: shots (rockets, mines),
 * salvos, or seconds of fire (flamethrower); the machine gun never runs
 * out. A custom car built with rockets, a salvo or mines carries a
 * magazine of `mag` that refills one every `reload` seconds. Damage is in
 * hit points.
 */
export const WEAPONS = {
  mg: { label: 'Machine gun', interval: 1 / 9, damage: 5, range: 70, spread: 0.02, color: 0xffd23f },
  rockets: { label: 'Rockets', interval: 0.6, ammo: 8, mag: 3, reload: 2.5, damage: 45, radius: 7, speed: 45, turn: 2.4, range: 90, color: 0xff5a36 },
  salvo: { label: 'Rocket salvo', interval: 0.95, ammo: 4, mag: 2, reload: 4.5, perShot: 3, damage: 32, radius: 6.5, speed: 42, turn: 2.8, range: 90, color: 0xff2d55 },
  flamer: { label: 'Flamethrower', ammo: 8, dps: 36, range: 15, color: 0xff9a1f },
  mines: { label: 'Mines', interval: 0.5, ammo: 4, mag: 3, reload: 3.5, damage: 55, radius: 6.5, trigger: 3.5, arm: 0.8, color: 0xffd23f },
  inferno: { label: 'Flamethrower', dps: 36, range: 15, color: 0xff9a1f }, // the Inferno's own, on its tank
};
/** Weapon order on the wire (index = code). */
export const WEAPON_CODES = ['mg', 'rockets', 'salvo', 'flamer', 'mines', 'inferno'];

const _wq = new THREE.Quaternion();
const _we = new THREE.Euler();
const _wv = new THREE.Vector3();

/** Where a car's turret sits (car frame): the flamethrower mount, else the middle of its roof. */
export function turretMount(def) {
  if (def.flamethrower) return def.flamethrower.mount;
  if (def.turretMount) return def.turretMount;
  let top = 0, z = 0;
  for (const h of def.hitbox) {
    const t = h.at[1] + h.half[1];
    if (t > top) { top = t; z = h.at[2]; }
  }
  def.turretMount = [0, top, z];
  return def.turretMount;
}

/** A car frame point in the world, for a car pose (x, y, z, heading, pitch, roll). */
export function carPoint(car, local, out = new THREE.Vector3()) {
  _we.set(-(car.pitch || 0), car.heading, car.roll || 0, 'YXZ');
  _wq.setFromEuler(_we);
  out.set(local[0], local[1], local[2]).applyQuaternion(_wq);
  out.x += car.x;
  out.y += car.y || 0;
  out.z += car.z;
  return out;
}

/** Unit direction for a yaw (0 = +Z) and pitch (up positive). */
export function aimDir(yaw, pitch, out = new THREE.Vector3()) {
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c);
}

/**
 * Ray against a car's bounding box (in its yaw frame; pitch and roll
 * ignored). `b` = { lo, hi } hitbox bounds. Returns the distance or -1.
 */
export function rayCar(o, d, maxD, car, b) {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  const px = o.x - car.x, py = o.y - (car.y || 0), pz = o.z - car.z;
  // Into the car frame: local x = right... (x' = x cos - z sin, z' = x sin + z cos)
  const lo = [px * c - pz * s, py, px * s + pz * c];
  const ld = [d.x * c - d.z * s, d.y, d.x * s + d.z * c];
  let t0 = 0, t1 = maxD;
  for (let i = 0; i < 3; i++) {
    const pad = i === 1 ? 0.1 : 0.15; // a touch generous
    const min = b.lo[i] - pad, max = b.hi[i] + pad;
    if (Math.abs(ld[i]) < 1e-8) {
      if (lo[i] < min || lo[i] > max) return -1;
      continue;
    }
    let a = (min - lo[i]) / ld[i], e = (max - lo[i]) / ld[i];
    if (a > e) [a, e] = [e, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, e);
    if (t0 > t1) return -1;
  }
  return t0;
}

/** Hitbox bounds in the car frame. */
export function carBounds(def) {
  if (def.vsBounds) return def.vsBounds;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const h of def.hitbox) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], h.at[i] - h.half[i]);
      hi[i] = Math.max(hi[i], h.at[i] + h.half[i]);
    }
  }
  lo[1] = Math.min(lo[1], 0.1);
  def.vsBounds = { lo, hi };
  return def.vsBounds;
}

// --- Turrets ---------------------------------------------------------------

const turretMats = {};
function tMat(key, color, emissive = 0, intensity = 0) {
  if (!turretMats[key]) {
    turretMats[key] = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, metalness: 0.55, roughness: 0.45 });
    turretMats[key].userData.shared = true; // CarModel.dispose leaves it alone
  }
  return turretMats[key];
}

/**
 * Put a weapon's turret on a car (`parent` is the car model's root): on
 * the roof, or a mine dispenser at the back. Returns the turret.
 */
export function mountTurret(parent, def, weapon) {
  const t = makeTurret(weapon);
  t.key = weapon;
  const m = turretMount(def);
  if (weapon === 'mines') t.root.position.set(m[0], Math.max(0.9, m[1] * 0.6), carBounds(def).lo[2] + 0.4);
  else t.root.position.set(m[0], m[1], m[2]);
  parent.add(t.root);
  return t;
}

/**
 * A roof turret for a weapon: a swivelling base (`yaw`) and a gun that
 * tilts (`pitch`). Mines get a dispenser at the back instead.
 */
export function makeTurret(weapon) {
  const root = new THREE.Group();
  root.name = 'vsTurret';
  const dark = tMat('dark', 0x2b2f35);
  const yaw = new THREE.Group();
  const pitch = new THREE.Group();
  pitch.position.y = 0.26;
  yaw.add(pitch);
  root.add(yaw);
  const add = (parent, geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  if (weapon === 'mines') {
    add(yaw, new THREE.BoxGeometry(0.7, 0.3, 0.5), dark, 0, 0.15, 0);
    add(yaw, new THREE.CylinderGeometry(0.16, 0.16, 0.08, 14), tMat('mine', 0x3a3a3a, 0xff2020, 1.5), 0, 0.34, 0);
    return { root, yaw, pitch, muzzle: 0.3 };
  }
  add(yaw, new THREE.CylinderGeometry(0.3, 0.36, 0.2, 14), dark, 0, 0.1, 0);
  if (weapon === 'mg') {
    add(pitch, new THREE.BoxGeometry(0.34, 0.2, 0.42), dark, 0, 0, 0);
    const barrel = new THREE.CylinderGeometry(0.035, 0.035, 0.8, 8);
    barrel.rotateX(Math.PI / 2);
    for (const x of [-0.08, 0.08]) add(pitch, barrel, tMat('steel', 0x5a6068), x, 0.02, 0.55);
    return { root, yaw, pitch, muzzle: 0.95 };
  }
  if (weapon === 'rockets' || weapon === 'salvo') {
    const w = weapon === 'salvo' ? 0.78 : 0.56;
    add(pitch, new THREE.BoxGeometry(w, 0.38, 0.8), tMat(weapon, WEAPONS[weapon].color, WEAPONS[weapon].color, 0.25), 0, 0.02, 0.1);
    const tube = new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10);
    tube.rotateX(Math.PI / 2);
    const cols = weapon === 'salvo' ? 3 : 2;
    for (let i = 0; i < cols; i++) for (const y of [-0.08, 0.1]) add(pitch, tube, tMat('hole', 0x111111), (i - (cols - 1) / 2) * 0.22, y, 0.52);
    return { root, yaw, pitch, muzzle: 0.6 };
  }
  // Flamethrower: fuel tank and a nozzle.
  const tank = new THREE.CylinderGeometry(0.17, 0.17, 0.62, 12);
  tank.rotateX(Math.PI / 2);
  add(pitch, tank, tMat('fuel', 0xc94b1c, 0xff5a10, 0.2), 0, 0, -0.05);
  const noz = new THREE.CylinderGeometry(0.06, 0.1, 0.5, 10);
  noz.rotateX(Math.PI / 2);
  add(pitch, noz, tMat('steel', 0x5a6068), 0, 0.02, 0.45);
  return { root, yaw, pitch, muzzle: 0.75 };
}

// --- Effects in the world ---------------------------------------------------

/**
 * Tracers, flashes, sparks, rockets and mines. Rockets and mines are
 * simulated here (flight, homing, arming); what they do when they go off
 * is up to the `onBlast(kind, thing)` callback.
 */
export class Arsenal {
  constructor(scene) {
    this.scene = scene;
    // Tracers: short glowing streaks flying from muzzle to impact.
    this.tracerCap = 120;
    this.tracers = [];
    const tGeo = new THREE.BufferGeometry();
    this.tPos = new Float32Array(this.tracerCap * 6);
    this.tCol = new Float32Array(this.tracerCap * 6);
    tGeo.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    tGeo.setAttribute('color', new THREE.BufferAttribute(this.tCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerLines = new THREE.LineSegments(tGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.tracerLines.frustumCulled = false;
    scene.add(this.tracerLines);

    // Flashes and sparks: pooled additive sprites.
    const flashTex = glowTexture();
    this.sprites = [];
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffd27a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      s.visible = false;
      s.userData.life = 0;
      scene.add(s);
      this.sprites.push(s);
    }
    this.nextSprite = 0;

    this.rockets = [];
    this.mines = [];
    this.rocketGeo = (() => {
      const body = new THREE.CylinderGeometry(0.09, 0.09, 0.7, 8);
      body.rotateX(Math.PI / 2);
      return body;
    })();
    this.rocketMat = new THREE.MeshStandardMaterial({ color: 0xdedede, metalness: 0.4, roughness: 0.4 });
    this.mineGeo = new THREE.CylinderGeometry(0.42, 0.5, 0.16, 16);
    this.mineMat = new THREE.MeshStandardMaterial({ color: 0x2e3238, metalness: 0.5, roughness: 0.5 });
    this.mineLightGeo = new THREE.SphereGeometry(0.08, 8, 6);
    this.flashTex = flashTex;
  }

  /** A short-lived glow (muzzle flash, spark, fire). */
  flash(pos, size, color, life = 0.05) {
    const s = this.sprites[this.nextSprite];
    this.nextSprite = (this.nextSprite + 1) % this.sprites.length;
    s.position.copy(pos);
    s.scale.setScalar(size);
    s.material.color.setHex(color);
    s.material.opacity = 1;
    s.userData.life = s.userData.max = life;
    s.visible = true;
  }

  tracer(from, to, color = 0xffd25a) {
    if (this.tracers.length >= this.tracerCap) this.tracers.shift();
    const len = from.distanceTo(to);
    this.tracers.push({
      from: from.clone(), dir: _wv.subVectors(to, from).normalize().clone(), len, at: 0,
      c: new THREE.Color(color),
    });
  }

  fireRocket(r) {
    const mesh = new THREE.Mesh(this.rocketGeo, this.rocketMat);
    const tail = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, color: 0xff8a3a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    tail.scale.setScalar(0.9);
    tail.position.z = -0.45;
    mesh.add(tail);
    mesh.position.copy(r.pos);
    this.scene.add(mesh);
    r.mesh = mesh;
    r.age = 0;
    this.rockets.push(r);
    return r;
  }

  dropMine(m) {
    const mesh = new THREE.Mesh(this.mineGeo, this.mineMat);
    const light = new THREE.Mesh(this.mineLightGeo, new THREE.MeshBasicMaterial({ color: 0xff2a2a, toneMapped: false }));
    light.position.y = 0.11;
    mesh.add(light);
    mesh.position.set(m.pos.x, m.pos.y + 0.08, m.pos.z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    m.mesh = mesh;
    m.light = light;
    m.age = 0;
    this.mines.push(m);
    return m;
  }

  removeRocket(r) {
    this.scene.remove(r.mesh);
    r.mesh.children[0]?.material.dispose();
    r.dead = true;
  }

  removeMine(m) {
    this.scene.remove(m.mesh);
    m.light.material.dispose();
    m.dead = true;
  }

  clear() {
    for (const r of this.rockets) this.removeRocket(r);
    for (const m of this.mines) this.removeMine(m);
    this.rockets = [];
    this.mines = [];
    this.tracers = [];
    for (const s of this.sprites) s.visible = false;
  }

  /** Move rockets (homing on `targetOf(r)`), age mines, draw tracers and flashes. */
  update(dt, { targetOf, rocketHits, trail }) {
    for (const r of this.rockets) {
      if (r.dead) continue;
      r.age += dt;
      const t = targetOf(r);
      if (t && r.age > 0.12) {
        // Turn toward the target at a limited rate.
        const want = _wv.set(t.x - r.pos.x, t.y - r.pos.y, t.z - r.pos.z).normalize();
        const cur = r.vel.clone().normalize();
        const ang = Math.acos(Math.max(-1, Math.min(1, cur.dot(want))));
        if (ang > 1e-4) {
          const k = Math.min(1, (r.turn * dt) / ang);
          cur.lerp(want, k).normalize();
          r.vel.copy(cur.multiplyScalar(r.speed));
        }
      }
      const from = r.pos.clone();
      r.pos.addScaledVector(r.vel, dt);
      const hit = rocketHits(r, from, r.pos);
      if (hit || r.age > 3.2) {
        if (hit) r.pos.copy(hit);
        r.boom = true;
        continue;
      }
      r.mesh.position.copy(r.pos);
      r.mesh.lookAt(_wv.copy(r.pos).add(r.vel));
      trail(r.pos, r.vel);
    }
    for (const m of this.mines) {
      if (m.dead) continue;
      m.age += dt;
      // Blinks faster once armed.
      const rate = m.age < m.arm ? 2 : 6;
      m.light.visible = Math.sin(m.age * rate * Math.PI * 2) > 0;
    }

    // Tracers fly at 420 m/s as 5 m streaks.
    const P = this.tPos, C = this.tCol;
    let n = 0;
    this.tracers = this.tracers.filter((t) => t.at < t.len);
    for (const t of this.tracers) {
      t.at += 420 * dt;
      const a = Math.max(0, Math.min(t.len, t.at - 5));
      const b = Math.min(t.len, t.at);
      const i = n * 6;
      P[i] = t.from.x + t.dir.x * a; P[i + 1] = t.from.y + t.dir.y * a; P[i + 2] = t.from.z + t.dir.z * a;
      P[i + 3] = t.from.x + t.dir.x * b; P[i + 4] = t.from.y + t.dir.y * b; P[i + 5] = t.from.z + t.dir.z * b;
      C[i] = t.c.r * 0.3; C[i + 1] = t.c.g * 0.3; C[i + 2] = t.c.b * 0.3;
      C[i + 3] = t.c.r * 2; C[i + 4] = t.c.g * 2; C[i + 5] = t.c.b * 2;
      n++;
    }
    for (let i = n * 6; i < this.tracerCap * 6; i++) P[i] = 0;
    const g = this.tracerLines.geometry;
    g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, n * 2);

    for (const s of this.sprites) {
      if (!s.visible) continue;
      s.userData.life -= dt;
      if (s.userData.life <= 0) { s.visible = false; continue; }
      s.material.opacity = s.userData.life / s.userData.max;
    }
  }

  /** Rockets that hit something this frame (and are now gone). */
  spent() {
    const out = this.rockets.filter((r) => r.boom && !r.dead);
    for (const r of out) this.removeRocket(r);
    this.rockets = this.rockets.filter((r) => !r.dead);
    return out;
  }
}

let _glow;
function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}
