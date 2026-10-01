import * as THREE from 'three';

// Third-person chase camera with a few presets. The camera trails the
// car's heading with some lag and leans toward the direction of travel
// during slides, so drifts read clearly on screen.

const MODES = [
  { name: 'Chase', dist: 6.2, height: 2.3, look: 1.1, lag: 5 },
  { name: 'Far', dist: 10, height: 3.8, look: 1.0, lag: 4 },
  { name: 'Hood', hood: true },
];

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;
    this.yaw = 0;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.initialised = false;
    this.vehicleCam = { scale: 1, hoodY: 1.42, hoodZ: 0.9 };
    this.boostFov = 0;
  }

  /** Fit the camera to a vehicle's size (see `cam` in vehicles.js). */
  setVehicle(def) {
    this.vehicleCam = def.cam;
  }

  get modeName() {
    return MODES[this.mode].name;
  }

  cycle() {
    this.mode = (this.mode + 1) % MODES.length;
    this.initialised = false;
  }

  snap() {
    this.initialised = false;
  }

  update(car, dt) {
    const m = MODES[this.mode];
    const cam = this.camera;
    const speed = car.speed;

    // Blend heading with velocity direction when moving forward quickly.
    let targetYaw = car.heading;
    if (speed > 3 && car.vLong > 0) {
      const velYaw = Math.atan2(car.velX, car.velZ);
      targetYaw = car.heading + wrap(velYaw - car.heading) * 0.55;
    }

    if (!this.initialised) {
      this.yaw = targetYaw;
    } else {
      this.yaw += wrap(targetYaw - this.yaw) * (1 - Math.exp(-dt * (m.lag || 8)));
    }

    this.boostFov += ((car.boosting ? 9 : 0) - this.boostFov) * (1 - Math.exp(-dt * 6));
    const fov = 62 + Math.min(18, speed * 0.28) + this.boostFov;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 3));
      cam.updateProjectionMatrix();
    }

    if (m.hood) {
      const sinH = Math.sin(car.heading);
      const cosH = Math.cos(car.heading);
      const { hoodY, hoodZ } = this.vehicleCam;
      cam.position.set(car.x + sinH * hoodZ, hoodY, car.z + cosH * hoodZ);
      cam.lookAt(car.x + sinH * 25, hoodY - 0.5, car.z + cosH * 25);
      this.initialised = true;
      return;
    }

    // Pull back a little at speed.
    const k = this.vehicleCam.scale;
    const dist = m.dist * k + Math.min(2, speed * 0.03);
    const desired = new THREE.Vector3(
      car.x - Math.sin(this.yaw) * dist,
      m.height * k,
      car.z - Math.cos(this.yaw) * dist,
    );
    const lookAt = new THREE.Vector3(
      car.x + Math.sin(car.heading) * 2,
      m.look * k,
      car.z + Math.cos(car.heading) * 2,
    );

    if (!this.initialised) {
      this.pos.copy(desired);
      this.target.copy(lookAt);
      this.initialised = true;
    } else {
      // Stiffer horizontally than vertically for a planted feel.
      const kH = 1 - Math.exp(-dt * 12);
      const kV = 1 - Math.exp(-dt * 4);
      this.pos.x += (desired.x - this.pos.x) * kH;
      this.pos.z += (desired.z - this.pos.z) * kH;
      this.pos.y += (desired.y - this.pos.y) * kV;
      this.target.lerp(lookAt, 1 - Math.exp(-dt * 15));
    }

    cam.position.copy(this.pos);
    cam.lookAt(this.target);
  }
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
