import { DEFAULT_SPEC } from './physics.js';

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
  blurb: 'Does not crash into things. Burns straight through them.',
  stats: { top: 255, accel: 5.4 },
  burns: true,
  color: 0x1d1f24,
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

// Fill in every handling value so models and parked bodies can read them too.
export const VEHICLES = [sports, hatch, pickup, bus, ember].map((v) => ({ ...v, spec: { ...DEFAULT_SPEC, ...v.spec } }));
