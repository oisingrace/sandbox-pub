import { CarPhysics, DEFAULT_SPEC } from './physics.js';

// Custom cars. A custom car is plain data (a "design"): a body style, size,
// colours, bolt-on parts, an engine sound, a few tuning sliders and an
// optional special ability. `compileCar` turns a design into a complete
// vehicle definition, the same shape as the hand-built ones in vehicles.js:
// handling spec, hitbox, camera, exhaust, stats and a body builder for
// CarModel. Designs are JSON-safe, so they can be saved, shared as a code
// and sent to other players; every value is clamped on the way in.
//
// Design shape (every field optional; see DEFAULT_DESIGN):
//   { id, name, style, color, trim, accent,
//     size:   { length, width, height, ride, wheels }   // 0..1 sliders around the style's base
//     tune:   { power, weight, grip, balance, boost }  // 0..1, 0.5 is neutral
//     engine: 'sport' | 'hatch' | 'v8' | 'diesel' | 'ember',
//     ability: 'none' | 'burner',
//     weapon: 'mg' | 'rockets' | 'salvo' | 'flamethrower' | 'mines',  // the roof-mounted weapon
//     parts:  ['spoiler', 'scoop', 'bullbar', 'lightbar', 'stacks', 'stripes', 'cage'],
//     aerial: true | false }  // jumps, double jumps, flips and air control (Space)

export const STYLES = {
  coupe: { label: 'Coupe', length: 4.3, width: 1.82, roof: 1.3, body: 0.42, ride: 0.2, cabin: [0.24, 0.62], taper: 0.55, wheel: 0.34, engine: 'sport', power: 1 },
  hatch: { label: 'Hatchback', length: 3.9, width: 1.74, roof: 1.45, body: 0.44, ride: 0.2, cabin: [0.06, 0.64], taper: 0.85, wheel: 0.32, engine: 'hatch', power: 0.7 },
  muscle: { label: 'Muscle', length: 4.8, width: 1.92, roof: 1.33, body: 0.52, ride: 0.2, cabin: [0.24, 0.58], taper: 0.62, wheel: 0.36, engine: 'v8', power: 1.35 },
  pickup: { label: 'Pickup', length: 5.4, width: 1.96, roof: 1.95, body: 0.52, ride: 0.42, cabin: [0.45, 0.72], taper: 0.9, wheel: 0.42, engine: 'v8', bed: true, power: 1.15 },
  van: { label: 'Van', length: 5.0, width: 1.98, roof: 2.15, body: 0.6, ride: 0.3, cabin: [0.02, 0.84], taper: 0.92, wheel: 0.36, engine: 'diesel', power: 0.85 },
  striker: { label: 'Striker', length: 3.9, width: 1.96, roof: 1.24, body: 0.42, ride: 0.26, cabin: [0.16, 0.56], taper: 0.65, wheel: 0.38, engine: 'sport', power: 1.15 },
  buggy: { label: 'Buggy', length: 3.6, width: 1.9, roof: 1.6, body: 0.34, ride: 0.42, cabin: [0.28, 0.66], taper: 1, wheel: 0.44, engine: 'sport', open: true, power: 0.75 },
};
export const ENGINES = { sport: 'Sports', hatch: 'Four-pot', v8: 'V8', diesel: 'Diesel', ember: 'Turbine' };
export const ABILITIES = { none: 'None', burner: 'Burner (burns what it hits)' };
/** Roof weapons a custom car can carry (fired with X / click; see weapons.js). */
export const WEAPON_MOUNTS = { mg: 'Machine gun', rockets: 'Rockets', salvo: 'Rocket salvo', flamethrower: 'Flamethrower', mines: 'Mines' };
export const PARTS = {
  spoiler: 'Rear wing', scoop: 'Hood scoop', bullbar: 'Bull bar', lightbar: 'Roof lights',
  stacks: 'Exhaust stacks', stripes: 'Racing stripes', cage: 'Roll cage',
};
export const SIZE_KEYS = { length: 'Length', width: 'Width', height: 'Roof height', ride: 'Ride height', wheels: 'Wheel size' };
export const TUNE_KEYS = {
  power: ['Power', 'More torque: quicker everywhere'],
  weight: ['Weight', 'Heavier hits harder but is slower'],
  grip: ['Grip', 'Tyre grip'],
  balance: ['Balance', 'Low: stable and planted · High: loose, tail-happy'],
  boost: ['Boost', 'Rocket boost strength'],
};

export const DEFAULT_DESIGN = {
  name: 'My car', style: 'coupe', color: 0xe8b21c, trim: 0x1c1c22, accent: 0xff6a10,
  size: { length: 0.5, width: 0.5, height: 0.5, ride: 0.5, wheels: 0.5 },
  tune: { power: 0.5, weight: 0.5, grip: 0.5, balance: 0.5, boost: 0.5 },
  engine: null, ability: 'none', weapon: 'mg', parts: ['stripes'], aerial: false,
};

const clamp01 = (v, d = 0.5) => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : d);
const colour = (v, d) => (Number.isFinite(+v) ? Math.max(0, Math.min(0xffffff, Math.round(+v))) : d);
const lerp = (a, b, t) => a + (b - a) * t;

/** Make any value into a valid design (unknown fields dropped, numbers clamped). */
export function cleanDesign(raw = {}) {
  const d = DEFAULT_DESIGN;
  const style = STYLES[raw.style] ? raw.style : d.style;
  const out = {
    id: typeof raw.id === 'string' && /^[a-z0-9-]{3,24}$/.test(raw.id) ? raw.id : newDesignId(),
    name: String(raw.name ?? d.name).replace(/\s+/g, ' ').trim().slice(0, 22) || d.name,
    style,
    color: colour(raw.color, d.color),
    trim: colour(raw.trim, d.trim),
    accent: colour(raw.accent, d.accent),
    size: {},
    tune: {},
    engine: ENGINES[raw.engine] ? raw.engine : STYLES[style].engine,
    ability: ABILITIES[raw.ability] ? raw.ability : 'none',
    // Older designs had the flamethrower as a special ability.
    weapon: WEAPON_MOUNTS[raw.weapon] ? raw.weapon : raw.ability === 'flamethrower' ? 'flamethrower' : 'mg',
    parts: [...new Set((Array.isArray(raw.parts) ? raw.parts : d.parts).filter((p) => PARTS[p]))],
    aerial: !!raw.aerial,
  };
  for (const k of Object.keys(SIZE_KEYS)) out.size[k] = clamp01(raw.size?.[k]);
  for (const k of Object.keys(TUNE_KEYS)) out.tune[k] = clamp01(raw.tune?.[k]);
  return out;
}

export function newDesignId() {
  return `c-${Math.random().toString(36).slice(2, 9)}`;
}

/** Share codes: the design as compact URL-safe base64 JSON. */
export function designToCode(design) {
  const json = JSON.stringify(cleanDesign(design));
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function codeToDesign(code) {
  const b64 = String(code).trim().replace(/-/g, '+').replace(/_/g, '/');
  const json = decodeURIComponent(escape(atob(b64)));
  const d = cleanDesign(JSON.parse(json));
  d.id = newDesignId(); // an imported copy is its own car
  return d;
}

/** Physical layout of a design, in metres (shared by the body, hitbox and handling). */
function layout(d) {
  const st = STYLES[d.style];
  const L = st.length * lerp(0.85, 1.18, d.size.length);
  const W = st.width * lerp(0.9, 1.1, d.size.width);
  const ride = st.ride * lerp(0.6, 1.6, d.size.ride);
  const body = st.body;
  const roof = ride + body + (st.roof - st.ride - st.body) * lerp(0.82, 1.22, d.size.height);
  const wheel = st.wheel * lerp(0.82, 1.25, d.size.wheels);
  const z0 = -L / 2 + st.cabin[0] * L;
  const z1 = -L / 2 + st.cabin[1] * L;
  return { st, L, W, ride, body, roof, wheel, z0, z1, deck: ride + body + 0.12 };
}

/**
 * Turn a design into a full vehicle definition (see vehicles.js). Pass
 * `withStats = false` to skip measuring top speed and 0-100 (a few ms).
 */
export function compileCar(raw, home = { x: 0, z: -64, heading: 0 }, withStats = true) {
  const d = cleanDesign(raw);
  const g = layout(d);
  const { st, L, W, ride, body, roof, wheel, z0, z1 } = g;
  const t = d.tune;

  // Handling. Mass from size, then the weight slider.
  const volume = L * W * (roof - ride);
  const baseMass = volume * (st.open ? 105 : 125);
  const mass = Math.round(baseMass * lerp(0.75, 1.4, t.weight) / 10) * 10;
  const cgToFront = L * 0.29;
  const cgToRear = L * 0.31;
  const spec = {
    ...DEFAULT_SPEC,
    mass,
    inertiaScale: ((L * L + W * W) / 12) * 0.95,
    cgToFront, cgToRear,
    cgHeight: ride + body * 0.55,
    trackWidth: W - 0.14,
    wheelRadius: wheel,
    tireGrip: lerp(0.88, 1.35, t.grip),
    rearGripBias: lerp(1.45, 1.05, t.balance),
    maxSteer: Math.max(0.45, 0.66 - L * 0.012),
    steerSpeed: lerp(2.0, 2.8, 1 - t.weight),
    brakeForce: mass * 11.5,
    dragCoef: 0.32 * W * (roof - ride * 0.5) * (st.open ? 1.3 : 1),
    rollingResistance: 10 + mass / 160,
    engineBrake: 250 + mass * 0.12,
    // Each style has its own engine, sized to the car's size (not the
    // weight slider, so extra weight costs speed), then the power slider.
    torqueScale: st.power * (baseMass / 1300) ** 0.55 * lerp(0.45, 2.0, t.power),
    boostAccel: lerp(4, 11, t.boost),
    engineTone: lerp(1.15, 0.75, Math.min(1, mass / 3000)),
  };
  spec.body = { halfW: W / 2, halfL: L / 2, top: roof };

  const flamer = d.weapon === 'flamethrower';
  const cabH = roof - g.deck;
  const hitbox = [
    { half: [W / 2, (body + 0.12) / 2, L / 2], at: [0, ride + (body + 0.12) / 2, 0] },
    { half: [(W - 0.3) / 2, cabH / 2, (z1 - z0) / 2], at: [0, g.deck + cabH / 2, (z0 + z1) / 2] },
  ];
  const turret = { z: st.bed ? z0 - 0.55 : (z0 + z1) / 2, y: roof + (st.bed ? -0.1 : 0.1) };
  if (flamer) hitbox.push({ half: [0.38, 0.28, 0.6], at: [0, turret.y + 0.25, turret.z] });

  const stacks = d.parts.includes('stacks');
  const def = {
    id: d.id,
    custom: true,
    design: d,
    name: d.name,
    voice: d.engine,
    blurb: `Custom ${st.label.toLowerCase()} with ${[WEAPON_MOUNTS[d.weapon].toLowerCase(), d.ability !== 'none' && ABILITIES[d.ability].split(' (')[0].toLowerCase()].filter(Boolean).join(' and ')}${d.aerial ? ', jumps and flips' : ''}.`,
    color: d.color,
    trim: d.trim,
    accent: d.accent,
    swatch: d.color,
    length: L,
    width: W,
    suspension: st.open ? 1.3 : roof > 1.8 ? 1.25 : 1,
    burns: d.ability === 'burner',
    aerial: d.aerial,
    flamethrower: flamer ? { mount: [0, turret.y + 0.32, turret.z + 1.15] } : undefined,
    // Other weapons: a turret on the roof (built by CarModel, fired by versus.js).
    weapon: flamer ? undefined : d.weapon,
    turretMount: [0, turret.y - 0.05, turret.z],
    spec,
    hitbox,
    home,
    cam: { scale: Math.max(0.9, Math.min(1.6, (L / 4.3) * 0.6 + (roof / 1.35) * 0.4)), hoodY: roof - 0.12, hoodZ: z1 - 0.25 },
    exhaust: stacks
      ? [[W / 2 - 0.2, roof + 0.25, z0 - 0.15], [-(W / 2 - 0.2), roof + 0.25, z0 - 0.15]]
      : [[W * 0.25, ride + 0.18, -L / 2 - 0.04], [-W * 0.25, ride + 0.18, -L / 2 - 0.04]],
    wheelWidth: 0.22 + W * 0.04 + (st.open ? 0.08 : 0),
    build: (kit) => buildBody(kit, d, g, turret),
  };
  def.stats = withStats ? measure(spec) : null;
  return def;
}

/** The bodywork, from boxes and tapered boxes (CarModel merges them by material). */
function buildBody({ THREE, box, tapered, add, lights }, d, g, turret) {
  const { st, L, W, ride, body, roof, z0, z1 } = g;
  const front = L / 2, rear = -L / 2;
  const deck = g.deck;
  const cabH = roof - deck;
  const parts = new Set(d.parts);

  // Lower body and the shoulder line.
  box(W, body, L, 'paint', 0, ride + body / 2, 0);
  tapered(W, 0.12, L - 0.08, W - 0.1, L - 0.35, 0, 'paint', 0, ride + body + 0.06, 0);
  // Bumpers and sills.
  box(W + 0.04, 0.18, 0.16, 'dark', 0, ride + 0.1, front);
  box(W + 0.04, 0.18, 0.16, 'dark', 0, ride + 0.1, rear);
  box(W - 0.3, 0.04, L - 0.5, 'dark', 0, ride - 0.01, 0);

  if (st.open) {
    // Buggy: open tub, seats and a tubular cage instead of a cabin.
    box(W - 0.3, 0.3, z1 - z0, 'dark', 0, deck + 0.05, (z0 + z1) / 2);
    for (const sx of [-0.35, 0.35]) box(0.42, 0.5, 0.12, 'dark', sx, deck + 0.3, z0 + 0.25);
    cage({ box }, W - 0.25, z0, z1, deck, roof);
  } else {
    // Cabin: glass greenhouse plus a roof panel.
    const len = z1 - z0;
    const topLen = len * st.taper * 0.85;
    const lean = st.bed ? -0.02 : (len - topLen) * -0.18; // windscreen raked more than the back
    tapered(W - 0.14, cabH - 0.04, len, W - 0.42, topLen, lean, 'glass', 0, deck + (cabH - 0.04) / 2, (z0 + z1) / 2);
    box(W - 0.4, 0.05, topLen * 0.96, 'paint', 0, roof - 0.02, (z0 + z1) / 2 + lean);
    // Pillars between the windows read as a car, not a block of glass.
    for (const sx of [-1, 1]) box(0.04, cabH * 0.75, 0.1, 'paint', sx * (W / 2 - 0.12), deck + cabH * 0.4, (z0 + z1) / 2);
  }
  if (st.bed) {
    // Pickup bed behind the cab.
    const bedLen = z0 - rear - 0.1;
    const bz = rear + 0.05 + bedLen / 2;
    box(W - 0.08, 0.06, bedLen, 'dark', 0, deck + 0.02, bz);
    for (const sx of [-1, 1]) box(0.08, 0.42, bedLen, 'paint', sx * (W / 2 - 0.04), deck + 0.2, bz);
    box(W, 0.42, 0.08, 'paint', 0, deck + 0.2, rear + 0.04);
  }

  // Bolt-ons.
  if (parts.has('stripes')) {
    for (const sx of [-0.22, 0.22]) {
      box(0.16, 0.01, L - 0.5, 'trim', sx * (W / 1.8), ride + body + 0.125, 0);
      if (!st.open) box(0.16, 0.01, (z1 - z0) * st.taper * 0.8, 'trim', sx * (W / 1.8), roof + 0.006, (z0 + z1) / 2);
    }
  }
  if (parts.has('spoiler')) {
    const wz = rear + 0.25;
    const wy = st.bed ? deck + 0.75 : deck + 0.35;
    box(W * 0.92, 0.05, 0.4, 'trim', 0, wy, wz);
    for (const sx of [-1, 1]) {
      box(0.05, wy - deck, 0.12, 'dark', sx * W * 0.3, deck + (wy - deck) / 2, wz);
      box(0.04, 0.2, 0.42, 'trim', sx * W * 0.46, wy + 0.06, wz);
    }
  }
  if (parts.has('scoop')) {
    tapered(0.62, 0.18, 0.9, 0.5, 0.6, -0.08, 'trim', 0, ride + body + 0.2, front - (front - z1) / 2);
    box(0.5, 0.1, 0.03, 'dark', 0, ride + body + 0.24, front - (front - z1) / 2 + 0.44);
  }
  if (parts.has('bullbar')) {
    box(W * 0.8, 0.06, 0.06, 'chrome', 0, ride + body * 0.9, front + 0.2);
    box(W * 0.8, 0.06, 0.06, 'chrome', 0, ride + 0.25, front + 0.2);
    for (const sx of [-1, 0, 1]) box(0.06, body * 0.75, 0.06, 'chrome', sx * W * 0.32, ride + body * 0.57, front + 0.2);
  }
  if (parts.has('lightbar')) {
    const ly = st.open ? roof + 0.08 : roof + 0.08;
    box(W * 0.7, 0.1, 0.12, 'dark', 0, ly, z1 - 0.3);
    for (let i = -2; i <= 2; i++) add(new THREE.BoxGeometry(0.16, 0.07, 0.02), 'glow', i * W * 0.13, ly, z1 - 0.23);
  }
  if (parts.has('stacks')) {
    for (const sx of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.07, 0.07, roof + 0.25 - deck, 10), 'chrome', sx * (W / 2 - 0.2), deck + (roof + 0.25 - deck) / 2, z0 - 0.15);
    }
  }
  if (parts.has('cage') && !st.open) cage({ box }, W - 0.3, z0, z1, roof - 0.02, roof + 0.35);

  // Abilities.
  if (d.ability === 'burner') {
    for (const sx of [-1, 1]) box(0.03, 0.05, L - 0.8, 'glow', sx * (W / 2 + 0.01), ride + body * 0.5, -0.1);
    box(W - 0.3, 0.03, 0.04, 'glow', 0, ride + 0.12, front + 0.06);
  }
  if (st.bed && d.weapon !== 'flamethrower') {
    // A post in the bed for the roof weapon to sit on.
    box(0.36, turret.y - 0.05 - deck, 0.36, 'dark', 0, deck + (turret.y - 0.05 - deck) / 2, turret.z);
  }
  if (d.weapon === 'flamethrower') {
    box(0.5, 0.18, 0.5, 'dark', 0, turret.y + 0.03, turret.z);
    box(0.7, 0.36, 1.0, 'dark', 0, turret.y + 0.25, turret.z);
    box(0.74, 0.06, 1.04, 'trim', 0, turret.y + 0.45, turret.z);
    box(0.16, 0.16, 1.8, 'chrome', 0, turret.y + 0.32, turret.z + 0.3);
    box(0.24, 0.24, 0.12, 'dark', 0, turret.y + 0.32, turret.z + 1.12);
    box(0.16, 0.16, 0.04, 'glow', 0, turret.y + 0.32, turret.z + 1.19);
  }

  lights({
    frontZ: front + 0.02, rearZ: rear - 0.02, y: ride + body * 0.62,
    headX: W * 0.34, tailX: W * 0.36, headW: Math.min(0.42, W * 0.22), tailW: Math.min(0.46, W * 0.24),
    h: 0.1, rearY: ride + body * 0.7,
  });
}

/** Tubular roll cage over a span of the car. */
function cage({ box }, w, z0, z1, y0, y1) {
  const h = y1 - y0;
  for (const z of [z0 + 0.1, z1 - 0.1]) {
    for (const sx of [-1, 1]) box(0.07, h, 0.07, 'dark', sx * w / 2, y0 + h / 2, z);
    box(w, 0.07, 0.07, 'dark', 0, y1, z);
  }
  for (const sx of [-1, 1]) box(0.07, 0.07, z1 - z0 - 0.2, 'dark', sx * w / 2, y1, (z0 + z1) / 2);
}

const _statCache = new Map();

/**
 * Top speed and 0-100 km/h, measured by actually driving the handling
 * model flat out for a while (so the numbers are honest).
 */
export function measure(spec) {
  const key = JSON.stringify(spec);
  if (_statCache.has(key)) return _statCache.get(key);
  const car = new CarPhysics({ ...spec, assists: true });
  const dt = 1 / 120;
  let accel = null, top = 0, lastCheck = 0;
  for (let i = 1; i <= 120 * 90; i++) {
    car.step(dt, { steer: 0, throttle: 1, brake: 0, handbrake: false, boost: false });
    const v = car.speed;
    if (accel === null && v >= 100 / 3.6) accel = i * dt;
    top = Math.max(top, v);
    // Every second: stop once it has levelled off.
    if (i % 120 === 0) {
      if (i > 120 * 10 && top - lastCheck < 0.1) break;
      lastCheck = top;
    }
  }
  const stats = { top: Math.round(top * 3.6), accel: accel === null ? 99 : Math.round(accel * 10) / 10 };
  _statCache.set(key, stats);
  return stats;
}
