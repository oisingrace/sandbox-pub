import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';
import { createWorld, populateArena, DRIVE_LIMIT } from './world.js';
import { VEHICLES } from './vehicles.js';
import { Garage } from './customs.js';
import { compileCar } from './carkit.js';
import { Workshop } from './workshop.js';
import { Destruction, initRapier, WORLD_STEP } from './destruction.js';
import { SkidMarks, Smoke } from './effects.js';
import { ChaseCamera } from './camera.js';
import { Input } from './input.js';
import { CarAudio } from './audio.js';
import { loadSettings, saveSettings, changeSetting } from './settings.js';
import { Menu } from './menu.js';
import { BurnEffect } from './burn.js';
import { Terrain, arenaRamps } from './terrain.js';
import { Net } from './net.js';
import { Multiplayer, SPAWN_SLOTS, SEND_INTERVAL, nameTag } from './multiplayer.js';
import { footprint, yawInertia, overlap, contactImpulse, applyToCar } from './carCollision.js';
import { createStadium, kickoffSpot, TEAM_COLORS, PITCH } from './stadium.js';
import { Football, setTeamGlow, TEAM_NAMES } from './football.js';
import { Bot } from './bot.js';
import { ScreenQuake } from './quake.js';
import { FlameFX, FlameTank, nozzle } from './flamethrower.js';
import { Score, pointsFor, EXPLOSION_POINTS, COMBO_WINDOW } from './score.js';

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
// The garage holds the built-in cars plus your custom ones (see customs.js).
const garage = new Garage();
const fleet = garage.all.map((def) => {
  const model = new CarModel(def);
  scene.add(model.root);
  return { def, model, parked: null };
});
let active = fleet.find((v) => v.def.id === settings.startVehicle) || fleet[0];
// Maps. Each has its scenery group, ramps (the car's handling reads heights
// from `terrain`; the physics world gets matching colliders), contents and
// boundary. Free roam plays on the lot, car football in the stadium.
const lotTerrain = new Terrain();
arenaRamps(lotTerrain);
lotTerrain.buildMeshes(world.arena);
const stadium = createStadium(scene, renderer);
const MAPS = {
  free: {
    name: 'lot', group: world.arena, terrain: lotTerrain, orbit: { radius: 82, height: 34 },
    addColliders: (w) => lotTerrain.addColliders(w), populate: populateArena, contain: containLot,
  },
  football: stadium,
};
let mode = 'free';
let map = MAPS.free;
let terrain = map.terrain;

let car = new CarPhysics({ ...active.def.spec, assists: settings.assists }, terrain);
const destruction = new Destruction(scene, 300);
destruction.statics = map;
const skids = new SkidMarks(scene);
const smoke = new Smoke(scene);
const dust = new Smoke(scene, 160, 0xb9ad98);
const soot = new Smoke(scene, 120, 0x2e2a28);
const burnFx = new BurnEffect(scene);
const chase = new ChaseCamera(camera);
const input = new Input();
const audio = new CarAudio();

let smashed = 0;
const quake = new ScreenQuake();
const flames = new FlameFX(scene);
const tank = new FlameTank();
const score = new Score();
const _nz = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };
// Multiplayer (peer-to-peer; see net.js and multiplayer.js).
const net = new Net();
const mp = new Multiplayer({ scene, destruction, findVehicle: (id) => garage.find(id) });
let slot = 0; // our start position in a room
let state = 'menu'; // 'menu' | 'playing' | 'paused'
let arenaDirty = false; // has the arena been played in since it was built?
// Car football.
const football = new Football({ scene, destruction });
let bot = null; // computer opponent in solo football
let ballCam = true;
let ownTouchUntil = 0; // online: we hit the ball; our local ball leads until then
let netTimer = 0;
let lastBeep = 0;
const myId = () => (net.online ? net.id : 'me');

/**
 * Online, everyone's cars break things on every screen; only count (and
 * reward boost for) the ones our own car was closest to.
 */
function creditedToMe(pos) {
  if (!net.online && !bot) return true;
  const mine = Math.hypot(pos.x - car.x, pos.z - car.z);
  if (bot && Math.hypot(pos.x - bot.car.x, pos.z - bot.car.z) < mine) return false;
  for (const r of mp.remotes.values()) {
    if (r.seen && Math.hypot(pos.x - r.proxy.x, pos.z - r.proxy.z) < mine) return false;
  }
  return true;
}

destruction.on('fracture', (pos, kind) => {
  const mine = creditedToMe(pos);
  if (mine) { smashed++; award(pointsFor(kind.mass)); }
  const base = settings.effects === 'high' ? 2 + Math.round(kind.mass / 60) : 1;
  const n = Math.min(6, base);
  for (let i = 0; i < n; i++) dust.emit(pos, { x: 0, z: 0 }, 0.6 + Math.random() * 0.4, pos.y);
  audio.impact(kind.material, 1, pos);
  quake.smash(kind.mass, pos, car);
  if (mine) car.boost = Math.min(1, car.boost + 0.015); // smashing refills boost
});
destruction.on('burn', (info) => {
  const mine = creditedToMe(info.pos);
  if (mine) { smashed++; award(pointsFor(info.kind.mass)); }
  burnFx.ignite(info);
  const puffs = settings.effects === 'high' ? 3 : 1;
  for (let i = 0; i < puffs; i++) soot.emit(info.pos, { x: 0, z: 0 }, 0.8, info.pos.y + 0.5);
  audio.burn(Math.min(1, 0.4 + info.kind.mass / 300), info.pos);
  quake.smash(info.kind.mass, info.pos, car, 0.6); // burning is quieter than smashing
  if (mine) car.boost = Math.min(1, car.boost + 0.012);
});
destruction.on('impact', (material, strength, pos) => {
  audio.impact(material, strength, pos);
  quake.add(strength * 0.25, pos, car); // debris crashing down adds to the rumble
});
destruction.on('explode', (pos, distance) => {
  const mine = creditedToMe(pos);
  if (mine) { smashed++; award(EXPLOSION_POINTS); }
  burnFx.fireball(pos);
  const puffs = settings.effects === 'high' ? 8 : 3;
  for (let i = 0; i < puffs; i++) {
    soot.emit(pos, { x: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 }, 1, pos.y + 0.5 + Math.random() * 2);
    dust.emit(pos, { x: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 14 }, 1, pos.y);
  }
  audio.explosion(pos, distance);
  quake.add(12, pos, car, 30); // a blast is felt further away than a smash
  quake.kick(Math.max(0, 1 - distance / 35) * 0.6);
  if (mine) car.boost = Math.min(1, car.boost + 0.05);
});

/** Destruction points (free roam; football has its own score). */
function award(base) {
  if (mode !== 'free' || state === 'menu') return;
  score.add(base);
}
score.onComboEnd = ({ count, mult, points }) => {
  toast(`Combo over: ${count} smashed at ×${mult}, +${points.toLocaleString('en-US')}`);
};

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
  audio.setVolume(settings.volume);
  quake.strength = settings.screenShake;
  burnFx.setDetail(settings.effects === 'high' ? 150 : 60, settings.effects === 'high');
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
  map.populate(destruction);
  // Parked vehicles to swap into (free roam, solo only: they can't be kept
  // in sync online).
  const parking = !net.online && mode === 'free';
  for (const v of fleet) v.parked = v === active || !parking ? null : destruction.spawnVehicle(v.def, v.def.home);
  for (const v of fleet) v.model.root.visible = v === active || !!v.parked;
  if (mode === 'football') football.spawnBall();
  arenaDirty = false;
}

/** Our start position: kickoff spot in football, else the start line. */
function homeSpot() {
  if (mode === 'football') return teamSpot(myId());
  return net.online ? SPAWN_SLOTS[slot % SPAWN_SLOTS.length] : active.def.home;
}

/** A player's kickoff spot: by team, and their order within the team. */
function teamSpot(id) {
  const team = football.teams.get(id) ?? 0;
  let index = 0;
  for (const [other, t] of football.teams) {
    if (other === id) break;
    if (t === team) index++;
  }
  return kickoffSpot(team, index);
}

function resetCar() {
  const home = homeSpot();
  car.reset(home.x, home.z, home.heading);
  destruction.teleportCar(car);
  skids.clear();
  chase.setVehicle(active.def);
  chase.snap();
}

function resetBot() {
  if (!bot) return;
  const s = teamSpot('bot');
  bot.car.reset(s.x, s.z, s.heading);
  bot.stuck = bot.reversing = 0;
}

function resetAll() {
  burnFx.clear();
  buildArena();
  smashed = 0;
  score.reset();
  flames.clear();
  resetCar();
  resetBot();
  // The referee starts a new match; others wait for its kickoff.
  if (mode === 'football' && football.referee) football.startMatch();
}

// --- Game modes ------------------------------------------------------------
/** Switch map and rules (does not rebuild; see enterMode). */
function setMode(next) {
  mode = next === 'football' ? 'football' : 'free';
  map = MAPS[mode];
  terrain = map.terrain;
  car.terrain = terrain;
  if (bot) bot.car.terrain = terrain;
  destruction.statics = map;
  for (const m of Object.values(MAPS)) m.group.visible = m === map;
  football.setActive(mode === 'football');
  input.football = mode === 'football';
  football.referee = !net.online || net.isHost;
  football.myId = myId();
  document.body.classList.toggle('football', mode === 'football');
  chase.focus = mode === 'football' && ballCam ? football.mesh.position : null;
  chase.bounds = mode === 'football' ? keepCameraInStadium : null;
  if (mode === 'football' && !net.online) {
    football.teams = new Map([['me', 0], ['bot', 1]]);
    ensureBot();
  } else {
    removeBot();
  }
  if (mode === 'football' && net.online && net.isHost && !football.teams.has('host')) {
    football.teams = new Map([['host', 0]]);
    for (const id of mp.remotes.keys()) assignTeam(id);
  }
  updateNames();
  refreshTeamGlows();
  menu.setOnline(net.online, net.code, net.isHost, mode);
}

/** Keep the chase camera inside the stadium glass (and inside goals). */
function keepCameraInStadium(pos) {
  const { halfX: X, halfZ: Z, goalHalf: G, goalDepth: D } = PITCH;
  const m = 0.8;
  pos.x = Math.max(-X + m, Math.min(X - m, pos.x));
  const zl = Math.abs(pos.x) < G - m ? Z + D - m : Z - m;
  pos.z = Math.max(-zl, Math.min(zl, pos.z));
  // Cut corners.
  const over = (Math.abs(pos.x) + Math.abs(pos.z) - (X + Z - PITCH.chamfer)) / Math.SQRT2 + m;
  if (over > 0 && Math.abs(pos.z) <= Z) {
    pos.x -= Math.sign(pos.x) * over / Math.SQRT2;
    pos.z -= Math.sign(pos.z) * over / Math.SQRT2;
  }
}

/** Switch mode and start it fresh. */
function enterMode(next) {
  setMode(next);
  resetAll();
  arenaDirty = mode === 'football';
}

function ensureBot() {
  if (bot) return;
  const def = VEHICLES.find((v) => v.id === (active.def.id === 'hatch' ? 'sports' : 'hatch'));
  bot = new Bot(def, terrain, 1);
  const tag = nameTag('Bot', def, TEAM_COLORS[1]);
  tag.position.set(0, Math.max(...def.hitbox.map((h) => h.at[1] + h.half[1])) + 1.1, 0);
  bot.model.root.add(tag);
  setTeamGlow(bot.model, def, 1);
  scene.add(bot.model.root);
  destruction.addRemoteCar('bot', def, bot.car);
  resetBot();
}

function removeBot() {
  if (!bot) return;
  scene.remove(bot.model.root);
  destruction.removeRemoteCar('bot');
  bot = null;
}

/** Host: put a new player on the team with fewer players. */
function assignTeam(id) {
  const count = [0, 0];
  for (const t of football.teams.values()) count[t]++;
  football.teams.set(id, count[0] <= count[1] ? 0 : 1);
}

function updateNames() {
  football.names = new Map([[myId(), settings.playerName || 'You'], ['bot', 'Bot']]);
  for (const [id, p] of net.players) if (id !== net.id) football.names.set(id, p.name);
}

function refreshTeamGlows() {
  const on = mode === 'football';
  setTeamGlow(active.model, active.def, on ? football.teams.get(myId()) ?? 0 : null);
  for (const v of fleet) if (v !== active) setTeamGlow(v.model, v.def, null);
  for (const r of mp.remotes.values()) setTeamGlow(r.model, r.def, on ? football.teams.get(r.id) ?? null : null);
}

football.on('kickoff', () => {
  resetCar();
  resetBot();
  lastBeep = 0;
});
football.on('go', () => {
  football.showGo();
  audio.beep(true);
  audio.whistle();
});
football.on('goal', (g) => {
  const pos = new THREE.Vector3(g.x, Math.max(1.5, g.y), g.z);
  burnFx.fireball(pos);
  destruction.blast(pos, 10);
  for (let i = 0; i < 10; i++) {
    soot.emit(pos, { x: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 }, 1, pos.y + Math.random() * 2);
  }
  audio.explosion(pos, Math.hypot(car.x - pos.x, car.z - pos.z));
  audio.goalHorn();
  stadium.celebrate();
  quake.kick(0.5);
  refreshPlayers();
});
football.on('overtime', () => {
  toast('Overtime: next goal wins');
  audio.whistle();
});
football.on('ended', () => audio.whistle(true));
football.on('restart', () => {
  // Referee: a fresh arena and match for everyone.
  resetAll();
  if (net.online) net.sendEvent({ type: 'rebuild' });
});
football.on('touch', (id) => {
  if (id === myId()) ownTouchUntil = performance.now() + 400;
});

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
/**
 * Swap to any vehicle on the spot (garage / V key). In solo the car we
 * leave goes back to its parking spot; online, other players see the new
 * car appear through our state updates.
 */
function changeVehicle(def) {
  const target = fleet.find((v) => v.def === def);
  if (!target || target === active) return;
  const pose = { x: car.x, z: car.z, heading: car.heading };
  const old = active;
  // The cars trade places: the one we leave parks where the new one was
  // waiting (never on top of us).
  let spot = old.def.home;
  if (target.parked) {
    const t = target.parked.body.translation();
    const q = target.parked.body.rotation();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    spot = { x: t.x, z: t.z, heading: Math.atan2(fwd.x, fwd.z) };
    destruction.removeVehicle(target.parked);
    target.parked = null;
  }
  if (!net.online && mode === 'free') old.parked = destruction.spawnVehicle(old.def, spot);
  old.model.root.visible = !!old.parked;

  active = target;
  active.model.root.visible = true;
  car = new CarPhysics({ ...def.spec, assists: settings.assists }, terrain);
  car.reset(pose.x, pose.z, pose.heading);
  destruction.createCar(def);
  destruction.teleportCar(car);
  skids.clear();
  chase.setVehicle(def);
  chase.snap();
  audio.setVehicle(def);
  setSetting('startVehicle', def.id);
  refreshTeamGlows();
  refreshBadges();
  announceCar(def);
  toast(`Driving: ${def.name}`);
}

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
  car = new CarPhysics({ ...target.def.spec, assists: settings.assists }, terrain);
  car.reset(t.x, t.z, heading);
  destruction.createCar(target.def);
  destruction.teleportCar(car);
  skids.clear();
  chase.setVehicle(target.def);
  chase.snap();
  audio.setVehicle(target.def);
  refreshBadges();
  announceCar(target.def);
  toast(`Driving: ${target.def.name}`);
}

// --- HUD -------------------------------------------------------------
const hud = {
  speed: $('speed'), gear: $('gear'), rpmFill: $('rpm-fill'), drift: $('drift'),
  toast: $('toast'), telemetry: $('telemetry'), assists: $('assists'), cam: $('cam'), smashed: $('smashed'),
  vehicle: $('vehicle'), prompt: $('prompt'), fps: $('fps'), boostFill: $('boost-fill'),
  fuelFill: $('fuel-fill'), points: $('score-points'), mult: $('score-mult'), comboFill: $('score-combo-fill'),
  comboCount: $('score-count'), gain: $('score-gain'), scorePanel: $('score'),
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
  // Flamethrower controls and fuel gauge only for a vehicle that has one.
  document.body.classList.toggle('flamer', !!active.def.flamethrower);
}

// --- Menus and game state -------------------------------------------------
const menu = new Menu({
  vehicles: () => garage.all,
  onWorkshop: () => workshop.open(),
  getSettings: () => settings,
  onSetting: setSetting,
  onPlay: (def) => play(def),
  onResume: () => resume(),
  onRebuild: () => { if (rebuildArena()) resume(); },
  onQuit: () => { leaveRoom(); openMainMenu(); },
  onHost: (name) => hostRoom(name),
  onJoin: (code, name) => joinRoom(code, name),
  onLeave: () => { leaveRoom(); toast('You left the room'); resume(); },
  onCopyCode: () => net.code,
  currentVehicle: () => active.def.id,
  onPickVehicle: (def) => { changeVehicle(def); resume(); },
  // Show the chosen mode's map behind the main menu.
  onModePicked: (m) => { if (state === 'menu' && !net.online && m !== mode) enterMode(m); },
});

// --- Custom cars --------------------------------------------------------------
const workshop = new Workshop({
  garage,
  show: (name) => menu.show(name, name === 'workshop' ? 'main' : undefined),
  onPreview: (design) => showPreview(design),
  onSaved: (def) => { syncFleet(); menu.selectVehicle(def.id); setSetting('startVehicle', def.id); },
  onDeleted: () => { syncFleet(); menu.selectVehicle(active.def.id); },
  onTestDrive: (def) => { showPreview(null); play(fleet.find((v) => v.def.id === def.id)?.def); },
});

/** Match the fleet to the garage after custom cars are saved or deleted. */
function syncFleet() {
  const defs = garage.all;
  const activeId = active.def.id;
  for (const v of [...fleet]) {
    if (defs.includes(v.def)) continue;
    if (v.parked) destruction.removeVehicle(v.parked);
    scene.remove(v.model.root);
    v.model.dispose();
    fleet.splice(fleet.indexOf(v), 1);
  }
  for (const def of defs) {
    if (fleet.some((v) => v.def === def)) continue;
    const model = new CarModel(def);
    model.root.visible = false;
    scene.add(model.root);
    fleet.push({ def, model, parked: null });
  }
  fleet.sort((a, b) => defs.indexOf(a.def) - defs.indexOf(b.def));
  const next = fleet.find((v) => v.def.id === activeId) || fleet[0];
  if (next !== active) {
    active = next;
    car = new CarPhysics({ ...active.def.spec, assists: settings.assists }, terrain);
  }
  arenaDirty = true; // park new cars (and drop deleted ones) on the next Play
}

/** Tell the other players what our custom car looks like (built-ins they already know). */
function announceCar(def) {
  if (net.online && def.custom) net.sendEvent({ type: 'cardef', car: def.design });
}

// The workshop preview: the design being edited, on a turntable in a
// showroom of its own (a separate scene, so no map scenery, parked cars or
// stadium stands can get between the camera and the car).
const SHOWROOM = { x: 0, z: 0 };
let preview = null; // { model, def }
let previewSpin = 0;
let showroom = null;

function buildShowroom() {
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x1b1f27);
  room.fog = new THREE.Fog(0x1b1f27, 18, 45);
  room.add(new THREE.HemisphereLight(0xe8eefc, 0x2a2622, 1.1));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
  key.position.set(-6, 10, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.03;
  room.add(key);
  const rim = new THREE.DirectionalLight(0x9fc6ff, 1.2);
  rim.position.set(6, 4, -8);
  room.add(rim);
  // Floor and a turntable disc with a light ring round its edge.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.06; // below the turntable's top, so they don't fight
  floor.receiveShadow = true;
  room.add(floor);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.3, 0.06, 64), new THREE.MeshStandardMaterial({ color: 0x3a3f49, roughness: 0.7 }));
  disc.position.y = -0.03;
  disc.receiveShadow = true;
  room.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.25, 0.03, 8, 96), new THREE.MeshBasicMaterial({ color: 0xffd23f, toneMapped: false }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.01;
  room.add(ring);
  return room;
}

function showPreview(design) {
  if (preview) {
    showroom.remove(preview.model.root);
    preview.model.dispose();
    preview = null;
  }
  if (!design) {
    camera.clearViewOffset();
    return;
  }
  const def = compileCar(design, SHOWROOM, false);
  const model = new CarModel(def);
  showroom ||= buildShowroom();
  showroom.add(model.root);
  preview = { model, def, pose: { x: SHOWROOM.x, y: 0, z: SHOWROOM.z, heading: 0, pitch: 0, roll: 0, velX: 0, velZ: 0, vLong: 0, steer: 0, braking: 0, handbrake: false, gear: 1, boosting: false, airborne: false, accelLat: 0, accelLong: 0, frontWheelSpeed: 0, rearWheelSpeed: 0, spec: def.spec } };
  model.update(preview.pose, 0);
}

/** Orbit the camera round the preview car, with the car shifted right of the menu. */
function updatePreview(dt) {
  if (menu.current !== 'editor') { showPreview(null); return; }
  previewSpin += dt * 0.35;
  const { def } = preview;
  const dist = Math.max(6.5, def.length * 1.5 + def.spec.body.top);
  camera.position.set(SHOWROOM.x + Math.sin(previewSpin) * dist, 1.6 + def.spec.body.top * 0.5, SHOWROOM.z + Math.cos(previewSpin) * dist);
  camera.lookAt(SHOWROOM.x, def.spec.body.top * 0.45, SHOWROOM.z);
  const w = innerWidth, h = innerHeight;
  if (w > 760) camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
  else camera.clearViewOffset();
  preview.model.update(preview.pose, dt);
}

function play(def) {
  audio.start();
  audio.setPaused(false);
  const chosen = fleet.find((v) => v.def === def) || active;
  // Online, the room's mode wins (the host picked it).
  const wanted = net.online && !net.isHost ? net.mode : menu.mode;
  if (chosen !== active) {
    for (const v of fleet) setTeamGlow(v.model, v.def, null);
    active = chosen;
    car = new CarPhysics({ ...active.def.spec, assists: settings.assists }, terrain);
    arenaDirty = true;
  }
  if (wanted !== mode) {
    setMode(wanted);
    arenaDirty = true;
  }
  if (arenaDirty || mode === 'football') {
    resetAll();
  } else {
    resetCar();
  }
  refreshTeamGlows();
  arenaDirty = true;
  announceCar(active.def);
  audio.setVehicle(active.def);
  refreshBadges();
  menu.hide();
  state = 'playing';
  clock.getDelta();
  accumulator = 0;
}

/** Rebuild the arena; online, only the host can, and it rebuilds for everyone. */
function rebuildArena() {
  if (net.online && !net.isHost) {
    toast(mode === 'football' ? 'Only the host can restart the match' : 'Only the host can rebuild the arena');
    return false;
  }
  resetAll();
  arenaDirty = true;
  if (net.online) net.sendEvent({ type: 'rebuild' });
  toast(mode === 'football' ? 'New match' : 'Arena rebuilt');
  return true;
}

// --- Online play -------------------------------------------------------------
net.on('joined', (id, name, vehicle, design) => {
  if (id === net.id) return;
  if (design) garage.addRemote(design); // their custom car
  mp.addPlayer(id, name, vehicle);
  announceCar(active.def); // and ours, if custom, for the newcomer
  toast(`${name} joined`);
  updateNames();
  if (net.isHost && mode === 'football') assignTeam(id);
  // Give everyone the same fresh arena when someone new arrives.
  if (net.isHost) {
    resetAll();
    arenaDirty = true;
    net.sendEvent({ type: 'rebuild' });
  }
  refreshPlayers();
});
net.on('left', (id) => {
  const p = mp.remotes.get(id);
  mp.removePlayer(id);
  if (p) toast(`${p.name} left`);
  if (net.isHost) football.teams.delete(id);
  refreshPlayers();
});
net.on('state', (id, s) => mp.onState(id, s));
net.on('ball', (id, b) => { if (mode === 'football') football.takeBall(id, b); });
net.on('match', (m) => {
  if (mode !== 'football' || net.isHost) return;
  football.applySnapshot(m, performance.now() < ownTouchUntil);
});
net.on('event', (id, e) => {
  if (e.type === 'cardef') {
    // A player's custom car (new or edited): rebuild their model if they're in it.
    const def = garage.addRemote(e.car);
    const r = mp.remotes.get(id);
    if (def && r && r.def.id === def.id && r.def !== def) mp.addPlayer(id, r.name, def.id);
    return;
  }
  if (e.type === 'hit' && e.to === net.id) {
    // Another player hit us: take their impulse now, unless we already
    // resolved this contact ourselves a moment ago.
    const now = performance.now() / 1000;
    if (now - (lastContact.get(id) || -1) < 0.25) return;
    lastHitFrom.set(id, now);
    const m = car.spec.mass;
    applyToCar(car, m, m * car.spec.inertiaScale, e.jx, e.jz, e.px, e.pz);
    collisionFx(Math.hypot(e.jx, e.jz) / m, e.px, e.pz);
    return;
  }
  if (e.type === 'rebuild' && id === 'host') {
    resetAll();
    arenaDirty = true;
    toast(mode === 'football' ? 'New match' : 'The host rebuilt the arena');
  }
});
net.on('hostLeft', () => {
  net.leave(); // so the rest of this runs as solo
  mp.clear();
  toast('The host left. You are playing solo now.');
  updateOnlineUi();
  enterMode(mode);
});

async function hostRoom(name) {
  setSetting('playerName', name);
  menu.setOnlineStatus('Creating a room…');
  try {
    await net.host(name, menu.vehicle.id, menu.mode, menu.vehicle.custom ? menu.vehicle.design : null);
    slot = 0;
    startOnline();
  } catch (err) {
    menu.setOnlineStatus(err.message, true);
  }
}

async function joinRoom(code, name) {
  if (!code.trim()) {
    menu.setOnlineStatus('Type the room code your friend gave you.', true);
    return;
  }
  setSetting('playerName', name);
  menu.setOnlineStatus('Joining…');
  try {
    await net.join(code, name, menu.vehicle.id, menu.vehicle.custom ? menu.vehicle.design : null);
    slot = Math.max(1, net.players.size - 1);
    startOnline();
  } catch (err) {
    menu.setOnlineStatus(err.message, true);
  }
}

function startOnline() {
  menu.setOnlineStatus('');
  arenaDirty = true; // start from a fresh arena
  football.teams = new Map();
  setMode(net.mode);
  play(menu.vehicle);
  updateOnlineUi();
  toast(net.isHost ? `Room ${net.code} created: share the code` : `Joined room ${net.code}`);
}

function leaveRoom() {
  if (!net.online) return;
  net.leave();
  mp.clear();
  updateOnlineUi();
  enterMode(menu.mode);
}

function updateOnlineUi() {
  document.body.classList.toggle('online', net.online);
  $('room-code').textContent = net.code || '';
  menu.setOnline(net.online, net.code, net.isHost, mode);
  refreshPlayers();
}

let playersTimer = 0;
let playersSig = '';
function refreshPlayers() {
  const list = $('players');
  if (!net.online) { list.hidden = true; return; }
  list.hidden = false;
  const fb = mode === 'football';
  const color = (id, def) => (fb ? TEAM_COLORS[football.teams.get(id) ?? 0] : def.swatch ?? def.color);
  const pts = (id, n) => (fb ? football.goals.get(id) || 0 : n);
  const rows = [{ name: `${settings.playerName || 'You'} (you)`, color: color(net.id, active.def), smashed: pts(net.id, score.points) }];
  for (const r of mp.remotes.values()) rows.push({ name: r.name, color: color(r.id, r.def), smashed: pts(r.id, r.smashed) });
  refreshTeamGlows();
  rows.sort((a, b) => b.smashed - a.smashed);
  // Only touch the page when something shown actually changed.
  const sig = JSON.stringify(rows);
  if (sig === playersSig) return;
  playersSig = sig;
  const ul = $('players-list');
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.background = `#${r.color.toString(16).padStart(6, '0')}`;
    const name = document.createElement('span');
    name.textContent = r.name;
    const val = document.createElement('b');
    val.textContent = r.smashed.toLocaleString('en-US');
    li.append(dot, name, val);
    return li;
  }));
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  audio.setPaused(true);
  menu.show('pause');
}

function resume() {
  menu.hide();
  state = 'playing';
  audio.start();
  audio.setPaused(false);
  clock.getDelta(); // don't count the time spent paused
  accumulator = 0;
}

function openMainMenu() {
  state = 'menu';
  audio.setPaused(true);
  menu.show('main');
}

/**
 * One network tick (20 per second): send our car, and as host, everyone's
 * newest cars plus the football match in one bundle per player. Keeps the
 * leftover time so the rate doesn't sag with the frame rate.
 */
function netTick(dt) {
  netTimer -= dt;
  if (netTimer > 0) return;
  netTimer = Math.max(0, netTimer + SEND_INTERVAL);
  const own = mp.encode(car, active.def.id, score.points);
  if (net.isHost) {
    net.flush(own, mode === 'football' ? football.snapshot(++matchTicks % 10 === 0) : null);
  } else {
    if (own) net.sendState(own);
    if (mode === 'football' && performance.now() < ownTouchUntil) net.sendBall(football.ballMessage());
  }
}
let matchTicks = 0;

/** Flame particles and roar for every firing flamethrower; our fuel gauge. */
function updateFlames(dt) {
  let roar = 0;
  if (car.firing) {
    nozzle(car, active.def.flamethrower.mount, _nz);
    flames.emit('me', _nz.pos, _nz.dir, { x: car.velX, z: car.velZ }, dt);
    roar = 1;
  }
  for (const rm of mp.remotes.values()) {
    if (!rm.proxy.firing || !rm.def.flamethrower || !rm.seen) continue;
    nozzle(rm.proxy, rm.def.flamethrower.mount, _nz);
    flames.emit(rm.id, _nz.pos, _nz.dir, { x: rm.proxy.velX, z: rm.proxy.velZ }, dt);
    roar = Math.max(roar, 1 / (1 + (Math.hypot(rm.proxy.x - car.x, rm.proxy.z - car.z) / 15) ** 2));
  }
  flames.update(dt);
  audio.flame(roar);
  if (car.firing) quake.floor(0.12);
  hud.fuelFill.style.width = `${tank.level * 100}%`;
  hud.fuelFill.classList.toggle('empty', tank.empty);
}

/** Points, multiplier and combo timer (free roam). */
function updateScoreHud(dt) {
  score.update(dt);
  hud.scorePanel.hidden = mode !== 'free';
  hud.points.textContent = score.points.toLocaleString('en-US');
  hud.mult.textContent = `×${score.mult}`;
  hud.mult.dataset.level = Math.min(10, score.mult);
  hud.scorePanel.classList.toggle('combo', score.combo > 0);
  hud.comboFill.style.width = `${Math.max(0, score.timer / COMBO_WINDOW) * 100}%`;
  hud.comboCount.textContent = score.combo > 0 ? `${score.combo} smashed` : '';
  const since = performance.now() - score.gainAt;
  hud.gain.textContent = since < 700 ? `+${score.lastGain.toLocaleString('en-US')}` : '';
}

/** Gameplay keys only act while driving. */
const playing = (fn) => () => { if (state === 'playing') fn(); };

input.onPress('Escape', () => {
  if (state === 'playing') pause();
  else if (state === 'paused' && menu.current === 'pause') resume();
  else if (['options', 'controls', 'garage'].includes(menu.current)) menu.back();
});
input.onPress('KeyP', () => { if (state === 'playing') pause(); else if (state === 'paused' && menu.current === 'pause') resume(); });
input.onPress('KeyR', playing(() => { resetCar(); toast('Car reset'); }));
input.onPress('KeyB', playing(() => rebuildArena()));
input.onPress('KeyC', playing(() => { chase.cycle(); refreshBadges(); toast(`Camera: ${chase.modeName}`); }));
input.onPress('KeyE', playing(enterNearby));
input.onPress('KeyV', () => {
  if (state === 'playing') { pause(); menu.showGarage(); }
  else if (menu.current === 'garage') resume();
});
input.onPress('KeyT', playing(() => {
  setSetting('assists', !settings.assists);
  toast(settings.assists ? 'Assists ON (traction + countersteer)' : 'Assists OFF: full drift mode');
}));
input.onPress('KeyY', playing(toggleBallCam));
input.onPress('KeyM', () => { setSetting('sound', !settings.sound); toast(settings.sound ? 'Sound on' : 'Sound off'); });
input.onPress('KeyF', playing(() => hud.telemetry.classList.toggle('hidden')));
input.onPress('KeyH', playing(() => $('help').classList.toggle('hidden')));

function toggleBallCam() {
  if (mode !== 'football') return;
  ballCam = !ballCam;
  chase.focus = ballCam ? football.mesh.position : null;
  toast(ballCam ? 'Ball cam on' : 'Ball cam off');
}

function enterNearby() {
  const v = nearbyVehicle();
  if (v) switchTo(v);
}

// Menu buttons click (and the first click unlocks audio).
$('menu').addEventListener('click', (e) => {
  if (!e.target.closest('button')) return;
  audio.start();
  audio.ui();
});

const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) {
  document.body.classList.add('touch');
  for (const el of document.querySelectorAll('[data-touch]')) input.bindTouchButton(el, el.dataset.touch);
  $('touch-cam').addEventListener('click', () => { chase.cycle(); refreshBadges(); });
  $('touch-reset').addEventListener('click', resetCar);
  $('touch-pause').addEventListener('click', pause);
  $('touch-enter').addEventListener('click', enterNearby);
  $('touch-garage').addEventListener('click', () => { pause(); menu.showGarage(); });
  $('touch-ballcam').addEventListener('click', toggleBallCam);
}

// Pause when the tab is hidden (also where an ad break would hook in).
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// Keep the car on the lot: a soft wall just outside the barrier ring.
function containLot(c) {
  let hit = 0;
  for (const axis of ['x', 'z']) {
    const vel = axis === 'x' ? 'velX' : 'velZ';
    if (Math.abs(c[axis]) > DRIVE_LIMIT) {
      c[axis] = Math.sign(c[axis]) * DRIVE_LIMIT;
      if (Math.sign(c[vel]) === Math.sign(c[axis])) {
        hit = Math.max(hit, Math.abs(c[vel]));
        c[vel] *= -0.3;
        c.yawRate *= 0.5;
      }
    }
  }
  return hit;
}

function containCar() {
  const hit = map.contain(car);
  if (hit > 3) {
    quake.kick(hit * 0.03);
    audio.impact('crash', Math.min(1, hit / 20));
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

  // Online, the world keeps running behind the pause menu (others are still
  // driving); our own car just gets no input.
  const simulate = state === 'playing' || (state === 'paused' && net.online);
  if (simulate) {
    const frozen = mode === 'football' && football.phase === 'kickoff';
    const idle = { steer: 0, throttle: 0, brake: 0, handbrake: true, boost: false, jump: false };
    const inputNow = state === 'playing' && !frozen ? controls : idle;
    // Flamethrower: fuel and firing, once per frame.
    car.firing = tank.update(dt, !!(active.def.flamethrower && inputNow.fire));
    accumulator += dt;
    let steps = 0;
    while (accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      car.aerial = mode === 'football'; // jumps, flips and air control
      car.step(PHYSICS_DT, inputNow);
      containCar();
      if (bot) {
        bot.car.aerial = true;
        if (frozen) Object.assign(bot.input, idle);
        else bot.think(football.ball, PHYSICS_DT);
        bot.step(PHYSICS_DT);
        map.contain(bot.car);
      }
      resolveCarCollisions();
      if (car.landed) onLanding(car.landed);
      if (car.blocked > 3) {
        quake.kick(car.blocked * 0.03);
        audio.impact('crash', Math.min(1, car.blocked / 15));
      }
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
    if (net.online) {
      mp.update(dt);
      netTick(dt);
      playersTimer -= dt;
      if (playersTimer <= 0) { playersTimer = 0.5; refreshPlayers(); }
    }
    updateScene(dt);
  } else if (state === 'menu') {
    if (preview) {
      updatePreview(dt);
    } else {
      // Slow orbit over the arena behind the main menu.
      menuOrbit += dt * 0.06;
      const { radius, height } = map.orbit;
      camera.position.set(Math.sin(menuOrbit) * radius, height, Math.cos(menuOrbit) * radius);
      camera.lookAt(0, 2, 0);
    }
    destruction.sync();
    if (mode === 'football') football.syncMesh();
    if (bot) bot.model.update(bot.car, 0);
    for (const v of fleet) if (v.parked) v.model.updateParked(v.parked.body, dt);
    active.model.update(car, 0);
    if (!preview) world.followSun(new THREE.Vector3(0, 0, 0));
  }
  // Paused: redraw the frozen frame only a few times a second (enough to
  // show settings changes behind the menu) to save battery.
  if (state === 'paused' && !net.online) {
    pausedRedraw -= raw;
    if (pausedRedraw > 0) return;
    pausedRedraw = 0.25;
  }
  renderer.render(preview && state === 'menu' ? showroom : scene, camera);
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

// --- Car-to-car collisions ------------------------------------------------
// Car footprints for collisions, worked out once per vehicle definition.
const footprintCache = new WeakMap();
const footprints = { get: (def) => footprintCache.get(def) || footprintCache.set(def, footprint(def)).get(def) };
const lastContact = new Map(); // remote id -> time we last resolved a hit with them
const lastHitFrom = new Map(); // remote id -> time they last sent us a hit
const _hitQ = new THREE.Quaternion();
const _hitFwd = new THREE.Vector3();

/** Our car as a collision body. */
function myBody() {
  const m = car.spec.mass;
  return {
    x: car.x, z: car.z, y: car.y, heading: car.heading, velX: car.velX, velZ: car.velZ,
    yawRate: car.yawRate, mass: m, inertia: m * car.spec.inertiaScale, fp: footprints.get(active.def),
  };
}

/**
 * Resolve our car against parked vehicles (solo) and other players' cars
 * (online), with momentum-conserving impulses. Runs every physics step.
 */
function resolveCarCollisions() {
  // Parked vehicles are Rapier bodies: push both, by mass.
  for (const v of fleet) {
    if (!v.parked) continue;
    const body = v.parked.body;
    const t = body.translation();
    const r = body.rotation();
    _hitFwd.set(0, 0, 1).applyQuaternion(_hitQ.set(r.x, r.y, r.z, r.w));
    const lv = body.linvel();
    const fp = footprints.get(v.def);
    const mass = body.mass();
    const B = { x: t.x, z: t.z, y: t.y, heading: Math.atan2(_hitFwd.x, _hitFwd.z), velX: lv.x, velZ: lv.z, yawRate: body.angvel().y, mass, inertia: yawInertia(mass, fp), fp };
    const A = myBody();
    const c = overlap(A, B);
    if (!c) continue;
    // Separate them in proportion to their masses.
    const share = (1 / A.mass) / (1 / A.mass + 1 / B.mass);
    car.x += c.nx * c.depth * share;
    car.z += c.nz * c.depth * share;
    body.setTranslation({ x: t.x - c.nx * c.depth * (1 - share), y: t.y, z: t.z - c.nz * c.depth * (1 - share) }, true);
    const imp = contactImpulse(A, B, c);
    if (!imp) continue;
    applyToCar(car, A.mass, A.inertia, imp.jx, imp.jz, c.px, c.pz);
    body.applyImpulseAtPoint({ x: -imp.jx, y: 0, z: -imp.jz }, { x: c.px, y: t.y + fp.top * 0.4, z: c.pz }, true);
    collisionFx(imp.speed, c.px, c.pz);
  }

  // The solo football bot: both cars are ours to push.
  if (bot) {
    const bc = bot.car;
    const fp = footprints.get(bot.def);
    const mass = bc.spec.mass;
    const B = { x: bc.x, z: bc.z, y: bc.y, heading: bc.heading, velX: bc.velX, velZ: bc.velZ, yawRate: bc.yawRate, mass, inertia: mass * bc.spec.inertiaScale, fp };
    const A = myBody();
    const c = overlap(A, B);
    if (c) {
      const share = (1 / A.mass) / (1 / A.mass + 1 / B.mass);
      car.x += c.nx * c.depth * share;
      car.z += c.nz * c.depth * share;
      bc.x -= c.nx * c.depth * (1 - share);
      bc.z -= c.nz * c.depth * (1 - share);
      const imp = contactImpulse(A, B, c);
      if (imp) {
        applyToCar(car, A.mass, A.inertia, imp.jx, imp.jz, c.px, c.pz);
        applyToCar(bc, B.mass, B.inertia, -imp.jx, -imp.jz, c.px, c.pz);
        collisionFx(imp.speed, c.px, c.pz);
      }
    }
  }

  // Other players: we can only move our own car; the hit is sent to them.
  if (!net.online) return;
  const now = performance.now() / 1000;
  for (const r of mp.collisionTargets(car.x, car.z)) {
    const fp = footprints.get(r.def);
    const mass = r.def.spec.mass;
    const B = { ...r, mass, inertia: yawInertia(mass, fp), fp };
    const A = myBody();
    const c = overlap(A, B);
    if (!c) continue;
    const share = (1 / A.mass) / (1 / A.mass + 1 / B.mass);
    car.x += c.nx * c.depth * share;
    car.z += c.nz * c.depth * share;
    if (now - (lastHitFrom.get(r.id) || -1) < 0.25) continue; // they already hit us
    const imp = contactImpulse(A, B, c);
    if (!imp) continue;
    lastContact.set(r.id, now);
    applyToCar(car, A.mass, A.inertia, imp.jx, imp.jz, c.px, c.pz);
    net.sendEvent({ type: 'hit', to: r.id, jx: -imp.jx, jz: -imp.jz, px: c.px, pz: c.pz });
    collisionFx(imp.speed, c.px, c.pz);
  }
}

let collisionFxCooldown = 0;
/** Crunch, shake and dust, scaled by the closing speed. */
function collisionFx(speed, px, pz) {
  if (speed < 1.2) return;
  const now = performance.now();
  if (now < collisionFxCooldown) return;
  collisionFxCooldown = now + 120;
  const pos = { x: px, y: (car.y || 0) + 0.6, z: pz };
  audio.impact('crash', Math.min(1, speed / 14));
  audio.impact('metal', Math.min(1, speed / 18), pos);
  quake.kick(speed * 0.05);
  const puffs = settings.effects === 'high' ? 4 : 2;
  for (let i = 0; i < puffs; i++) dust.emit(pos, { x: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, Math.min(1, speed / 12), pos.y);
}

/** Touchdown: thump, shake, dust off the wheels, and boost for big air. */
function onLanding({ impact, misalign, airTime }) {
  if (impact > 2.5) {
    quake.kick(impact * 0.035 + misalign * 0.2);
    audio.impact('crash', Math.min(1, impact / 14 + misalign * 0.3));
    active.model.contactPoints(contacts);
    for (const p of contacts) dust.emit(p, { x: car.velX * 0.3, z: car.velZ * 0.3 }, Math.min(1, impact / 12), terrain.heightAt(p.x, p.z) + 0.2);
  }
  if (airTime > 0.6) {
    car.boost = Math.min(1, car.boost + airTime * 0.08);
    if (misalign < 0.6 && mode !== 'football') toast(`Clean landing: ${airTime.toFixed(1)} s of air`);
  }
}

function stepWorld() {
  const r = destruction.step(car);
  // Flamethrowers (ours and other players') set fire to what they reach.
  if (car.firing) {
    nozzle(car, active.def.flamethrower.mount, _nz);
    destruction.flameSweep(_nz.pos, _nz.dir, WORLD_STEP, _nz.pos);
  }
  for (const rm of mp.remotes.values()) {
    if (!rm.proxy.firing || !rm.def.flamethrower || !rm.seen) continue;
    nozzle(rm.proxy, rm.def.flamethrower.mount, _nz);
    destruction.flameSweep(_nz.pos, _nz.dir, WORLD_STEP, _nz.pos);
  }
  if (mode === 'football') football.step(WORLD_STEP);
  if (r.total > 0) {
    const dv = car.applyImpulse(r.jx, r.jz, r.torque);
    quake.kick(dv * 0.12);
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
  if (bot) bot.model.update(bot.car, dt);
  if (mode === 'football') {
    stadium.update(dt);
    if (football.phase === 'kickoff') {
      const n = Math.ceil(football.timer);
      if (n !== lastBeep && n >= 1 && n <= 3) { lastBeep = n; audio.beep(); }
    }
  }
  for (const v of fleet) if (v.parked) v.model.updateParked(v.parked.body, dt);
  const near = car.speed < 8 ? nearbyVehicle() : null;
  hud.prompt.classList.toggle('show', !!near);
  if (near) hud.prompt.innerHTML = `<kbd>E</kbd> Drive the ${near.def.name.toLowerCase()}`;

  // Tire effects.
  active.model.contactPoints(contacts);
  for (const p of contacts) p.y = terrain.heightAt(p.x, p.z);
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
    skids.add(i, p, car.airborne ? 0 : s);
    if (!front && s > 0.35 && Math.random() < s * smokeRate) smoke.emit(p, { x: car.velX, z: car.velZ }, s);
    squeal = Math.max(squeal, s);
  });
  smoke.update(dt);
  dust.update(dt);
  soot.update(dt);
  burnFx.update(dt);
  audio.update(car, squeal);
  if (car.boosting) quake.floor(0.18);
  hud.boostFill.style.width = `${car.boost * 100}%`;
  updateFlames(dt);
  updateScoreHud(dt);
  hud.boostFill.classList.toggle('on', car.boosting);

  chase.update(car, dt);
  quake.apply(camera, dt);
  world.followSun(active.model.root.position);
  audio.setListener(camera);
  football.update(dt, camera);

  // HUD.
  hud.speed.textContent = Math.round(speed * 3.6);
  hud.gear.textContent = car.gearLabel;
  hud.smashed.textContent = smashed;
  const rpmT = (car.rpm - car.spec.idleRpm) / (car.spec.redline - car.spec.idleRpm);
  hud.rpmFill.style.width = `${Math.max(0, Math.min(1, rpmT)) * 100}%`;
  hud.rpmFill.classList.toggle('red', car.rpm > car.spec.shiftUpRpm - 300);

  if (car.airborne && !car.tumbling && car.airTime > 0.35) {
    hud.drift.innerHTML = `AIR <b>${car.airTime.toFixed(1)}s</b><small>${Math.round(car.y)} m up</small>`;
    hud.drift.classList.add('show');
    driftTimer = 1.4;
  } else if (car.isDrifting) {
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
      `quake      ${quake.level.toFixed(2).padStart(6)}  (activity ${quake.activity.toFixed(1)})\n` +
      `res scale  ${pixelRatio().toFixed(2).padStart(6)}`;
  }
}

setMode(menu.mode);
buildArena();
resetCar();
resetBot();
applySettings();
openMainMenu();

window.game = {
  get car() { return car; }, get active() { return active; }, get state() { return state; }, net, mp,
  get renderer() { return renderer; }, get settings() { return settings; },
  fleet, chase, scene, destruction, switchTo, nearbyVehicle, setSetting, menu, quake, score, tank,
  football, get bot() { return bot; }, get mode() { return mode; }, enterMode, garage,
};
requestAnimationFrame(frame);
