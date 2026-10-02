// Car-to-car collisions, top-down. Every car is an oriented rectangle the
// size of its footprint; overlaps are found with the separating axis test,
// and resolved with a rigid-body impulse (mass, yaw inertia, restitution and
// friction), so a hatchback bounces off a bus while the bus barely moves.
//
// Bodies passed in are plain objects:
//   { x, z, y, heading, velX, velZ, yawRate, mass, inertia, fp }
// where fp = footprint(def). Positions are the car's CG; fp.offZ is the
// footprint centre's offset from the CG along the car.

const RESTITUTION = 0.25;
const FRICTION = 0.35;

/** Rectangle and height span of a vehicle, from its hitbox. */
export function footprint(def) {
  let minZ = Infinity, maxZ = -Infinity, top = 0, halfW = 0;
  for (const h of def.hitbox) {
    minZ = Math.min(minZ, h.at[2] - h.half[2]);
    maxZ = Math.max(maxZ, h.at[2] + h.half[2]);
    top = Math.max(top, h.at[1] + h.half[1]);
    halfW = Math.max(halfW, h.half[0]);
  }
  return { halfL: (maxZ - minZ) / 2, halfW, offZ: (maxZ + minZ) / 2, top };
}

/** Yaw inertia of a rectangle footprint. */
export function yawInertia(mass, fp) {
  return (mass * ((fp.halfL * 2) ** 2 + (fp.halfW * 2) ** 2)) / 12;
}

function box(b) {
  const ux = Math.sin(b.heading), uz = Math.cos(b.heading); // forward
  const vx = Math.cos(b.heading), vz = -Math.sin(b.heading); // left
  const cx = b.x + ux * b.fp.offZ;
  const cz = b.z + uz * b.fp.offZ;
  return { cx, cz, ux, uz, vx, vz, hl: b.fp.halfL, hw: b.fp.halfW };
}

function corners(o) {
  const out = [];
  for (const a of [-1, 1]) for (const c of [-1, 1]) {
    out.push({ x: o.cx + o.ux * o.hl * a + o.vx * o.hw * c, z: o.cz + o.uz * o.hl * a + o.vz * o.hw * c });
  }
  return out;
}

function inside(o, p, margin = 0.02) {
  const dx = p.x - o.cx, dz = p.z - o.cz;
  return Math.abs(dx * o.ux + dz * o.uz) <= o.hl + margin && Math.abs(dx * o.vx + dz * o.vz) <= o.hw + margin;
}

/**
 * Overlap test. Returns { nx, nz, depth, px, pz } with the normal pointing
 * from B to A, or null when the cars don't touch.
 */
export function overlap(A, B) {
  // Different heights (one flying over the other) don't collide.
  const aLo = A.y || 0, bLo = B.y || 0;
  if (aLo > bLo + B.fp.top || bLo > aLo + A.fp.top) return null;
  const a = box(A), b = box(B);
  const dx = a.cx - b.cx, dz = a.cz - b.cz;
  let best = Infinity, nx = 0, nz = 0;
  for (const [ax, az] of [[a.ux, a.uz], [a.vx, a.vz], [b.ux, b.uz], [b.vx, b.vz]]) {
    const ra = a.hl * Math.abs(a.ux * ax + a.uz * az) + a.hw * Math.abs(a.vx * ax + a.vz * az);
    const rb = b.hl * Math.abs(b.ux * ax + b.uz * az) + b.hw * Math.abs(b.vx * ax + b.vz * az);
    const d = dx * ax + dz * az;
    const o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best) {
      best = o;
      const s = d >= 0 ? 1 : -1;
      nx = ax * s;
      nz = az * s;
    }
  }
  // Contact point: corners of one car inside the other, averaged.
  let pts = corners(a).filter((p) => inside(b, p));
  if (!pts.length) pts = corners(b).filter((p) => inside(a, p));
  const px = pts.length ? pts.reduce((s, p) => s + p.x, 0) / pts.length : (a.cx + b.cx) / 2;
  const pz = pts.length ? pts.reduce((s, p) => s + p.z, 0) / pts.length : (a.cz + b.cz) / 2;
  return { nx, nz, depth: best, px, pz };
}

/**
 * Impulse that resolves a contact between A and B (B may be immovable to
 * this caller, but its mass still counts). Returns { jx, jz, speed } where
 * (jx, jz) is the impulse on A (B gets the opposite), applied at the
 * contact point, and speed is the closing speed; null if already separating.
 */
export function contactImpulse(A, B, c) {
  const rax = c.px - A.x, raz = c.pz - A.z;
  const rbx = c.px - B.x, rbz = c.pz - B.z;
  // Velocity of each car at the contact point (yaw spin adds w x r).
  const vax = A.velX + A.yawRate * raz, vaz = A.velZ - A.yawRate * rax;
  const vbx = B.velX + B.yawRate * rbz, vbz = B.velZ - B.yawRate * rbx;
  const rvx = vax - vbx, rvz = vaz - vbz;
  const vn = rvx * c.nx + rvz * c.nz;
  if (vn >= 0) return null;

  const k = (rx, rz, nx, nz) => rz * nx - rx * nz; // yaw torque arm
  const kaN = k(rax, raz, c.nx, c.nz), kbN = k(rbx, rbz, c.nx, c.nz);
  const denomN = 1 / A.mass + 1 / B.mass + (kaN * kaN) / A.inertia + (kbN * kbN) / B.inertia;
  const jn = (-(1 + RESTITUTION) * vn) / denomN;

  // Friction along the contact tangent (gives glancing hits their spin).
  let tx = rvx - vn * c.nx, tz = rvz - vn * c.nz;
  const tl = Math.hypot(tx, tz);
  let jt = 0;
  if (tl > 1e-4) {
    tx /= tl; tz /= tl;
    const kaT = k(rax, raz, tx, tz), kbT = k(rbx, rbz, tx, tz);
    const denomT = 1 / A.mass + 1 / B.mass + (kaT * kaT) / A.inertia + (kbT * kbT) / B.inertia;
    jt = Math.max(-FRICTION * jn, Math.min(FRICTION * jn, -tl / denomT));
  }
  return { jx: c.nx * jn + tx * jt, jz: c.nz * jn + tz * jt, speed: -vn };
}

/** Apply an impulse (jx, jz) at a point to one of our plain car states. */
export function applyToCar(car, mass, inertia, jx, jz, px, pz) {
  const rx = px - car.x, rz = pz - car.z;
  car.velX += jx / mass;
  car.velZ += jz / mass;
  car.yawRate += Math.max(-4, Math.min(4, (rz * jx - rx * jz) / inertia));
}
