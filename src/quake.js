// Screen quake. Two sources add up:
//  - trauma: short kicks from our own car (crashes, hard landings, boost),
//    which fade within half a second;
//  - destruction activity: a running measure of how much is being broken,
//    burned and blown up around us right now. Every piece adds energy by its
//    mass, less the further away it happens, and the total leaks away over
//    a second or so. A lone brick barely registers; ploughing through a
//    wall rumbles; a collapsing building or a chain of fuel drums shakes the
//    whole screen.
// The motion is smooth noise (layered sines), not random jitter: a low
// rumble that gets faster and more violent as it grows, moving the camera
// a little and tilting it a touch.

const ACTIVITY_DECAY = 0.7;  // seconds for destruction activity to fade to ~37%
const TRAUMA_DECAY = 5;      // per second
const FALLOFF = 14;          // metres: things this far away count for half

export class ScreenQuake {
  constructor() {
    this.trauma = 0;
    this.activity = 0;
    this.t = 0;        // noise time (runs faster when shaking harder)
    this.strength = 1; // player setting: 0 (off) .. 1.6
    this.level = 0;    // current shake, 0..1 (for the HUD/telemetry and rumble)
    this.phase = Array.from({ length: 9 }, () => Math.random() * 100);
    this.rumbleAt = 0;
  }

  /** A short jolt (0..1) from our own car. */
  kick(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Keep the shake at least this strong for now (boost roar). */
  floor(amount) {
    this.trauma = Math.max(this.trauma, amount);
  }

  /**
   * Destruction happened at `pos` (any {x, z}), seen from `from` (our car).
   * `energy` is roughly 1 for a 100 kg piece breaking. `falloff` is the
   * distance at which it counts for half (explosions carry further).
   */
  add(energy, pos, from, falloff = FALLOFF) {
    const d = pos && from ? Math.hypot(pos.x - from.x, pos.z - from.z) : 0;
    this.activity += energy / (1 + (d / falloff) ** 2);
  }

  /** Something of `mass` kg broke or burned. */
  smash(mass, pos, from, scale = 1) {
    this.add(Math.pow(mass / 100, 0.7) * scale, pos, from);
  }

  /**
   * Advance and shake the camera (call after the chase camera has placed
   * it this frame).
   */
  apply(camera, dt) {
    this.trauma *= Math.exp(-dt * TRAUMA_DECAY);
    this.activity *= Math.exp(-dt / ACTIVITY_DECAY);
    // Destruction activity saturates: lots more debris, only a bit more shake.
    this.rumble = 1 - Math.exp(-this.activity / 45);
    const s = Math.min(1, this.trauma + this.rumble * 0.9) * this.strength;
    this.level = Math.min(1, s);
    if (s < 0.002) return;
    const a = s * s; // square it: small shakes stay subtle, big ones hit hard
    // Faster shaking as it gets more violent: a 2.5 Hz rumble rising to
    // 8 Hz, with quicker overtones on top.
    const hz = 2.5 + 5.5 * Math.min(1, s);
    this.t += dt * hz * Math.PI * 2;
    const t = this.t;
    const p = this.phase;
    const n = (i) => Math.sin(t + p[i]) * 0.55 + Math.sin(t * 2.13 + p[i + 3]) * 0.3 + Math.sin(t * 4.71 + p[i + 6]) * 0.15;
    camera.position.x += n(0) * a * 0.35;
    camera.position.y += n(1) * a * 0.25;
    camera.position.z += n(2) * a * 0.35;
    camera.rotateX(n(1) * a * 0.025);
    camera.rotateZ(n(2) * a * 0.04);
    this.padRumble(s);
  }

  /** Rumble a connected gamepad along with the shake. */
  padRumble(s) {
    if (s < 0.08) return;
    const now = performance.now();
    if (now < this.rumbleAt) return;
    this.rumbleAt = now + 90;
    const pad = navigator.getGamepads?.().find((g) => g && g.connected && g.vibrationActuator);
    pad?.vibrationActuator.playEffect?.('dual-rumble', {
      duration: 110,
      strongMagnitude: Math.min(1, s * 0.9),
      weakMagnitude: Math.min(1, s * 0.6),
    }).catch?.(() => {});
  }
}
