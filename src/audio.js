// Synthesised engine + tire squeal. Created lazily on first user gesture
// because browsers block audio until then.

const IMPACTS = {
  brick: { filter: 'lowpass', freq: 1100, q: 0.8, decay: 0.2, gain: 0.5, tones: [90], toneGain: 0.5, toneDecay: 0.6 },
  concrete: { filter: 'lowpass', freq: 600, q: 0.7, decay: 0.32, gain: 0.7, tones: [60], toneGain: 0.9, toneDecay: 0.8 },
  wood: { filter: 'bandpass', freq: 750, q: 1.4, decay: 0.16, gain: 0.7, tones: [210, 330], toneGain: 0.35, toneDecay: 0.5 },
  metal: { filter: 'bandpass', freq: 2200, q: 9, decay: 0.55, gain: 0.45, tones: [420, 1130], toneGain: 0.35, toneDecay: 1 },
  plastic: { filter: 'highpass', freq: 1400, q: 0.7, decay: 0.08, gain: 0.35, tones: [], toneGain: 0, toneDecay: 0 },
  crash: { filter: 'lowpass', freq: 420, q: 1, decay: 0.45, gain: 0.9, tones: [48], toneGain: 1, toneDecay: 0.9 },
};

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

  /**
   * One-shot collision sound. `strength` is 0..1. Calls are rate limited
   * so a collapsing wall doesn't stack hundreds of voices.
   */
  impact(material, strength) {
    if (!this.ctx || this.muted || strength < 0.05) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.voices = (this.voices || []).filter((t) => t > now);
    if (this.voices.length > 10) return;
    const preset = IMPACTS[material] || IMPACTS.concrete;
    const dur = preset.decay * (0.6 + strength);
    this.voices.push(now + dur);

    const gain = ctx.createGain();
    const peak = Math.min(0.9, preset.gain * (0.25 + strength));
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    gain.connect(this.master);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filter = ctx.createBiquadFilter();
    filter.type = preset.filter;
    filter.frequency.value = preset.freq * (0.85 + Math.random() * 0.3);
    filter.Q.value = preset.q;
    src.connect(filter).connect(gain);
    src.start(now, Math.random());
    src.stop(now + dur);

    // Tonal body: a thump for heavy things, a ring for metal.
    for (const tone of preset.tones) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = tone * (0.9 + Math.random() * 0.2);
      osc.frequency.setValueAtTime(f * 1.4, now);
      osc.frequency.exponentialRampToValueAtTime(f, now + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak * preset.toneGain, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur * preset.toneDecay);
      osc.connect(g).connect(this.master);
      osc.start(now);
      osc.stop(now + dur * preset.toneDecay);
    }
  }

  noiseBuffer() {
    if (!this._noise) {
      const len = this.ctx.sampleRate * 2;
      this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this._noise;
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
