import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Terrain } from './terrain.js';
import { mulberry32 } from './world.js';

// The car football stadium: a long walled pitch with a goal at each end,
// grandstands, floodlights, and the usual pile of things to break along the
// sidelines and in the corners.
//
// The pitch runs along Z. Blue defends the -Z goal and attacks +Z; Orange
// the other way round. Walls are fixed Rapier colliders (tall and invisible
// above the glass, so the ball stays in); cars are kept in by `contain`,
// since a kinematic car body doesn't collide with fixed ones.

export const PITCH = {
  halfX: 36,
  halfZ: 60,
  goalHalf: 8,     // goal mouth is 16 m wide
  goalDepth: 7,
  goalHeight: 5,
  chamfer: 8,      // corners are cut at 45° so the ball never gets stuck
};
export const TEAM_COLORS = [0x2f7bff, 0xff7a1a];

const WALL_TOP = 30;   // invisible collider height
const GLASS_TOP = 8;   // visible glass height
const BASE_TOP = 1.2;  // concrete kerb under the glass

/** Wall segments (centre line) around the pitch, excluding the goal mouths. */
function wallSegments() {
  const { halfX: X, halfZ: Z, goalHalf: G, chamfer: C } = PITCH;
  const segs = [];
  for (const sx of [-1, 1]) segs.push([[sx * X, -(Z - C)], [sx * X, Z - C]]);
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      segs.push([[sx * G, sz * Z], [sx * (X - C), sz * Z]]);
      segs.push([[sx * (X - C), sz * Z], [sx * X, sz * (Z - C)]]);
    }
  }
  return segs;
}

export function createStadium(scene, renderer) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const { halfX: X, halfZ: Z, goalHalf: G, goalDepth: D, goalHeight: H } = PITCH;

  // --- Ground: concrete surround, striped pitch, goal floors -------------
  const concrete = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 200),
    new THREE.MeshStandardMaterial({ color: 0x8e8c88, roughness: 0.95 }),
  );
  concrete.rotation.x = -Math.PI / 2;
  concrete.position.y = 0.002;
  concrete.receiveShadow = true;
  group.add(concrete);

  const pitchShape = new THREE.Shape();
  const C = PITCH.chamfer;
  pitchShape.moveTo(-X, -(Z - C));
  pitchShape.lineTo(-(X - C), -Z);
  pitchShape.lineTo(X - C, -Z);
  pitchShape.lineTo(X, -(Z - C));
  pitchShape.lineTo(X, Z - C);
  pitchShape.lineTo(X - C, Z);
  pitchShape.lineTo(-(X - C), Z);
  pitchShape.lineTo(-X, Z - C);
  const pitchGeo = new THREE.ShapeGeometry(pitchShape);
  // UVs in metres / pitch size so the stripe texture spans the pitch.
  const uv = pitchGeo.attributes.uv;
  const pp = pitchGeo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (pp.getX(i) + X) / (2 * X), (pp.getY(i) + Z) / (2 * Z));
  const pitch = new THREE.Mesh(pitchGeo, new THREE.MeshStandardMaterial({ map: grassStripes(renderer), roughness: 0.92 }));
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.y = 0.006;
  pitch.receiveShadow = true;
  group.add(pitch);

  const line = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
  const flat = (geo, mat, x, z, rotY = 0, y = 0.014) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, rotY);
    m.position.set(x, y, z);
    m.renderOrder = 1;
    group.add(m);
    return m;
  };
  const W = 0.3; // line width
  for (const sx of [-1, 1]) flat(new THREE.PlaneGeometry(W, 2 * (Z - C)), line, sx * (X - 1.2), 0);
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) flat(new THREE.PlaneGeometry(X - C - G, W), line, sx * (G + (X - C - G) / 2), sz * (Z - 1.2));
    // Goal line across the mouth, in the defending team's colour.
    const team = sz < 0 ? 0 : 1;
    flat(new THREE.PlaneGeometry(2 * G, 0.5), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], transparent: true, opacity: 0.9, depthWrite: false }), 0, sz * Z);
    // Penalty box.
    flat(new THREE.PlaneGeometry(30, W), line, 0, sz * (Z - 16));
    for (const sx of [-1, 1]) flat(new THREE.PlaneGeometry(W, 14.8), line, sx * 15, sz * (Z - 1.2 - 7.4));
    // Goal floor, tinted.
    flat(new THREE.PlaneGeometry(2 * G, D), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], transparent: true, opacity: 0.35, depthWrite: false }), 0, sz * (Z + D / 2), 0, 0.01);
    // Team colour wash over each half.
    flat(new THREE.PlaneGeometry(2 * (X - 1.2), Z - 1.2), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], transparent: true, opacity: 0.07, depthWrite: false }), 0, sz * (Z - 1.2) / 2, 0, 0.01);
  }
  flat(new THREE.PlaneGeometry(2 * (X - 1.2), W), line, 0, 0);
  flat(new THREE.RingGeometry(9, 9 + W, 96), line, 0, 0);
  flat(new THREE.CircleGeometry(0.6, 24), line, 0, 0);
  // Arrows on the ramps' run-ups along the sidelines.

  // --- Walls: concrete kerb, glass, posts and a rail -----------------------
  const kerbMat = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.85 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x5f6670, metalness: 0.7, roughness: 0.4 });
  const kerbs = [], glass = [], steel = [];
  const along = (a, b, w, h, y0, out) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const geo = new THREE.BoxGeometry(w, h, len);
    geo.rotateY(Math.atan2(dx, dz));
    // Push the wall outward so its inner face is on the line.
    const nx = -dz / len, nz = dx / len;
    const s = Math.sign(nx * (a[0] + b[0]) + nz * (a[1] + b[1])) || 1;
    geo.translate((a[0] + b[0]) / 2 + nx * s * w / 2, y0 + h / 2, (a[1] + b[1]) / 2 + nz * s * w / 2);
    out.push(geo);
    return { len, dx: dx / len, dz: dz / len, nx: nx * s, nz: nz * s };
  };
  for (const [a, b] of wallSegments()) {
    along(a, b, 0.6, BASE_TOP, 0, kerbs);
    along(a, b, 0.08, GLASS_TOP - BASE_TOP, BASE_TOP, glass);
    const f = along(a, b, 0.25, 0.2, GLASS_TOP, steel);
    const n = Math.max(1, Math.round(f.len / 8));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const post = new THREE.BoxGeometry(0.22, GLASS_TOP - BASE_TOP, 0.22);
      post.translate(a[0] + (b[0] - a[0]) * t + f.nx * 0.15, BASE_TOP + (GLASS_TOP - BASE_TOP) / 2, a[1] + (b[1] - a[1]) * t + f.nz * 0.15);
      steel.push(post);
    }
  }
  // Glass above each goal mouth.
  for (const sz of [-1, 1]) {
    const g = new THREE.BoxGeometry(2 * G, GLASS_TOP - H, 0.08);
    g.translate(0, H + (GLASS_TOP - H) / 2, sz * (Z + 0.04));
    glass.push(g);
    const rail = new THREE.BoxGeometry(2 * G, 0.2, 0.25);
    rail.translate(0, GLASS_TOP, sz * (Z + 0.12));
    steel.push(rail);
  }
  const kerbMesh = new THREE.Mesh(mergeGeometries(kerbs), kerbMat);
  kerbMesh.castShadow = kerbMesh.receiveShadow = true;
  const glassMesh = new THREE.Mesh(mergeGeometries(glass), glassMat);
  glassMesh.renderOrder = 2;
  const steelMesh = new THREE.Mesh(mergeGeometries(steel), steelMat);
  steelMesh.castShadow = true;
  group.add(kerbMesh, glassMesh, steelMesh);

  // --- Goals: frame and net in the defending team's colour ----------------
  for (const sz of [-1, 1]) {
    const team = sz < 0 ? 0 : 1;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: TEAM_COLORS[team], emissiveIntensity: 0.35, roughness: 0.4 });
    const parts = [];
    for (const sx of [-1, 1]) {
      const post = new THREE.CylinderGeometry(0.22, 0.22, H, 16);
      post.translate(sx * G, H / 2, sz * Z);
      parts.push(post);
    }
    const bar = new THREE.CylinderGeometry(0.22, 0.22, 2 * G + 0.44, 16);
    bar.rotateZ(Math.PI / 2);
    bar.translate(0, H, sz * Z);
    parts.push(bar);
    const frame = new THREE.Mesh(mergeGeometries(parts), frameMat);
    frame.castShadow = true;
    group.add(frame);

    const netMat = new THREE.MeshBasicMaterial({ map: netTexture(), color: TEAM_COLORS[team], transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const net = [];
    const back = new THREE.PlaneGeometry(2 * G, H);
    back.translate(0, H / 2, sz * (Z + D));
    net.push(back);
    for (const sx of [-1, 1]) {
      const side = new THREE.PlaneGeometry(D, H);
      side.rotateY(Math.PI / 2);
      side.translate(sx * G, H / 2, sz * (Z + D / 2));
      net.push(side);
    }
    const roof = new THREE.PlaneGeometry(2 * G, D);
    roof.rotateX(Math.PI / 2);
    roof.translate(0, H, sz * (Z + D / 2));
    net.push(roof);
    const netMesh = new THREE.Mesh(mergeGeometries(net), netMat);
    netMesh.renderOrder = 2;
    group.add(netMesh);
  }

  // --- Grandstands and crowd ----------------------------------------------
  const standMat = new THREE.MeshStandardMaterial({ color: 0x6d717a, roughness: 0.9 });
  const stands = [];
  const seats = []; // [x, y, z, team bias]
  const TIERS = 7;
  const rowsAlong = (axis, sign, from, to, inner, teamBias) => {
    for (let t = 0; t < TIERS; t++) {
      const depth = 2.2;
      const off = inner + t * depth + depth / 2;
      const h = 1 + t * 1.1;
      const len = to - from;
      const geo = axis === 'x' ? new THREE.BoxGeometry(depth, h, len) : new THREE.BoxGeometry(len, h, depth);
      if (axis === 'x') geo.translate(sign * off, h / 2, (from + to) / 2);
      else geo.translate((from + to) / 2, h / 2, sign * off);
      stands.push(geo);
      for (let u = from + 0.6; u < to - 0.4; u += 0.95) {
        const jitter = (Math.random() - 0.5) * 0.25;
        if (axis === 'x') seats.push([sign * (off + 0.3), h, u + jitter, teamBias]);
        else seats.push([u + jitter, h, sign * (off + 0.3), teamBias]);
      }
    }
  };
  rowsAlong('x', -1, -64, 64, X + 6, 0.5);
  rowsAlong('x', 1, -64, 64, X + 6, 0.5);
  rowsAlong('z', -1, -X - 4, X + 4, Z + D + 5, 0.1); // behind Blue's goal: mostly blue fans
  rowsAlong('z', 1, -X - 4, X + 4, Z + D + 5, 0.9);
  const standMesh = new THREE.Mesh(mergeGeometries(stands), standMat);
  standMesh.receiveShadow = true;
  group.add(standMesh);

  const fan = new THREE.BoxGeometry(0.5, 0.85, 0.4);
  fan.translate(0, 0.42, 0);
  const crowd = new THREE.InstancedMesh(fan, new THREE.MeshStandardMaterial({ roughness: 0.8 }), seats.length);
  const rng = mulberry32(5);
  const shirt = new THREE.Color();
  const PALETTE = [0xe8e2d6, 0x2b2b30, 0x8a5a3c, 0x5c7c4a, 0xd1b28a];
  const m4 = new THREE.Matrix4();
  seats.forEach(([x, y, z, bias], i) => {
    m4.makeTranslation(x, y, z);
    crowd.setMatrixAt(i, m4);
    const r = rng();
    if (r < 0.75) shirt.setHex(TEAM_COLORS[rng() < bias ? 1 : 0]);
    else shirt.setHex(PALETTE[(rng() * PALETTE.length) | 0]);
    shirt.offsetHSL(0, 0, (rng() - 0.5) * 0.12);
    crowd.setColorAt(i, shirt);
  });
  group.add(crowd);
  const crowdPhase = seats.map(() => rng() * Math.PI * 2);
  let cheer = 0;

  // --- Floodlights ---------------------------------------------------------
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6dd, emissiveIntensity: 2.5 });
  const towers = [], lamps = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (X + 22), z = sz * (Z + 14);
      const pole = new THREE.BoxGeometry(1, 30, 1);
      pole.translate(x, 15, z);
      towers.push(pole);
      const head = new THREE.BoxGeometry(7, 3.5, 0.6);
      head.rotateX(-0.5);
      head.rotateY(Math.atan2(-x, -z));
      head.translate(x, 30, z);
      lamps.push(head);
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(towers), steelMat), new THREE.Mesh(mergeGeometries(lamps), lampMat));

  // --- Ramps ---------------------------------------------------------------
  const terrain = new Terrain();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Kickers along each sideline, launching toward halfway.
      terrain.addRamp({ x: sx * 31.5, z: sz * 31, heading: sz > 0 ? Math.PI : 0, length: 7, width: 5, height: 1.6, profile: 'kicker' });
    }
  }
  terrain.buildMeshes(group);

  return {
    name: 'stadium',
    group,
    terrain,
    orbit: { radius: 70, height: 30 },
    addColliders(world) {
      terrain.addColliders(world);
      addStadiumColliders(world);
    },
    populate: populateStadium,
    contain: containStadium,
    /** Make the crowd jump for a few seconds. */
    celebrate() { cheer = 3.5; },
    update(dt) {
      if (cheer <= 0) return;
      cheer -= dt;
      const k = Math.max(0, Math.min(1, cheer));
      for (let i = 0; i < seats.length; i++) {
        const [x, y, z] = seats[i];
        const hop = Math.max(0, Math.sin(cheer * 11 + crowdPhase[i])) * 0.45 * k;
        m4.makeTranslation(x, y + hop, z);
        crowd.setMatrixAt(i, m4);
      }
      crowd.instanceMatrix.needsUpdate = true;
    },
  };
}

/** Fixed colliders: walls, chamfered corners, goal boxes and a ceiling. */
function addStadiumColliders(world) {
  const { halfZ: Z, goalHalf: G, goalDepth: D, goalHeight: H } = PITCH;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const box = (hx, hy, hz, x, y, z, yaw = 0) => {
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.3).setRestitution(0.5);
    if (yaw) cd.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    world.createCollider(cd, body);
  };
  const T = 0.5; // half thickness
  for (const [a, b] of wallSegments()) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    let nx = -dz / len, nz = dx / len;
    const s = Math.sign(nx * (a[0] + b[0]) + nz * (a[1] + b[1])) || 1;
    nx *= s; nz *= s;
    box(T, WALL_TOP / 2, len / 2 + T, (a[0] + b[0]) / 2 + nx * T, WALL_TOP / 2, (a[1] + b[1]) / 2 + nz * T, Math.atan2(dx, dz));
  }
  for (const sz of [-1, 1]) {
    // Above the goal mouth, from the crossbar up.
    box(G + T, (WALL_TOP - H) / 2, T, 0, H + (WALL_TOP - H) / 2, sz * (Z + T));
    // Goal box: sides, back, roof.
    for (const sx of [-1, 1]) box(T, H / 2 + T, D / 2 + T, sx * (G + T), H / 2, sz * (Z + D / 2));
    box(G + T, H / 2 + T, T, 0, H / 2, sz * (Z + D + T));
    box(G + T, T, D / 2 + T, 0, H + T, sz * (Z + D / 2));
  }
  box(60, 0.5, 80, 0, WALL_TOP + 0.5, 0); // ceiling
}

/**
 * Keep a car (anything with x, z, velX, velZ, yawRate) on the pitch and in
 * the goals. Returns the speed of the hardest wall hit (0 if none).
 */
export function containStadium(c, margin = 1.5) {
  const { halfX: X, halfZ: Z, goalHalf: G, goalDepth: D, chamfer: C } = PITCH;
  let hit = 0;
  const push = (nx, nz, depth) => {
    c.x += nx * depth;
    c.z += nz * depth;
    const vn = c.velX * nx + c.velZ * nz;
    if (vn < 0) {
      c.velX -= 1.3 * vn * nx;
      c.velZ -= 1.3 * vn * nz;
      c.yawRate *= 0.5;
      hit = Math.max(hit, -vn);
    }
  };
  const sx = Math.sign(c.x) || 1, sz = Math.sign(c.z) || 1;
  const ax = Math.abs(c.x), az = Math.abs(c.z);
  const mouth = G - margin * 0.75;
  if (az > Z) {
    // Inside a goal: its side nets and back.
    if (ax > mouth) push(-sx, 0, ax - mouth);
    const back = Z + D - margin;
    if (Math.abs(c.z) > back) push(0, -sz, Math.abs(c.z) - back);
    return hit;
  }
  if (ax > X - margin) push(-sx, 0, ax - (X - margin));
  if (az > Z - margin && Math.abs(c.x) > mouth) push(0, -sz, az - (Z - margin));
  const diag = (Math.abs(c.x) + Math.abs(c.z) - (X + Z - C)) / Math.SQRT2 + margin;
  if (diag > 0) push(-sx / Math.SQRT2, -sz / Math.SQRT2, diag);
  return hit;
}

/** Where each team lines up for kickoff (index = player number in the team). */
export function kickoffSpot(team, index) {
  const SPOTS = [[0, 40], [-14, 46], [14, 46], [0, 54], [-24, 52], [24, 52], [-8, 56], [8, 56]];
  const [x, z] = SPOTS[index % SPOTS.length];
  return team === 0 ? { x: -x, z: -z, heading: 0 } : { x, z, heading: Math.PI };
}

// --- Things to smash ----------------------------------------------------------

/** One brick wall of a goal's back net (rebuilt at every kickoff). */
export function goalWall(d, sz) {
  const { halfZ: Z, goalHalf: G, goalDepth: D } = PITCH;
  stadiumBricks(d, 0, sz * (Z + D - 0.35), 0, 2 * G - 0.4, 6);
}

function stadiumBricks(d, x, z, yaw, len, rows) {
  const opts = { sleep: true };
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const place = (u, y, kind) => d.spawn(kind, { x: x + u * c, y, z: z - u * s }, yaw, opts);
  for (let r = 0; r < rows; r++) {
    const y = 0.15 + r * 0.302;
    let u = -len / 2;
    if (r % 2) { place(u + 0.15, y, 'brickHalf'); u += 0.3; }
    while (u + 0.6 <= len / 2 + 1e-6) { place(u + 0.3, y, 'brick'); u += 0.6; }
    if (u < len / 2 - 1e-6) place(u + 0.15, y, 'brickHalf');
  }
}

export function populateStadium(d) {
  const { halfX: X, halfZ: Z } = PITCH;
  const opts = { sleep: true };
  for (const sx of [-1, 1]) {
    // Brick advertising boards along the middle of each sideline.
    stadiumBricks(d, sx * (X - 1.5), 0, Math.PI / 2, 30, 4);
    // Light poles at the halfway line, just inside the glass.
    d.spawn('pole', { x: sx * (X - 1.2), y: 3.5, z: 19 }, 0, opts);
    d.spawn('pole', { x: sx * (X - 1.2), y: 3.5, z: -19 }, 0, opts);
    // Cones along the halfway line.
    for (let x = 13; x <= X - 4; x += 3) d.spawn('cone', { x: sx * x, y: 0.3, z: 0 }, 0, opts);
    for (const sz of [-1, 1]) {
      // Crate pyramids near the corners.
      const cz = sz * 44;
      const cx = sx * (X - 3);
      for (let i = 0; i < 3; i++) d.spawn('crate', { x: cx, y: 0.5, z: cz + (i - 1) * 1.02 }, 0, opts);
      for (let i = 0; i < 2; i++) d.spawn('crate', { x: cx, y: 1.5, z: cz + (i - 0.5) * 1.02 }, 0, opts);
      d.spawn('crate', { x: cx, y: 2.5, z: cz }, 0, opts);
      // Fuel drums tucked into the cut corners: blasts throw the ball about.
      const fx = sx * (X - 6.5), fz = sz * (Z - 4.5);
      for (const [ox, oz] of [[0, 0], [0.7, 0.3], [0.2, 0.75]]) d.spawn('fuel', { x: fx + sx * ox, y: 0.45, z: fz + sz * oz }, 0, opts);
      // Barrel rows flanking the goals.
      for (let i = 0; i < 4; i++) d.spawn('barrel', { x: sx * (13 + i * 0.75), y: 0.48, z: sz * (Z - 3) }, 0, opts);
      // Concrete block posts in midfield.
      for (let y = 0; y < 2; y++) d.spawn('block', { x: sx * 14, y: 0.5 + y * 1.001, z: sz * 28 }, 0, opts);
      // Stacked slab gates at each penalty box corner.
      d.spawn('slab', { x: sx * 15, y: 1.1, z: sz * (Z - 16) }, 0, opts);
    }
  }
  for (const sz of [-1, 1]) goalWall(d, sz);
}

// --- Textures -------------------------------------------------------------------

function grassStripes(renderer) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 512;
  const g = c.getContext('2d');
  const stripes = 16;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 ? '#4f8f3c' : '#5a9c45';
    g.fillRect(0, (i * c.height) / stripes, c.width, c.height / stripes);
  }
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

let _net;
function netTexture() {
  if (_net) return _net;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 30, 30);
  _net = new THREE.CanvasTexture(c);
  _net.wrapS = _net.wrapT = THREE.RepeatWrapping;
  _net.repeat.set(16, 5);
  return _net;
}
