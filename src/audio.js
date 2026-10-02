// All game audio, synthesised with Web Audio (no sound files). Created on
// the first user gesture because browsers block audio until then.
//
//   engine/loops ──► loopBus ─┐
//   one-shots ────► sfxBus ───┼──► master (volume) ──► compressor ──► out
//                   reverb ◄──┘ (send)  └─► ┘
//
// One-shots in the world (impacts, burns, explosions) go through a panner
// so they come from where they happen; the listener follows the camera.

const IMPACTS = {
  brick: { filter: 'lowpass', freq: 1100, q: 0.8, decay: 0.2, gain: 0.5, tones: [90], toneGain: 0.5, toneDecay: 0.6 },
  concrete: { filter: 'lowpass', freq: 600, q: 0.7, decay: 0.32, gain: 0.7, tones: [60], toneGain: 0.9, toneDecay: 0.8 },
  wood: { filter: 'bandpass', freq: 750, q: 1.4, decay: 0.16, gain: 0.7, tones: [210, 330], toneGain: 0.35, toneDecay: 0.5 },
  metal: { filter: 'bandpass', freq: 2200, q: 9, decay: 0.55, gain: 0.45, tones: [420, 1130], toneGain: 0.35, toneDecay: 1 },
  plastic: { filter: 'highpass', freq: 1400, q: 0.7, decay: 0.08, gain: 0.35, tones: [180], toneGain: 0.2, toneDecay: 0.4 },
  glass: { filter: 'highpass', freq: 3200, q: 1.5, decay: 0.35, gain: 0.45, tones: [2600, 3900, 5300], toneGain: 0.18, toneDecay: 0.7 },
  ball: { filter: 'lowpass', freq: 1300, q: 1.1, decay: 0.16, gain: 0.85, tones: [120, 78], toneGain: 0.9, toneDecay: 0.7 },
  crash: { filter: 'lowpass', freq: 420, q: 1, decay: 0.45, gain: 0.9, tones: [48], toneGain: 1, toneDecay: 0.9 },
};

// Engine characters. fund/sub/harm: oscillator mix (firing frequency,
// half, double). drive: distortion. cut*: filter cutoff (Hz) at idle and
// the extra opened by throttle. am: "burble" (amplitude wobble at half the
// firing rate). noise: intake/mechanical noise. whine: turbine-like tone.
const VOICES = {
  sport: { fund: 0.55, sub: 0.25, harm: 0.2, drive: 2.5, q: 5, cutBase: 350, cutThrottle: 1900, am: 0.08, noise: 0.05, pops: true, whine: 0 },
  hatch: { fund: 0.45, sub: 0.12, harm: 0.32, drive: 1.8, q: 3, cutBase: 520, cutThrottle: 2300, am: 0, noise: 0.07, pops: false, whine: 0 },
  v8: { fund: 0.45, sub: 0.6, harm: 0.1, drive: 3.5, q: 6, cutBase: 220, cutThrottle: 1100, am: 0.5, noise: 0.04, pops: true, whine: 0 },
  diesel: { fund: 0.4, sub: 0.5, harm: 0.16, drive: 5, q: 2, cutBase: 170, cutThrottle: 900, am: 0.35, noise: 0.2, pops: false, whine: 0 },
  ember: { fund: 0.38, sub: 0.2, harm: 0.22, drive: 2, q: 4, cutBase: 420, cutThrottle: 2100, am: 0, noise: 0.05, pops: true, whine: 0.09 },
};

const MAX_VOICES = 16;

export class CarAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.75;
    this.paused = true;
    this.voice = VOICES.sport;
    this.prevGear = 1;
    this.prevThrottle = 0;
  }

  /** Create (or resume) the audio context. Must run inside a user gesture. */
  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    // Output chain: master volume -> gentle bus compressor -> speakers.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.2;
    this.compressor.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(this.compressor);
    this.applyVolume();

    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.loopBus = ctx.createGain();
    this.loopBus.gain.value = this.paused ? 0 : 1;
    this.loopBus.connect(this.master);

    // Reverb send: a generated decaying-noise impulse response.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulseResponse(1.8, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.buildEngine();
    this.buildLoops();
  }

  buildEngine() {
    const ctx = this.ctx;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.engineMix = ctx.createGain(); // amplitude-modulated by the burble LFO
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineMix.connect(this.shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.loopBus);

    const osc = (type) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      o.connect(g).connect(this.engineMix);
      o.start();
      return { o, g };
    };
    this.oscFund = osc('sawtooth');
    this.oscSub = osc('square');
    this.oscHarm = osc('triangle');
    this.oscWhine = osc('sine');

    this.amOsc = ctx.createOscillator();
    this.amDepth = ctx.createGain();
    this.amOsc.connect(this.amDepth).connect(this.engineMix.gain);
    this.amOsc.start();

    // Intake / mechanical noise.
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 1.2;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.noiseSource().connect(this.intakeFilter).connect(this.intakeGain).connect(this.engineGain);

    this.applyVoice();
  }

  buildLoops() {
    const ctx = this.ctx;
    const loop = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      this.noiseSource().connect(f).connect(g).connect(this.loopBus);
      return { f, g };
    };
    this.squealA = loop('bandpass', 900, 7);
    this.squealB = loop('bandpass', 1850, 9);
    this.boost = loop('bandpass', 500, 0.8);
    this.rumble = loop('lowpass', 160, 0.7);
    this.wind = loop('bandpass', 650, 0.4);
  }

  /** Pick the engine character for a vehicle (see `voice` in vehicles.js). */
  setVehicle(def) {
    this.voice = VOICES[def.voice] || VOICES.sport;
    if (this.ctx) this.applyVoice();
  }

  applyVoice() {
    const v = this.voice;
    const t = this.ctx.currentTime;
    this.oscFund.g.gain.setTargetAtTime(v.fund, t, 0.05);
    this.oscSub.g.gain.setTargetAtTime(v.sub, t, 0.05);
    this.oscHarm.g.gain.setTargetAtTime(v.harm, t, 0.05);
    this.oscWhine.g.gain.setTargetAtTime(v.whine, t, 0.05);
    this.engineMix.gain.value = 1 - v.am / 2;
    this.amDepth.gain.value = v.am / 2;
    this.engineFilter.Q.value = v.q;
    this.shaper.curve = distortionCurve(v.drive);
  }

  /** Pausing silences the car but keeps one-shots (menu clicks) working. */
  setPaused(paused) {
    this.paused = paused;
    if (!this.ctx) return;
    if (!paused) this.ctx.resume();
    this.loopBus.gain.setTargetAtTime(paused ? 0 : 1, this.ctx.currentTime, 0.08);
  }

  setVolume(volume) {
    this.volume = volume;
    this.applyVolume();
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyVolume();
  }

  applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * 0.7;
  }

  /** Follow the camera so positional sounds pan and fade correctly. */
  setListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const e = camera.matrixWorld.elements; // camera looks down its local -Z
    const f = { x: -e[8], y: -e[9], z: -e[10] };
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t); l.forwardY.setValueAtTime(f.y, t); l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
    this.listenerPos = p;
  }

  /** Output node for a one-shot: panned in the world if `pos` is given. */
  outputFor(pos, reverb = 0.3) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    if (pos) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 7;
      panner.rolloffFactor = 1.1;
      panner.maxDistance = 250;
      if (panner.positionX) {
        panner.positionX.value = pos.x; panner.positionY.value = pos.y; panner.positionZ.value = pos.z;
      } else {
        panner.setPosition(pos.x, pos.y, pos.z);
      }
      out.connect(panner).connect(this.sfxBus);
    } else {
      out.connect(this.sfxBus);
    }
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      out.connect(send).connect(this.reverbSend);
    }
    return out;
  }

  /** Is a world position close enough to bother playing? */
  audible(pos, range = 140) {
    if (!pos || !this.listenerPos) return true;
    const p = this.listenerPos;
    return Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z) < range;
  }

  /** Reserve a voice; loud sounds may still play when we're near the cap. */
  claimVoice(duration, strength) {
    const now = this.ctx.currentTime;
    this.voices = (this.voices || []).filter((t) => t > now);
    if (this.voices.length >= MAX_VOICES || (this.voices.length > MAX_VOICES * 0.6 && strength < 0.35)) return false;
    this.voices.push(now + duration);
    return true;
  }

  /**
   * One-shot collision sound. `strength` is 0..1; `pos` places it in the
   * world (omit for sounds on the player's own car).
   */
  impact(material, strength, pos) {
    if (!this.ctx || this.muted || strength < 0.05 || !this.audible(pos)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const preset = IMPACTS[material] || IMPACTS.concrete;
    const dur = preset.decay * (0.6 + strength);
    if (!this.claimVoice(dur, strength)) return;

    const out = this.outputFor(pos, material === 'crash' ? 0.25 : 0.4);
    const peak = Math.min(0.9, preset.gain * (0.25 + strength));
    out.gain.setValueAtTime(peak, now);
    out.gain.exponentialRampToValueAtTime(0.001, now + dur);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filter = ctx.createBiquadFilter();
    filter.type = preset.filter;
    filter.frequency.value = preset.freq * (0.85 + Math.random() * 0.3);
    filter.Q.value = preset.q;
    src.connect(filter).connect(out);
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
      g.gain.setValueAtTime(preset.toneGain, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur * preset.toneDecay);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + dur * preset.toneDecay);
    }
  }

  /** Whoosh and crackle of something catching fire. */
  burn(strength = 1, pos) {
    if (!this.ctx || this.muted || !this.audible(pos)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.lastBurn && now - this.lastBurn < 0.05) return;
    if (!this.claimVoice(1, strength)) return;
    this.lastBurn = now;
    const out = this.outputFor(pos, 0.3);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(350, now);
    filter.frequency.exponentialRampToValueAtTime(2400, now + 0.18);
    filter.frequency.exponentialRampToValueAtTime(600, now + 0.9);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.5 * strength, now + 0.06);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.95);
    src.connect(filter).connect(out);
    src.start(now, Math.random());
    src.stop(now + 1);
    this.crackles(out, now + 0.1, 4, 0.5);
  }

  /** Fuel drum explosion: deep boom, blast noise, crackle and a long tail. */
  explosion(pos, distance = 20) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.lastBoom && now - this.lastBoom < 0.04) return;
    this.lastBoom = now;
    const out = this.outputFor(pos, 0.9);
    out.gain.value = 1;

    // Sub-bass thump sweeping down.
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(95, now);
    boom.frequency.exponentialRampToValueAtTime(28, now + 1.1);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, now);
    bg.gain.exponentialRampToValueAtTime(1.2, now + 0.015);
    bg.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    boom.connect(bg).connect(out);
    boom.start(now);
    boom.stop(now + 1.35);

    // Blast: wide noise burst that darkens as it decays.
    const blast = ctx.createBufferSource();
    blast.buffer = this.noiseBuffer();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000, now);
    lp.frequency.exponentialRampToValueAtTime(300, now + 1.4);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
    blast.connect(lp).connect(ng).connect(out);
    blast.start(now, Math.random());
    blast.stop(now + 1.7);

    this.crackles(out, now + 0.15, 7, 0.6);
    // Close blasts briefly duck the engine so they hit harder.
    if (distance < 25) {
      const g = this.loopBus.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(this.paused ? 0 : 0.35, now);
      g.setTargetAtTime(this.paused ? 0 : 1, now + 0.15, 0.35);
    }
  }

  crackles(out, start, count, level) {
    const ctx = this.ctx;
    for (let i = 0; i < count; i++) {
      const t0 = start + Math.random() * 0.6;
      const c = ctx.createBufferSource();
      c.buffer = this.noiseBuffer();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000 + Math.random() * 1500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * (0.4 + Math.random() * 0.6), t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.03);
      c.connect(hp).connect(g).connect(out);
      c.start(t0, Math.random());
      c.stop(t0 + 0.04);
    }
  }

  /** Exhaust pops when lifting off at high revs. */
  pops() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const t0 = now + 0.05 + i * (0.06 + Math.random() * 0.1);
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700 + Math.random() * 600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.55 * (0.5 + Math.random() * 0.5), t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
      src.connect(f).connect(g).connect(this.loopBus);
      src.start(t0, Math.random());
      src.stop(t0 + 0.08);
    }
  }

  /** Referee's whistle: a trilled high tone. `long` for full time. */
  whistle(long = false) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const blasts = long ? [[0, 0.35], [0.45, 0.35], [0.9, 0.9]] : [[0, 0.5]];
    for (const [t0, dur] of blasts) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 2900;
      const trill = ctx.createOscillator();
      trill.frequency.value = 38;
      const depth = ctx.createGain();
      depth.gain.value = 180;
      trill.connect(depth).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + t0);
      g.gain.exponentialRampToValueAtTime(0.16, now + t0 + 0.02);
      g.gain.setValueAtTime(0.16, now + t0 + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, now + t0 + dur);
      o.connect(g).connect(this.sfxBus);
      for (const n of [o, trill]) { n.start(now + t0); n.stop(now + t0 + dur + 0.02); }
    }
  }

  /** Countdown beep; `go` is the higher final one. */
  beep(go = false) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = go ? 1320 : 660;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2400;
    const g = ctx.createGain();
    const dur = go ? 0.45 : 0.16;
    g.gain.setValueAtTime(0.12, now);
    g.gain.setValueAtTime(0.12, now + dur - 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(f).connect(g).connect(this.sfxBus);
    o.start(now);
    o.stop(now + dur + 0.02);
  }

  /** Goal: stadium horn plus the crowd going up. */
  goalHorn() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.32, now + 0.08);
    out.gain.setValueAtTime(0.32, now + 1.5);
    out.gain.exponentialRampToValueAtTime(0.001, now + 2.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    lp.connect(out).connect(this.sfxBus);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    out.connect(send).connect(this.reverbSend);
    for (const f of [174, 220, 261]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(now);
      o.stop(now + 2.25);
    }
    this.crowd(1, 4);
  }

  /** Crowd roar: band-passed noise swelling and fading over `dur` seconds. */
  crowd(level = 0.6, dur = 2.5) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.35 * level, now + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.sfxBus);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    g.connect(send).connect(this.reverbSend);
    src.start(now, Math.random());
    src.stop(now + dur + 0.05);
  }

  /**
   * Flamethrower roar: a continuous low rumble plus a fizzing hiss, faded to
   * `level` (0 = off). Built on first use.
   */
  flame(level) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.flameOut) {
      this.flameOut = ctx.createGain();
      this.flameOut.gain.value = 0;
      this.flameOut.connect(this.loopBus);
      for (const [type, freq, q, gain, rate] of [['lowpass', 380, 0.9, 1.1, 0.6], ['bandpass', 2600, 0.7, 0.35, 1.3]]) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer();
        src.loop = true;
        src.playbackRate.value = rate;
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(f).connect(g).connect(this.flameOut);
        src.start();
      }
      // Slow flutter so it sounds like burning, not static.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 7;
      const depth = ctx.createGain();
      depth.gain.value = 0.25;
      lfo.connect(depth).connect(this.flameOut.gain);
      lfo.start();
      this.flameLfo = depth;
    }
    const target = this.muted ? 0 : Math.min(1, level) * 0.55;
    this.flameOut.gain.setTargetAtTime(target, ctx.currentTime, target > (this.flameLevel || 0) ? 0.03 : 0.12);
    this.flameLfo.gain.setTargetAtTime(target * 0.35, ctx.currentTime, 0.05);
    this.flameLevel = target;
  }

  /** Short tick for menu buttons. */
  ui() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1400, now);
    o.frequency.exponentialRampToValueAtTime(900, now + 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    o.connect(g).connect(this.sfxBus);
    o.start(now);
    o.stop(now + 0.07);
  }

  /** Per-frame update of the continuous sounds. */
  update(car, skid) {
    if (!this.ctx || this.paused) return;
    const t = this.ctx.currentTime;
    const v = this.voice;
    const firing = (car.rpm / 60) * 2 * (car.spec.engineTone ?? 1); // 4-cylinder firing frequency

    // Gear changes: a short dip in volume as the clutch goes in.
    let dip = 1;
    if (car.gear !== this.prevGear) {
      this.shiftAt = t;
      this.prevGear = car.gear;
    }
    if (this.shiftAt && t - this.shiftAt < 0.14) dip = 0.45;

    this.oscFund.o.frequency.setTargetAtTime(firing, t, 0.03);
    this.oscSub.o.frequency.setTargetAtTime(firing * 0.5 * 1.006, t, 0.03);
    this.oscHarm.o.frequency.setTargetAtTime(firing * 2.01, t, 0.03);
    this.oscWhine.o.frequency.setTargetAtTime(600 + car.rpm * 0.55 + car.speed * 8, t, 0.08);
    this.amOsc.frequency.setTargetAtTime(Math.max(4, firing * 0.25), t, 0.05);
    const load = car.throttle;
    this.engineFilter.frequency.setTargetAtTime(v.cutBase + load * v.cutThrottle + car.rpm * 0.12, t, 0.05);
    this.engineGain.gain.setTargetAtTime((0.1 + load * 0.14 + (car.rpm / 7000) * 0.05) * dip, t, 0.04);
    this.intakeFilter.frequency.setTargetAtTime(500 + car.rpm * 0.3, t, 0.05);
    this.intakeGain.gain.setTargetAtTime(v.noise * (0.2 + load) * (car.rpm / 5000), t, 0.05);

    // Lift-off at high revs: crackle and pop.
    if (v.pops && this.prevThrottle > 0.7 && load < 0.1 && car.rpm > 4500 && car.gear > 0) this.pops();
    this.prevThrottle = load;

    const squeal = Math.min(0.35, skid * 0.4);
    this.squealA.g.gain.setTargetAtTime(squeal, t, 0.05);
    this.squealB.g.gain.setTargetAtTime(squeal * 0.35, t, 0.05);
    this.squealA.f.frequency.setTargetAtTime(700 + skid * 500, t, 0.1);

    this.boost.g.gain.setTargetAtTime(car.boosting ? 0.32 : 0, t, car.boosting ? 0.05 : 0.15);
    this.boost.f.frequency.setTargetAtTime(car.boosting ? 380 + car.speed * 14 : 300, t, 0.2);

    // Road rumble and wind rise with speed, so speed is audible.
    const sp = car.speed;
    this.rumble.g.gain.setTargetAtTime(Math.min(0.28, sp * 0.009), t, 0.1);
    this.wind.g.gain.setTargetAtTime(Math.min(0.3, (sp / 55) ** 2 * 0.3), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(450 + sp * 12, t, 0.2);
  }

  // --- Helpers ---------------------------------------------------------------

  noiseBuffer() {
    if (!this._noise) {
      const len = this.ctx.sampleRate * 2;
      this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this._noise;
  }

  noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  impulseResponse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
    return buf;
  }
}

function distortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}
