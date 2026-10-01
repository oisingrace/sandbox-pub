import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// Rigid-body world for everything the car can smash. Each object kind is
// drawn with one InstancedMesh, so hundreds of pieces stay cheap. Objects
// with a `fracture` rule shatter into a grid of smaller kinds when a
// contact force exceeds their `breakForce`.

export async function initRapier() {
  await RAPIER.init();
}

const MAX_BODIES = 1700;
const FRACTURES_PER_STEP = 10;
const MAX_DEBRIS_SPEED = 32;
const SOLVER_ITERATIONS = 4;
// Rapier treats the kinematic car as infinitely heavy; scaling the reaction
// makes hits feel weighty without making the car bounce off bricks.
const REACTION_SCALE = 1.6;
// Momentum the car loses per kg of material it shatters (N·s per kg),
// standing in for mortar and joints that a loose stack doesn't have.
const BREAK_DRAG = 7;
export const WORLD_STEP = 1 / 60;
const STEP = WORLD_STEP;
// breakForce values are tuned as force over a 1/120 s step; convert to impulse.
const breakImpulse = (kind) => (kind.breakForce || Infinity) / 120;

// --- Geometry helpers --------------------------------------------------

function colored(geo, hex) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function merge(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const arr = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}

function barrierProfile(w, h, d, topW) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setX(i, pos.getX(i) * (topW / w));
  geo.computeVertexNormals();
  return geo;
}

function coneGeo() {
  const parts = [];
  const add = (g, hex) => parts.push(colored(g, hex));
  const base = new THREE.BoxGeometry(0.5, 0.05, 0.5); base.translate(0, -0.275, 0); add(base, 0xff5a1f);
  const lower = new THREE.CylinderGeometry(0.13, 0.2, 0.25, 14); lower.translate(0, -0.125, 0); add(lower, 0xff5a1f);
  const band = new THREE.CylinderGeometry(0.09, 0.13, 0.17, 14); band.translate(0, 0.085, 0); add(band, 0xf5f5f5);
  const tip = new THREE.CylinderGeometry(0.02, 0.09, 0.2, 14); tip.translate(0, 0.27, 0); add(tip, 0xff5a1f);
  return merge(parts);
}

function poleGeo() {
  const pole = colored(new THREE.CylinderGeometry(0.1, 0.14, 7, 10), 0x9a9da3);
  const arm = new THREE.BoxGeometry(1.0, 0.1, 0.12); arm.translate(0.45, 3.35, 0);
  const lamp = new THREE.BoxGeometry(0.5, 0.14, 0.3); lamp.translate(0.85, 3.28, 0);
  return merge([pole, colored(arm, 0x8a8d93), colored(lamp, 0xfff2c4)]);
}

function treeGeo() {
  const trunk = colored(new THREE.CylinderGeometry(0.16, 0.24, 3, 8), 0x6b4a2f);
  const f1 = new THREE.ConeGeometry(1.6, 2.6, 8); f1.translate(0, 2.0, 0);
  const f2 = new THREE.ConeGeometry(1.15, 2.0, 8); f2.translate(0, 3.0, 0);
  return merge([trunk, colored(f1, 0x3f7a3a), colored(f2, 0x4f8f45)]);
}

// --- Object kinds ------------------------------------------------------
// size = full extents of the collider box (or [radius, height] for cylinders).

const BRICK_COLORS = [0xa34a32, 0xb2553a, 0x93412c, 0xa85b42, 0x8e3e2b];
const CONCRETE = [0xb8b5ad, 0xaeaba3, 0xc2bfb7];
const WOOD = [0xb58a52, 0xa77d48, 0xc0965c];

export const KINDS = {
  brick: { size: [0.6, 0.3, 0.3], mass: 12, colors: BRICK_COLORS, material: 'brick', breakForce: 14000, fracture: { into: 'brickHalf', grid: [2, 1, 1] }, cap: 600 },
  brickHalf: { size: [0.3, 0.3, 0.3], mass: 6, colors: BRICK_COLORS, material: 'brick', cap: 900 },

  crate: { size: [1, 1, 1], mass: 40, colors: WOOD, material: 'wood', breakForce: 26000, fracture: { into: 'crateChunk', grid: [2, 2, 2] }, cap: 60 },
  crateChunk: { size: [0.5, 0.5, 0.5], mass: 5, colors: WOOD, material: 'wood', cap: 500 },

  block: { size: [1, 1, 1], mass: 220, colors: CONCRETE, material: 'concrete', breakForce: 150000, fracture: { into: 'blockChunk', grid: [2, 2, 2] }, cap: 200 },
  blockChunk: { size: [0.5, 0.5, 0.5], mass: 27, colors: CONCRETE, material: 'concrete', cap: 900 },

  plank: { size: [4.4, 0.2, 1], mass: 60, colors: WOOD, material: 'wood', breakForce: 30000, fracture: { into: 'plankHalf', grid: [2, 1, 1] }, cap: 20 },
  plankHalf: { size: [2.2, 0.2, 1], mass: 30, colors: WOOD, material: 'wood', breakForce: 30000, fracture: { into: 'plankBit', grid: [2, 1, 1] }, cap: 40 },
  plankBit: { size: [1.1, 0.2, 1], mass: 15, colors: WOOD, material: 'wood', cap: 80 },

  slab: { size: [0.3, 2.2, 1.2], mass: 90, colors: [0xe8e4da, 0xd9534f, 0x3d7dd8, 0xf2c230], material: 'concrete', breakForce: 70000, fracture: { into: 'slabHalf', grid: [1, 2, 1] }, cap: 50 },
  slabHalf: { size: [0.3, 1.1, 1.2], mass: 45, colors: [0xe8e4da, 0xd9534f, 0x3d7dd8, 0xf2c230], material: 'concrete', cap: 100 },

  barrier: { size: [0.6, 0.9, 3], mass: 700, colors: [0xe9e6df, 0xd9d5cc], material: 'concrete', breakForce: 420000, fracture: { into: 'barrierChunk', grid: [1, 1, 3] }, geo: () => barrierProfile(0.6, 0.9, 3, 0.26), cap: 180 },
  barrierChunk: { size: [0.6, 0.9, 1], mass: 233, colors: [0xe9e6df, 0xd9d5cc], material: 'concrete', geo: () => barrierProfile(0.6, 0.9, 1, 0.26), cap: 300 },

  barrel: { shape: 'cyl', size: [0.32, 0.95], mass: 22, colors: [0xc8342b, 0x2f6fb3, 0xe0a526, 0x4c8c3a], material: 'metal', restitution: 0.25, cap: 60 },
  cone: { shape: 'cyl', size: [0.2, 0.6], mass: 3, colors: [0xffffff], material: 'plastic', geo: coneGeo, restitution: 0.3, cap: 60 },

  pole: { shape: 'cyl', size: [0.13, 7], mass: 150, colors: [0xffffff], material: 'metal', breakForce: 90000, fracture: { into: 'poleHalf', grid: [1, 2, 1] }, geo: poleGeo, cap: 40 },
  poleHalf: { shape: 'cyl', size: [0.13, 3.5], mass: 75, colors: [0x9a9da3], material: 'metal', cap: 80 },

  tree: { shape: 'tree', size: [0.22, 3], mass: 320, colors: [0xffffff], material: 'wood', geo: treeGeo, cap: 30 },
};

// --- Instanced rendering pool -------------------------------------------

class Pool {
  constructor(scene, kind) {
    this.kind = kind;
    let geo;
    if (kind.geo) geo = kind.geo();
    else if (kind.shape === 'cyl') geo = new THREE.CylinderGeometry(kind.size[0], kind.size[0], kind.size[1], 16);
    else geo = new THREE.BoxGeometry(...kind.size);
    const mat = new THREE.MeshStandardMaterial({
      roughness: kind.material === 'metal' ? 0.45 : 0.85,
      metalness: kind.material === 'metal' ? 0.35 : 0,
      vertexColors: !!geo.attributes.color,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, kind.cap);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color()); // allocate instanceColor
    this.entities = [];
    scene.add(this.mesh);
  }

  get full() {
    return this.entities.length >= this.kind.cap;
  }

  add(entity, color) {
    entity.slot = this.entities.length;
    this.entities.push(entity);
    this.mesh.setColorAt(entity.slot, color);
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = this.entities.length;
  }

  remove(entity) {
    const last = this.entities.pop();
    if (last !== entity) {
      this.entities[entity.slot] = last;
      last.slot = entity.slot;
      this.mesh.setColorAt(last.slot, last.color);
      this.mesh.instanceColor.needsUpdate = true;
      last.dirty = true;
    }
    this.mesh.count = this.entities.length;
  }

  clear() {
    this.entities.length = 0;
    this.mesh.count = 0;
  }
}

// --- The destructible world -------------------------------------------

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();

export class Destruction {
  constructor(scene, groundHalfSize) {
    this.scene = scene;
    this.groundHalfSize = groundHalfSize;
    this.recycleRange = 110;
    this.pools = {};
    for (const [name, kind] of Object.entries(KINDS)) {
      kind.name = name;
      this.pools[name] = new Pool(scene, kind);
    }
    this.listeners = { impact: [], fracture: [] };
    this.createWorld();
  }

  on(event, fn) {
    this.listeners[event].push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event]) fn(...args);
  }

  createWorld() {
    if (this.world) this.world.free();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.world.numSolverIterations = SOLVER_ITERATIONS;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.byCollider = new Map();
    this.fragments = [];
    this.breakQueue = [];
    this.bodyCount = 0;
    this.time = 0;
    for (const pool of Object.values(this.pools)) pool.clear();

    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(this.groundHalfSize, 0.5, this.groundHalfSize).setFriction(0.8),
      ground,
    );
    this.carBody = null;
  }

  /** Kinematic stand-in for the player's car (it pushes; we read reactions). */
  createCar(spec) {
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0);
    this.carBody = this.world.createRigidBody(desc);
    const midZ = (spec.cgToFront - spec.cgToRear) / 2 + 0.05;
    this.carColliders = [
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.92, 0.33, 2.2).setTranslation(0, 0.58, midZ).setFriction(0.4), this.carBody),
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.7, 0.26, 1.0).setTranslation(0, 1.15, midZ - 0.3).setFriction(0.4), this.carBody),
    ];
    this.carMass = spec.mass;
    this.carInertia = spec.mass * spec.inertiaScale;
  }

  teleportCar(car) {
    const h = car.heading;
    this.carBody.setTranslation({ x: car.x, y: 0, z: car.z }, true);
    this.carBody.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
  }

  /**
   * Spawn one object.
   * @param {string} kindName
   * @param {{x,y,z}} pos  centre of the collider
   * @param {number|THREE.Quaternion} rot  yaw in radians, or a quaternion
   */
  spawn(kindName, pos, rot = 0, opts = {}) {
    const kind = KINDS[kindName];
    const pool = this.pools[kindName];
    if (pool.full) return null;
    const q = typeof rot === 'number' ? _q.setFromAxisAngle(_v.set(0, 1, 0), rot) : rot;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(opts.fragment ? 0.25 : 0.05)
      .setAngularDamping(opts.fragment ? 0.8 : 0.15)
      .setSleeping(!!opts.sleep);
    if (opts.vel) desc.setLinvel(opts.vel.x, opts.vel.y, opts.vel.z);
    if (opts.angvel) desc.setAngvel(opts.angvel);
    if (kind.mass < 15) desc.setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);

    const colliders = [];
    const events = RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
    const threshold = Math.min(breakImpulse(kind), kind.mass * 2.5) / STEP;
    const finish = (cd, mass) => {
      cd.setMass(mass)
        .setFriction(kind.friction ?? 0.7)
        .setRestitution(kind.restitution ?? 0.08)
        .setActiveEvents(events)
        .setContactForceEventThreshold(threshold);
      colliders.push(this.world.createCollider(cd, body));
    };
    if (kind.shape === 'cyl') {
      finish(RAPIER.ColliderDesc.cylinder(kind.size[1] / 2, kind.size[0]), kind.mass);
    } else if (kind.shape === 'tree') {
      finish(RAPIER.ColliderDesc.cylinder(1.5, kind.size[0]), kind.mass * 0.75);
      finish(RAPIER.ColliderDesc.ball(1.25).setTranslation(0, 2.3, 0), kind.mass * 0.25);
    } else {
      finish(RAPIER.ColliderDesc.cuboid(kind.size[0] / 2, kind.size[1] / 2, kind.size[2] / 2), kind.mass);
    }

    const color = opts.color ?? new THREE.Color(kind.colors[(Math.random() * kind.colors.length) | 0]);
    const entity = { kind, body, colliders, color, dirty: true, born: this.time, alive: true };
    pool.add(entity, color);
    for (const c of colliders) this.byCollider.set(c.handle, entity);
    this.bodyCount++;
    if (opts.fragment) this.fragments.push(entity);
    return entity;
  }

  despawn(entity) {
    if (!entity.alive) return;
    entity.alive = false;
    for (const c of entity.colliders) this.byCollider.delete(c.handle);
    this.world.removeRigidBody(entity.body);
    this.pools[entity.kind.name].remove(entity);
    this.bodyCount--;
  }

  fracture(entity) {
    const { kind } = entity;
    const into = KINDS[kind.fracture.into];
    const [nx, ny, nz] = kind.fracture.grid;
    const t = entity.body.translation();
    const r = entity.body.rotation();
    const lv = entity.body.linvel();
    const av = entity.body.angvel();
    const color = entity.color;
    this.despawn(entity);

    const q = _q.set(r.x, r.y, r.z, r.w).clone();
    const centre = new THREE.Vector3(t.x, t.y, t.z);
    const angular = new THREE.Vector3(av.x, av.y, av.z);
    const size = kind.shape === 'cyl' ? [kind.size[0] * 2, kind.size[1], kind.size[0] * 2] : kind.size;
    const step = [size[0] / nx, size[1] / ny, size[2] / nz];
    // Pieces burst outward a little; harder hits come in faster already.
    const burst = 1.2 + Math.random() * 1.5;
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const local = new THREE.Vector3(
            (ix + 0.5) * step[0] - size[0] / 2,
            (iy + 0.5) * step[1] - size[1] / 2,
            (iz + 0.5) * step[2] - size[2] / 2,
          );
          const world = local.clone().applyQuaternion(q);
          const pos = world.clone().add(centre);
          const spin = new THREE.Vector3().crossVectors(angular, world);
          const dir = world.lengthSq() > 1e-6 ? world.clone().normalize() : new THREE.Vector3(0, 1, 0);
          const vel = {
            x: lv.x + spin.x + dir.x * burst + (Math.random() - 0.5),
            y: lv.y + spin.y + Math.abs(dir.y) * burst + Math.random() * 1.5,
            z: lv.z + spin.z + dir.z * burst + (Math.random() - 0.5),
          };
          const av2 = { x: av.x + (Math.random() - 0.5) * 8, y: av.y + (Math.random() - 0.5) * 8, z: av.z + (Math.random() - 0.5) * 8 };
          this.spawn(into.name, pos, q, { vel, angvel: av2, color, fragment: true });
        }
      }
    }
    // Smashing through something costs the car momentum.
    if (this.car && Math.hypot(centre.x - this.car.x, centre.z - this.car.z) < 4) {
      this.breakDrag += kind.mass * BREAK_DRAG;
    }
    this.emit('fracture', centre, kind);
  }

  /**
   * Advance one fixed step. The car's kinematic body is moved to the car's
   * pose, the world is stepped, and the contact impulses on the car are
   * returned so the caller can feed them back into the car's own physics.
   */
  step(car) {
    this.time += STEP;
    this.car = car;
    this.breakDrag = 0;
    const h = car.heading;
    this.carBody.setNextKinematicTranslation({ x: car.x, y: 0, z: car.z });
    this.carBody.setNextKinematicRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });

    this.world.step(this.eventQueue);

    // Reaction on the car (read before fractures remove any colliders).
    let jx = 0, jz = 0, torque = 0, total = 0;
    for (const col of this.carColliders) {
      this.world.contactPairsWith(col, (other) => {
        const entity = this.byCollider.get(other.handle);
        if (!entity) return;
        this.world.contactPair(col, other, (manifold, flipped) => {
          let imp = 0;
          for (let i = 0; i < manifold.numContacts(); i++) imp += manifold.contactImpulse(i);
          if (imp <= 0) return;
          const n = manifold.normal();
          const s = flipped ? 1 : -1; // impulse on the car points away from the other body
          const ix = n.x * imp * s;
          const iz = n.z * imp * s;
          const t = entity.body.translation();
          const rx = t.x - car.x;
          const rz = t.z - car.z;
          jx += ix;
          jz += iz;
          torque += rz * ix - rx * iz;
          total += imp;
        });
      });
    }

    // Breakage and impact sounds.
    const toBreak = new Set(this.breakQueue);
    const settling = this.time < 0.6;
    this.eventQueue.drainContactForceEvents((ev) => {
      const force = ev.totalForceMagnitude();
      const a = this.byCollider.get(ev.collider1());
      const b = this.byCollider.get(ev.collider2());
      for (const e of [a, b]) {
        if (!e || !e.alive) continue;
        if (!settling && e.kind.fracture && force * STEP > breakImpulse(e.kind)) toBreak.add(e);
        const dv = (force * STEP) / e.kind.mass;
        if (dv > 2.5) {
          const t = e.body.translation();
          this.emit('impact', e.kind.material, Math.min(1, dv / 14), t);
        }
      }
    });
    // Spread big collapses over several steps to avoid frame spikes.
    this.breakQueue = [];
    let budget = FRACTURES_PER_STEP;
    for (const e of toBreak) {
      if (!e.alive) continue;
      if (budget-- > 0) this.fracture(e);
      else this.breakQueue.push(e);
    }
    this.enforceBudget();

    const k = REACTION_SCALE;
    jx *= k;
    jz *= k;
    torque *= k;
    const speed = Math.hypot(car.velX, car.velZ);
    if (this.breakDrag > 0 && speed > 0.5) {
      jx -= (car.velX / speed) * this.breakDrag;
      jz -= (car.velZ / speed) * this.breakDrag;
      total += this.breakDrag;
    }
    return { jx, jz, torque, total };
  }

  /** Remove the oldest debris when the body budget is exceeded. */
  enforceBudget() {
    if (this.bodyCount <= MAX_BODIES) return;
    this.fragments = this.fragments.filter((e) => e.alive);
    // Prefer debris that is already asleep, so removing it disturbs nothing.
    for (let i = 0; i < this.fragments.length && this.bodyCount > MAX_BODIES; i++) {
      const e = this.fragments[i];
      if (e.body.isSleeping()) this.despawn(e);
    }
    while (this.bodyCount > MAX_BODIES && this.fragments.length) {
      const e = this.fragments.shift();
      if (e.alive) this.despawn(e);
    }
  }

  /** Copy body transforms into the instance buffers. */
  sync() {
    for (const pool of Object.values(this.pools)) {
      let changed = false;
      for (const e of pool.entities) {
        if (!e.dirty && e.body.isSleeping()) continue;
        e.dirty = false;
        const t = e.body.translation();
        const r = e.body.rotation();
        _p.set(t.x, t.y, t.z);
        _q.set(r.x, r.y, r.z, r.w);
        _m.compose(_p, _q, _s);
        pool.mesh.setMatrixAt(e.slot, _m);
        changed = true;
        // Debris that leaves the arena is recycled.
        if (t.y < -20 || Math.abs(t.x) > this.recycleRange || Math.abs(t.z) > this.recycleRange) {
          this.despawn(e);
          continue;
        }
        // Pieces squeezed between the car and a pile can be launched
        // absurdly fast; cap them so nothing rockets off the map.
        const v = e.body.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (sp > MAX_DEBRIS_SPEED) {
          const k = MAX_DEBRIS_SPEED / sp;
          e.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
        }
        // Rapier only sleeps a whole pile at once; put individual pieces
        // to sleep once they've been nearly still for a moment.
        const w = e.body.angvel();
        if (sp < 0.12 && Math.hypot(w.x, w.y, w.z) < 0.25) {
          if (e.stillSince === undefined) e.stillSince = this.time;
          else if (this.time - e.stillSince > 0.7) { e.body.sleep(); e.stillSince = undefined; }
        } else {
          e.stillSince = undefined;
        }
      }
      if (changed) pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
