import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Terrain } from './terrain.js';

// The Scrapyard: the Versus arena. A square yard walled in corrugated
// steel, with a raised cross in the middle (two table ramps crossing),
// kickers in each quarter, and cover everywhere: container stacks,
// concrete block walls, brick walls, jersey barriers, crates, and fuel
// drums that blow up anyone parked next to them. Upgrade pads (see
// versus.js) sit in the open between the cover.

export const YARD = {
  half: 85,        // inner face of the walls
  wallHeight: 6,   // the visible fence
};
const WALL_TOP_VS = 24; // invisible collider height (debris stays in)

/** Upgrade pads: the top of the cross, its four ends, and the four corners. */
export const PADS = [
  [0, 0], [40, 0], [-40, 0], [0, 40], [0, -40],
  [58, 58], [-58, 58], [58, -58], [-58, -58],
].map(([x, z]) => ({ x, z }));

/** Where cars (re)enter: along the walls, facing the middle. */
export const SPAWNS = [
  [74, 26], [74, -26], [-74, 26], [-74, -26], [26, 74], [-26, 74], [26, -74], [-26, -74],
].map(([x, z]) => ({ x, z, heading: Math.atan2(-x, -z) }));

export function createScrapyard(scene, renderer) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const H = YARD.half;

  // --- Ground: packed dirt inside, gravel outside -------------------------
  const dirt = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * H, 2 * H),
    new THREE.MeshStandardMaterial({ map: dirtTexture(renderer), roughness: 0.97 }),
  );
  dirt.rotation.x = -Math.PI / 2;
  dirt.position.y = 0.004;
  dirt.receiveShadow = true;
  group.add(dirt);
  const outside = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * H + 160, 2 * H + 160),
    new THREE.MeshStandardMaterial({ color: 0x6f6a61, roughness: 1 }),
  );
  outside.rotation.x = -Math.PI / 2;
  outside.position.y = 0.001;
  outside.receiveShadow = true;
  group.add(outside);

  // Painted spawn boxes along the walls.
  const paint = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.55, depthWrite: false });
  const boxes = [];
  for (const s of SPAWNS) {
    for (const [w, d, ox, oz] of [[4, 0.25, 0, 3], [4, 0.25, 0, -3], [0.25, 6, 2, 0], [0.25, 6, -2, 0]]) {
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.translate(ox, 0, oz);
      g.rotateY(s.heading);
      g.translate(s.x, 0.012, s.z);
      boxes.push(g);
    }
  }
  const boxMesh = new THREE.Mesh(mergeGeometries(boxes), paint);
  boxMesh.renderOrder = 1;
  group.add(boxMesh);

  // --- Walls: corrugated steel sheets on posts ----------------------------
  const sheetMats = [0x8b5a3c, 0x6e7378, 0x9a6b45, 0x5d6268, 0x7d4b33].map((c) => new THREE.MeshStandardMaterial({
    color: c, map: corrugationTexture(), roughness: 0.75, metalness: 0.35,
  }));
  const sheets = sheetMats.map(() => []);
  const posts = [];
  const W = YARD.wallHeight;
  let n = 0;
  for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
    for (let u = -H; u < H; u += 4) {
      const g = new THREE.BoxGeometry(4.05, W + (n * 7 % 3) * 0.35, 0.12);
      const h = W + (n * 7 % 3) * 0.35;
      g.translate(0, h / 2, 0);
      g.rotateZ(((n * 13) % 5 - 2) * 0.006); // a little crooked
      if (axis === 'x') { g.rotateY(Math.PI / 2); g.translate(sign * (H + 0.1), 0, u + 2); }
      else g.translate(u + 2, 0, sign * (H + 0.1));
      sheets[n % sheets.length].push(g);
      const p = new THREE.BoxGeometry(0.25, W + 0.8, 0.25);
      p.translate(0, (W + 0.8) / 2, 0);
      if (axis === 'x') p.translate(sign * (H + 0.25), 0, u);
      else p.translate(u, 0, sign * (H + 0.25));
      posts.push(p);
      n++;
    }
  }
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x4b5057, metalness: 0.6, roughness: 0.5 });
  sheets.forEach((list, i) => {
    const m = new THREE.Mesh(mergeGeometries(list), sheetMats[i]);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  });
  const postMesh = new THREE.Mesh(mergeGeometries(posts), steelMat);
  postMesh.castShadow = true;
  group.add(postMesh);

  // Scrap piles outside the fence: cars stacked like the yard's stock.
  const rng = mulberryVs(11);
  const scrapColors = [0x8a3b2e, 0x3a5a7d, 0x6b6b5f, 0x9a7b3c, 0x4e6b4a];
  const scrapMats = scrapColors.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.2 }));
  const scrapGeos = scrapColors.map(() => []);
  for (let i = 0; i < 70; i++) {
    const side = i % 4;
    const u = (rng() * 2 - 1) * (H + 10);
    const off = H + 6 + rng() * 14;
    const x = side === 0 ? off : side === 1 ? -off : u;
    const z = side === 2 ? off : side === 3 ? -off : u;
    const layers = 1 + Math.floor(rng() * 3);
    for (let l = 0; l < layers; l++) {
      const g = new THREE.BoxGeometry(1.9, 1.1, 4.2);
      g.rotateY(rng() * Math.PI);
      g.rotateZ((rng() - 0.5) * 0.2);
      g.translate(x + (rng() - 0.5), 0.55 + l * 1.12, z + (rng() - 0.5));
      scrapGeos[(rng() * scrapGeos.length) | 0].push(g);
    }
  }
  scrapGeos.forEach((list, i) => {
    if (!list.length) return;
    const m = new THREE.Mesh(mergeGeometries(list), scrapMats[i]);
    m.castShadow = true;
    group.add(m);
  });

  // --- Floodlights at the corners --------------------------------------------
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 2.4 });
  const towers = [], lamps = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (H + 5), z = sz * (H + 5);
      const pole = new THREE.BoxGeometry(0.9, 22, 0.9);
      pole.translate(x, 11, z);
      towers.push(pole);
      const head = new THREE.BoxGeometry(5, 2.6, 0.5);
      head.rotateX(-0.55);
      head.rotateY(Math.atan2(-x, -z));
      head.translate(x, 22, z);
      lamps.push(head);
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(towers), steelMat), new THREE.Mesh(mergeGeometries(lamps), lampMat));

  // --- Ramps: the raised cross, and kickers in each quarter ----------------
  const terrain = new Terrain();
  terrain.addRamp({ x: 0, z: -17, heading: 0, length: 34, width: 9, height: 3, profile: 'table', parts: [10, 14] });
  terrain.addRamp({ x: -17, z: 0, heading: Math.PI / 2, length: 34, width: 9, height: 3, profile: 'table', parts: [10, 14] });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Kickers in each quarter launch toward the middle, over the cover.
      terrain.addRamp({ x: sx * 50, z: sz * 50, heading: Math.atan2(-sx, -sz), length: 7, width: 5, height: 1.8, profile: 'kicker' });
    }
  }
  terrain.buildMeshes(group);

  return {
    name: 'scrapyard',
    group,
    terrain,
    orbit: { radius: 100, height: 48 },
    addColliders(world) {
      terrain.addColliders(world);
      addYardColliders(world);
    },
    populate: populateScrapyard,
    contain: containYard,
  };
}

function addYardColliders(world) {
  const H = YARD.half;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const T = 0.5;
  for (const [x, z, hx, hz] of [[H + T, 0, T, H + 2 * T], [-H - T, 0, T, H + 2 * T], [0, H + T, H + 2 * T, T], [0, -H - T, H + 2 * T, T]]) {
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, WALL_TOP_VS / 2, hz).setTranslation(x, WALL_TOP_VS / 2, z).setFriction(0.4).setRestitution(0.3), body);
  }
}

/** Keep a car inside the fence. Returns the speed of the hardest wall hit. */
export function containYard(c, margin = 1.6) {
  const L = YARD.half - margin;
  let hit = 0;
  if (c.y > WALL_TOP_VS - 3) {
    c.y = WALL_TOP_VS - 3;
    if (c.velY > 0) c.velY = 0;
  }
  for (const axis of ['x', 'z']) {
    const vel = axis === 'x' ? 'velX' : 'velZ';
    const over = Math.abs(c[axis]) - L;
    if (over <= 0) continue;
    const s = Math.sign(c[axis]);
    c[axis] = s * L;
    if (Math.sign(c[vel]) === s) {
      hit = Math.max(hit, Math.abs(c[vel]));
      c[vel] *= -0.35;
      c.yawRate *= 0.5;
    }
  }
  return hit;
}

/** Keep the chase camera inside the fence. */
export function keepCameraInYard(pos) {
  const L = YARD.half - 0.8;
  pos.x = Math.max(-L, Math.min(L, pos.x));
  pos.z = Math.max(-L, Math.min(L, pos.z));
}

// --- Cover -------------------------------------------------------------------

function brickWallVs(d, x, z, yaw, len, rows) {
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

export function populateScrapyard(d) {
  const opts = { sleep: true };
  const H = YARD.half;
  const C = 2.6; // container height
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // L-shaped container forts in each quarter, one stacked two high.
      const cx = sx * 27, cz = sz * 27;
      d.spawn('container', { x: cx, y: C / 2, z: cz + sz * 4 }, 0, opts);
      d.spawn('container', { x: cx, y: C * 1.5 + 0.01, z: cz + sz * 4 }, 0, opts);
      d.spawn('container', { x: cx + sx * 4, y: C / 2, z: cz - sz * 1.5 }, Math.PI / 2, opts);
      // Fuel drums tucked inside each fort: shoot them when someone's close.
      for (const [ox, oz] of [[0, 0], [0.7, 0.3], [0.25, 0.75]]) {
        d.spawn('fuel', { x: cx - sx * 1 + ox, y: 0.45, z: cz + sz * 1.2 + oz }, 0, opts);
      }
      // Crate pyramids in the open corners near the corner pads.
      const px = sx * 66, pz = sz * 46;
      for (let i = 0; i < 3; i++) d.spawn('crate', { x: px, y: 0.5, z: pz + (i - 1) * 1.02 }, 0, opts);
      for (let i = 0; i < 2; i++) d.spawn('crate', { x: px, y: 1.5, z: pz + (i - 0.5) * 1.02 }, 0, opts);
      d.spawn('crate', { x: px, y: 2.5, z: pz }, 0, opts);
      // Jersey barriers in chevrons round the corner pads.
      const bx = sx * 58, bz = sz * 58;
      for (const [ox, oz, yaw] of [[-sx * 6, 0, 0], [0, -sz * 6, Math.PI / 2]]) {
        d.spawn('barrier', { x: bx + ox, y: 0.45, z: bz + oz }, yaw, opts);
      }
      // Barrels by the cross's corners.
      for (let i = 0; i < 3; i++) d.spawn('barrel', { x: sx * (8 + i * 0.75), y: 0.48, z: sz * 9 }, 0, opts);
      // Lamp poles at the cross's inside corners.
      d.spawn('pole', { x: sx * 6, y: 3.5, z: sz * 6 }, 0, opts);
    }
  }
  for (const s of [-1, 1]) {
    // Concrete block walls along the east and west, with a gap to drive through.
    for (const z of [-14, -11, -8, 8, 11, 14]) {
      for (let y = 0; y < 2; y++) d.spawn('block', { x: s * 54, y: 0.5 + y * 1.001, z }, 0, opts);
    }
    for (let z = -6; z <= 6; z += 1.01) d.spawn('block', { x: s * 57, y: 0.5, z }, 0, opts);
    // Brick walls to the north and south.
    brickWallVs(d, -12, s * 56, 0, 9, 5);
    brickWallVs(d, 12, s * 56, 0, 9, 5);
    // Barrier lines flanking the long ramps' run-ups.
    for (const u of [-1, 1]) {
      d.spawn('barrier', { x: u * 7.5, y: 0.45, z: s * 24 }, 0, opts);
      d.spawn('barrier', { x: s * 24, y: 0.45, z: u * 7.5 }, Math.PI / 2, opts);
    }
    // Stacked slabs at the ends of the cross.
    for (const u of [-1, 1]) d.spawn('slab', { x: u * 3, y: 1.1, z: s * 46 }, Math.PI / 2, opts);
    for (const u of [-1, 1]) d.spawn('slab', { x: s * 46, y: 1.1, z: u * 3 }, 0, opts);
    // Fuel drums against the walls at the middle of each side.
    for (const [ox, oz] of [[0, 0], [0.7, 0.2], [0.3, 0.75]]) {
      d.spawn('fuel', { x: s * (H - 3) - s * ox, y: 0.45, z: 18 + oz }, 0, opts);
      d.spawn('fuel', { x: -18 - ox, y: 0.45, z: s * (H - 3) - s * oz }, 0, opts);
    }
  }
  // A crate stack on top of the cross, to fight over.
  for (const [x, z] of [[-1.6, -1.6], [1.6, 1.6]]) {
    d.spawn('crate', { x, y: 3.5, z }, 0, opts);
    d.spawn('crate', { x, y: 4.5, z }, 0, opts);
  }
}

// --- Textures ------------------------------------------------------------------

function mulberryVs(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dirtTexture(renderer) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#7d6e5a';
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n * 0.9; img.data[i + 2] += n * 0.8;
  }
  g.putImageData(img, 0, 0);
  // Oil stains and tyre tracks.
  for (let i = 0; i < 14; i++) {
    g.fillStyle = `rgba(30, 26, 22, ${0.08 + Math.random() * 0.12})`;
    g.beginPath();
    g.ellipse(Math.random() * 256, Math.random() * 256, 6 + Math.random() * 20, 4 + Math.random() * 12, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

let _corrugation;
function corrugationTexture() {
  if (_corrugation) return _corrugation;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d');
  for (let x = 0; x < 64; x++) {
    const v = 190 + Math.round(Math.sin((x / 64) * Math.PI * 2 * 6) * 50);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, 0, 1, 8);
  }
  _corrugation = new THREE.CanvasTexture(c);
  _corrugation.colorSpace = THREE.SRGBColorSpace;
  _corrugation.wrapS = _corrugation.wrapT = THREE.RepeatWrapping;
  return _corrugation;
}
