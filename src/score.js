// Points for destruction, with a combo multiplier. Every thing you break,
// burn or blow up scores by how big it was, times the multiplier. Keep the
// destruction going (each smash within COMBO_WINDOW of the last) and the
// multiplier climbs, up to ×10; pause too long and the combo cashes in and
// the multiplier drops back to ×1.

export const COMBO_WINDOW = 2.2; // seconds a combo survives without another smash
// Smashes in a row needed for each multiplier: ×2 at 5, ×3 at 12, ... ×10 at 250.
const TIERS = [0, 5, 12, 25, 45, 70, 100, 140, 190, 250];

/** Base points for breaking or burning something of `mass` kg. */
export function pointsFor(mass) {
  return 10 + Math.round(Math.sqrt(mass) * 3);
}
export const EXPLOSION_POINTS = 250;

export class Score {
  constructor() {
    this.reset();
  }

  reset() {
    this.points = 0;
    this.combo = 0;      // smashes in the current combo
    this.comboPoints = 0;
    this.timer = 0;      // seconds left before the combo ends
    this.mult = 1;
    this.best = this.best || 0;
    this.onComboEnd = this.onComboEnd || null;
    this.lastGain = 0;
    this.gainAt = -1;
  }

  /** Award `base` points (times the multiplier). Returns the points given. */
  add(base) {
    this.combo++;
    this.timer = COMBO_WINDOW;
    this.mult = multiplierFor(this.combo);
    const gain = base * this.mult;
    this.points += gain;
    this.comboPoints += gain;
    this.lastGain = gain;
    this.gainAt = performance.now();
    return gain;
  }

  update(dt) {
    if (this.combo === 0) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    // Combo over: report it and start again at ×1.
    if (this.combo >= 5) this.onComboEnd?.({ count: this.combo, mult: this.mult, points: this.comboPoints });
    this.best = Math.max(this.best, this.comboPoints);
    this.combo = 0;
    this.comboPoints = 0;
    this.mult = 1;
    this.timer = 0;
  }

  /** Progress (0..1) toward the next multiplier. */
  get progress() {
    if (this.mult >= TIERS.length) return 1;
    const lo = TIERS[this.mult - 1], hi = TIERS[this.mult];
    return (this.combo - lo) / (hi - lo);
  }
}

function multiplierFor(combo) {
  let m = 1;
  for (let i = 1; i < TIERS.length; i++) if (combo >= TIERS[i]) m = i + 1;
  return m;
}
