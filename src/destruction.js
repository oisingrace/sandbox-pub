import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// Rigid-body world for everything the car can smash. Each object kind is
// drawn with one InstancedMesh, so hundreds of pieces stay cheap. Objects
// with a `fracture` rule shatter into a grid of smaller kinds when a
// contact force exceeds their `breakForce`.

export async function initRapier() {
  await RAPIER.init();
}

const FRACTURES_PER_STEP = 10;
const BURNS_PER_STEP = 24;
// Collision groups: (membership << 16) | filter. Driven cars and parked
// vehicles skip each other in Rapier (a kinematic car would shove a bus
// like it weighed nothing); carCollision.js resolves those pairs with
// proper masses instead. Both still hit everything else.
const GROUP_CAR = (0x0002 << 16) | (0xffff & ~0x0004);
const GROUP_VEHICLE = (0x0004 << 16) | (0xffff & ~0x0002);
const BLAST_RADIUS = 9;
const BLAST_SPEED = 16; // m/s of push at the centre
const MAX_DEBRIS_SPEED = 32;
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

function fuelGeo() {
  const body = colored(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 18), 0xc81e1e);
  const band = new THREE.CylinderGeometry(0.305, 0.305, 0.18, 18); band.translate(0, 0.05, 0);
  const rings = [-0.3, 0.38].map((y) => { const g = new THREE.CylinderGeometry(0.31, 0.31, 0.04, 18); g.translate(0, y, 0); return colored(g, 0x2a1a1a); });
  return merge([body, colored(band, 0xf2c230), ...rings]);
}

function pinGeo() {
  const profile = [[0.001, -1.2], [0.26, -1.2], [0.36, -0.85], [0.38, -0.55], [0.3, -0.1], [0.17, 0.3],
    [0.16, 0.45], [0.22, 0.75], [0.24, 0.95], [0.18, 1.12], [0.001, 1.2]].map(([r, y]) => new THREE.Vector2(r, y));
  const body = colored(new THREE.LatheGeometry(profile, 16), 0xf6f3ec);
  const stripes = [0.33, 0.47].map((y) => { const g = new THREE.CylinderGeometry(0.172, 0.168, 0.06, 16); g.translate(0, y, 0); return colored(g, 0xc8242b); });
  return merge([body, ...stripes]);
}

function fenceGeo() {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const picket = new THREE.BoxGeometry(0.14, 1.0, 0.04);
    picket.translate(-0.83 + i * 0.333, 0, 0);
    parts.push(colored(picket, 0xf1ece2));
  }
  for (const y of [-0.25, 0.25]) {
    const rail = new THREE.BoxGeometry(2.0, 0.09, 0.04);
    rail.translate(0, y, -0.035);
    parts.push(colored(rail, 0xd8d0c2));
  }
  return merge(parts);
}

function canopyGeo() {
  const roof = colored(new THREE.BoxGeometry(12, 0.5, 8), 0xf4f4f2);
  const fascia = new THREE.BoxGeometry(12.04, 0.22, 8.04); fascia.translate(0, 0.08, 0);
  return merge([roof, colored(fascia, 0xd7263d)]);
}

function pumpGeo() {
  const body = colored(new THREE.BoxGeometry(0.8, 1.8, 0.5), 0x2f9e5b);
  const face = new THREE.BoxGeometry(0.6, 0.5, 0.52); face.translate(0, 0.45, 0);
  const top = new THREE.BoxGeometry(0.84, 0.16, 0.54); top.translate(0, 0.86, 0);
  return merge([body, colored(face, 0x1b1d22), colored(top, 0xf4f4f2)]);
}

// --- Object kinds ------------------------------------------------------
// size = full extents of the collider box (or [radius, height] for cylinders).

const BRICK_COLORS = [0xa34a32, 0xb2553a, 0x93412c, 0xa85b42, 0x8e3e2b];
const CONCRETE = [0xb8b5ad, 0xaeaba3, 0xc2bfb7];
const WOOD = [0xb58a52, 0xa77d48, 0xc0965c];
const FACADE = [0xd9cbb3, 0xcfc0a6, 0xe0d3bd];

export const KINDS = {
  brick: { size: [0.6, 0.3, 0.3], mass: 12, colors: BRICK_COLORS, material: 'brick', breakForce: 14000, fracture: { into: 'brickHalf', grid: [2, 1, 1] }, cap: 800 },
  brickHalf: { size: [0.3, 0.3, 0.3], mass: 6, colors: BRICK_COLORS, material: 'brick', cap: 900 },

  crate: { size: [1, 1, 1], mass: 40, colors: WOOD, material: 'wood', breakForce: 26000, fracture: { into: 'crateChunk', grid: [2, 2, 2] }, cap: 60 },
  crateChunk: { size: [0.5, 0.5, 0.5], mass: 5, colors: WOOD, material: 'wood', cap: 500 },

  block: { size: [1, 1, 1], mass: 220, colors: CONCRETE, material: 'concrete', breakForce: 150000, fracture: { into: 'blockChunk', grid: [2, 2, 2] }, cap: 200 },
  lintel: { size: [4, 1, 1], mass: 880, colors: CONCRETE, material: 'concrete', breakForce: 300000, fracture: { into: 'block', grid: [4, 1, 1] }, cap: 4 },
  blockChunk: { size: [0.5, 0.5, 0.5], mass: 27, colors: CONCRETE, material: 'concrete', cap: 900 },

  plank: { size: [4.4, 0.2, 1], mass: 60, colors: WOOD, material: 'wood', breakForce: 30000, fracture: { into: 'plankHalf', grid: [2, 1, 1] }, cap: 20 },
  plankHalf: { size: [2.2, 0.2, 1], mass: 30, colors: WOOD, material: 'wood', breakForce: 30000, fracture: { into: 'plankBit', grid: [2, 1, 1] }, cap: 40 },
  plankBit: { size: [1.1, 0.2, 1], mass: 15, colors: WOOD, material: 'wood', cap: 80 },

  slab: { size: [0.3, 2.2, 1.2], mass: 90, colors: [0xe8e4da, 0xd9534f, 0x3d7dd8, 0xf2c230], material: 'concrete', breakForce: 70000, fracture: { into: 'slabHalf', grid: [1, 2, 1] }, cap: 50 },
  slabHalf: { size: [0.3, 1.1, 1.2], mass: 45, colors: [0xe8e4da, 0xd9534f, 0x3d7dd8, 0xf2c230], material: 'concrete', cap: 100 },

  barrier: { size: [0.6, 0.9, 3], mass: 700, colors: [0xe9e6df, 0xd9d5cc], material: 'concrete', breakForce: 420000, fracture: { into: 'barrierChunk', grid: [1, 1, 3] }, geo: () => barrierProfile(0.6, 0.9, 3, 0.26), cap: 240 },
  barrierChunk: { size: [0.6, 0.9, 1], mass: 233, colors: [0xe9e6df, 0xd9d5cc], material: 'concrete', geo: () => barrierProfile(0.6, 0.9, 1, 0.26), cap: 300 },

  barrel: { shape: 'cyl', size: [0.32, 0.95], mass: 22, colors: [0xc8342b, 0x2f6fb3, 0xe0a526, 0x4c8c3a], material: 'metal', restitution: 0.25, cap: 60 },
  cone: { shape: 'cyl', size: [0.2, 0.6], mass: 3, colors: [0xffffff], material: 'plastic', geo: coneGeo, restitution: 0.3, cap: 60 },

  pole: { shape: 'cyl', size: [0.13, 7], mass: 150, colors: [0xffffff], material: 'metal', breakForce: 90000, fracture: { into: 'poleHalf', grid: [1, 2, 1] }, geo: poleGeo, cap: 40 },
  poleHalf: { shape: 'cyl', size: [0.13, 3.5], mass: 75, colors: [0x9a9da3], material: 'metal', cap: 80 },

  // Office building pieces.
  panel: { size: [2, 1.2, 0.4], mass: 500, colors: FACADE, material: 'concrete', breakForce: 250000, fracture: { into: 'panelChunk', grid: [2, 2, 1] }, cap: 100 },
  panelChunk: { size: [1, 0.6, 0.4], mass: 125, colors: FACADE, material: 'concrete', cap: 300 },
  pillar: { size: [0.5, 1.5, 0.4], mass: 180, colors: FACADE, material: 'concrete', breakForce: 90000, fracture: { into: 'pillarChunk', grid: [1, 2, 1] }, cap: 100 },
  pillarChunk: { size: [0.5, 0.75, 0.4], mass: 90, colors: FACADE, material: 'concrete', cap: 120 },
  floorSlab: { size: [2, 0.3, 6.8], mass: 900, colors: [0xa9a59c, 0x9f9b92], material: 'concrete', breakForce: 400000, fracture: { into: 'floorChunk', grid: [2, 1, 2] }, cap: 30 },
  floorChunk: { size: [1, 0.3, 3.4], mass: 225, colors: [0xa9a59c, 0x9f9b92], material: 'concrete', cap: 120 },
  glass: { size: [0.75, 1.44, 0.06], mass: 6, colors: [0x9fd4ee, 0x8fc9e6], material: 'glass', glass: true, breakForce: 1500, fracture: { into: 'shard', grid: [2, 2, 1] }, cap: 180 },
  shard: { size: [0.375, 0.72, 0.06], mass: 1.5, colors: [0x9fd4ee, 0x8fc9e6], material: 'glass', glass: true, noCcd: true, lifetime: 6, cap: 500 },

  // Explosive fuel drums: a hard hit (or the Ember) sets them off.
  fuel: { shape: 'cyl', size: [0.3, 0.9], mass: 35, colors: [0xffffff], material: 'metal', geo: fuelGeo, explosive: true, breakForce: 9000, cap: 40 },

  // Giant bowling pins.
  pin: { shape: 'cyl', size: [0.36, 2.4], mass: 40, colors: [0xffffff], material: 'plastic', geo: pinGeo, restitution: 0.35, cap: 12 },

  // Shipping containers split into sections.
  container: { matte: true, size: [6.1, 2.6, 2.44], mass: 2500, colors: [0xe0583f, 0x4a90dc, 0x48b873, 0xf29a3e, 0x9370cc], material: 'metal', breakForce: 900000, fracture: { into: 'containerSection', grid: [3, 1, 1] }, cap: 30 },
  containerSection: { matte: true, size: [2.0333, 2.6, 2.44], mass: 833, colors: [0xe0583f, 0x4a90dc, 0x48b873, 0xf29a3e, 0x9370cc], material: 'metal', cap: 90 },

  // Water tower: four legs, a platform and a tank.
  steelLeg: { size: [0.3, 7, 0.3], mass: 140, colors: [0x7d848c], material: 'metal', breakForce: 80000, fracture: { into: 'legHalf', grid: [1, 2, 1] }, cap: 8 },
  legHalf: { size: [0.3, 3.5, 0.3], mass: 70, colors: [0x7d848c], material: 'metal', cap: 16 },
  platform: { matte: true, size: [3.6, 0.3, 3.6], mass: 600, colors: [0x6c737b], material: 'metal', breakForce: 260000, fracture: { into: 'platformChunk', grid: [2, 1, 2] }, cap: 2 },
  platformChunk: { matte: true, size: [1.8, 0.3, 1.8], mass: 150, colors: [0x6c737b], material: 'metal', cap: 8 },
  tank: { matte: true, shape: 'cyl', size: [1.6, 2.6], mass: 1400, colors: [0x7fb0cf], material: 'metal', breakForce: 650000, fracture: { into: 'tankChunk', grid: [2, 2, 2] }, cap: 2 },
  tankChunk: { matte: true, size: [1.6, 1.3, 1.6], mass: 175, colors: [0x7fb0cf], material: 'metal', cap: 16 },

  // Picket fence panels.
  fence: { size: [2, 1, 0.08], mass: 14, colors: [0xffffff], material: 'wood', geo: fenceGeo, breakForce: 2600, fracture: { into: 'fenceBit', grid: [4, 1, 1] }, cap: 40 },
  fenceBit: { size: [0.5, 1, 0.08], mass: 3.5, colors: [0xf1ece2], material: 'wood', cap: 160 },

  // Gas station.
  canopy: { matte: true, size: [12, 0.5, 8], mass: 3000, colors: [0xffffff], material: 'metal', geo: canopyGeo, breakForce: 900000, fracture: { into: 'canopyChunk', grid: [3, 1, 2] }, cap: 2 },
  canopyChunk: { matte: true, size: [4, 0.5, 4], mass: 500, colors: [0xf4f4f2], material: 'metal', cap: 12 },
  column: { size: [0.5, 4.5, 0.5], mass: 400, colors: [0xe6e2d8], material: 'concrete', breakForce: 140000, fracture: { into: 'columnChunk', grid: [1, 3, 1] }, cap: 8 },
  columnChunk: { size: [0.5, 1.5, 0.5], mass: 133, colors: [0xe6e2d8], material: 'concrete', cap: 24 },
  pump: { matte: true, size: [0.8, 1.8, 0.5], mass: 150, colors: [0xffffff], material: 'metal', geo: pumpGeo, breakForce: 50000, fracture: { into: 'pumpChunk', grid: [1, 2, 1] }, cap: 8 },
  pumpChunk: { matte: true, size: [0.8, 0.9, 0.5], mass: 75, colors: [0x2f9e5b], material: 'metal', cap: 16 },

  tree: { shape: 'tree', size: [0.22, 3], mass: 320, colors: [0xffffff], material: 'wood', geo: treeGeo, cap: 40 },
};

// --- Instanced rendering pool -------------------------------------------

class Pool {
  constructor(scene, kind) {
    this.kind = kind;
    let geo;
    if (kind.geo) geo = kind.geo();
    else if (kind.shape === 'cyl') geo = new THREE.CylinderGeometry(kind.size[0], kind.size[0], kind.size[1], 16);
    else geo = new THREE.BoxGeometry(...kind.size);
    const mat = kind.glass
      ? new THREE.MeshStandardMaterial({ roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.45, depthWrite: false })
      : new THREE.MeshStandardMaterial({
        // Painted metal (containers, tanks) reads better matte without reflections.
        roughness: kind.material === 'metal' && !kind.matte ? 0.45 : 0.85,
        metalness: kind.material === 'metal' && !kind.matte ? 0.35 : 0,
        vertexColors: !!geo.attributes.color,
      });
    this.mesh = new THREE.InstancedMesh(geo, mat, kind.cap);
    this.mesh.count = 0;
    this.mesh.castShadow = !kind.glass;
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
const _sv = new THREE.Vector3();
const _euler = new THREE.Euler();
const _carQ = new THREE.Quaternion();

/** Bounds of a vehicle's hitbox in its own frame. */
function hitboxBounds(def) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const h of def.hitbox) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], h.at[i] - h.half[i]);
      hi[i] = Math.max(hi[i], h.at[i] + h.half[i]);
    }
  }
  return { lo, hi };
}

/** The car's full orientation: heading, plus pitch and roll on ramps and in the air. */
function carRotation(car) {
  _euler.set(-(car.pitch || 0), car.heading, car.roll || 0, 'YXZ');
  _carQ.setFromEuler(_euler);
  return { x: _carQ.x, y: _carQ.y, z: _carQ.z, w: _carQ.w };
}

export class Destruction {
  constructor(scene, groundHalfSize) {
    this.scene = scene;
    this.groundHalfSize = groundHalfSize;
    this.recycleRange = 140;
    this.options = { debrisLimit: 600, breakage: 'detailed', debrisLifetime: 60, physicsQuality: 4 };
    this.pools = {};
    for (const [name, kind] of Object.entries(KINDS)) {
      kind.name = name;
      this.pools[name] = new Pool(scene, kind);
    }
    this.listeners = { impact: [], fracture: [], burn: [], explode: [] };
    this.createWorld();
  }

  /** Apply the player's destruction settings (see settings.js). */
  configure(opts) {
    Object.assign(this.options, opts);
    if (this.world) this.world.numSolverIterations = this.options.physicsQuality;
    this.enforceBudget();
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
    this.world.numSolverIterations = this.options.physicsQuality;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.byCollider = new Map();
    this.fragments = [];
    this.breakQueue = [];
    this.pendingBlasts = [];
    this.blastJ = { x: 0, z: 0 };
    this.bodyCount = 0;
    this.debrisCount = 0;
    this.time = 0;
    for (const pool of Object.values(this.pools)) pool.clear();

    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(this.groundHalfSize, 0.5, this.groundHalfSize).setFriction(0.8),
      ground,
    );
    this.statics?.addColliders(this.world); // the map's ramps and walls
    this.carBody = null;
    // Remote players' cars survive a rebuild: recreate their bodies.
    for (const r of this.remoteCars?.values() || []) this.buildRemoteBody(r);
  }

  /** Kinematic stand-in for the vehicle being driven (it pushes; we read reactions). */
  createCar(def) {
    if (this.carBody) this.world.removeRigidBody(this.carBody);
    this.lastCarPose = null;
    this.carBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.burner = !!def.burns;
    // Bounds of the hitbox in the car frame, for the burn query.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const h of def.hitbox) {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], h.at[i] - h.half[i]);
        hi[i] = Math.max(hi[i], h.at[i] + h.half[i]);
      }
    }
    this.carBounds = { lo, hi };
    this.carColliders = def.hitbox.map((h) => this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(...h.half).setTranslation(...h.at).setFriction(0.4).setCollisionGroups(GROUP_CAR),
      this.carBody,
    ));
  }

  /**
   * A parked vehicle: a dynamic body that rests on four wheel spheres, so
   * it can be shoved, spun and flipped like everything else.
   */
  spawnVehicle(def, pose, vel = null) {
    const { spec } = def;
    const h = pose.heading;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.x, pose.y ?? 0, pose.z)
      .setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) })
      .setLinearDamping(0.15)
      .setAngularDamping(0.4)
      .setSleeping(!vel);
    if (vel) {
      desc.setLinvel(vel.x, 0, vel.z);
      desc.setAngvel({ x: 0, y: vel.yaw, z: 0 });
    }
    const body = this.world.createRigidBody(desc);
    const volume = (b) => b.half[0] * b.half[1] * b.half[2];
    const totalVol = def.hitbox.reduce((sum, b) => sum + volume(b), 0);
    const events = RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
    const colliders = def.hitbox.map((b) => this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(...b.half).setTranslation(...b.at)
        .setMass(spec.mass * 0.96 * volume(b) / totalVol)
        .setFriction(0.5).setRestitution(0.1)
        .setActiveEvents(events).setContactForceEventThreshold(spec.mass * 2.5 / STEP)
        .setCollisionGroups(GROUP_VEHICLE),
      body,
    ));
    const r = spec.wheelRadius;
    const ht = spec.trackWidth / 2;
    for (const [x, z] of [[ht, spec.cgToFront], [-ht, spec.cgToFront], [ht, -spec.cgToRear], [-ht, -spec.cgToRear]]) {
      colliders.push(this.world.createCollider(
        RAPIER.ColliderDesc.ball(r).setTranslation(x, r, z).setMass(spec.mass * 0.01).setFriction(0.9)
          .setCollisionGroups(GROUP_VEHICLE),
        body,
      ));
    }
    const entity = { kind: { name: 'vehicle', mass: spec.mass, material: 'metal' }, body, colliders, alive: true, vehicle: def };
    for (const c of colliders) this.byCollider.set(c.handle, entity);
    return entity;
  }

  removeVehicle(entity) {
    if (!entity.alive) return;
    entity.alive = false;
    for (const c of entity.colliders) this.byCollider.delete(c.handle);
    this.world.removeRigidBody(entity.body);
  }

  /**
   * Another player's car (multiplayer): a kinematic body driven by their
   * network updates. It pushes, smashes and (for the Ember) burns things in
   * our world just like our own car, so their destruction shows up here too.
   */
  addRemoteCar(key, def, proxy) {
    this.removeRemoteCar(key);
    const r = { def, proxy, burner: !!def.burns, bounds: hitboxBounds(def) };
    (this.remoteCars ||= new Map()).set(key, r);
    this.buildRemoteBody(r);
    return r;
  }

  buildRemoteBody(r) {
    const p = r.proxy;
    r.last = null;
    r.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(p.x, p.y || 0, p.z).setRotation(carRotation(p)));
    r.colliders = r.def.hitbox.map((h) => this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(...h.half).setTranslation(...h.at).setFriction(0.4).setCollisionGroups(GROUP_CAR), r.body));
  }

  removeRemoteCar(key) {
    const r = this.remoteCars?.get(key);
    if (!r) return;
    if (r.body && this.world.getRigidBody(r.body.handle)) this.world.removeRigidBody(r.body);
    this.remoteCars.delete(key);
  }

  teleportCar(car) {
    const h = car.heading;
    this.lastCarPose = { x: car.x, z: car.z, h, y: car.y || 0, p: car.pitch || 0 };
    this.carBody.setTranslation({ x: car.x, y: car.y || 0, z: car.z }, true);
    this.carBody.setRotation(carRotation(car), true);
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
    if (kind.mass < 15 && !kind.noCcd) desc.setCcdEnabled(true);
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
    const entity = { kind, body, colliders, color, dirty: true, born: this.time, alive: true, fragment: !!opts.fragment };
    pool.add(entity, color);
    for (const c of colliders) this.byCollider.set(c.handle, entity);
    this.bodyCount++;
    if (entity.fragment) this.debrisCount++;
    if (opts.fragment) this.fragments.push(entity);
    return entity;
  }

  /** Register a body made elsewhere (the football) so it takes part in contacts and blasts. */
  register(entity) {
    for (const c of entity.colliders) this.byCollider.set(c.handle, entity);
  }

  unregister(entity) {
    for (const c of entity.colliders) this.byCollider.delete(c.handle);
  }

  /** Remove every spawned object matching `test(entity, position)`. */
  despawnWhere(test) {
    for (const pool of Object.values(this.pools)) {
      for (const e of [...pool.entities]) {
        if (e.alive && test(e, e.body.translation())) this.despawn(e);
      }
    }
  }

  despawn(entity) {
    if (!entity.alive) return;
    entity.alive = false;
    for (const c of entity.colliders) this.byCollider.delete(c.handle);
    this.world.removeRigidBody(entity.body);
    this.pools[entity.kind.name].remove(entity);
    this.bodyCount--;
    if (entity.fragment) this.debrisCount--;
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
    this.blastJ ||= { x: 0, z: 0 };
    // Chain reactions: detonate drums whose fuse ran out.
    if (this.pendingBlasts.length) {
      const due = this.pendingBlasts.filter((b) => b.at <= this.time);
      this.pendingBlasts = this.pendingBlasts.filter((b) => b.at > this.time);
      for (const b of due) if (b.entity.alive) this.explode(b.entity);
    }
    // Only move the kinematic body when the car actually moved: Rapier
    // treats every kinematic update as motion and wakes whatever touches it.
    const h = car.heading;
    const last = this.lastCarPose;
    const y = car.y || 0;
    const moved = !last || Math.abs(car.x - last.x) > 1e-4 || Math.abs(car.z - last.z) > 1e-4
      || Math.abs(h - last.h) > 1e-5 || Math.abs(y - last.y) > 1e-4 || Math.abs((car.pitch || 0) - last.p) > 1e-5;
    if (moved) {
      this.carBody.setNextKinematicTranslation({ x: car.x, y, z: car.z });
      this.carBody.setNextKinematicRotation(carRotation(car));
      this.lastCarPose = { x: car.x, z: car.z, h, y, p: car.pitch || 0 };
    }

    if (this.burner) this.burnAround(car);
    for (const r of this.remoteCars?.values() || []) {
      // Like our own car: only move the body when the car moved, so parked
      // players don't keep waking up everything they're touching.
      const p = r.proxy;
      const y = p.y || 0;
      const l = r.last;
      if (!l || Math.abs(p.x - l.x) > 1e-4 || Math.abs(p.z - l.z) > 1e-4 || Math.abs(y - l.y) > 1e-4
        || Math.abs(p.heading - l.h) > 1e-5 || Math.abs((p.pitch || 0) - l.p) > 1e-5 || Math.abs((p.roll || 0) - l.r) > 1e-5) {
        r.body.setNextKinematicTranslation({ x: p.x, y, z: p.z });
        r.body.setNextKinematicRotation(carRotation(p));
        r.last = { x: p.x, y, z: p.z, h: p.heading, p: p.pitch || 0, r: p.roll || 0 };
        if (r.burner && Math.abs(p.vLong) > 0.2) this.burnAround(p, r.bounds);
      }
    }
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
    const toExplode = new Set();
    const settling = this.time < 0.6;
    this.eventQueue.drainContactForceEvents((ev) => {
      const force = ev.totalForceMagnitude();
      const a = this.byCollider.get(ev.collider1());
      const b = this.byCollider.get(ev.collider2());
      for (const e of [a, b]) {
        if (!e || !e.alive) continue;
        if (!settling && force * STEP > breakImpulse(e.kind)) {
          if (e.kind.explosive) toExplode.add(e);
          else if (this.canBreak(e)) toBreak.add(e);
        }
        const dv = (force * STEP) / e.kind.mass;
        if (dv > 2.5) {
          const t = e.body.translation();
          this.emit('impact', e.kind.material, Math.min(1, dv / 14), t);
        }
      }
    });
    for (const e of toExplode) if (e.alive) this.explode(e);
    for (const e of this.blastBreaks || []) if (e.alive && this.canBreak(e)) toBreak.add(e);
    this.blastBreaks = [];

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
    if (this.blastJ.x || this.blastJ.z) {
      jx += this.blastJ.x;
      jz += this.blastJ.z;
      total += Math.hypot(this.blastJ.x, this.blastJ.z);
      this.blastJ = { x: 0, z: 0 };
    }
    return { jx, jz, torque, total };
  }

  /**
   * Fuel drum explosion: pushes everything within BLAST_RADIUS outward and
   * up, shatters breakable things close by, lights the fuse on nearby
   * drums (chain reactions) and shoves the car.
   */
  explode(entity) {
    const t = entity.body.translation();
    const centre = new THREE.Vector3(t.x, t.y, t.z);
    this.despawn(entity);
    this.blast(t);
    const car = this.car;
    this.emit('explode', centre, car ? Math.hypot(car.x - t.x, car.z - t.z) : 99);
  }

  /** Push, shatter and set off everything around a point (no sound or flash). */
  blast(t, R = BLAST_RADIUS) {
    const seen = new Set();
    this.world.collidersWithAabbIntersectingAabb(t, { x: R, y: R, z: R }, (c) => {
      const body = c.parent();
      if (!body || seen.has(body.handle)) return true;
      seen.add(body.handle);
      if (!body.isDynamic()) return true;
      const p = body.translation();
      const dx = p.x - t.x, dy = p.y - t.y + 1.2, dz = p.z - t.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > R) return true;
      const falloff = 1 - d / R;
      const e = this.byCollider.get(c.handle);
      if (e?.kind.explosive) {
        if (!this.pendingBlasts.some((b) => b.entity === e)) {
          this.pendingBlasts.push({ entity: e, at: this.time + 0.12 + Math.random() * 0.2 });
        }
        return true;
      }
      // Velocity change rather than raw impulse, so light and heavy things
      // both fly believably (heavy ones less).
      const dv = BLAST_SPEED * falloff * (e ? Math.min(1, 300 / e.kind.mass + 0.15) : 0.4);
      const m = body.mass();
      const inv = 1 / (d || 1);
      body.applyImpulse({ x: dx * inv * dv * m, y: (dy * inv + 0.6) * dv * m, z: dz * inv * dv * m }, true);
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * dv, y: (Math.random() - 0.5) * m * dv, z: (Math.random() - 0.5) * m * dv }, true);
      if (e && falloff > 0.45) (this.blastBreaks ||= []).push(e);
      return true;
    });
    // The car isn't a dynamic body; push it through the reaction channel.
    const car = this.car;
    if (car) {
      const dx = car.x - t.x, dz = car.z - t.z;
      const d = Math.hypot(dx, dz);
      if (d < R) {
        const dv = BLAST_SPEED * 0.35 * (1 - d / R) * Math.min(1, 1600 / car.spec.mass);
        this.blastJ.x += (dx / (d || 1)) * dv * car.spec.mass;
        this.blastJ.z += (dz / (d || 1)) * dv * car.spec.mass;
      }
    }
  }

  /**
   * The burner car: everything inside a box around it (stretched ahead by
   * the distance it covers this step) burns away before the solver can
   * push it, so the car slices through instead of bulldozing.
   */
  burnAround(car, bounds = this.carBounds) {
    const { lo, hi } = bounds;
    const ahead = Math.abs(car.vLong) * STEP * 2 + 0.3;
    const dir = car.vLong >= 0 ? 1 : -1;
    const half = { x: (hi[0] - lo[0]) / 2 + 0.25, y: (hi[1] - lo[1]) / 2 + 0.2, z: (hi[2] - lo[2]) / 2 + 0.25 + ahead / 2 };
    const localZ = (hi[2] + lo[2]) / 2 + (dir * ahead) / 2;
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);
    const centre = { x: car.x + sinH * localZ, y: (car.y || 0) + (hi[1] + lo[1]) / 2, z: car.z + cosH * localZ };
    const rot = carRotation(car);
    const found = new Set();
    this.world.intersectionsWithShape(centre, rot, new RAPIER.Cuboid(half.x, half.y, half.z), (collider) => {
      const e = this.byCollider.get(collider.handle);
      if (e && e.alive && !e.vehicle && !e.kind.noBurn) found.add(e);
      return found.size < BURNS_PER_STEP;
    });
    for (const e of found) this.burn(e, car);
  }

  burn(entity, car) {
    if (entity.kind.explosive) {
      this.explode(entity);
      return;
    }
    const t = entity.body.translation();
    const r = entity.body.rotation();
    const info = {
      kind: entity.kind,
      color: entity.color,
      pos: new THREE.Vector3(t.x, t.y, t.z),
      quat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      from: new THREE.Vector3(car.x, t.y, car.z),
    };
    const size = entity.kind.shape === 'cyl' || entity.kind.shape === 'tree'
      ? Math.max(entity.kind.size[0] * 2, entity.kind.size[1]) : Math.max(...entity.kind.size);
    this.despawn(entity);
    // Wake whatever was resting on it so it falls.
    const r2 = size / 2 + 0.4;
    this.world.collidersWithAabbIntersectingAabb(t, { x: r2, y: r2, z: r2 }, (c) => {
      c.parent()?.wakeUp();
      return true;
    });
    this.emit('burn', info);
  }

  /** Breakage setting: "simple" lets intact objects break once but not their pieces. */
  canBreak(e) {
    const mode = this.options.breakage;
    if (!e.kind.fracture || mode === 'off') return false;
    return mode === 'detailed' || !e.fragment;
  }

  /** Remove the oldest debris pieces when there are more than the limit. */
  enforceBudget() {
    const max = this.options.debrisLimit;
    if (this.debrisCount <= max) return;
    this.fragments = this.fragments.filter((e) => e.alive);
    // Prefer debris that is already asleep, so removing it disturbs nothing.
    for (let i = 0; i < this.fragments.length && this.debrisCount > max; i++) {
      const e = this.fragments[i];
      if (e.body.isSleeping()) this.despawn(e);
    }
    while (this.debrisCount > max && this.fragments.length) {
      const e = this.fragments.shift();
      if (e.alive) this.despawn(e);
    }
  }

  lifetimeOf(e) {
    if (e.kind.lifetime) return e.kind.lifetime;
    return e.fragment ? this.options.debrisLifetime : 0;
  }

  /** Copy body transforms into the instance buffers. */
  sync() {
    for (const pool of Object.values(this.pools)) {
      let changed = false;
      for (const e of pool.entities) {
        const life = this.lifetimeOf(e);
        const left = life ? life - (this.time - e.born) : Infinity;
        if (!e.dirty && left >= 1 && e.body.isSleeping()) continue;
        e.dirty = false;
        const t = e.body.translation();
        const r = e.body.rotation();
        _p.set(t.x, t.y, t.z);
        _q.set(r.x, r.y, r.z, r.w);
        // Debris past its lifetime shrinks away over its last second.
        const k = left < 1 ? Math.max(0.01, left) : 1;
        _m.compose(_p, _q, _sv.set(k, k, k));
        if (left < 1) e.dirty = true; // keep animating even if it fell asleep
        pool.mesh.setMatrixAt(e.slot, _m);
        changed = true;
        // Debris that leaves the arena (or outlives its kind's lifetime) is recycled.
        if (left <= 0 || t.y < -20 || Math.abs(t.x) > this.recycleRange || Math.abs(t.z) > this.recycleRange) {
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
