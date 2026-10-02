import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';
import { PITCH } from './stadium.js';

// A computer opponent for solo football. It drives the same car physics as
// the player: it lines up behind the ball facing the goal it attacks, goes
// round the ball when it's on the wrong side, falls back to defend when the
// ball heads for its own goal, and backs out when it gets stuck.

const wrapBot = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clampBot = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Bot {
  constructor(def, terrain, team) {
    this.def = def;
    this.team = team;
    this.car = new CarPhysics({ ...def.spec, assists: true }, terrain);
    this.model = new CarModel(def);
    this.stuck = 0;
    this.reversing = 0;
    this.input = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false };
  }

  /** Decide this step's controls. `ball` is { x, y, z, vx, vz }. */
  think(ball, dt) {
    const c = this.car;
    const goalZ = this.team === 0 ? PITCH.halfZ : -PITCH.halfZ; // the goal we attack
    const ownZ = -goalZ;
    // Where the ball will be shortly.
    const look = 0.35;
    const bx = ball.x + ball.vx * look;
    const bz = ball.z + ball.vz * look;
    // Unit vector from the target goal to the ball: we want to be behind
    // the ball along this line, then drive through it.
    let gx = bx, gz = bz - goalZ;
    const gl = Math.hypot(gx, gz) || 1;
    gx /= gl; gz /= gl;

    let tx, tz;
    let charge = false;
    const toBallX = bx - c.x, toBallZ = bz - c.z;
    const dist = Math.hypot(toBallX, toBallZ);
    // How far "behind" the ball we are (positive = on the right side).
    const behind = (c.x - bx) * gx + (c.z - bz) * gz;
    const ballToOwn = Math.abs(ball.z - ownZ);
    const meToOwn = Math.abs(c.z - ownZ);

    if (ballToOwn < 35 && meToOwn > ballToOwn + 4 && Math.sign(ball.vz) === Math.sign(ownZ) && Math.abs(ball.vz) > 4) {
      // Ball is heading for our goal and we're upfield: get back to goal.
      tx = clampBot(ball.x * 0.4, -6, 6);
      tz = ownZ - Math.sign(ownZ) * 6;
      if (meToOwn < 10) { tx = bx; tz = bz; charge = true; }
    } else if (behind > 1.5) {
      // Right side: aim a little behind the ball, then straight through it.
      const lead = Math.min(4, dist * 0.3);
      tx = bx + gx * lead;
      tz = bz + gz * lead;
      if (dist < 9) { tx = bx - gx * 1.2; tz = bz - gz * 1.2; charge = true; }
    } else {
      // Wrong side: loop round the ball, passing it on the open side.
      const px = -gz, pz = gx;
      const side = Math.sign((c.x - bx) * px + (c.z - bz) * pz) || 1;
      tx = bx + gx * 7 + px * side * 6;
      tz = bz + gz * 7 + pz * side * 6;
    }
    tx = clampBot(tx, -PITCH.halfX + 3, PITCH.halfX - 3);
    tz = clampBot(tz, -PITCH.halfZ + 2, PITCH.halfZ - 2);

    const dx = tx - c.x, dz = tz - c.z;
    const err = wrapBot(Math.atan2(dx, dz) - c.heading);
    const speed = c.speed;
    const inp = this.input;

    // Unstick: pushing but not moving for a moment -> reverse out.
    if (this.reversing > 0) {
      this.reversing -= dt;
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = -Math.sign(err) || 1;
      inp.handbrake = false;
      inp.boost = false;
      return inp;
    }
    if (inp.throttle > 0.5 && speed < 1.2 && !c.airborne) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 0.9) {
      this.stuck = 0;
      this.reversing = 0.9;
    }

    inp.steer = clampBot(err * 2.6, -1, 1);
    const sharp = Math.abs(err);
    inp.throttle = sharp > 1.4 && speed > 14 ? 0.3 : 1;
    inp.brake = sharp > 1.9 && speed > 18 ? 0.6 : 0;
    inp.handbrake = sharp > 1.3 && speed > 9 && speed < 26;
    inp.boost = !c.airborne && sharp < 0.18 && (charge || Math.hypot(dx, dz) > 25) && c.boost > 0.15;
    // Jump at a high ball that's close and in front; flip into it on the way.
    const ahead = Math.cos(wrapBot(Math.atan2(ball.x - c.x, ball.z - c.z) - c.heading));
    const near = Math.hypot(ball.x - c.x, ball.z - c.z);
    inp.jump = false;
    inp.pitch = undefined;
    if (!c.airborne && ball.y > 2.6 && ball.y < 6 && near < 7 && ahead > 0.85 && !this.reversing) {
      inp.jump = true;
    } else if (c.airborne && c.jumps === 1 && c.airTime > 0.25 && near < 4.5 && ahead > 0.7) {
      inp.jump = true;   // second press with the nose-down stick: a front flip into the ball
      inp.pitch = -1;
    } else if (c.airborne) {
      inp.pitch = Math.max(-1, Math.min(1, -c.pitch * 2)); // keep level for the landing
    }
    return inp;
  }

  step(dt) {
    this.car.step(dt, this.input);
  }
}
