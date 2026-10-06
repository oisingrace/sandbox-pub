import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';

// Computer drivers for free roam and the Motorway. Each has a driving
// style:
//   cruise  just drives about: between random spots on the lot, or along
//           its lane on the Motorway (slowing behind slower cars, changing
//           lanes, turning round at the ends), so there's traffic to crash into
//   smash   goes looking for things to break and drives flat out into them
//   chase   comes after you: lines up, boosts, rams, backs off and comes again
// They drive the same car physics as you and bump, dent and smash like you.

const wrapRb = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clampRb = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const ROAM_STYLES = ['cruise', 'smash', 'chase'];

export class RoamBot {
  /**
   * @param {string} id
   * @param {string} name
   * @param {object} def    vehicle definition
   * @param {object} terrain
   * @param {'cruise'|'smash'|'chase'} style
   */
  constructor(id, name, def, terrain, style) {
    this.id = id;
    this.name = name;
    this.def = def;
    this.style = style;
    // driftAssist 0: the AI is tuned for the plain handling.
    this.car = new CarPhysics({ ...def.spec, assists: true, driftAssist: 0 }, terrain);
    this.model = new CarModel(def);
    this.input = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, jump: false };
    this.stuck = 0;
    this.reversing = 0;
    this.goal = null;
    this.goalTime = 0;
    this.backOff = 0;
    this.lastGoals = [];
    // Motorway: which way and which lane, and a cruising speed of its own (80-125 km/h).
    this.dir = 1;
    this.lane = 1;
    this.cruise = 22 + Math.random() * 12;
    this.laneTimer = 4 + Math.random() * 8;
    this.stillFor = 0;
  }

  /** Put the car down somewhere, facing a way. */
  place(x, z, heading) {
    this.car.reset(x, z, heading);
    this.stuck = this.reversing = this.backOff = 0;
    this.goal = null;
    this.stillFor = 0;
  }

  /**
   * Just crashed into something at `speed` (m/s); `intoPlayer` when it was you.
   * Rammers back off for a moment and then come again.
   */
  crashed(speed, intoPlayer) {
    if (this.style === 'chase' && intoPlayer && speed > 4) this.backOff = 0.9 + Math.random() * 0.6;
    if (this.style === 'smash' && speed > 6) this.goalTime = Math.min(this.goalTime, 0.8); // hit it: pick the next thing soon
  }

  /**
   * Decide this frame's controls.
   * @param {number} dt
   * @param {object} w   { map: 'lot'|'motorway', player: car, cars: [car...], limit, road, targets(bot) }
   */
  think(dt, w) {
    const c = this.car;
    const inp = this.input;
    inp.jump = false;
    let tx, tz, want = 30, charge = false;

    if (this.style === 'chase') {
      const p = w.player;
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (this.backOff > 0) {
        // Back away from the hit, then turn and come again.
        this.backOff -= dt;
        Object.assign(inp, { throttle: 0, brake: 1, steer: 0, handbrake: false, boost: false });
        return;
      }
      const lead = Math.min(1.1, d / 35);
      tx = p.x + (p.velX || 0) * lead;
      tz = p.z + (p.velZ || 0) * lead;
      want = d > 60 ? 60 : 40;
      charge = d < 35;
    } else if (this.style === 'smash') {
      this.goalTime -= dt;
      if (!this.goal || this.goalTime <= 0 || Math.hypot(this.goal.x - c.x, this.goal.z - c.z) < 3) {
        this.goal = w.targets(this) || this.randomSpot(w);
        this.goalTime = 9;
      }
      tx = this.goal.x;
      tz = this.goal.z;
      const d = Math.hypot(tx - c.x, tz - c.z);
      want = d < 40 ? 45 : 35;
      charge = d < 30;
    } else if (w.map === 'motorway') {
      ({ tx, tz, want } = this.laneDrive(dt, w));
    } else {
      if (!this.goal || Math.hypot(this.goal.x - c.x, this.goal.z - c.z) < 10) this.goal = this.randomSpot(w);
      tx = this.goal.x;
      tz = this.goal.z;
      want = this.cruise * 0.75;
    }

    const dx = tx - c.x, dz = tz - c.z;
    const err = wrapRb(Math.atan2(dx, dz) - c.heading);
    const speed = c.speed;

    // Unstick: pushing but not moving for a moment -> reverse out.
    if (this.reversing > 0) {
      this.reversing -= dt;
      Object.assign(inp, { throttle: 0, brake: 1, steer: -Math.sign(err) || 1, handbrake: false, boost: false });
      return;
    }
    if (inp.throttle > 0.5 && speed < 1.5 && !c.airborne) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 0.9) {
      this.stuck = 0;
      this.reversing = 0.8 + Math.random() * 0.6;
      if (this.style !== 'chase') this.goalTime = 0;
      if (w.map === 'lot' && this.style === 'cruise') this.goal = null;
    }
    this.stillFor = speed < 1 ? this.stillFor + dt : 0;

    const sharp = Math.abs(err);
    inp.steer = clampRb(err * 2.4, -1, 1);
    // Slow for corners: the sharper the turn, the lower the speed it wants.
    const cornerSpeed = sharp > 0.35 ? Math.max(9, 30 - sharp * 14) : Infinity;
    const target = Math.min(want, cornerSpeed);
    inp.throttle = speed < target ? 1 : speed < target + 3 ? 0.25 : 0;
    inp.brake = speed > target + 5 ? Math.min(1, (speed - target) / 10) : 0;
    inp.handbrake = sharp > 1.3 && speed > 9 && speed < 26;
    inp.boost = !c.airborne && sharp < 0.15 && charge && c.boost > 0.25 && speed < 50;
  }

  /** A random spot on the lot to drive to. */
  randomSpot(w) {
    const L = (w.limit || 140) - 12;
    if (w.map === 'motorway') {
      const c = this.car;
      return { x: (Math.random() * 2 - 1) * 12, z: clampRb(c.z + (Math.random() * 2 - 1) * 200, -w.road.half + 40, w.road.half - 40) };
    }
    return { x: (Math.random() * 2 - 1) * L, z: (Math.random() * 2 - 1) * L };
  }

  /** Motorway traffic: keep to a lane, keep a gap, change lanes, turn round at the ends. */
  laneDrive(dt, w) {
    const c = this.car;
    const R = w.road;
    // Turn round near the ends (across the open central reservation).
    if (this.dir * c.z > R.half - 110) {
      this.dir = -this.dir;
      this.lane = 0; // come out of the turn in the lane nearest the middle
    }
    const laneX = (k) => this.dir * (R.median + R.lane * (k + 0.5));
    // Changing lanes now and then.
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTimer = 5 + Math.random() * 10;
      const k = clampRb(this.lane + (Math.random() < 0.5 ? -1 : 1), 0, R.lanes - 1);
      if (this.laneClear(w, laneX(k))) this.lane = k;
    }
    // Something slower ahead in the lane: change lanes if there's room, else slow down.
    let want = this.cruise;
    const ahead = this.carAhead(w, laneX(this.lane), 12 + c.speed * 1.4);
    if (ahead) {
      const alt = [this.lane - 1, this.lane + 1].filter((k) => k >= 0 && k < R.lanes);
      const free = alt.find((k) => this.laneClear(w, laneX(k)));
      if (free !== undefined && this.laneTimer < 9) {
        this.lane = free;
        this.laneTimer = 3 + Math.random() * 4;
      } else {
        const theirs = ahead.car.velZ * this.dir;
        want = Math.max(0, Math.min(want, theirs - 1 + (ahead.gap - 10) * 0.25));
      }
    }
    const look = 14 + c.speed * 0.7;
    return { tx: laneX(this.lane), tz: c.z + this.dir * look, want };
  }

  /** The nearest car in front of us within `range` in the lane at `x`. */
  carAhead(w, x, range) {
    const c = this.car;
    let best = null;
    for (const o of w.cars) {
      if (o === c) continue;
      const gap = (o.z - c.z) * this.dir;
      if (gap <= 0 || gap > range || Math.abs(o.x - x) > 2.2) continue;
      if (!best || gap < best.gap) best = { car: o, gap };
    }
    return best;
  }

  laneClear(w, x) {
    const c = this.car;
    for (const o of w.cars) {
      if (o === c) continue;
      const gap = (o.z - c.z) * this.dir;
      if (Math.abs(o.x - x) < 2.4 && gap > -10 && gap < 22) return false;
    }
    return true;
  }

  step(dt) {
    this.car.step(dt, this.input);
  }
}
