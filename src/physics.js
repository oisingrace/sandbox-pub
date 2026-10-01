// Vehicle dynamics: a planar "bicycle" model with per-axle tire forces.
//
// Conventions (car-local frame):
//   x = forward, y = left, yaw rate positive = turning left.
// World frame is three.js X/Z with heading 0 facing +Z:
//   forward = (sin h, cos h), left = (cos h, -sin h).

const G = 9.81;

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
  idleRpm: 900,
  redline: 7200,
  shiftUpRpm: 6800,
  shiftDownRpm: 3000,
  shiftTime: 0.18,
  assists: true,           // traction control + counter-steer help
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
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export class CarPhysics {
  constructor(spec = {}) {
    this.spec = { ...DEFAULT_SPEC, ...spec };
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
      const torque = engineTorque(engineRpm) * drive;
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

    this.heading += this.yawRate * dt;
    this.x += this.velX * dt;
    this.z += this.velZ * dt;

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

  tireCurve(slip) {
    const { tireB: B, tireC: C } = this.spec;
    return Math.sin(C * Math.atan(B * slip));
  }

  /** True when the rear is sliding enough to count as a drift. */
  get isDrifting() {
    return this.vLong > 6 && Math.abs(Math.atan2(this.vLat, this.vLong)) > 0.18;
  }
}
