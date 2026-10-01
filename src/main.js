import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';
import { createWorld, populateArena, DRIVE_LIMIT } from './world.js';
import { VEHICLES } from './vehicles.js';
import { Destruction, initRapier, WORLD_STEP } from './destruction.js';
import { SkidMarks, Smoke } from './effects.js';
import { ChaseCamera } from './camera.js';
import { Input } from './input.js';
import { CarAudio } from './audio.js';
import { loadSettings, saveSettings, changeSetting } from './settings.js';
import { Menu } from './menu.js';

const PHYSICS_DT = 1 / 120;
// At most this many car steps per frame (2 debris-world steps). A slow
// frame drops time instead of trying to catch up and getting slower.
const MAX_STEPS_PER_FRAME = 4;
const $ = (id) => document.getElementById(id);

try {
  await initRapier();
} catch (err) {
  $('loading').textContent = 'Could not load the physics engine. Check your connection and reload.';
  throw err;
}
$('loading').remove();

let settings = loadSettings();

// --- Renderer / scene ------------------------------------------------
let renderer = null;
let dynScale = 1; // dynamic-resolution multiplier, 0.5..1

function createRenderer() {
  const old = renderer;
  renderer = new THREE.WebGLRenderer({ antialias: settings.antialias, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setSize(innerWidth, innerHeight);
  if (old) {
    old.domElement.replaceWith(renderer.domElement);
    old.dispose();
  } else {
    $('app').appendChild(renderer.domElement);
  }
}

function pixelRatio() {
  const base = settings.resolution > 1 ? Math.min(devicePixelRatio, 2) : settings.resolution;
  return base * (settings.dynamicResolution ? dynScale : 1);
}

createRenderer();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 700);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const world = createWorld(scene, renderer);
// Every vehicle has a model in the scene. One is driven (custom handling
// model + kinematic collider); the rest are parked rigid bodies.
const fleet = VEHICLES.map((def) => {
  const model = new CarModel(def);
  scene.add(model.root);
  return { def, model, parked: null };
});
let active = fleet.find((v) => v.def.id === settings.startVehicle) || fleet[0];
let car = new CarPhysics({ ...active.def.spec, assists: settings.assists });
const destruction = new Destruction(scene, 300);
const skids = new SkidMarks(scene);
const smoke = new Smoke(scene);
const dust = new Smoke(scene, 160, 0xb9ad98);
const chase = new ChaseCamera(camera);
const input = new Input();
const audio = new CarAudio();

let smashed = 0;
let shake = 0;
let state = 'menu'; // 'menu' | 'playing' | 'paused'
let arenaDirty = false; // has the arena been played in since it was built?

destruction.on('fracture', (pos, kind) => {
  smashed++;
  const base = settings.effects === 'high' ? 2 + Math.round(kind.mass / 60) : 1;
  const n = Math.min(6, base);
  for (let i = 0; i < n; i++) dust.emit(pos, { x: 0, z: 0 }, 0.6 + Math.random() * 0.4, pos.y);
  audio.impact(kind.material, 1);
});
destruction.on('impact', (material, strength) => audio.impact(material, strength));

// --- Settings ----------------------------------------------------------
let shadowsWere = null;

function applySettings({ rebuildRenderer = false } = {}) {
  if (rebuildRenderer) {
    createRenderer();
    shadowsWere = null;
  }
  renderer.setPixelRatio(pixelRatio());
  const shadowsOn = settings.shadows !== 'off';
  renderer.shadowMap.enabled = shadowsOn;
  renderer.shadowMap.type = settings.shadows === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (shadowsWere !== null && shadowsWere !== settings.shadows) {
    // Materials compile shadow support in; recompile after toggling.
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
  shadowsWere = settings.shadows;
  world.setGraphics(settings, camera);
  destruction.configure({
    debrisLimit: settings.debrisLimit,
    breakage: settings.breakage,
    debrisLifetime: settings.debrisLifetime,
    physicsQuality: settings.physicsQuality,
  });
  car.spec.assists = settings.assists;
  audio.setMuted(!settings.sound);
  $('fps').hidden = !settings.showFps;
  refreshBadges();
}

function setSetting(key, value) {
  const prev = settings;
  settings = changeSetting(settings, key, value);
  saveSettings(settings);
  if (key === 'startVehicle') return;
  applySettings({ rebuildRenderer: prev.antialias !== settings.antialias });
}

// --- Arena and vehicles --------------------------------------------------
function buildArena() {
  destruction.createWorld();
  destruction.createCar(active.def);
  populateArena(destruction);
  for (const v of fleet) v.parked = v === active ? null : destruction.spawnVehicle(v.def, v.def.home);
  arenaDirty = false;
}

function resetCar() {
  const { home } = active.def;
  car.reset(home.x, home.z, home.heading);
  destruction.teleportCar(car);
  skids.clear();
  chase.setVehicle(active.def);
  chase.snap();
}

function resetAll() {
  buildArena();
  smashed = 0;
  resetCar();
}

/** The parked vehicle closest to the driver, if it's near enough to hop into. */
function nearbyVehicle() {
  let best = null;
  let bestGap = 3.5;
  for (const v of fleet) {
    if (!v.parked) continue;
    const t = v.parked.body.translation();
    const gap = Math.hypot(t.x - car.x, t.z - car.z) - (v.def.length + active.def.length) / 4;
    if (gap < bestGap) { best = v; bestGap = gap; }
  }
  return best;
}

/** Leave the current vehicle parked where it is and take over `target`. */
function switchTo(target) {
  const old = active;
  old.parked = destruction.spawnVehicle(
    old.def,
    { x: car.x, z: car.z, heading: car.heading },
    { x: car.velX, z: car.velZ, yaw: car.yawRate },
  );
  // Take the target's pose (set upright if it was knocked over).
  const t = target.parked.body.translation();
  const q = target.parked.body.rotation();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  const heading = Math.atan2(fwd.x, fwd.z);
  destruction.removeVehicle(target.parked);
  target.parked = null;

  active = target;
  car = new CarPhysics({ ...target.def.spec, assists: settings.assists });
  car.reset(t.x, t.z, heading);
  destruction.createCar(target.def);
  destruction.teleportCar(car);
  skids.clear();
  chase.setVehicle(target.def);
  chase.snap();
  refreshBadges();
  toast(`Driving: ${target.def.name}`);
}

// --- HUD -------------------------------------------------------------
const hud = {
  speed: $('speed'), gear: $('gear'), rpmFill: $('rpm-fill'), drift: $('drift'),
  toast: $('toast'), telemetry: $('telemetry'), assists: $('assists'), cam: $('cam'), smashed: $('smashed'),
  vehicle: $('vehicle'), prompt: $('prompt'), fps: $('fps'),
};
let toastTimer = 0;
function toast(msg) {
  hud.toast.textContent = msg;
  hud.toast.classList.add('show');
  toastTimer = 1.6;
}
function refreshBadges() {
  hud.assists.textContent = `Assists: ${settings.assists ? 'ON' : 'OFF'}`;
  hud.assists.classList.toggle('off', !settings.assists);
  hud.cam.textContent = `Camera: ${chase.modeName}`;
  hud.vehicle.textContent = active.def.name;
}

// --- Menus and game state -------------------------------------------------
const menu = new Menu({
  vehicles: VEHICLES,
  getSettings: () => settings,
  onSetting: setSetting,
  onPlay: (def) => play(def),
  onResume: () => resume(),
  onRebuild: () => { resetAll(); resume(); toast('Arena rebuilt'); },
  onQuit: () => openMainMenu(),
});

function play(def) {
  audio.start();
  const chosen = fleet.find((v) => v.def === def) || active;
  if (chosen !== active || arenaDirty) {
    active = chosen;
    car = new CarPhysics({ ...active.def.spec, assists: settings.assists });
    resetAll();
  } else {
    resetCar();
  }
  arenaDirty = true;
  refreshBadges();
  menu.hide();
  state = 'playing';
  clock.getDelta();
  accumulator = 0;
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  audio.suspend();
  menu.show('pause');
}

function resume() {
  menu.hide();
  state = 'playing';
  audio.start();
  clock.getDelta(); // don't count the time spent paused
  accumulator = 0;
}

function openMainMenu() {
  state = 'menu';
  audio.suspend();
  menu.show('main');
}

/** Gameplay keys only act while driving. */
const playing = (fn) => () => { if (state === 'playing') fn(); };

input.onPress('Escape', () => {
  if (state === 'playing') pause();
  else if (state === 'paused' && menu.current === 'pause') resume();
  else if (menu.current === 'options' || menu.current === 'controls') menu.back();
});
input.onPress('KeyP', () => { if (state === 'playing') pause(); else if (state === 'paused' && menu.current === 'pause') resume(); });
input.onPress('KeyR', playing(() => { resetCar(); toast('Car reset'); }));
input.onPress('KeyB', playing(() => { resetAll(); arenaDirty = true; toast('Arena rebuilt'); }));
input.onPress('KeyC', playing(() => { chase.cycle(); refreshBadges(); toast(`Camera: ${chase.modeName}`); }));
input.onPress('KeyE', playing(enterNearby));
input.onPress('KeyT', playing(() => {
  setSetting('assists', !settings.assists);
  toast(settings.assists ? 'Assists ON (traction + countersteer)' : 'Assists OFF: full drift mode');
}));
input.onPress('KeyM', () => { setSetting('sound', !settings.sound); toast(settings.sound ? 'Sound on' : 'Sound off'); });
input.onPress('KeyF', playing(() => hud.telemetry.classList.toggle('hidden')));
input.onPress('KeyH', playing(() => $('help').classList.toggle('hidden')));

function enterNearby() {
  const v = nearbyVehicle();
  if (v) switchTo(v);
}

const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) {
  document.body.classList.add('touch');
  for (const el of document.querySelectorAll('[data-touch]')) input.bindTouchButton(el, el.dataset.touch);
  $('touch-cam').addEventListener('click', () => { chase.cycle(); refreshBadges(); });
  $('touch-reset').addEventListener('click', resetCar);
  $('touch-pause').addEventListener('click', pause);
  $('touch-enter').addEventListener('click', enterNearby);
}

// Pause when the tab is hidden (also where an ad break would hook in).
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// Keep the car on the lot: a soft wall just outside the barrier ring.
function containCar() {
  for (const axis of ['x', 'z']) {
    const vel = axis === 'x' ? 'velX' : 'velZ';
    if (Math.abs(car[axis]) > DRIVE_LIMIT) {
      car[axis] = Math.sign(car[axis]) * DRIVE_LIMIT;
      if (Math.sign(car[vel]) === Math.sign(car[axis])) {
        const hit = Math.abs(car[vel]);
        car[vel] *= -0.3;
        car.yawRate *= 0.5;
        if (hit > 3) { shake = Math.min(1, shake + hit * 0.03); audio.impact('crash', Math.min(1, hit / 20)); }
      }
    }
  }
}

// --- Main loop ------------------------------------------------------
const clock = new THREE.Clock();
let accumulator = 0;
let driftScore = 0;
let driftTimer = 0;
let crashCooldown = 0;
let worldClock = 0;
let menuOrbit = 0;
let pausedRedraw = 0;
const contacts = [];
const perf = { avg: 1 / 60, slowFor: 0, fastFor: 0, fpsTimer: 0, frames: 0 };

function frame() {
  requestAnimationFrame(frame);
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.1);
  trackPerformance(raw);
  const controls = input.read(dt); // polled every frame so the gamepad can pause/resume

  if (state === 'playing') {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      car.step(PHYSICS_DT, controls);
      containCar();
      // The debris world runs at a lower rate than the car's handling.
      worldClock += PHYSICS_DT;
      if (worldClock >= WORLD_STEP - 1e-9) {
        worldClock -= WORLD_STEP;
        stepWorld();
      }
      accumulator -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
    updateScene(dt);
  } else if (state === 'menu') {
    // Slow orbit over the arena behind the main menu.
    menuOrbit += dt * 0.06;
    camera.position.set(Math.sin(menuOrbit) * 58, 26, Math.cos(menuOrbit) * 58);
    camera.lookAt(0, 2, 0);
    destruction.sync();
    for (const v of fleet) if (v.parked) v.model.updateParked(v.parked.body, dt);
    active.model.update(car, 0);
    world.followSun(new THREE.Vector3(0, 0, 0));
  }
  // Paused: redraw the frozen frame only a few times a second (enough to
  // show settings changes behind the menu) to save battery.
  if (state === 'paused') {
    pausedRedraw -= raw;
    if (pausedRedraw > 0) return;
    pausedRedraw = 0.25;
  }
  renderer.render(scene, camera);
}

/** FPS readout and dynamic resolution. */
function trackPerformance(raw) {
  perf.avg += (Math.min(raw, 0.25) - perf.avg) * 0.05;
  perf.frames++;
  perf.fpsTimer += raw;
  if (perf.fpsTimer >= 0.5) {
    if (settings.showFps) hud.fps.textContent = `${Math.round(perf.frames / perf.fpsTimer)} FPS`;
    perf.frames = 0;
    perf.fpsTimer = 0;
  }
  if (!settings.dynamicResolution || state !== 'playing') return;
  if (perf.avg > 1 / 45) {
    perf.slowFor += raw;
    perf.fastFor = 0;
    if (perf.slowFor > 1.5 && dynScale > 0.5) {
      dynScale = Math.max(0.5, dynScale - 0.1);
      renderer.setPixelRatio(pixelRatio());
      perf.slowFor = 0;
    }
  } else if (perf.avg < 1 / 57) {
    perf.fastFor += raw;
    perf.slowFor = 0;
    if (perf.fastFor > 4 && dynScale < 1) {
      dynScale = Math.min(1, dynScale + 0.05);
      renderer.setPixelRatio(pixelRatio());
      perf.fastFor = 0;
    }
  } else {
    perf.slowFor = perf.fastFor = 0;
  }
}

function stepWorld() {
  const r = destruction.step(car);
  if (r.total > 0) {
    const dv = car.applyImpulse(r.jx, r.jz, r.torque);
    shake = Math.min(1, shake + dv * 0.12);
    if (dv > 0.6 && crashCooldown <= 0) {
      audio.impact('crash', Math.min(1, dv / 3));
      crashCooldown = 0.12;
    }
  }
  crashCooldown -= WORLD_STEP;
}

function updateScene(dt) {
  destruction.sync();
  active.model.update(car, dt);
  for (const v of fleet) if (v.parked) v.model.updateParked(v.parked.body, dt);
  const near = car.speed < 8 ? nearbyVehicle() : null;
  hud.prompt.classList.toggle('show', !!near);
  if (near) hud.prompt.innerHTML = `<kbd>E</kbd> Drive the ${near.def.name.toLowerCase()}`;

  // Tire effects.
  active.model.contactPoints(contacts);
  const speed = car.speed;
  const latSlipF = Math.abs(Math.sin(car.slipFront));
  const latSlipR = Math.abs(Math.sin(car.slipRear));
  const lockR = car.handbrake && speed > 2 ? 0.8 : 0;
  const lockF = car.braking > 0.9 && speed > 8 ? 0.25 : 0;
  const speedGate = Math.min(1, speed / 6);
  const frontSkid = Math.max(0, latSlipF - 0.17) * 3 + lockF;
  const rearSkid = Math.max(Math.max(0, latSlipR - 0.14) * 3, car.wheelspin * 1.5, lockR);
  const smokeRate = settings.effects === 'high' ? 0.9 : 0.35;
  let squeal = 0;
  contacts.forEach((p, i) => {
    const front = i < 2;
    const s = Math.min(1, (front ? frontSkid : rearSkid) * (front ? speedGate : Math.max(speedGate, car.wheelspin)));
    skids.add(i, p, s);
    if (!front && s > 0.35 && Math.random() < s * smokeRate) smoke.emit(p, { x: car.velX, z: car.velZ }, s);
    squeal = Math.max(squeal, s);
  });
  smoke.update(dt);
  dust.update(dt);
  audio.update(car, squeal);

  chase.update(car, dt);
  if (shake > 0.001) {
    const a = shake * shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
    shake *= Math.exp(-dt * 6);
  }
  world.followSun(active.model.root.position);

  // HUD.
  hud.speed.textContent = Math.round(speed * 3.6);
  hud.gear.textContent = car.gearLabel;
  hud.smashed.textContent = smashed;
  const rpmT = (car.rpm - car.spec.idleRpm) / (car.spec.redline - car.spec.idleRpm);
  hud.rpmFill.style.width = `${Math.max(0, Math.min(1, rpmT)) * 100}%`;
  hud.rpmFill.classList.toggle('red', car.rpm > car.spec.shiftUpRpm - 300);

  if (car.isDrifting) {
    const angle = Math.abs(Math.atan2(car.vLat, car.vLong)) * 57.3;
    driftScore += angle * speed * dt * 0.1;
    driftTimer = 1.2;
    hud.drift.innerHTML = `DRIFT <b>${Math.round(driftScore)}</b><small>${Math.round(angle)}°</small>`;
    hud.drift.classList.add('show');
  } else if (driftTimer > 0) {
    driftTimer -= dt;
    if (driftTimer <= 0) {
      hud.drift.classList.remove('show');
      driftScore = 0;
    }
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) hud.toast.classList.remove('show');
  }

  if (!hud.telemetry.classList.contains('hidden')) {
    const deg = (r) => (r * 57.3).toFixed(1).padStart(6);
    hud.telemetry.textContent =
      `steer      ${deg(car.steer)}°\n` +
      `slip F     ${deg(car.slipFront)}°\n` +
      `slip R     ${deg(car.slipRear)}°\n` +
      `body slip  ${deg(Math.atan2(car.vLat, Math.abs(car.vLong) + 1e-3))}°\n` +
      `yaw rate   ${deg(car.yawRate)}°/s\n` +
      `lat G      ${(car.accelLat / 9.81).toFixed(2).padStart(6)}\n` +
      `rpm        ${(car.rpm | 0).toString().padStart(6)}\n` +
      `bodies     ${destruction.bodyCount.toString().padStart(6)}\n` +
      `res scale  ${pixelRatio().toFixed(2).padStart(6)}`;
  }
}

buildArena();
resetCar();
applySettings();
openMainMenu();

window.game = {
  get car() { return car; }, get active() { return active; }, get state() { return state; },
  get renderer() { return renderer; }, get settings() { return settings; },
  fleet, chase, scene, destruction, switchTo, nearbyVehicle, setSetting, menu,
};
requestAnimationFrame(frame);
