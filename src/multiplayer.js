import * as THREE from 'three';
import { CarModel } from './carModel.js';

// Other players' cars. Each one is drawn from network snapshots, smoothed by
// rendering slightly in the past (INTERP_DELAY) and interpolating between
// the two snapshots around that moment. Each also has a kinematic body in
// our own physics world, so their crashes, burns and explosions happen on
// our screen too. Debris is simulated locally on every computer, so it can
// land a little differently for each player.

const SEND_INTERVAL = 1 / 20;
const INTERP_DELAY = 0.1;   // seconds behind real time we draw remote cars
const MAX_EXTRAPOLATE = 0.25;

/** Start positions in multiplayer: a row along the start line. */
export const SPAWN_SLOTS = [0, -7, 7, -14, 14, -21, 21, -28].map((x) => ({ x, z: -52, heading: 0 }));

const round = (v) => Math.round(v * 100) / 100;
const wrapMp = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Multiplayer {
  constructor({ scene, destruction, vehicles }) {
    this.scene = scene;
    this.destruction = destruction;
    this.vehicles = vehicles;
    this.remotes = new Map();
    this.sendTimer = 0;
    this.clock = 0;
  }

  get count() {
    return this.remotes.size;
  }

  addPlayer(id, name, vehicleId) {
    this.removePlayer(id);
    const def = this.vehicles.find((v) => v.id === vehicleId) || this.vehicles[0];
    const model = new CarModel(def);
    model.root.visible = false;
    const proxy = makeProxy(def);
    const tag = nameTag(name, def);
    const top = Math.max(...def.hitbox.map((h) => h.at[1] + h.half[1]));
    tag.position.set(0, top + 1.1, 0);
    model.root.add(tag);
    this.scene.add(model.root);
    this.destruction.addRemoteCar(id, def, proxy);
    const remote = { id, name, def, model, proxy, snaps: [], smashed: 0, seen: false };
    this.remotes.set(id, remote);
    return remote;
  }

  removePlayer(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.model.root);
    this.destruction.removeRemoteCar(id);
    this.remotes.delete(id);
  }

  clear() {
    for (const id of [...this.remotes.keys()]) this.removePlayer(id);
  }

  /** A state snapshot arrived from another player. */
  onState(id, s) {
    let r = this.remotes.get(id);
    if (!r) return;
    if (s.v && s.v !== r.def.id) r = this.addPlayer(id, r.name, s.v); // they changed vehicle
    r.snaps.push({ t: this.clock, ...s });
    if (r.snaps.length > 30) r.snaps.splice(0, r.snaps.length - 30);
    r.smashed = s.sm || 0;
  }

  /** Move remote cars to where they were INTERP_DELAY ago. */
  update(dt) {
    this.clock += dt;
    const rt = this.clock - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const snaps = r.snaps;
      if (!snaps.length) continue;
      let a = snaps[0];
      let b = null;
      for (let i = snaps.length - 1; i >= 0; i--) {
        if (snaps[i].t <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
      }
      const p = r.proxy;
      if (b) {
        const k = (rt - a.t) / Math.max(1e-6, b.t - a.t);
        p.x = a.x + (b.x - a.x) * k;
        p.y = a.y + (b.y - a.y) * k;
        p.z = a.z + (b.z - a.z) * k;
        p.heading = a.h + wrapMp(b.h - a.h) * k;
        p.pitch = a.p + (b.p - a.p) * k;
        p.roll = a.r + (b.r - a.r) * k;
      } else {
        // Ran out of snapshots: carry on along the last known velocity briefly.
        const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, rt - a.t));
        p.x = a.x + a.vx * ahead;
        p.y = Math.max(0, a.y + a.vy * ahead);
        p.z = a.z + a.vz * ahead;
        p.heading = a.h;
        p.pitch = a.p;
        p.roll = a.r;
      }
      const latest = snaps[snaps.length - 1];
      p.velX = latest.vx;
      p.velZ = latest.vz;
      p.vLong = latest.vl;
      p.steer = latest.st;
      p.boosting = !!latest.b;
      p.airborne = !!latest.a;
      p.braking = latest.br ? 1 : 0;
      p.handbrake = !!latest.hb;
      p.gear = latest.g;
      p.frontWheelSpeed = p.rearWheelSpeed = latest.vl;
      if (!r.seen) {
        // First sighting: place the body directly instead of sweeping it
        // across the map from wherever it started.
        const body = this.destruction.remoteCars?.get(r.id)?.body;
        body?.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
        r.model.root.visible = true;
        r.seen = true;
      }
      r.model.update(p, dt);
    }
  }

  /** Send our own car's state, throttled to SEND_INTERVAL. */
  send(net, car, vehicleId, smashed, dt) {
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = SEND_INTERVAL;
    net.sendState({
      v: vehicleId,
      x: round(car.x), y: round(car.y || 0), z: round(car.z),
      h: round(car.heading), p: round(car.pitch || 0), r: round(car.roll || 0),
      vx: round(car.velX), vy: round(car.velY || 0), vz: round(car.velZ), vl: round(car.vLong),
      st: round(car.steer), b: car.boosting ? 1 : 0, a: car.airborne ? 1 : 0,
      br: car.braking > 0.05 ? 1 : 0, hb: car.handbrake ? 1 : 0, g: car.gear, sm: smashed,
    });
  }

  /**
   * Where each remote car is *now* (not where it's drawn, 100 ms behind):
   * its latest snapshot carried forward by its velocity. Used for car-to-car
   * collisions so hits line up with what the other player sees.
   */
  collisionTargets() {
    const out = [];
    for (const r of this.remotes.values()) {
      const s = r.snaps[r.snaps.length - 1];
      if (!r.seen || !s) continue;
      const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, this.clock - s.t));
      out.push({
        id: r.id, def: r.def,
        x: s.x + s.vx * ahead, z: s.z + s.vz * ahead, y: s.y,
        heading: s.h, velX: s.vx, velZ: s.vz, yawRate: 0,
      });
    }
    return out;
  }
}

function makeProxy(def) {
  return {
    x: 0, y: -50, z: 0, heading: 0, pitch: 0, roll: 0,
    velX: 0, velZ: 0, vLong: 0, steer: 0, braking: 0, handbrake: false, gear: 1,
    boosting: false, airborne: false, landed: null, accelLat: 0, accelLong: 0,
    frontWheelSpeed: 0, rearWheelSpeed: 0, spec: def.spec,
  };
}

/** Floating name label above a remote car. */
function nameTag(name, def) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  const w = Math.min(240, g.measureText(name).width + 40);
  g.fillStyle = 'rgba(12, 14, 18, 0.7)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 8, w, 48, 24);
  g.fill();
  g.fillStyle = `#${(def.swatch ?? def.color).toString(16).padStart(6, '0')}`;
  g.beginPath();
  g.arc((256 - w) / 2 + 22, 32, 7, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f4f5f7';
  g.textBaseline = 'middle';
  g.fillText(name, (256 - w) / 2 + 36, 33, w - 46);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(3.2, 0.8, 1);
  sprite.renderOrder = 10;
  return sprite;
}
