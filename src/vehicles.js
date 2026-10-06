import { DEFAULT_SPEC } from './physics.js';
import { compileCar, measure } from './carkit.js';

// The drivable fleet. Each entry carries:
//   spec    overrides for the handling model (merged over physics.js DEFAULT_SPEC)
//   hitbox  collision boxes in the vehicle frame (half extents + centre)
//   home    where it parks when the arena is built
//   cam     chase-camera scale and hood-camera position
//   build   adds bodywork through the CarModel kit (see carModel.js)
// Vehicle frame: x = left, y = up, z = forward, origin on the ground under the CG.

const sports = {
  id: 'sports',
  name: 'Sports coupe',
  voice: 'sport',
  blurb: 'Quick, grippy and happy to drift.',
  stats: { top: 245, accel: 5.1 },
  color: 0xd7263d,
  length: 4.3,
  width: 1.8,
  spec: {},
  hitbox: [
    { half: [0.92, 0.33, 2.2], at: [0, 0.58, 0] },
    { half: [0.7, 0.26, 1.0], at: [0, 1.15, -0.3] },
  ],
  home: { x: 0, z: -52, heading: 0 },
  cam: { scale: 1, hoodY: 1.42, hoodZ: 0.9 },
  exhaust: [[0.45, 0.4, -2.24], [-0.45, 0.4, -2.24]],
  build({ THREE, box, tapered, add, front, rear, lights }) {
    const len = 4.3;
    const cz = (front + rear) / 2 + 0.05;
    box(1.8, 0.38, len, 'paint', 0, 0.55, cz);
    tapered(1.8, 0.16, len - 0.1, 1.68, len - 0.5, -0.05, 'paint', 0, 0.82, cz);
    tapered(1.0, 0.06, 1.3, 0.8, 1.1, 0, 'paint', 0, 0.92, front + 0.25);
    tapered(1.62, 0.5, 2.0, 1.26, 1.05, -0.12, 'glass', 0, 1.13, cz - 0.25);
    tapered(1.3, 0.04, 1.08, 1.24, 1.0, 0, 'paint', 0, 1.38, cz - 0.37);
    box(1.84, 0.16, 0.18, 'dark', 0, 0.42, cz + len / 2);
    box(1.84, 0.18, 0.18, 'dark', 0, 0.43, cz - len / 2);
    box(1.5, 0.03, len - 0.4, 'dark', 0, 0.35, cz);
    box(0.9, 0.16, 0.02, 'dark', 0, 0.56, cz + len / 2 + 0.005);
    const wingZ = cz - len / 2 + 0.22;
    box(1.7, 0.04, 0.32, 'dark', 0, 1.14, wingZ);
    for (const s of [-1, 1]) box(0.05, 0.24, 0.12, 'dark', s * 0.6, 1.02, wingZ);
    for (const s of [-1, 1]) box(0.18, 0.1, 0.12, 'paint', s * 0.93, 1.0, cz + 0.55);
    for (const s of [-1, 1]) {
      const tip = add(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 12), 'chrome', s * 0.45, 0.4, cz - len / 2 - 0.08);
      tip.rotation.x = Math.PI / 2;
    }
    lights({ frontZ: cz + len / 2, rearZ: cz - len / 2, y: 0.68, headX: 0.62, tailX: 0.6 });
  },
};

const hatch = {
  id: 'hatch',
  name: 'Hatchback',
  voice: 'hatch',
  blurb: 'Light and nimble. Tail-happy with assists off.',
  stats: { top: 178, accel: 7.2 },
  color: 0x2f7bd6,
  length: 3.85,
  width: 1.72,
  suspension: 1.3,
  spec: {
    mass: 1050, inertiaScale: 1.25, cgToFront: 1.1, cgToRear: 1.35, cgHeight: 0.5,
    trackWidth: 1.5, wheelRadius: 0.3, tireGrip: 1.05, maxSteer: 0.62,
    brakeForce: 11500, dragCoef: 0.55, engineBrake: 250,
    boostAccel: 6, torqueScale: 0.5, gearRatios: [3.5, 2.1, 1.45, 1.1, 0.9], finalDrive: 3.9, engineTone: 1.25,
  },
  hitbox: [
    { half: [0.86, 0.28, 1.92], at: [0, 0.6, -0.125] },
    { half: [0.75, 0.28, 1.15], at: [0, 1.12, -0.42] },
  ],
  home: { x: -7, z: -52, heading: 0 },
  cam: { scale: 0.95, hoodY: 1.42, hoodZ: 0.5 },
  exhaust: [[0.5, 0.36, -2.13]],
  wheelWidth: 0.22,
  build({ box, tapered, lights }) {
    const len = 3.85;
    const cz = -0.125;
    box(1.72, 0.52, len, 'paint', 0, 0.58, cz);
    tapered(1.66, 0.56, 2.5, 1.4, 1.9, -0.25, 'glass', 0, 1.12, cz - 0.3);
    box(1.42, 0.05, 1.85, 'paint', 0, 1.42, cz - 0.5);
    tapered(1.7, 0.08, 1.0, 1.55, 0.9, 0, 'paint', 0, 0.88, cz + 1.4);
    box(1.76, 0.18, 0.15, 'dark', 0, 0.38, cz + len / 2);
    box(1.76, 0.18, 0.15, 'dark', 0, 0.38, cz - len / 2);
    box(0.7, 0.12, 0.02, 'dark', 0, 0.62, cz + len / 2 + 0.005);
    box(1.3, 0.05, 0.25, 'dark', 0, 1.42, cz - len / 2 + 0.25); // roof spoiler
    for (const s of [-1, 1]) box(0.16, 0.1, 0.1, 'paint', s * 0.9, 1.0, cz + 0.85);
    lights({ frontZ: cz + len / 2, rearZ: cz - len / 2, y: 0.72, headX: 0.6, tailX: 0.66, tailW: 0.26, h: 0.14 });
  },
};

const pickup = {
  id: 'pickup',
  name: 'Pickup truck',
  voice: 'v8',
  blurb: 'Torquey and heavy. Hits harder than it looks.',
  stats: { top: 197, accel: 6.4 },
  color: 0x2d6a4f,
  length: 5.5,
  width: 1.96,
  suspension: 1.4,
  spec: {
    mass: 2100, inertiaScale: 2.3, cgToFront: 1.6, cgToRear: 1.75, cgHeight: 0.7,
    trackWidth: 1.76, wheelRadius: 0.42, tireGrip: 0.98, maxSteer: 0.56, steerSpeed: 2.0,
    brakeForce: 23000, dragCoef: 1.1, rollingResistance: 20, engineBrake: 600,
    boostAccel: 6, torqueScale: 1.3, gearRatios: [3.5, 2.2, 1.5, 1.15, 0.9], finalDrive: 3.9, engineTone: 0.7,
  },
  hitbox: [
    { half: [0.98, 0.35, 2.75], at: [0, 0.95, -0.075] },
    { half: [0.9, 0.43, 0.95], at: [0, 1.62, 0.275] },
  ],
  home: { x: 7, z: -52, heading: 0 },
  cam: { scale: 1.25, hoodY: 2.05, hoodZ: 0.9 },
  exhaust: [[0.6, 0.62, -2.95], [-0.6, 0.62, -2.95]],
  wheelWidth: 0.32,
  build({ box, tapered, lights }) {
    const cz = -0.075;
    const len = 5.5;
    const frontZ = cz + len / 2;
    const rearZ = cz - len / 2;
    box(1.95, 0.5, len, 'paint', 0, 0.95, cz);
    box(1.6, 0.2, len - 0.5, 'dark', 0, 0.6, cz);
    box(1.9, 0.18, 1.6, 'paint', 0, 1.29, frontZ - 0.8);
    tapered(1.92, 0.85, 1.9, 1.75, 1.6, -0.05, 'glass', 0, 1.62, 0.275);
    box(1.76, 0.06, 1.62, 'paint', 0, 2.06, 0.25);
    // Bed.
    const bedZ = (rearZ + (0.275 - 0.95)) / 2;
    const bedLen = 0.275 - 0.95 - rearZ;
    box(1.9, 0.06, bedLen, 'dark', 0, 1.22, bedZ);
    for (const s of [-1, 1]) box(0.08, 0.45, bedLen, 'paint', s * 0.935, 1.42, bedZ);
    box(1.94, 0.45, 0.08, 'paint', 0, 1.42, rearZ + 0.04);
    box(1.9, 0.45, 0.08, 'paint', 0, 1.42, 0.275 - 0.95);
    // Chrome.
    box(2.0, 0.2, 0.18, 'chrome', 0, 0.78, frontZ + 0.05);
    box(2.0, 0.2, 0.18, 'chrome', 0, 0.78, rearZ - 0.05);
    box(1.3, 0.3, 0.03, 'chrome', 0, 1.12, frontZ + 0.01);
    for (const s of [-1, 1]) box(0.2, 0.14, 0.14, 'chrome', s * 1.02, 1.75, 0.95);
    lights({ frontZ, rearZ, y: 1.12, rearY: 1.42, headX: 0.72, tailX: 0.84, tailW: 0.16, h: 0.16 });
  },
};

const bus = {
  id: 'bus',
  name: 'School bus',
  voice: 'diesel',
  blurb: 'Slow to start, impossible to stop. Built for buildings.',
  stats: { top: 133, accel: 18 },
  color: 0xf2b705,
  trim: 0xf5f1e6,
  length: 10.6,
  width: 2.5,
  suspension: 0.6,
  spec: {
    mass: 9000, inertiaScale: 8, cgToFront: 2.6, cgToRear: 3.2, cgHeight: 1.1,
    trackWidth: 2.1, wheelRadius: 0.5, tireGrip: 0.85, maxSteer: 0.58,
    steerSpeed: 1.5, steerReturn: 2.5, steerSpeedScale: 500,
    brakeForce: 70000, dragCoef: 4, rollingResistance: 90, engineBrake: 2200,
    torqueScale: 1.8, gearRatios: [3.0, 2.0, 1.45, 1.15, 1.0], finalDrive: 7,
    shiftUpRpm: 6000, engineTone: 0.45, boostAccel: 2.8,
  },
  hitbox: [{ half: [1.27, 1.2, 5.3], at: [0, 1.85, -0.3] }],
  home: { x: 22, z: -50, heading: Math.PI / 2 },
  cam: { scale: 1.9, hoodY: 2.7, hoodZ: 4.6 },
  exhaust: [[0.8, 0.7, -5.72], [-0.8, 0.7, -5.72]],
  wheelWidth: 0.36,
  build({ box, lights }) {
    const cz = -0.3;
    const len = 10.6;
    const frontZ = cz + len / 2;
    const rearZ = cz - len / 2;
    box(2.5, 2.3, len, 'paint', 0, 1.85, cz);
    box(2.4, 0.15, len - 0.2, 'trim', 0, 3.07, cz);
    box(2.52, 0.8, 8.2, 'glass', 0, 2.35, cz - 0.5);
    box(2.3, 1.0, 0.04, 'glass', 0, 2.3, frontZ + 0.01);
    box(1.9, 0.7, 0.04, 'glass', 0, 2.4, rearZ - 0.01);
    for (const y of [1.6, 1.3]) box(2.52, 0.06, len + 0.02, 'dark', 0, y, cz);
    box(2.6, 0.3, 0.2, 'dark', 0, 0.75, frontZ + 0.08);
    box(2.6, 0.3, 0.2, 'dark', 0, 0.75, rearZ - 0.08);
    box(0.03, 1.7, 0.9, 'glass', -1.26, 1.6, frontZ - 1.2); // door
    box(0.9, 0.18, 0.03, 'dark', 0, 2.95, frontZ + 0.02); // destination sign
    lights({ frontZ, rearZ, y: 1.1, headX: 0.9, tailX: 1.0, tailW: 0.25, h: 0.2 });
  },
};

// The burner: anything it touches ignites and burns away as glowing voxels
// instead of being knocked over (see `burns` in destruction.js).
const ember = {
  id: 'ember',
  name: 'Ember GT',
  voice: 'ember',
  blurb: 'Does not crash into things. Burns straight through them.',
  stats: { top: 255, accel: 5.4 },
  burns: true,
  color: 0x1d1f24,
  swatch: 0xff6a10, // the body is near-black; lists show its glow colour
  length: 4.5,
  width: 1.9,
  spec: {
    mass: 1400, inertiaScale: 1.4, cgToFront: 1.3, cgToRear: 1.4, cgHeight: 0.42,
    trackWidth: 1.72, wheelRadius: 0.35, tireGrip: 1.12, torqueScale: 1.12, boostAccel: 8,
    engineTone: 0.85,
  },
  hitbox: [
    { half: [0.95, 0.3, 2.25], at: [0, 0.52, -0.05] },
    { half: [0.7, 0.22, 1.1], at: [0, 0.98, -0.25] },
  ],
  home: { x: -14, z: -52, heading: 0 },
  cam: { scale: 1, hoodY: 1.3, hoodZ: 0.9 },
  exhaust: [[0.32, 0.42, -2.36], [-0.32, 0.42, -2.36]],
  wheelWidth: 0.3,
  build({ box, tapered, lights }) {
    const len = 4.5;
    const cz = -0.05;
    const front = cz + len / 2;
    const rear = cz - len / 2;
    // Low wedge body that rises toward the rear.
    box(1.9, 0.3, len, 'paint', 0, 0.48, cz);
    tapered(1.9, 0.2, len - 0.15, 1.6, len - 0.9, -0.3, 'paint', 0, 0.73, cz);
    tapered(1.5, 0.42, 2.0, 1.1, 1.2, -0.25, 'glass', 0, 1.0, cz - 0.15);
    box(1.94, 0.12, 0.6, 'paint', 0, 0.86, rear + 0.3); // rear deck
    // Glowing accents: side blades, front splitter edge, rear light bar.
    for (const sx of [-1, 1]) {
      box(0.03, 0.05, len - 0.9, 'glow', sx * 0.96, 0.5, cz - 0.1);
      box(0.06, 0.22, 0.5, 'glow', sx * 0.94, 0.62, cz - 0.6); // side intake
    }
    box(1.7, 0.03, 0.04, 'glow', 0, 0.36, front + 0.02);
    box(1.6, 0.06, 0.03, 'glow', 0, 0.78, rear - 0.01);
    box(1.92, 0.08, 0.2, 'dark', 0, 0.3, front - 0.05);
    box(1.92, 0.16, 0.18, 'dark', 0, 0.36, rear + 0.05);
    lights({ frontZ: front, rearZ: rear, y: 0.58, headX: 0.68, tailX: 0.62, headW: 0.36, tailW: 0.4, h: 0.06 });
  },
};

// The flamethrower pickup: a pickup with a fuel-tank turret in the bed and
// a nozzle over the cab (see flamethrower.js). `flamethrower.mount` is the
// nozzle tip in the vehicle frame.
const inferno = {
  id: 'inferno',
  name: 'Inferno pickup',
  voice: 'v8',
  blurb: 'A pickup with a flamethrower in the bed. Hold X (or click) to set the world on fire.',
  stats: pickup.stats,
  color: 0x2a2b2f,
  trim: 0xc8321e,
  swatch: 0xff7a1a,
  length: pickup.length,
  width: pickup.width,
  suspension: pickup.suspension,
  spec: pickup.spec,
  hitbox: [...pickup.hitbox, { half: [0.42, 0.32, 0.75], at: [0, 1.95, -1.45] }],
  home: { x: -21, z: -52, heading: 0 },
  cam: { scale: 1.3, hoodY: 2.05, hoodZ: 0.9 },
  exhaust: pickup.exhaust,
  wheelWidth: pickup.wheelWidth,
  flamethrower: { mount: [0, 2.42, 0.95] },
  build(kit) {
    const { THREE, box, add } = kit;
    pickup.build(kit);
    // Fuel tanks lying in the bed.
    for (const sx of [-0.5, 0.5]) {
      const tank = add(new THREE.CylinderGeometry(0.26, 0.26, 1.5, 16), 'trim', sx, 1.52, -2.0);
      tank.rotation.x = Math.PI / 2;
    }
    box(0.08, 0.08, 1.2, 'chrome', 0, 1.55, -1.9); // feed pipe
    // Turret: pedestal, housing, barrel over the cab, glowing nozzle.
    box(0.5, 0.5, 0.5, 'dark', 0, 1.5, -1.3);
    box(0.8, 0.5, 1.2, 'dark', 0, 1.98, -1.4);
    box(0.84, 0.08, 1.24, 'trim', 0, 2.25, -1.4);
    box(0.2, 0.2, 2.2, 'chrome', 0, 2.38, -0.2);
    box(0.3, 0.3, 0.16, 'dark', 0, 2.38, 0.86);
    box(0.2, 0.2, 0.04, 'glow', 0, 2.42, 0.95);
    // Warning stripes on the tailgate.
    for (let i = -2; i <= 2; i++) box(0.12, 0.3, 0.02, 'glow', i * 0.34, 1.42, -2.87);
  },
};

// Motorbikes. The handling model is already a "bicycle" (one tyre force
// per axle), so a bike is a light, narrow vehicle with `bike: true`: the
// model draws two wheels on the centre line, leans into corners and puts a
// rider on top (see carModel.js and riderAndBars below).

/** A rider in leathers, hunched over the bars at `barZ`, sitting at `seatY`. */
function riderAndBars({ THREE, box, add }, { seatY, seatZ, barY, barZ, crouch }) {
  // Handlebars and grips.
  box(0.62, 0.04, 0.04, 'dark', 0, barY, barZ);
  // Legs: thighs along the tank, shins down to the pegs.
  for (const s of [-1, 1]) {
    box(0.13, 0.13, 0.46, 'dark', s * 0.15, seatY + 0.06, seatZ + 0.16).rotation.x = -0.25;
    box(0.12, 0.42, 0.12, 'dark', s * 0.19, seatY - 0.22, seatZ + 0.02).rotation.x = 0.45;
    box(0.13, 0.08, 0.22, 'dark', s * 0.19, seatY - 0.42, seatZ - 0.02);
  }
  // Torso leaning forward, arms to the grips, helmet with a visor.
  const torsoH = 0.56;
  const torso = box(0.38, torsoH, 0.26, 'trim', 0, seatY + 0.08 + torsoH / 2 * Math.cos(crouch), seatZ + torsoH / 2 * Math.sin(crouch));
  torso.rotation.x = crouch;
  const shoulderY = seatY + 0.08 + torsoH * Math.cos(crouch) - 0.06;
  const shoulderZ = seatZ + torsoH * Math.sin(crouch) - 0.02;
  for (const s of [-1, 1]) {
    const dy = barY - shoulderY, dz = barZ - shoulderZ;
    const len = Math.hypot(dy, dz);
    const arm = box(0.09, 0.09, len, 'trim', s * 0.24, (shoulderY + barY) / 2, (shoulderZ + barZ) / 2);
    arm.rotation.x = -Math.atan2(dy, dz);
  }
  const headY = shoulderY + 0.22, headZ = shoulderZ + 0.08;
  add(new THREE.SphereGeometry(0.16, 16, 12), 'paint', 0, headY, headZ);
  box(0.24, 0.08, 0.04, 'glass', 0, headY + 0.01, headZ + 0.15);
}

const streetbike = {
  id: 'streetbike',
  name: 'Street bike',
  voice: 'hatch',
  blurb: 'A sports bike. Tiny, fast and leans hard into corners. Thread it through traffic.',
  color: 0x18b46b,
  trim: 0x23262c,
  swatch: 0x18b46b,
  bike: true,
  length: 2.05,
  width: 0.72,
  suspension: 1,
  spec: {
    mass: 290, inertiaScale: 0.36, cgToFront: 0.72, cgToRear: 0.72, cgHeight: 0.62,
    trackWidth: 0.45, wheelRadius: 0.31, tireGrip: 1.3, rearGripBias: 1.25, handbrakeGrip: 0.5,
    maxSteer: 0.42, steerSpeed: 3, brakeForce: 4300, dragCoef: 0.2, rollingResistance: 3, engineBrake: 70,
    torqueScale: 0.42, gearRatios: [2.9, 2.0, 1.55, 1.25, 1.05, 0.9], finalDrive: 3.7, boostAccel: 8, engineTone: 1.4,
  },
  hitbox: [
    { half: [0.3, 0.38, 1.0], at: [0, 0.62, 0] },
    { half: [0.26, 0.34, 0.36], at: [0, 1.28, -0.05] },
  ],
  home: { x: 11, z: -52, heading: 0 },
  cam: { scale: 0.8, hoodY: 1.45, hoodZ: 0.2 },
  exhaust: [[0.16, 0.62, -0.92]],
  wheelWidth: 0.16,
  build(kit) {
    const { THREE, box, tapered, add, lights } = kit;
    // Engine, frame and swingarm.
    box(0.3, 0.32, 0.44, 'dark', 0, 0.5, 0.05);
    box(0.34, 0.06, 0.95, 'trim', 0, 0.72, 0.02);
    for (const s of [-1, 1]) box(0.05, 0.06, 0.72, 'trim', s * 0.11, 0.36, -0.36).rotation.x = -0.08;
    // Front forks, raked back.
    for (const s of [-1, 1]) box(0.05, 0.62, 0.05, 'chrome', s * 0.1, 0.62, 0.62).rotation.x = -0.42;
    // Tank, fairing, screen, seat and tail.
    tapered(0.36, 0.26, 0.66, 0.26, 0.48, -0.04, 'paint', 0, 0.88, 0.14);
    tapered(0.42, 0.46, 0.44, 0.2, 0.22, 0.08, 'paint', 0, 0.76, 0.6);
    tapered(0.3, 0.2, 0.1, 0.2, 0.06, -0.06, 'glass', 0, 1.08, 0.66);
    box(0.28, 0.08, 0.5, 'dark', 0, 0.88, -0.32);
    tapered(0.3, 0.16, 0.46, 0.1, 0.3, -0.04, 'paint', 0, 0.98, -0.62);
    // Exhaust can under the tail, mudguard over the front wheel.
    const can = add(new THREE.CylinderGeometry(0.07, 0.06, 0.5, 12), 'chrome', 0.16, 0.62, -0.68);
    can.rotation.x = Math.PI / 2 - 0.3;
    box(0.16, 0.03, 0.42, 'paint', 0, 0.66, 0.74);
    riderAndBars(kit, { seatY: 0.92, seatZ: -0.3, barY: 1.0, barZ: 0.48, crouch: 0.75 });
    lights({ frontZ: 0.84, rearZ: -0.85, y: 0.82, headX: 0.06, tailX: 0.06, headW: 0.1, tailW: 0.1, h: 0.07, rearY: 0.98 });
  },
};

const dirtbike = {
  id: 'dirtbike',
  name: 'Dirt bike',
  voice: 'hatch',
  blurb: 'Long-travel trail bike with jumps and air control (Space). Loose at the back, made for ramps.',
  color: 0xf26a1b,
  trim: 0x2b5bd7,
  swatch: 0xf26a1b,
  bike: true,
  aerial: true,
  length: 2.1,
  width: 0.8,
  suspension: 1.5,
  spec: {
    mass: 230, inertiaScale: 0.38, cgToFront: 0.74, cgToRear: 0.74, cgHeight: 0.72,
    trackWidth: 0.45, wheelRadius: 0.36, tireGrip: 1.12, rearGripBias: 1.05, handbrakeGrip: 0.4,
    maxSteer: 0.5, steerSpeed: 3.2, brakeForce: 3200, dragCoef: 0.3, rollingResistance: 4, engineBrake: 60,
    torqueScale: 0.3, gearRatios: [3.0, 2.1, 1.6, 1.3, 1.1], finalDrive: 4.8, boostAccel: 7, engineTone: 1.55,
  },
  hitbox: [
    { half: [0.3, 0.42, 1.02], at: [0, 0.72, 0] },
    { half: [0.26, 0.34, 0.34], at: [0, 1.42, -0.08] },
  ],
  home: { x: 14, z: -52, heading: 0 },
  cam: { scale: 0.82, hoodY: 1.6, hoodZ: 0.2 },
  exhaust: [[0.17, 0.92, -0.8]],
  wheelWidth: 0.15,
  build(kit) {
    const { THREE, box, tapered, add, lights } = kit;
    box(0.26, 0.3, 0.38, 'dark', 0, 0.6, 0.04);
    box(0.08, 0.08, 0.9, 'trim', 0, 0.84, 0.02);
    for (const s of [-1, 1]) box(0.05, 0.06, 0.76, 'chrome', s * 0.11, 0.42, -0.38).rotation.x = -0.12;
    for (const s of [-1, 1]) box(0.06, 0.8, 0.06, 'chrome', s * 0.1, 0.74, 0.62).rotation.x = -0.4;
    // Slim tank and side panels, a long flat seat, plastics front and back.
    tapered(0.34, 0.22, 0.5, 0.24, 0.36, 0, 'paint', 0, 0.98, 0.22);
    for (const s of [-1, 1]) box(0.03, 0.26, 0.42, 'paint', s * 0.17, 0.88, -0.22);
    box(0.24, 0.08, 0.84, 'dark', 0, 1.06, -0.18);
    tapered(0.22, 0.04, 0.6, 0.18, 0.5, 0.06, 'paint', 0, 1.0, -0.72);
    tapered(0.22, 0.04, 0.56, 0.16, 0.42, 0.08, 'paint', 0, 1.02, 0.84);
    // Number plate on the front, high pipe out the back.
    box(0.3, 0.26, 0.03, 'trim', 0, 1.14, 0.78).rotation.x = -0.35;
    const pipe = add(new THREE.CylinderGeometry(0.06, 0.06, 0.52, 12), 'chrome', 0.17, 0.86, -0.56);
    pipe.rotation.x = Math.PI / 2 - 0.45;
    riderAndBars(kit, { seatY: 1.08, seatZ: -0.22, barY: 1.24, barZ: 0.52, crouch: 0.42 });
    lights({ frontZ: 0.82, rearZ: -1.0, y: 1.0, headX: 0.05, tailX: 0.05, headW: 0.09, tailW: 0.08, h: 0.06, rearY: 1.02 });
  },
};

// Fill in every handling value so models and parked bodies can read them too.
const BUILT = [sports, hatch, pickup, bus, ember, inferno, streetbike, dirtbike].map((v) => ({ ...v, spec: { ...DEFAULT_SPEC, ...v.spec, body: bodyBox(v.hitbox) } }));
// The bikes' numbers are measured (the cars' were tuned by hand).
for (const v of BUILT) v.stats ||= measure(v.spec);

// The Striker: the car football car (everyone drives it there), also a
// normal car everywhere else. It's built with the custom car kit (see
// carkit.js) like a player's design; its `aerial` flag gives it jumps,
// double jumps, flips and air control.
export const STRIKER_DESIGN = {
  id: 'striker', name: 'Striker', style: 'striker',
  color: 0xe9ecef, trim: 0x16181d, accent: 0x38d0ff,
  size: { length: 0.5, width: 0.5, height: 0.35, ride: 0.55, wheels: 0.55 },
  tune: { power: 0.6, weight: 0.35, grip: 0.65, balance: 0.45, boost: 0.75 },
  engine: 'sport', ability: 'none', parts: ['spoiler', 'stripes'], aerial: true,
};
const striker = {
  ...compileCar(STRIKER_DESIGN, { x: -28, z: -52, heading: 0 }),
  custom: false,
  blurb: 'Jumps, double jumps and flips; steer it in the air. The car football car.',
};

export const VEHICLES = [...BUILT, striker];

/** Size of a vehicle's body from its hitbox, for landings and tumbling. */
function bodyBox(hitbox) {
  let halfW = 0, minZ = Infinity, maxZ = -Infinity, top = 0;
  for (const h of hitbox) {
    halfW = Math.max(halfW, h.half[0]);
    minZ = Math.min(minZ, h.at[2] - h.half[2]);
    maxZ = Math.max(maxZ, h.at[2] + h.half[2]);
    top = Math.max(top, h.at[1] + h.half[1]);
  }
  return { halfW, halfL: (maxZ - minZ) / 2, top };
}
