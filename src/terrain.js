import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// Ramps and jumps. Each ramp is a solid block whose top follows a height
// profile along its length; its back and sides are vertical walls.
// The car's handling model queries `heightAt` directly (fast, exact), while
// Rapier gets the same shape as a fixed trimesh so debris and parked cars
// slide off it too.
//
// Ramp frame: u runs along the ramp (0 = entry, length = far end) in the
// direction of `heading`; v runs across it (-width/2 .. width/2).

export const PROFILES = {
  /** Curved launch kicker: steepest at the lip, then a vertical drop. */
  kicker: (H, L) => (u) => H * Math.pow(u / L, 1.5),
  /** Straight wedge. */
  wedge: (H, L) => (u) => (H * u) / L,
  /** Down-slope for landing (high end first). */
  landing: (H, L) => (u) => H * (1 - u / L),
  /** Up, flat top, down. `parts` = [up, flat, down] lengths. */
  table: (H, L, parts) => (u) => {
    const [a, b] = parts;
    if (u < a) return (H * u) / a;
    if (u < a + b) return H;
    return H * (1 - (u - a - b) / (L - a - b));
  },
};

export class Terrain {
  constructor() {
    this.ramps = [];
    this.meshes = [];
  }

  /**
   * @param {object} r  { x, z, heading, length, width, height, profile, parts? }
   *   (x, z) is the entry edge centre; the ramp extends `length` along `heading`.
   */
  addRamp(r) {
    const ramp = { ...r };
    ramp.h = PROFILES[r.profile](r.height, r.length, r.parts);
    ramp.sin = Math.sin(r.heading);
    ramp.cos = Math.cos(r.heading);
    // Bounding circle for a cheap early-out.
    ramp.cx = r.x + ramp.sin * (r.length / 2);
    ramp.cz = r.z + ramp.cos * (r.length / 2);
    ramp.radius = Math.hypot(r.length / 2, r.width / 2) + 0.5;
    this.ramps.push(ramp);
    return ramp;
  }

  /** Ground height at a world point (0 on the flat lot). */
  heightAt(x, z) {
    let h = 0;
    for (const r of this.ramps) {
      const dx = x - r.cx;
      const dz = z - r.cz;
      if (dx * dx + dz * dz > r.radius * r.radius) continue;
      const ex = x - r.x;
      const ez = z - r.z;
      const u = ex * r.sin + ez * r.cos;
      const v = ex * r.cos - ez * r.sin;
      if (u < 0 || u > r.length || Math.abs(v) > r.width / 2) continue;
      h = Math.max(h, r.h(u));
    }
    return h;
  }

  /** Build the render meshes (once per scene). */
  buildMeshes(scene) {
    const top = new THREE.MeshStandardMaterial({ map: rampTexture(), roughness: 0.85 });
    const side = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.9 });
    for (const r of this.ramps) {
      const geo = rampGeometry(r);
      const mesh = new THREE.Mesh(geo, [top, side]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /**
   * Add the ramps to a (fresh) Rapier world. Each ramp is a row of convex
   * slices (one per profile segment): far more robust than a triangle mesh,
   * which lets small objects slip through its seams.
   */
  addColliders(world) {
    for (const r of this.ramps) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const w = r.width / 2;
      for (let i = 0; i < SEGMENTS; i++) {
        const u0 = (i / SEGMENTS) * r.length;
        const u1 = ((i + 1) / SEGMENTS) * r.length;
        const h0 = Math.max(0.02, r.h(u0));
        const h1 = Math.max(0.02, r.h(u1));
        const pts = [];
        for (const [u, h] of [[u0, h0], [u1, h1]]) {
          for (const v of [-w, w]) {
            const x = r.x + r.sin * u + r.cos * v;
            const z = r.z + r.cos * u - r.sin * v;
            pts.push(x, 0, z, x, h, z);
          }
        }
        const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
        if (desc) world.createCollider(desc.setFriction(0.8), body);
      }
    }
  }
}

const SEGMENTS = 24;

/**
 * Closed solid: a top surface sampled along the profile, two side walls,
 * a back wall and a bottom. Material group 0 = top, 1 = walls.
 */
function rampGeometry(r) {
  const w = r.width / 2;
  const pts = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const u = (i / SEGMENTS) * r.length;
    pts.push([u, Math.max(0.001, r.h(u))]);
  }
  const positions = [];
  const uvs = [];
  const indices = [];
  const groups = [];
  const toWorld = (u, y, v) => [r.x + r.sin * u + r.cos * v, y, r.z + r.cos * u - r.sin * v];
  const pushQuad = (a, b, c, d, uvQuad) => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(...p);
    uvs.push(...(uvQuad || [0, 0, 1, 0, 1, 1, 0, 1]));
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Top surface (group 0).
  let start = indices.length;
  for (let i = 0; i < SEGMENTS; i++) {
    const [u0, h0] = pts[i];
    const [u1, h1] = pts[i + 1];
    const t0 = u0 / 4, t1 = u1 / 4;
    pushQuad(toWorld(u0, h0, w), toWorld(u0, h0, -w), toWorld(u1, h1, -w), toWorld(u1, h1, w),
      [0, t0, r.width / 4, t0, r.width / 4, t1, 0, t1]);
  }
  groups.push([start, indices.length - start, 0]);

  // Walls and bottom (group 1).
  start = indices.length;
  for (let i = 0; i < SEGMENTS; i++) {
    const [u0, h0] = pts[i];
    const [u1, h1] = pts[i + 1];
    // Left (v = +w) and right (v = -w) sides.
    pushQuad(toWorld(u0, 0, w), toWorld(u0, h0, w), toWorld(u1, h1, w), toWorld(u1, 0, w));
    pushQuad(toWorld(u1, 0, -w), toWorld(u1, h1, -w), toWorld(u0, h0, -w), toWorld(u0, 0, -w));
  }
  const [uEnd, hEnd] = pts[SEGMENTS];
  const [, hStart] = pts[0];
  pushQuad(toWorld(uEnd, 0, w), toWorld(uEnd, hEnd, w), toWorld(uEnd, hEnd, -w), toWorld(uEnd, 0, -w)); // far wall
  pushQuad(toWorld(0, 0, -w), toWorld(0, hStart, -w), toWorld(0, hStart, w), toWorld(0, 0, w)); // entry lip
  pushQuad(toWorld(0, 0, w), toWorld(uEnd, 0, w), toWorld(uEnd, 0, -w), toWorld(0, 0, -w)); // bottom
  groups.push([start, indices.length - start, 1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  for (const [s, c, m] of groups) geo.addGroup(s, c, m);
  geo.computeVertexNormals();
  return geo;
}

/** Concrete ramp surface with hazard chevrons, tiling every 4 m. */
let _rampTex = null;
function rampTexture() {
  if (_rampTex) return _rampTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#9a968d';
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // Yellow chevrons pointing up the ramp.
  g.strokeStyle = 'rgba(242, 194, 48, 0.9)';
  g.lineWidth = 18;
  g.beginPath();
  g.moveTo(40, 170); g.lineTo(128, 90); g.lineTo(216, 170);
  g.stroke();
  _rampTex = new THREE.CanvasTexture(c);
  _rampTex.wrapS = _rampTex.wrapT = THREE.RepeatWrapping;
  _rampTex.colorSpace = THREE.SRGBColorSpace;
  return _rampTex;
}

/** The arena's ramps. Positions are chosen to stay clear of other objects. */
export function arenaRamps(terrain) {
  // Straight off the start line, aimed at the big brick wall.
  terrain.addRamp({ x: 0, z: -42, heading: 0, length: 8, width: 5, height: 1.6, profile: 'kicker' });
  // Side kickers: one flies into a crate pyramid, one over the low wall.
  terrain.addRamp({ x: -11, z: -12, heading: -Math.PI / 2, length: 7, width: 5, height: 1.4, profile: 'kicker' });
  terrain.addRamp({ x: 22, z: 6, heading: Math.PI / 2, length: 7, width: 5, height: 1.5, profile: 'kicker' });
  // Gap jump on the east side: launch, 12 m gap, landing ramp.
  terrain.addRamp({ x: 66, z: 24, heading: 0, length: 7, width: 6, height: 1.6, profile: 'kicker' });
  terrain.addRamp({ x: 66, z: 43, heading: 0, length: 16, width: 7, height: 2, profile: 'landing' });
  // Tabletop across the north.
  terrain.addRamp({ x: -12, z: 66, heading: Math.PI / 2, length: 22, width: 7, height: 2.2, profile: 'table', parts: [7, 8] });
  // Mega ramp in the west, aimed at the container yard.
  terrain.addRamp({ x: -64, z: 66, heading: Math.atan2(-15, -62), length: 16, width: 7, height: 4.5, profile: 'kicker' });
  // Outer districts: a big kicker aimed into the downtown blocks...
  terrain.addRamp({ x: 123, z: 22, heading: 0, length: 10, width: 6, height: 2.4, profile: 'kicker' });
  // ...and the south-east ramp park: a launch kicker and a long tabletop.
  terrain.addRamp({ x: 118, z: -122, heading: 0, length: 8, width: 6, height: 1.8, profile: 'kicker' });
  terrain.addRamp({ x: 132, z: -62, heading: -Math.PI / 2, length: 24, width: 7, height: 2.4, profile: 'table', parts: [7, 9] });
}
