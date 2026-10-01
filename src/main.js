import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';
import { createWorld, populateArena, START, DRIVE_LIMIT } from './world.js';
import { Destruction, initRapier, WORLD_STEP } from './destruction.js';
import { SkidMarks, Smoke } from './effects.js';
import { ChaseCamera } from './camera.js';
import { Input } from './input.js';
import { CarAudio } from './audio.js';

const PHYSICS_DT = 1 / 120;
const $ = (id) => document.getElementById(id);

try {
  await initRapier();
} catch (err) {
  $('loading').textContent = 'Could not load the physics engine. Check your connection and reload.';
  throw err;
}
$('loading').remove();

// --- Renderer / scene ------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1200);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const world = createWorld(scene, renderer);
const car = new CarPhysics();
const model = new CarModel(car.spec);
scene.add(model.root);
const destruction = new Destruction(scene, 300);
const skids = new SkidMarks(scene);
const smoke = new Smoke(scene);
const dust = new Smoke(scene, 160, 0xb9ad98);
const chase = new ChaseCamera(camera);
const input = new Input();
const audio = new CarAudio();

let smashed = 0;
let shake = 0;

destruction.on('fracture', (pos, kind) => {
  smashed++;
  const n = Math.min(6, 2 + Math.round(kind.mass / 60));
  for (let i = 0; i < n; i++) dust.emit(pos, { x: 0, z: 0 }, 0.6 + Math.random() * 0.4, pos.y);
  audio.impact(kind.material, 1);
});
destruction.on('impact', (material, strength) => audio.impact(material, strength));

function buildArena() {
  destruction.createWorld();
  destruction.createCar(car.spec);
  populateArena(destruction);
}

function resetCar() {
  car.reset(START.x, START.z, START.heading);
  destruction.teleportCar(car);
  skids.clear();
  chase.snap();
}

function resetAll() {
  buildArena();
  smashed = 0;
  resetCar();
}

resetAll();

// --- HUD -------------------------------------------------------------
const hud = {
  speed: $('speed'), gear: $('gear'), rpmFill: $('rpm-fill'), drift: $('drift'),
  toast: $('toast'), telemetry: $('telemetry'), assists: $('assists'), cam: $('cam'), smashed: $('smashed'),
};
let toastTimer = 0;
function toast(msg) {
  hud.toast.textContent = msg;
  hud.toast.classList.add('show');
  toastTimer = 1.6;
}
function refreshBadges() {
  hud.assists.textContent = `Assists: ${car.spec.assists ? 'ON' : 'OFF'}`;
  hud.assists.classList.toggle('off', !car.spec.assists);
  hud.cam.textContent = `Camera: ${chase.modeName}`;
}

input.onPress('KeyR', () => { resetCar(); toast('Car reset'); });
input.onPress('KeyB', () => { resetAll(); toast('Arena rebuilt'); });
input.onPress('KeyC', () => { chase.cycle(); refreshBadges(); toast(`Camera: ${chase.modeName}`); });
input.onPress('KeyT', () => {
  car.spec.assists = !car.spec.assists;
  refreshBadges();
  toast(car.spec.assists ? 'Assists ON (traction + countersteer)' : 'Assists OFF: full drift mode');
});
input.onPress('KeyM', () => toast(audio.toggleMute() ? 'Sound off' : 'Sound on'));
input.onPress('KeyF', () => hud.telemetry.classList.toggle('hidden'));
input.onPress('KeyH', () => $('help').classList.toggle('hidden'));

const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) {
  document.body.classList.add('touch');
  for (const el of document.querySelectorAll('[data-touch]')) input.bindTouchButton(el, el.dataset.touch);
  $('touch-cam').addEventListener('click', () => { chase.cycle(); refreshBadges(); });
  $('touch-reset').addEventListener('click', resetCar);
  $('touch-rebuild').addEventListener('click', resetAll);
}

const startAudio = () => audio.start();
addEventListener('keydown', startAudio);
addEventListener('pointerdown', startAudio);

refreshBadges();

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
const contacts = [];

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  const controls = input.read(dt);

  accumulator += dt;
  let steps = 0;
  while (accumulator >= PHYSICS_DT && steps < 8) {
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
  if (steps === 8) accumulator = 0; // can't keep up: drop time rather than spiral
  frameTail(dt);
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

function frameTail(dt) {
  destruction.sync();
  model.update(car, dt);

  // Tire effects.
  model.contactPoints(contacts);
  const speed = car.speed;
  const latSlipF = Math.abs(Math.sin(car.slipFront));
  const latSlipR = Math.abs(Math.sin(car.slipRear));
  const lockR = car.handbrake && speed > 2 ? 0.8 : 0;
  const lockF = car.braking > 0.9 && speed > 8 ? 0.25 : 0;
  const speedGate = Math.min(1, speed / 6);
  const frontSkid = Math.max(0, latSlipF - 0.17) * 3 + lockF;
  const rearSkid = Math.max(Math.max(0, latSlipR - 0.14) * 3, car.wheelspin * 1.5, lockR);
  let squeal = 0;
  contacts.forEach((p, i) => {
    const front = i < 2;
    const s = Math.min(1, (front ? frontSkid : rearSkid) * (front ? speedGate : Math.max(speedGate, car.wheelspin)));
    skids.add(i, p, s);
    if (!front && s > 0.35 && Math.random() < s * 0.9) smoke.emit(p, { x: car.velX, z: car.velZ }, s);
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
  world.followSun(model.root.position);

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
      `bodies     ${destruction.bodyCount.toString().padStart(6)}`;
  }

  renderer.render(scene, camera);
}

window.game = { car, model, chase, scene, destruction };
requestAnimationFrame(frame);
