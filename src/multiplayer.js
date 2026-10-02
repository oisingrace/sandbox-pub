import * as THREE from 'three';
import { CarModel } from './carModel.js';

// Other players' cars. Each one is drawn from network snapshots, smoothed by
// rendering slightly in the past and interpolating between the two
// snapshots around that moment. Each also has a kinematic body in our own
// physics world, so their crashes, burns and explosions happen on our
// screen too. Debris is simulated locally on every computer, so it can land
// a little differently for each player.
//
// Snapshots carry the sender's own clock, so they're placed on the timeline
// by when they were *sent*, not when they happened to arrive: network
// jitter doesn't turn into stutter. How far in the past we draw adapts to
// how jittery each player's connection is.

export const SEND_INTERVAL = 1 / 20;
const IDLE_INTERVAL = 0.25;  // a parked car only needs a few updates a second
const MIN_DELAY = 0.07;      // seconds behind real time we draw remote cars...
const MAX_DELAY = 0.3;       // ...stretched up to this on jittery connections
const MAX_EXTRAPOLATE = 0.25;

// Car state on the wire is a flat array (about half the size of an object
// with named keys):
//   [time ms, vehicle, x, y, z, heading, pitch, roll, velX, velY, velZ,
//    vLong, steer, flags (1 boost, 2 airborne, 4 braking, 8 handbrake, 16 flamethrower), gear, points]

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
    this.lastSent = null;
    this.lastSentAt = -1;
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
    const remote = { id, name, def, model, proxy, snaps: [], smashed: 0, seen: false, offset: null, jitter: 0, delay: 0.1, lastTs: -1 };
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
  onState(id, arr) {
    let r = this.remotes.get(id);
    if (!r || !Array.isArray(arr)) return;
    const ts = arr[0];
    if (ts <= r.lastTs) {
      // Overtaken by a newer update on the unordered channel: slot it into
      // place if it's still useful for interpolation, else drop it.
      if (r.offset === null || !r.snaps.length || ts / 1000 + r.offset <= r.snaps[0].t) return;
      const s = decodeState(arr);
      s.t = ts / 1000 + r.offset;
      const i = r.snaps.findIndex((o) => o.t >= s.t);
      if (i >= 0 && r.snaps[i].t !== s.t) r.snaps.splice(i, 0, s);
      return;
    }
    r.lastTs = ts;
    const s = decodeState(arr);
    if (s.v !== r.def.id) {
      // They changed vehicle: keep the timing we've learned about them.
      const keep = { offset: r.offset, jitter: r.jitter, delay: r.delay, lastTs: r.lastTs };
      r = Object.assign(this.addPlayer(id, r.name, s.v), keep);
    }
    // Map their clock onto ours. The smallest (now - sent) seen is their
    // clock offset plus the quickest delivery; anything above it is jitter.
    const now = performance.now() / 1000;
    const sample = now - ts / 1000;
    if (r.offset === null || sample < r.offset) r.offset = sample;
    else r.offset += (sample - r.offset) * 0.002; // follow slow clock drift
    // Peak-hold jitter: jumps toward a late arrival, then fades over seconds.
    const late = sample - r.offset;
    r.jitter = late > r.jitter ? (late + r.jitter) / 2 : r.jitter * 0.995;
    s.t = ts / 1000 + r.offset;
    r.snaps.push(s);
    if (r.snaps.length > 30) r.snaps.splice(0, r.snaps.length - 30);
    r.smashed = s.sm;
  }

  /** Move remote cars to where they were a moment ago (see delay). */
  update(dt) {
    const now = performance.now() / 1000;
    for (const r of this.remotes.values()) {
      const snaps = r.snaps;
      if (!snaps.length) continue;
      // Draw far enough back to cover the gap between updates plus this
      // connection's jitter. The delay changes slowly so remote cars never
      // visibly speed up or slow down: it grows at up to 10% of real time
      // (when updates are arriving late) and shrinks at 1%.
      const target = Math.min(MAX_DELAY, Math.max(MIN_DELAY, SEND_INTERVAL + 0.015 + r.jitter));
      const diff = target - r.delay;
      r.delay += Math.max(-0.01 * dt, Math.min(0.1 * dt, diff));
      const rt = now - r.delay;
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
        // Wrapped, so flips and rolls through ±180° turn the short way.
        p.pitch = a.p + wrapMp(b.p - a.p) * k;
        p.roll = a.r + wrapMp(b.r - a.r) * k;
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
      p.firing = !!latest.fi;
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

  /**
   * Our own car's state for this network tick, or null when it's parked
   * and nothing changed (then it's only sent every IDLE_INTERVAL).
   */
  encode(car, vehicleId, smashed) {
    const now = performance.now();
    const flags = (car.boosting ? 1 : 0) | (car.airborne ? 2 : 0) | (car.braking > 0.05 ? 4 : 0) | (car.handbrake ? 8 : 0)
      | (car.firing ? 16 : 0);
    const s = [
      Math.round(now), vehicleId,
      round(car.x), round(car.y || 0), round(car.z), round(car.heading), round(car.pitch || 0), round(car.roll || 0),
      round(car.velX), round(car.velY || 0), round(car.velZ), round(car.vLong), round(car.steer),
      flags, car.gear, smashed,
    ];
    const last = this.lastSent;
    const still = last && Math.hypot(car.velX, car.velZ) < 0.05 && Math.abs(car.velY || 0) < 0.05
      && s.every((v, i) => i === 0 || v === last[i]);
    if (still && now - this.lastSentAt < IDLE_INTERVAL * 1000) return null;
    this.lastSent = s;
    this.lastSentAt = now;
    return s;
  }

  /**
   * Where each remote car near (x, z) is *now* (not where it's drawn, a bit behind):
   * its latest snapshot carried forward by its velocity. Used for car-to-car
   * collisions so hits line up with what the other player sees.
   */
  collisionTargets(x, z, range = 14) {
    const out = [];
    const now = performance.now() / 1000;
    for (const r of this.remotes.values()) {
      const s = r.snaps[r.snaps.length - 1];
      if (!r.seen || !s || Math.abs(s.x - x) > range || Math.abs(s.z - z) > range) continue;
      const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, now - s.t));
      out.push({
        id: r.id, def: r.def,
        x: s.x + s.vx * ahead, z: s.z + s.vz * ahead, y: s.y,
        heading: s.h, velX: s.vx, velZ: s.vz, yawRate: 0,
      });
    }
    return out;
  }
}

function decodeState(a) {
  const f = a[13];
  return {
    v: a[1], x: a[2], y: a[3], z: a[4], h: a[5], p: a[6], r: a[7],
    vx: a[8], vy: a[9], vz: a[10], vl: a[11], st: a[12],
    b: f & 1, a: f & 2, br: f & 4, hb: f & 8, fi: f & 16, g: a[14], sm: a[15] || 0,
  };
}

function makeProxy(def) {
  return {
    x: 0, y: -50, z: 0, heading: 0, pitch: 0, roll: 0,
    velX: 0, velZ: 0, vLong: 0, steer: 0, braking: 0, handbrake: false, gear: 1,
    boosting: false, airborne: false, landed: null, accelLat: 0, accelLong: 0,
    frontWheelSpeed: 0, rearWheelSpeed: 0, spec: def.spec,
  };
}

/** Floating name label above a car (dot in `color`, or the car's colour). */
export function nameTag(name, def, color) {
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
  g.fillStyle = `#${(color ?? def.swatch ?? def.color).toString(16).padStart(6, '0')}`;
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
