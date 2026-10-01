import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';
import { createWorld } from './world.js';
import { SkidMarks, Smoke } from './effects.js';
import { ChaseCamera } from './camera.js';
import { Input } from './input.js';
import { CarAudio } from './audio.js';

const PHYSICS_DT = 1 / 120;

// --- Renderer / scene ------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1500);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const world = createWorld(scene, renderer);
const car = new CarPhysics();
const model = new CarModel(car.spec);
scene.add(model.root);
const skids = new SkidMarks(scene);
const smoke = new Smoke(scene);
const chase = new ChaseCamera(camera);
const input = new Input();
const audio = new CarAudio();

// --- HUD -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const hud = {
  speed: $('speed'), gear: $('gear'), rpmFill: $('rpm-fill'), drift: $('drift'),
  toast: $('toast'), telemetry: $('telemetry'), assists: $('assists'), cam: $('cam'),
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

function resetCar() {
  car.reset(0, 0, 0);
  world.cones.reset();
  skids.clear();
  chase.snap();
}

input.onPress('KeyR', () => { resetCar(); toast('Reset'); });
input.onPress('KeyC', () => { chase.cycle(); refreshBadges(); toast(`Camera: ${chase.modeName}`); });
input.onPress('KeyT', () => {
  car.spec.assists = !car.spec.assists;
  refreshBadges();
  toast(car.spec.assists ? 'Assists ON (traction + countersteer)' : 'Assists OFF: full drift mode');
});
input.onPress('KeyM', () => toast(audio.toggleMute() ? 'Sound off' : 'Sound on'));
input.onPress('KeyF', () => hud.telemetry.classList.toggle('hidden'));
input.onPress('KeyH', () => $('help').classList.toggle('hidden'));

// Touch controls.
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) {
  document.body.classList.add('touch');
  for (const el of document.querySelectorAll('[data-touch]')) input.bindTouchButton(el, el.dataset.touch);
  $('touch-cam').addEventListener('click', () => { chase.cycle(); refreshBadges(); });
  $('touch-reset').addEventListener('click', resetCar);
}

const startAudio = () => audio.start();
addEventListener('keydown', startAudio);
addEventListener('pointerdown', startAudio);

refreshBadges();

// --- Main loop ------------------------------------------------------
const clock = new THREE.Clock();
let accumulator = 0;
let driftScore = 0;
let driftTimer = 0;
const contacts = [];

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const controls = input.read(dt);

  accumulator += dt;
  while (accumulator >= PHYSICS_DT) {
    car.step(PHYSICS_DT, controls);
    accumulator -= PHYSICS_DT;
  }

  model.update(car, dt);
  world.cones.update(dt, car);

  // Tire effects: per-wheel slip intensity drives marks, smoke and squeal.
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
  audio.update(car, squeal);

  chase.update(car, dt);
  world.followSun(model.root.position);

  // HUD.
  hud.speed.textContent = Math.round(speed * 3.6);
  hud.gear.textContent = car.gearLabel;
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
      `load F/R   ${(car.loadFront | 0).toString().padStart(5)} / ${car.loadRear | 0} N\n` +
      `long G     ${(car.accelLong / 9.81).toFixed(2).padStart(6)}\n` +
      `lat G      ${(car.accelLat / 9.81).toFixed(2).padStart(6)}\n` +
      `wheelspin  ${car.wheelspin.toFixed(2).padStart(6)}\n` +
      `rpm        ${(car.rpm | 0).toString().padStart(6)}`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// Expose for debugging from the console.
window.game = { car, model, chase, scene };
requestAnimationFrame(frame);
