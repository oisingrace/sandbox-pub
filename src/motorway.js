import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Terrain } from './terrain.js';
import { mulberry32 } from './world.js';

// The Motorway: a 2.4 km dual carriageway for flat-out driving. The road
// runs along Z: three lanes each way either side of a painted (open)
// central reservation, so the middle is always clear, then hard shoulders
// and grass verges out to a fence. Everything that gets in the way is on
// the sides: roadworks, broken-down lorries, barrier runs, lamp posts,
// crate and drum piles, signs, trees, overpass pillars, and kicker ramps
// on the hard shoulder.

export const ROAD = {
  half: 1200,      // the road runs from z = -half to +half
  median: 1.5,     // half width of the painted central reservation
  lane: 3.7,
  lanes: 3,
  shoulder: 3.3,
  fence: 44,       // cars are kept inside |x| < fence
  overpasses: [-800, -400, 0, 400, 800],
  deckBottom: 4.6, // underside of the overpass decks
};
const EDGE = ROAD.median + ROAD.lane * ROAD.lanes;   // edge of the carriageway (12.6 m)
const SIDE = EDGE + ROAD.shoulder;                   // edge of the hard shoulder (15.9 m)
const DECK_DEPTH = 10;
const END = ROAD.half - 4;                           // where the end walls stop cars

/** Start spots: in the lanes near the south end, facing north. */
export function motorwaySpawn(slot) {
  const xs = [7, 3.4, 10.7, -3.4, -7, -10.7, 14.2, -14.2];
  return { x: xs[slot % xs.length], z: -ROAD.half + 30 + Math.floor(slot / xs.length) * 10 + (slot % 2) * 4, heading: 0 };
}

export function createMotorway(scene, renderer) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const L = ROAD.half * 2;
  const aniso = renderer.capabilities.getMaxAnisotropy();

  // --- Ground: the road, the verges, embankments -------------------------
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(SIDE * 2 + 0.2, L + 20),
    new THREE.MeshStandardMaterial({ map: roadTexture(aniso, L + 20), roughness: 0.92 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.006;
  road.receiveShadow = true;
  group.add(road);

  const verge = new THREE.Mesh(
    new THREE.PlaneGeometry(260, L + 200),
    new THREE.MeshStandardMaterial({ map: grassTexture(aniso, L + 200), roughness: 1 }),
  );
  verge.rotation.x = -Math.PI / 2;
  verge.position.y = -0.02;
  verge.receiveShadow = true;
  group.add(verge);

  // Embankments rising beyond the fence on both sides.
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x6a8a48, roughness: 1 });
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(40, 1, L + 200);
    g.rotateZ(s * 0.22);
    g.translate(s * (ROAD.fence + 24), 3.6, 0);
    const bank = new THREE.Mesh(g, bankMat);
    bank.receiveShadow = true;
    group.add(bank);
  }

  // --- Fence, hard shoulder kerb, end walls -----------------------------------
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a9098, metalness: 0.6, roughness: 0.45 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
  const posts = [], rails = [];
  for (const s of [-1, 1]) {
    for (let z = -ROAD.half - 40; z <= ROAD.half + 40; z += 6) {
      const p = new THREE.BoxGeometry(0.14, 1.4, 0.14);
      p.translate(s * ROAD.fence, 0.7, z);
      posts.push(p);
    }
    for (const y of [0.55, 1.15]) {
      const r = new THREE.BoxGeometry(0.06, 0.12, L + 80);
      r.translate(s * ROAD.fence, y, 0);
      rails.push(r);
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(posts), wood), new THREE.Mesh(mergeGeometries(rails), steel));

  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b5ad, roughness: 0.9 });
  const chevron = new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.6 });
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ROAD.fence * 2 + 4, 3, 2), concrete);
    wall.position.set(0, 1.5, s * (ROAD.half + 1));
    wall.castShadow = wall.receiveShadow = true;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(SIDE * 2, 1.4), chevron);
    sign.position.set(0, 1.6, s * ROAD.half - s * 0.01);
    sign.rotation.y = s > 0 ? Math.PI : 0;
    group.add(wall, sign);
  }

  // --- Overpasses: decks, parapets and abutments (the pillars are breakable) ---
  const deckParts = [], parapets = [], signs = [];
  const D = ROAD.deckBottom;
  for (const z of ROAD.overpasses) {
    const deck = new THREE.BoxGeometry(ROAD.fence * 2 + 10, 1.3, DECK_DEPTH);
    deck.translate(0, D + 0.65, z);
    deckParts.push(deck);
    for (const dz of [-1, 1]) {
      const p = new THREE.BoxGeometry(ROAD.fence * 2 + 10, 1.1, 0.3);
      p.translate(0, D + 1.85, z + dz * (DECK_DEPTH / 2 - 0.15));
      parapets.push(p);
    }
    // Earth abutments carry the deck over the verges.
    for (const s of [-1, 1]) {
      const a = new THREE.BoxGeometry(8, D, DECK_DEPTH + 2);
      a.translate(s * (ROAD.fence + 2), D / 2, z);
      deckParts.push(a);
    }
    // A blue direction sign hung on each face.
    for (const dz of [-1, 1]) {
      const g = new THREE.PlaneGeometry(7, 2.2);
      if (dz > 0) g.rotateY(Math.PI);
      g.translate(dz < 0 ? 6.5 : -6.5, D - 0.2, z + dz * (DECK_DEPTH / 2 + 0.02));
      signs.push(g);
    }
  }
  const deckMesh = new THREE.Mesh(mergeGeometries(deckParts), concrete);
  deckMesh.castShadow = deckMesh.receiveShadow = true;
  const signMesh = new THREE.Mesh(mergeGeometries(signs), new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.5, side: THREE.DoubleSide }));
  group.add(deckMesh, new THREE.Mesh(mergeGeometries(parapets), concrete), signMesh);

  // --- Trees beyond the fence (scenery only) ---------------------------------------
  const rng = mulberry32(42);
  const trunk = new THREE.CylinderGeometry(0.18, 0.25, 2.4, 6);
  trunk.translate(0, 1.2, 0);
  const crown = new THREE.ConeGeometry(1.8, 5, 7);
  crown.translate(0, 4.6, 0);
  const n = 700;
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }), n);
  const crowns = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0x3f6b35, roughness: 1 }), n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const s = i % 2 ? 1 : -1;
    const x = s * (ROAD.fence + 8 + rng() * 70);
    const z = (rng() * 2 - 1) * (ROAD.half + 80);
    const k = 0.7 + rng() * 0.8;
    const lift = Math.max(0, Math.min(8, (Math.abs(x) - ROAD.fence - 4) * 0.22)) - 0.3;
    m4.compose(pos.set(x, lift, z), q.setFromAxisAngle(_up, rng() * 6.28), sc.set(k, k * (0.8 + rng() * 0.5), k));
    trunks.setMatrixAt(i, m4);
    crowns.setMatrixAt(i, m4);
    crowns.setColorAt(i, tint.setHSL(0.27 + rng() * 0.06, 0.35 + rng() * 0.2, 0.25 + rng() * 0.12));
  }
  crowns.castShadow = true;
  group.add(trunks, crowns);

  // --- Ramps: kickers on the hard shoulders, alternating sides ------------------------
  const terrain = new Terrain();
  for (const { s, z } of KICKERS) {
    terrain.addRamp({ x: s * (EDGE + ROAD.shoulder / 2), z, heading: 0, length: 9, width: 3, height: 1.6, profile: 'kicker' });
  }
  // A big table jump on each verge at the middle.
  for (const s of [-1, 1]) {
    terrain.addRamp({ x: s * 28, z: -150, heading: s > 0 ? Math.PI : 0, length: 34, width: 8, height: 3.2, profile: 'table', parts: [10, 14] });
  }
  terrain.buildMeshes(group);

  return {
    name: 'motorway',
    group,
    terrain,
    orbit: { radius: 70, height: 26 },
    recycle: ROAD.half + 60, // debris is only cleared once it's off the map
    spawn: motorwaySpawn,
    addColliders(world) {
      terrain.addColliders(world);
      addMotorwayColliders(world);
    },
    populate: populateMotorway,
    contain: containMotorway,
  };
}

const _up = new THREE.Vector3(0, 1, 0);

/** Kicker ramps on the hard shoulders, alternating sides (kept clear of obstacles). */
const KICKERS = [];
for (let i = 0, z = -ROAD.half + 180; z < ROAD.half - 150; i++, z += 290) KICKERS.push({ s: i % 2 ? 1 : -1, z });

/** Ground under the whole road (the shared ground slab is only 600 m), end walls and overpass decks. */
function addMotorwayColliders(world) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const box = (hx, hy, hz, x, y, z) => world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.8), body);
  box(ROAD.fence + 20, 0.5, ROAD.half + 60, 0, -0.5, 0);
  for (const s of [-1, 1]) {
    box(ROAD.fence + 2, 4, 1, 0, 4, s * (ROAD.half + 1));
    box(0.3, 3, ROAD.half + 2, s * (ROAD.fence + 0.3), 3, 0);
  }
  for (const z of ROAD.overpasses) box(ROAD.fence + 5, 0.65, DECK_DEPTH / 2, 0, ROAD.deckBottom + 0.65, z);
}

/**
 * Keep a car on the motorway: the fences, the end walls, and under the
 * overpass decks. Returns the speed of the hardest wall hit.
 */
export function containMotorway(c, margin = 1.4) {
  let hit = 0;
  const X = ROAD.fence - margin;
  if (Math.abs(c.x) > X) {
    const s = Math.sign(c.x);
    c.x = s * X;
    if (Math.sign(c.velX) === s) { hit = Math.max(hit, Math.abs(c.velX)); c.velX *= -0.3; c.yawRate *= 0.5; }
  }
  if (Math.abs(c.z) > END) {
    const s = Math.sign(c.z);
    c.z = s * END;
    if (Math.sign(c.velZ) === s) { hit = Math.max(hit, Math.abs(c.velZ)); c.velZ *= -0.3; c.yawRate *= 0.5; }
  }
  // A car flying into an overpass hits its underside.
  for (const z of ROAD.overpasses) {
    if (Math.abs(c.z - z) > DECK_DEPTH / 2 + 2) continue;
    const roof = ROAD.deckBottom - 1.6;
    if ((c.y || 0) > roof && (c.y || 0) < ROAD.deckBottom + 1.5) {
      c.y = roof;
      if (c.velY > 0) { hit = Math.max(hit, c.velY); c.velY = 0; }
    }
  }
  return hit;
}

// --- Things on the sides ------------------------------------------------------------

export function populateMotorway(d) {
  const rng = mulberry32(7);
  const opts = { sleep: true };
  const site = (fn) => { d.beginSite(); fn(); d.endSite(); };
  const spawn = (kind, x, y, z, yaw = 0) => d.spawn(kind, { x, y, z }, yaw, opts);

  // Lamp posts along both hard shoulders.
  for (let z = -ROAD.half + 30; z < ROAD.half - 20; z += 60) {
    for (const s of [-1, 1]) spawn('pole', s * (SIDE + 0.7), 3.5, z + (s > 0 ? 30 : 0));
  }
  // Overpass pillars: two pairs per bridge, at the edge of each hard shoulder.
  for (const z of ROAD.overpasses) {
    site(() => {
      for (const s of [-1, 1]) for (const dz of [-3, 3]) spawn('column', s * (SIDE + 1.6), 2.25, z + dz);
    });
  }

  // Obstacle clusters every 50-70 m on each side (never in the lanes).
  const kinds = [roadworks, lorry, barrierRun, cratePile, drums, grove, signs, wall];
  for (const s of [-1, 1]) {
    let z = -ROAD.half + 80 + rng() * 30;
    while (z < ROAD.half - 60) {
      // Keep clear of the bridges and the ramps.
      const nearBridge = ROAD.overpasses.some((o) => Math.abs(o - z) < 14);
      const nearRamp = KICKERS.some((k) => k.s === s && z > k.z - 40 && z < k.z + 22) || (z > -200 && z < -100);
      if (!nearBridge && !nearRamp) {
        const make = kinds[(rng() * kinds.length) | 0];
        site(() => make(s, z));
      }
      z += 50 + rng() * 25;
    }
  }

  /** Cones tapering onto the hard shoulder, with barriers and barrels. */
  function roadworks(s, z) {
    for (let i = 0; i < 9; i++) spawn('cone', s * (EDGE + 0.4 + Math.min(i, 5) * 0.5), 0.3, z + i * 3);
    for (let i = 0; i < 3; i++) spawn('barrier', s * (SIDE - 1.2), 0.45, z + 16 + i * 3.05);
    for (let i = 0; i < 3; i++) spawn('barrel', s * (SIDE - 2.6), 0.48, z + 18 + i * 1.2);
  }
  /** A broken-down lorry: two containers nose to tail on the shoulder, warning cones behind. */
  function lorry(s, z) {
    for (let i = 0; i < 2; i++) spawn('container', s * (SIDE - 0.4), 1.3, z + i * 6.3, Math.PI / 2);
    for (let i = 0; i < 4; i++) spawn('cone', s * (EDGE + 1.2), 0.3, z - 6 - i * 4);
    if (rng() < 0.5) for (const [ox, oz] of [[0, 0], [0.7, 0.3]]) spawn('fuel', s * (SIDE + 3 + ox), 0.45, z + 4 + oz);
  }
  /** A run of concrete barriers along the verge edge. */
  function barrierRun(s, z) {
    const n = 4 + ((rng() * 4) | 0);
    for (let i = 0; i < n; i++) spawn('barrier', s * (SIDE + 1.2), 0.45, z + i * 3.05);
  }
  /** Pallets of crates dropped on the verge. */
  function cratePile(s, z) {
    const x = s * (SIDE + 5 + rng() * 10);
    for (let i = 0; i < 3; i++) spawn('crate', x, 0.5, z + (i - 1) * 1.02);
    for (let i = 0; i < 2; i++) spawn('crate', x, 1.5, z + (i - 0.5) * 1.02);
    spawn('crate', x, 2.5, z);
  }
  /** Oil drums and fuel drums on the shoulder: hit them at speed. */
  function drums(s, z) {
    for (let i = 0; i < 4; i++) spawn('barrel', s * (EDGE + 1 + (i % 2) * 0.8), 0.48, z + i * 0.8);
    for (const [ox, oz] of [[0, 0], [0.7, 0.3], [0.25, 0.75]]) spawn('fuel', s * (SIDE - 0.8 + ox), 0.45, z + 4 + oz);
  }
  /** A few trees on the verge. */
  function grove(s, z) {
    const n = 3 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) spawn('tree', s * (SIDE + 8 + rng() * 18), 1.5, z + rng() * 16);
  }
  /** Roadside signs (slabs) on the verge edge. */
  function signs(s, z) {
    for (let i = 0; i < 2; i++) spawn('slab', s * (SIDE + 1.4), 1.1, z + i * 1.3, Math.PI / 2);
    spawn('pole', s * (SIDE + 2.4), 3.5, z + 0.6);
  }
  /** A stub of brick wall on the far verge, from some old building. */
  function wall(s, z) {
    const x = s * (SIDE + 10 + rng() * 12);
    for (let r = 0; r < 5; r++) {
      const y = 0.15 + r * 0.302;
      for (let i = 0; i < 10; i++) spawn(r % 2 && i === 0 ? 'brickHalf' : 'brick', x, y, z + i * 0.6 + (r % 2 ? 0.3 : 0), Math.PI / 2);
    }
  }
}

// --- Textures ---------------------------------------------------------------------

/** The road surface (32 m wide, a 32 m tile repeated along it): asphalt, lanes and the hatched middle. */
function roadTexture(aniso, length) {
  const c = document.createElement('canvas');
  const PX = 16; // pixels per metre
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#3d3f43';
  g.fillRect(0, 0, 512, 512);
  const img = g.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const W = 32;
  const px = (x) => (x + W / 2) * PX;
  // Hard shoulders a touch lighter.
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (const s of [-1, 1]) g.fillRect(Math.min(px(s * EDGE), px(s * SIDE)), 0, ROAD.shoulder * PX, 512);
  g.fillStyle = '#ecebe6';
  // Solid lines: carriageway edges and either side of the middle.
  for (const x of [-EDGE, EDGE, -ROAD.median, ROAD.median]) g.fillRect(px(x) - 2.4, 0, 4.8, 512);
  // Dashed lane lines: 6 m dashes, 10 m gaps.
  for (let k = 1; k < ROAD.lanes; k++) {
    for (const s of [-1, 1]) {
      const x = px(s * (ROAD.median + k * ROAD.lane));
      for (let z = 0; z < 512; z += 16 * PX) g.fillRect(x - 1.6, z, 3.2, 6 * PX);
    }
  }
  // Hatched central reservation (painted, so you can drive across it).
  g.save();
  g.beginPath();
  g.rect(px(-ROAD.median), 0, ROAD.median * 2 * PX, 512);
  g.clip();
  g.strokeStyle = 'rgba(236,235,230,0.85)';
  g.lineWidth = 3;
  for (let z = -64; z < 512 + 64; z += 4 * PX) {
    g.beginPath();
    g.moveTo(px(-ROAD.median), z);
    g.lineTo(px(0), z + ROAD.median * PX);
    g.lineTo(px(ROAD.median), z);
    g.stroke();
  }
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, length / 32);
  tex.anisotropy = aniso;
  return tex;
}

function grassTexture(aniso, length) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#6c8d4a';
  g.fillRect(0, 0, 128, 128);
  const img = g.getImageData(0, 0, 128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 30;
    img.data[i] += n * 0.7; img.data[i + 1] += n; img.data[i + 2] += n * 0.5;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(260 / 8, length / 8);
  tex.anisotropy = aniso;
  return tex;
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#d42a1f';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#ffffff';
  for (let x = 0; x < 512; x += 48) {
    g.beginPath();
    g.moveTo(x, 8); g.lineTo(x + 18, 32); g.lineTo(x, 56); g.lineTo(x + 14, 56); g.lineTo(x + 32, 32); g.lineTo(x + 14, 8);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#1d4fa3';
  g.fillRect(0, 0, 512, 160);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 496, 144);
  g.fillStyle = '#ffffff';
  g.font = '700 54px system-ui, sans-serif';
  g.fillText('SMASH LOT', 30, 76);
  g.font = '600 40px system-ui, sans-serif';
  g.fillText('M1  ↑  keep going', 30, 130);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
