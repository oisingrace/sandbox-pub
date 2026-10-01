// Synthesised engine + tire squeal. Created lazily on first user gesture
// because browsers block audio until then.

export class CarAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    // Engine: two detuned oscillators through a throttle-driven lowpass.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 4;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    this.osc1.connect(this.engineFilter);
    this.osc2.connect(g2).connect(this.engineFilter);
    this.osc1.start();
    this.osc2.start();

    // Tire squeal: band-passed noise.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 900;
    this.squealFilter.Q.value = 6;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(this.squealFilter).connect(this.squealGain).connect(this.master);
    noise.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  update(car, skid) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const firing = (car.rpm / 60) * 2; // 4-cylinder firing frequency
    this.osc1.frequency.setTargetAtTime(firing, t, 0.03);
    this.osc2.frequency.setTargetAtTime(firing * 0.5 * 1.01, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(300 + car.throttle * 1400 + car.rpm * 0.15, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.12 + car.throttle * 0.16, t, 0.05);
    this.squealGain.gain.setTargetAtTime(Math.min(0.35, skid * 0.4), t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(700 + skid * 500, t, 0.1);
  }
}
