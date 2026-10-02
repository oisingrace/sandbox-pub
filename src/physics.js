// Vehicle dynamics: a planar "bicycle" model with per-axle tire forces.
//
// Conventions (car-local frame):
//   x = forward, y = left, yaw rate positive = turning left.
// World frame is three.js X/Z with heading 0 facing +Z:
//   forward = (sin h, cos h), left = (cos h, -sin h).

const G = 9.81;
const MAX_STEP = 0.35; // a rise bigger than this in one step is a wall

// Rocket-style moves, used when `car.aerial` is on (car football):
const JUMP_SPEED = 5.2;      // m/s straight up off the ground
const JUMP_HOLD = 0.2;       // s: holding jump this long pushes a little higher...
const JUMP_HOLD_ACCEL = 11;  // ...with this much extra lift
const SECOND_JUMP_WINDOW = 1.4; // s after take-off to double jump or flip
const DOUBLE_JUMP_SPEED = 4.6;
const FLIP_TIME = 0.6;       // s for one full flip
const FLIP_SPEED = 6;        // m/s shove in the flip's direction
const AIR_PITCH_RATE = 5.5;  // rad/s at full stick
const AIR_YAW_RATE = 3.6;
const AIR_ROLL_RATE = 5.5;
const AIR_BOOST = 15;        // m/s^2 of thrust in the air (enough to fly)

export const DEFAULT_SPEC = {
  mass: 1250,              // kg
  inertiaScale: 1.4,       // yaw inertia = mass * inertiaScale (kg m^2 per kg)
  cgToFront: 1.25,         // m, CG to front axle
  cgToRear: 1.35,          // m, CG to rear axle
  cgHeight: 0.45,          // m, used for weight transfer
  trackWidth: 1.7,         // m
  wheelRadius: 0.34,       // m
  tireGrip: 1.15,          // peak friction coefficient
  tireB: 10,               // simplified Pacejka stiffness
  tireC: 1.3,              // simplified Pacejka shape
  rearGripBias: 1.25,      // rear grip multiplier; >1 gives a stable balance
  handbrakeGrip: 0.45,     // rear lateral grip multiplier with handbrake on
  maxSteer: 0.6,           // rad at standstill
  steerSpeed: 2.6,         // rad/s while turning in
  steerReturn: 4.5,        // rad/s while centering
  steerSpeedScale: 300,    // (m/s)^2; higher keeps more lock at speed
  brakeForce: 15000,       // N, total at full pedal
  brakeBias: 0.62,         // fraction to front axle
  dragCoef: 0.42,
  rollingResistance: 12,
  engineBrake: 350,        // N per unit of gear ratio when off throttle
  gearRatios: [3.4, 2.3, 1.72, 1.32, 1.06, 0.86],
  reverseRatio: 3.2,
  finalDrive: 3.7,
  drivetrainEfficiency: 0.82,
  torqueScale: 1,         // multiplies the shared torque curve
  engineTone: 1,          // engine sound pitch multiplier
  idleRpm: 900,
  redline: 7200,
  shiftUpRpm: 6800,
  shiftDownRpm: 3000,
  shiftTime: 0.18,
  assists: true,           // traction control + counter-steer help
  boostAccel: 7,           // m/s^2 of rocket thrust while boosting
  boostDuration: 3,        // seconds from a full meter to empty
  boostRecharge: 9,        // seconds to refill from empty when not boosting
  tractionLimit: 0.72,     // fraction of rear grip TC allows for drive
};

// Torque curve (rpm -> Nm), linearly interpolated.
const TORQUE_CURVE = [
  [0, 220], [1000, 250], [2500, 330], [4000, 390], [5200, 405],
  [6200, 380], [7000, 330], [7400, 0],
];

function engineTorque(rpm) {
  for (let i = 1; i < TORQUE_CURVE.length; i++) {
    const [r1, t1] = TORQUE_CURVE[i];
    if (rpm <= r1) {
      const [r0, t0] = TORQUE_CURVE[i - 1];
      return t0 + (t1 - t0) * ((rpm - r0) / (r1 - r0));
    }
  }
  return 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Air pitch input, + = nose up: the stick if given, else brake minus throttle (W dives, like Rocket League). */
const airPitchInput = (input) => clamp(input.pitch ?? ((input.brake || 0) - (input.throttle || 0)), -1, 1);
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class CarPhysics {
  constructor(spec = {}, terrain = null) {
    this.spec = { ...DEFAULT_SPEC, ...spec };
    this.terrain = terrain; // optional: anything with heightAt(x, z)
    // Body box for landings and tumbling: half width/length, roof height,
    // and the height of its middle (the point it rotates about in the air).
    const b = this.spec.body || {};
    this.body = { halfW: b.halfW ?? 0.95, halfL: b.halfL ?? 2.2, top: b.top ?? 1.35 };
    this.body.centre = this.body.top * 0.45;
    this.reset();
  }

  reset(x = 0, z = 0, heading = 0) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.velX = 0;
    this.velZ = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.gear = 1;          // -1 reverse, 1..n forward
    this.rpm = this.spec.idleRpm;
    this.shiftTimer = 0;
    this.accelLong = 0;     // smoothed, for weight transfer and body pitch
    this.accelLat = 0;      // smoothed, for body roll
    this.throttle = 0;
    this.braking = 0;
    this.handbrake = false;
    this.boost = 1;         // boost meter, 0..1
    this.boosting = false;
    // Vertical motion (ramps and jumps).
    this.y = this.terrain ? this.terrain.heightAt(x, z) : 0;
    this.velY = 0;
    this.pitch = 0;          // nose up positive
    this.roll = 0;           // left side up positive
    this.pitchRate = 0;
    this.rollRate = 0;
    this.airborne = false;
    this.airTime = 0;
    this.jumps = 0;          // jumps used since leaving the ground (aerial mode)
    this.jumpHeld = false;
    this.flip = null;        // { pitch, roll, t } while a flip is spinning the car
    this.tumbling = false;   // on the ground but not on the wheels (side, roof, an edge)
    this.lift = 0;           // body raised off the wheels' ground height while settling
    this.restTime = 0;
    this.landed = null;      // { impact, misalign, airTime } for one step after landing
    this.blocked = 0;        // speed of a hit against a ramp wall, for one step
    // Per-frame telemetry used by visuals/audio.
    this.vLong = 0;
    this.vLat = 0;
    this.slipFront = 0;
    this.slipRear = 0;
    this.wheelspin = 0;     // 0..1
    this.loadFront = 0;
    this.loadRear = 0;
    this.frontWheelSpeed = 0; // m/s at tire surface
    this.rearWheelSpeed = 0;
  }

  get speed() {
    return Math.hypot(this.velX, this.velZ);
  }

  get gearLabel() {
    if (this.gear < 0) return 'R';
    if (this.speed < 0.3 && this.throttle === 0) return 'N';
    return String(this.gear);
  }

  /**
   * @param {number} dt seconds
   * @param {{steer:number, throttle:number, brake:number, handbrake:boolean}} input
   *   steer: -1 (right) .. 1 (left); throttle/brake: 0..1
   */
  step(dt, input) {
    const s = this.spec;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);

    // World velocity -> car-local.
    let vx = this.velX * sinH + this.velZ * cosH;
    let vy = this.velX * cosH - this.velZ * sinH;
    const speed = Math.hypot(vx, vy);
    const w = this.yawRate;
    const a = s.cgToFront;
    const b = s.cgToRear;
    const L = a + b;

    // --- Gear selection / pedal mapping -------------------------------
    // Holding brake at a standstill engages reverse; throttle at a
    // standstill goes back to first. In reverse the pedals swap roles.
    if (this.gear > 0 && Math.abs(vx) < 0.6 && input.brake > 0.1 && input.throttle < 0.1) {
      this.gear = -1;
    } else if (this.gear < 0 && Math.abs(vx) < 0.6 && input.throttle > 0.1 && input.brake < 0.1) {
      this.gear = 1;
    }
    const drive = this.gear > 0 ? input.throttle : input.brake;
    const brakePedal = this.gear > 0 ? input.brake : input.throttle;
    this.throttle = drive;
    this.braking = brakePedal;
    this.handbrake = !!input.handbrake;

    // --- Boost: rocket thrust on top of the drivetrain (ignores traction).
    this.boosting = !!input.boost && this.boost > 0.02;
    if (this.boosting) this.boost = Math.max(0, this.boost - dt / s.boostDuration);
    else if (!input.boost) this.boost = Math.min(1, this.boost + dt / s.boostRecharge);

    this.landed = null;
    this.blocked = 0;
    const jumpPressed = !!input.jump && !this.jumpHeld;
    this.jumpHeld = !!input.jump;
    const wasAirborne = this.airborne;
    if (this.aerial && jumpPressed) this.jump(input);
    if (this.airborne && !wasAirborne) this.pitchLock = { throttle: (input.throttle || 0) > 0.05, brake: (input.brake || 0) > 0.05 };
    if (this.airborne) {
      this.flyStep(dt, input);
      return;
    }

    // --- Steering ------------------------------------------------------
    // Less lock at speed keeps the front tires near their peak slip angle.
    const steerLimit = s.maxSteer / (1 + (vx * vx) / s.steerSpeedScale);
    let target = clamp(input.steer, -1, 1) * steerLimit;
    if (s.assists && vx > 4) {
      // Counter-steer toward the direction of travel, like caster trail
      // pulling the wheels into a slide. Stronger with hands off.
      const bodySlip = Math.atan2(vy, vx);
      const gain = Math.abs(input.steer) < 0.05 ? 0.9 : 0.45;
      target = clamp(target + bodySlip * gain, -s.maxSteer, s.maxSteer);
    }
    const rate = Math.abs(target) > Math.abs(this.steer) && sign(target) === sign(this.steer)
      ? s.steerSpeed : s.steerReturn;
    const dSteer = clamp(target - this.steer, -rate * dt, rate * dt);
    this.steer += dSteer;
    const steer = this.steer;
    const cs = Math.cos(steer);
    const ss = Math.sin(steer);

    // --- Axle loads with longitudinal weight transfer -----------------
    const staticF = (s.mass * G * b) / L;
    const staticR = (s.mass * G * a) / L;
    const transfer = (s.mass * this.accelLong * s.cgHeight) / L;
    const FzF = Math.max(staticF - transfer, staticF * 0.25);
    const FzR = Math.max(staticR + transfer, staticR * 0.25);
    const maxF = s.tireGrip * FzF;
    const maxR = s.tireGrip * s.rearGripBias * FzR;

    // --- Engine / drivetrain -----------------------------------------
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const ratio = this.gear > 0 ? s.gearRatios[this.gear - 1] : s.reverseRatio;
    const wheelRpm = (Math.abs(vx) / s.wheelRadius) * (60 / (2 * Math.PI));
    let rpm = wheelRpm * ratio * s.finalDrive;

    if (this.gear > 0 && this.shiftTimer === 0) {
      if (rpm > s.shiftUpRpm && this.gear < s.gearRatios.length) {
        this.gear++;
        this.shiftTimer = s.shiftTime;
      } else if (this.gear > 1) {
        const lowerRpm = wheelRpm * s.gearRatios[this.gear - 2] * s.finalDrive;
        if (rpm < s.shiftDownRpm && lowerRpm < s.shiftUpRpm - 800) {
          this.gear--;
          this.shiftTimer = s.shiftTime;
        }
      }
    }

    // Slipping clutch: let the engine sit in its power band when launching.
    const engineRpm = Math.max(rpm, drive > 0.05 ? 2400 + drive * 1500 : s.idleRpm);
    let driveForce = 0;
    if (this.shiftTimer === 0 && engineRpm < s.redline) {
      const torque = engineTorque(engineRpm) * s.torqueScale * drive;
      driveForce = (torque * ratio * s.finalDrive * s.drivetrainEfficiency) / s.wheelRadius;
      if (this.gear < 0) driveForce = -driveForce * 0.6;
    }

    // --- Longitudinal tire forces ------------------------------------
    const vLongF = vx * cs + (vy + w * a) * ss;
    const vLatF = -vx * ss + (vy + w * a) * cs;
    const vLongR = vx;
    const vLatR = vy - w * b;

    // Brake force never exceeds what would stop the axle this step.
    const stopF = (s.mass * 0.5 * Math.abs(vLongF)) / dt;
    const stopR = (s.mass * 0.5 * Math.abs(vLongR)) / dt;

    let FxF = -sign(vLongF) * Math.min(brakePedal * s.brakeForce * s.brakeBias, maxF, stopF);
    let FxR;
    let rearLatCap;
    let wheelspin = 0;

    if (this.handbrake) {
      // Locked rear wheels: sliding friction, very little side grip.
      FxR = -sign(vLongR) * Math.min(maxR * 0.85, stopR);
      rearLatCap = maxR * s.handbrakeGrip;
    } else {
      const brakeR = -sign(vLongR) * Math.min(brakePedal * s.brakeForce * (1 - s.brakeBias), stopR);
      const engineBrake = drive < 0.05 && this.gear > 0
        ? -sign(vLongR) * Math.min(s.engineBrake * ratio, stopR) : 0;
      let tcDrive = driveForce;
      if (s.assists) tcDrive = clamp(driveForce, -maxR * s.tractionLimit, maxR * s.tractionLimit);
      FxR = tcDrive + brakeR + engineBrake;
      if (Math.abs(FxR) > maxR) {
        wheelspin = clamp((Math.abs(FxR) - maxR) / maxR, 0, 1);
        FxR = sign(FxR) * maxR;
      }
      // Friction circle: traction eats into cornering grip.
      rearLatCap = Math.sqrt(Math.max(maxR * maxR * 0.2, maxR * maxR - FxR * FxR));
    }
    const frontLatCap = Math.sqrt(Math.max(maxF * maxF * 0.05, maxF * maxF - FxF * FxF));

    // --- Lateral tire forces (simplified Pacejka) ---------------------
    // A floor on the longitudinal speed keeps slip angles sane at a crawl.
    const slipF = Math.atan2(vLatF, Math.max(Math.abs(vLongF), 3));
    const slipR = Math.atan2(vLatR, Math.max(Math.abs(vLongR), 3));
    const FyF = -frontLatCap * this.tireCurve(slipF);
    const FyR = -rearLatCap * this.tireCurve(slipR);

    // --- Body forces ---------------------------------------------------
    const drag = -s.dragCoef * speed;
    let Fx = FxF * cs - FyF * ss + FxR + drag * vx - s.rollingResistance * vx;
    let Fy = FxF * ss + FyF * cs + FyR + drag * vy;
    const torque = a * (FxF * ss + FyF * cs) - b * FyR;

    if (this.boosting) Fx += s.mass * s.boostAccel;
    Fx -= s.mass * G * Math.sin(this.pitch); // climbing a ramp costs speed
    const ax = Fx / s.mass;
    const ay = Fy / s.mass;

    // Integrate in world space.
    const fwdX = sinH, fwdZ = cosH, leftX = cosH, leftZ = -sinH;
    this.velX += (fwdX * ax + leftX * ay) * dt;
    this.velZ += (fwdZ * ax + leftZ * ay) * dt;
    this.yawRate += (torque / (s.mass * s.inertiaScale)) * dt;

    // Come fully to rest instead of creeping forever.
    if (drive < 0.05 && this.speed < 0.15) {
      this.velX *= 0.8;
      this.velZ *= 0.8;
      this.yawRate *= 0.8;
    }

    const prevX = this.x;
    const prevZ = this.z;
    this.heading += this.yawRate * dt;
    this.x += this.velX * dt;
    this.z += this.velZ * dt;
    this.followGround(dt, prevX, prevZ);

    // Smoothed accelerations for load transfer and body motion.
    const k = 1 - Math.exp(-dt * 10);
    this.accelLong += (ax - this.accelLong) * k;
    this.accelLat += (ay - this.accelLat) * k;

    // Telemetry.
    this.vLong = vx;
    this.vLat = vy;
    this.slipFront = slipF;
    this.slipRear = slipR;
    this.loadFront = FzF;
    this.loadRear = FzR;
    this.wheelspin = wheelspin;
    this.frontWheelSpeed = vLongF;
    this.rearWheelSpeed = this.handbrake ? 0 : vx + sign(driveForce || 1) * wheelspin * 25;

    const targetRpm = wheelspin > 0
      ? Math.min(s.redline, engineRpm + wheelspin * 4000)
      : clamp(engineRpm, s.idleRpm, s.redline);
    this.rpm += (targetRpm - this.rpm) * (1 - Math.exp(-dt * 12));
  }

  /**
   * Apply a collision impulse (N·s, world X/Z) and yaw torque impulse.
   * Per-step limits keep a car wedged against a pile from being launched.
   */
  applyImpulse(jx, jz, torque) {
    const s = this.spec;
    let dvx = jx / s.mass;
    let dvz = jz / s.mass;
    const dv = Math.hypot(dvx, dvz);
    const maxDv = 4;
    if (dv > maxDv) {
      dvx *= maxDv / dv;
      dvz *= maxDv / dv;
    }
    this.velX += dvx;
    this.velZ += dvz;
    this.yawRate += clamp(torque / (s.mass * s.inertiaScale), -0.8, 0.8);
    return Math.min(dv, maxDv);
  }

  /** Ground height under the CG plus the slope pitch and roll beneath the car. */
  sampleGround() {
    const t = this.terrain;
    if (!t) return { h: 0, pitch: 0, roll: 0 };
    const s = this.spec;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const at = (fwd, left) => t.heightAt(this.x + sinH * fwd + cosH * left, this.z + cosH * fwd - sinH * left);
    const hF = at(s.cgToFront, 0);
    const hR = at(-s.cgToRear, 0);
    const half = s.trackWidth / 2;
    const hL = at(0, half);
    const hRt = at(0, -half);
    const hC = at(0, 0);
    return {
      h: Math.max(hC, (hF + hR) / 2),
      pitch: Math.atan2(hF - hR, s.cgToFront + s.cgToRear),
      roll: Math.atan2(hL - hRt, s.trackWidth),
    };
  }

  /**
   * Keep the car on the ground, launch it when the ground drops away faster
   * than gravity can pull it down (a ramp lip), and stop it at walls.
   */
  followGround(dt, prevX, prevZ) {
    const g = this.sampleGround();
    // Work with the wheels' ground height, not the body lift (see below).
    const yBase = this.y - (this.lift || 0);
    // A sudden rise is a wall (the back or side of a ramp), not a slope.
    if (g.h - yBase > MAX_STEP) {
      this.blocked = this.speed;
      this.x = prevX;
      this.z = prevZ;
      this.velX *= -0.25;
      this.velZ *= -0.25;
      this.yawRate *= 0.5;
      return;
    }
    const ballistic = yBase + this.velY * dt - 0.5 * G * dt * dt;
    if (g.h >= ballistic - 0.02) {
      const newVelY = clamp((g.h - yBase) / dt, -30, 30);
      this.velY = newVelY;
      // Follow the slope closely, or settle more softly just after a landing.
      this.settle = Math.max(0, (this.settle || 0) - dt);
      const k = 1 - Math.exp(-dt * (this.settle > 0 ? 9 : 25));
      const pitch = this.pitch + (g.pitch - this.pitch) * k;
      const roll = this.roll + (g.roll - this.roll) * k;
      this.pitchRate = (pitch - this.pitch) / dt;
      this.rollRate = (roll - this.roll) / dt;
      this.pitch = pitch;
      this.roll = roll;
      // While the body is still tilted after a landing, lift it so its
      // lowest corner rests on the ground (front wheels touch, rear drops)
      // instead of the nose sinking in.
      const rp = pitch - g.pitch, rr = roll - g.roll;
      this.lift = Math.max(0, this.supportDepth(rp, rr) - this.body.centre * this.upAxis(rp, rr, 0).y);
      this.y = g.h + this.lift;
    } else {
      // Off the lip: keep the vertical speed the ramp gave us, but not the
      // ramp's curvature spin (that sends cars into backflips).
      this.airborne = true;
      this.pitchLock = { throttle: this.throttle > 0.05, brake: this.braking > 0.05 }; // see aerialControl
      this.pitchRate *= 0.15;
      this.rollRate *= 0.3;
      this.airTime = 0;
      this.lift = 0;
      this.y = ballistic;
      this.velY -= G * dt;
    }
  }

  /**
   * Jump (aerial mode). On the ground: hop up. In the air, once, soon after
   * take-off: a second jump, or with a direction held a flip that shoves the
   * car that way.
   */
  jump(input) {
    if (!this.airborne) {
      this.airborne = true;
      this.airTime = 0;
      this.jumps = 1;
      this.velY = Math.max(this.velY, 0) + JUMP_SPEED;
      this.y += 0.02;
      this.pitchRate = this.rollRate = 0;
      return;
    }
    if (this.jumps !== 1 || this.airTime > SECOND_JUMP_WINDOW) return;
    this.jumps = 2;
    const fwd = -airPitchInput(input); // + = flip forwards (nose down)
    const side = clamp(input.steer || 0, -1, 1); // + = left
    if (Math.abs(fwd) < 0.3 && Math.abs(side) < 0.3) {
      this.velY = Math.max(this.velY, 0) + DOUBLE_JUMP_SPEED;
      return;
    }
    // Flip: shove along the stick direction (car frame), kill the fall.
    const len = Math.hypot(fwd, side);
    const f = fwd / len, l = side / len;
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    this.velX += (sinH * f + cosH * l) * FLIP_SPEED;
    this.velZ += (cosH * f - sinH * l) * FLIP_SPEED;
    this.velY = Math.max(this.velY, 0.5);
    this.flip = { pitch: -f * (Math.PI * 2) / FLIP_TIME, roll: -l * (Math.PI * 2) / FLIP_TIME, t: FLIP_TIME };
  }

  /**
   * Off the wheels: flight, and tumbling on the ground (landing on a
   * corner, the side or the roof). Flips and rolls turn the car about its
   * middle, the ground is found under the car's lowest corner, and gravity
   * tips a car resting on an edge onto its wheels, side or roof.
   */
  flyStep(dt, input) {
    const s = this.spec;
    this.airTime += dt;
    this.velY -= G * dt;
    if (this.flip) {
      // A flip (or a self-righting hop) spins the car at a set rate.
      this.pitchRate = this.flip.pitch;
      this.rollRate = this.flip.roll;
      this.yawRate *= Math.exp(-dt * 4);
      this.flip.t -= dt;
      if (this.flip.t <= 0) {
        this.flip = null;
        this.pitchRate = this.rollRate = 0;
        // W/S held through a flip don't start pitching until pressed again.
        this.pitchLock = { throttle: (input.throttle || 0) > 0.05, brake: (input.brake || 0) > 0.05 };
      }
    } else if (this.tumbling) {
      this.tumbleForces(dt, input);
    } else if (this.aerial) {
      this.aerialControl(dt, input);
    } else {
      // In the air the nose settles toward the direction of travel (arcade
      // style), and throttle/brake tilt it from there. Steering yaws a little.
      const hSpeed = Math.hypot(this.velX, this.velZ);
      const glide = Math.atan2(this.velY, Math.max(hSpeed, 1)) * 0.7;
      const control = ((input.throttle || 0) - (input.brake || 0)) * 0.6;
      this.pitchRate += wrapAngle(glide + control - this.pitch) * 5 * dt;
      this.pitchRate *= Math.exp(-dt * 3);
      this.rollRate *= Math.exp(-dt * 1.5);
      this.yawRate += clamp(input.steer || 0, -1, 1) * 1.2 * dt;
      this.yawRate *= Math.exp(-dt * 1.2);
    }
    if (this.boosting && !this.tumbling) {
      const a = (this.aerial ? AIR_BOOST : s.boostAccel) * dt;
      const cp = Math.cos(this.pitch);
      this.velX += Math.sin(this.heading) * cp * a;
      this.velZ += Math.cos(this.heading) * cp * a;
      this.velY += Math.sin(this.pitch) * a;
    }
    const drag = Math.exp(-dt * 0.04);
    this.velX *= drag;
    this.velZ *= drag;
    // Keep the air speed sane.
    const sp = Math.hypot(this.velX, this.velY, this.velZ);
    if (sp > 40) {
      this.velX *= 40 / sp;
      this.velY *= 40 / sp;
      this.velZ *= 40 / sp;
    }
    this.turnAboutCentre(this.pitchRate * dt, this.rollRate * dt, this.yawRate * dt);
    this.x += this.velX * dt;
    this.z += this.velZ * dt;
    this.y += this.velY * dt;
    this.steer *= Math.exp(-dt * 4);
    // The engine revs freely with nothing to push against.
    const target = s.idleRpm + (s.redline - s.idleRpm) * (input.throttle || 0) * 0.95;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt * 6));
    this.throttle = input.throttle || 0;
    this.accelLong *= Math.exp(-dt * 4);
    this.accelLat *= Math.exp(-dt * 4);
    this.slipFront = this.slipRear = 0;
    this.wheelspin = 0;
    this.groundContact(dt, input);
  }

  /**
   * Rocket-style air control (aerial mode): pitch, yaw and air roll at a
   * steady rate and held attitude when the stick is let go.
   */
  aerialControl(dt, input) {
    if (this.jumps === 1 && this.jumpHeld && this.airTime < JUMP_HOLD) this.velY += JUMP_HOLD_ACCEL * dt;
    const k = Math.min(1, dt * 12);
    const steer = clamp(input.steer || 0, -1, 1);
    const rollMode = !!input.handbrake; // powerslide button = air roll
    // Throttle/brake held since take-off don't pitch the car until
    // they're let go and pressed again, so driving off a jump with W
    // held doesn't nosedive. (A gamepad stick is separate: no lock.)
    const lock = this.pitchLock || {};
    if ((input.throttle || 0) < 0.05) lock.throttle = false;
    if ((input.brake || 0) < 0.05) lock.brake = false;
    const pitchIn = input.pitch !== undefined ? airPitchInput(input)
      : clamp((lock.brake ? 0 : input.brake || 0) - (lock.throttle ? 0 : input.throttle || 0), -1, 1);
    this.pitchRate += (pitchIn * AIR_PITCH_RATE - this.pitchRate) * k;
    this.rollRate += ((rollMode ? -steer * AIR_ROLL_RATE : 0) - this.rollRate) * k;
    this.yawRate += ((rollMode ? 0 : steer * AIR_YAW_RATE) - this.yawRate) * k;
  }

  /** The car's local up axis in the world. */
  upAxis(pitch = this.pitch, roll = this.roll, heading = this.heading) {
    const cx = -Math.sin(roll);
    const cy = Math.cos(pitch) * Math.cos(roll);
    const cz = -Math.sin(pitch) * Math.cos(roll);
    const sh = Math.sin(heading), ch = Math.cos(heading);
    return { x: cx * ch + cz * sh, y: cy, z: -cx * sh + cz * ch };
  }

  /**
   * Rotate by the given angles about the middle of the car rather than the
   * point under it on the ground (where `x, y, z` sits), so flips look right.
   */
  turnAboutCentre(dPitch, dRoll, dYaw) {
    const hc = this.body.centre;
    const a = this.upAxis();
    this.pitch = wrapAngle(this.pitch + dPitch);
    this.roll = wrapAngle(this.roll + dRoll);
    this.heading = wrapAngle(this.heading + dYaw);
    const b = this.upAxis();
    this.x += hc * (a.x - b.x);
    this.y += hc * (a.y - b.y);
    this.z += hc * (a.z - b.z);
  }

  /**
   * How far the car's lowest corner is below its middle, for a pitch and
   * roll relative to the ground. The ends are rounded so a car never
   * balances on its nose; its sides and roof are flat, so it can rest there.
   */
  supportDepth(pitch, roll) {
    const { halfW, halfL, top, centre } = this.body;
    const sideY = Math.cos(pitch) * Math.sin(roll);
    const upY = Math.cos(pitch) * Math.cos(roll);
    const fwdY = Math.sin(pitch);
    const vertical = upY >= 0 ? centre * upY : (top - centre) * -upY;
    return halfW * Math.abs(sideY) + Math.hypot(halfL * fwdY, vertical);
  }

  /** Is the car roughly the right way up (within ~30°) on the ground beneath it? */
  wheelsDown(g) {
    const up = this.upAxis(this.pitch - g.pitch, this.roll - g.roll, 0);
    return up.y > 0.86;
  }

  /** Touching the ground while off the wheels: landing, rocking, tipping, sliding. */
  groundContact(dt, input) {
    const g = this.sampleGround();
    const rp = this.pitch - g.pitch, rr = this.roll - g.roll;
    const hc = this.body.centre;
    const centreY = this.y + hc * this.upAxis().y;
    const depth = this.supportDepth(rp, rr);
    const gap = centreY - depth - g.h;
    if (gap > 0.02) {
      if (this.tumbling && gap > 0.15) this.tumbling = false; // bounced clear
      return;
    }
    // Touching: keep the lowest corner on the ground.
    if (gap < 0) this.y -= gap;
    if (this.flip) {
      // Mid flip (or self-right): the car vaults over whatever corner
      // touches and finishes turning; the ground just holds it up.
      this.velY = Math.max(this.velY, 0);
      return;
    }
    const impact = Math.max(0, -this.velY);
    if (!this.tumbling) {
      this.landed = { impact, misalign: Math.acos(clamp(this.upAxis(rp, rr, 0).y, -1, 1)), airTime: this.airTime };
      this.jumps = 0;
      this.flip = null;
      this.airTime = 0; // from here it counts time on the ground off the wheels
    }
    // A little bounce on a hard hit, otherwise the ground just stops the fall.
    this.velY = impact > 3 ? impact * 0.22 : Math.max(0, this.velY);
    if (this.wheelsDown(g) && Math.abs(this.pitchRate) < 2.5 && Math.abs(this.rollRate) < 2.5) {
      this.land(g, impact);
      return;
    }
    this.tumbling = true;
    // Back on the wheels from here: jump (football) or wait a moment.
    const resting = Math.hypot(this.pitchRate, this.rollRate) < 0.8 && this.speed < 2;
    this.restTime = resting ? (this.restTime || 0) + dt : 0;
    const jumpPressed = this.aerial && input.jump && !this.wasJumpForRight;
    this.wasJumpForRight = !!input.jump;
    if (this.restTime > (this.aerial ? 0.9 : 1.2) || (jumpPressed && this.airTime > 0.2)) this.selfRight(g);
  }

  /** Gravity tipping the car over its edges, and sliding friction, while tumbling. */
  tumbleForces(dt, input) {
    const g = this.sampleGround();
    const rp = this.pitch - g.pitch, rr = this.roll - g.roll;
    // The car settles where its middle is lowest; the slope of that height
    // with angle is the gravity torque about the edge it's resting on.
    const e = 1e-3;
    const dPitch = (this.supportDepth(rp + e, rr) - this.supportDepth(rp - e, rr)) / (2 * e);
    const dRoll = (this.supportDepth(rp, rr + e) - this.supportDepth(rp, rr - e)) / (2 * e);
    const { halfW, halfL, top } = this.body;
    const k2Roll = (halfW * halfW + top * top * 0.25) / 3;
    const k2Pitch = (halfL * halfL + top * top * 0.25) / 3;
    this.pitchRate += (-G * dPitch / k2Pitch) * dt;
    this.rollRate += (-G * dRoll / k2Roll) * dt;
    // Scraping along the ground damps the spin; near wheels-down the
    // suspension soaks it up faster.
    const up = this.upAxis(rp, rr, 0).y;
    const damp = Math.exp(-dt * (up > 0.85 ? 4.5 : 1.8));
    this.pitchRate *= damp;
    this.rollRate *= damp;
    this.yawRate *= Math.exp(-dt * 2.5);
    // Sliding on a side or the roof drags hard; rocking on the wheels hardly at all.
    const mu = up > 0.7 ? 0.05 : 0.6;
    const sp = Math.hypot(this.velX, this.velZ);
    if (sp > 1e-3) {
      const k = Math.max(0, sp - mu * G * dt) / sp;
      this.velX *= k;
      this.velZ *= k;
    }
  }

  /** Hop and roll back onto the wheels (after resting on the side or roof). */
  selfRight(g) {
    const T = 0.55;
    let rp = wrapAngle(this.pitch - g.pitch);
    let rr = wrapAngle(this.roll - g.roll);
    // Upside down end over end is the same as rolled over and facing the
    // other way; roll it back, which reads better.
    if (Math.cos(rp) < 0) {
      rp = wrapAngle(Math.PI - rp);
      rr = wrapAngle(rr + Math.PI);
      this.pitch = g.pitch + rp;
      this.roll = g.roll + rr;
      this.heading = wrapAngle(this.heading + Math.PI);
    }
    this.velY = 4.5;
    this.tumbling = false;
    this.restTime = 0;
    this.flip = { pitch: -rp / T, roll: -rr / T, t: T, righting: true };
  }

  land(g, impact = Math.max(0, -this.velY)) {
    this.jumps = 0;
    this.flip = null;
    this.tumbling = false;
    this.restTime = 0;
    // Wheels down but the Euler angles may say "flipped twice" (end over
    // end and rolled over): write the same attitude the simple way round.
    if (Math.cos(this.pitch - g.pitch) < 0) {
      this.pitch = wrapAngle(Math.PI - this.pitch);
      this.roll = wrapAngle(this.roll + Math.PI);
      this.heading = wrapAngle(this.heading + Math.PI);
    }
    // Straight from flight: report it (for effects and airtime boost).
    // After tumbling about on the ground: no airtime to reward.
    const misalign = this.landed?.misalign ?? 0;
    const airTime = this.landed ? this.landed.airTime : 0;
    if (!this.aerial && impact > 8) {
      const loss = clamp((impact - 8) * 0.015, 0, 0.3);
      this.velX *= 1 - loss;
      this.velZ *= 1 - loss;
    }
    this.landed = { impact, misalign, airTime };
    this.airborne = false;
    const rp = this.pitch - g.pitch, rr = this.roll - g.roll;
    this.lift = Math.max(0, this.supportDepth(rp, rr) - this.body.centre * this.upAxis(rp, rr, 0).y);
    this.y = g.h + this.lift;
    this.velY = 0;
    // On the wheels and driving again; the body settles onto the ground
    // over a moment (see followGround) instead of snapping flat.
    this.settle = 0.4;
  }

  tireCurve(slip) {
    const { tireB: B, tireC: C } = this.spec;
    return Math.sin(C * Math.atan(B * slip));
  }

  /** True when the rear is sliding enough to count as a drift. */
  get isDrifting() {
    return this.vLong > 6 && Math.abs(Math.atan2(this.vLat, this.vLong)) > 0.18;
  }
}
