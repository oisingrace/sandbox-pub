// Merges keyboard, gamepad and on-screen touch controls into one
// analog-style input: steer -1 (right) .. 1 (left), throttle/brake 0..1.

const KEYS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  handbrake: ['Space'],
};

export class Input {
  constructor() {
    this.down = new Set();
    this.touch = { left: false, right: false, up: false, down: false, handbrake: false };
    this.pressedHandlers = new Map();
    this.kbSteer = 0;
    this.kbThrottle = 0;
    this.kbBrake = 0;

    addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.pressedHandlers.get(e.code)?.();
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }

  /** Register a one-shot action for a key (e.g. 'KeyR'). */
  onPress(code, fn) {
    this.pressedHandlers.set(code, fn);
  }

  bindTouchButton(el, name) {
    const set = (v) => (e) => {
      e.preventDefault();
      this.touch[name] = v;
      el.classList.toggle('active', v);
    };
    el.addEventListener('pointerdown', set(true));
    el.addEventListener('pointerup', set(false));
    el.addEventListener('pointercancel', set(false));
    el.addEventListener('pointerleave', set(false));
  }

  held(name) {
    return KEYS[name].some((k) => this.down.has(k)) || this.touch[name];
  }

  read(dt) {
    // Digital inputs are ramped so keyboard driving feels less twitchy.
    const steerTarget = (this.held('left') ? 1 : 0) - (this.held('right') ? 1 : 0);
    const steerRate = steerTarget === 0 ? 7 : Math.sign(steerTarget) !== Math.sign(this.kbSteer) ? 8 : 4;
    this.kbSteer = approach(this.kbSteer, steerTarget, steerRate * dt);
    this.kbThrottle = approach(this.kbThrottle, this.held('up') ? 1 : 0, 6 * dt);
    this.kbBrake = approach(this.kbBrake, this.held('down') ? 1 : 0, 8 * dt);

    const out = {
      steer: this.kbSteer,
      throttle: this.kbThrottle,
      brake: this.kbBrake,
      handbrake: this.held('handbrake'),
    };

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const deadzone = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const stick = deadzone(pad.axes[0] || 0);
      if (stick !== 0) out.steer = -Math.sign(stick) * stick * stick; // squared for finer centre control
      const rt = pad.buttons[7]?.value || 0;
      const lt = pad.buttons[6]?.value || 0;
      if (rt > 0.02) out.throttle = rt;
      if (lt > 0.02) out.brake = lt;
      if (pad.buttons[0]?.pressed || pad.buttons[5]?.pressed) out.handbrake = true;
      this.padButtons(pad);
    }
    return out;
  }

  padButtons(pad) {
    // Edge-detect a few buttons mapped to keyboard actions.
    const map = { 3: 'KeyR', 2: 'KeyC', 1: 'KeyT' };
    this.prevPad ||= {};
    for (const [idx, code] of Object.entries(map)) {
      const pressed = !!pad.buttons[idx]?.pressed;
      if (pressed && !this.prevPad[idx]) this.pressedHandlers.get(code)?.();
      this.prevPad[idx] = pressed;
    }
  }
}

function approach(v, target, maxDelta) {
  if (v < target) return Math.min(target, v + maxDelta);
  return Math.max(target, v - maxDelta);
}
