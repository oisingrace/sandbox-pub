// Things you unlock by playing (or with a code), saved in this browser.
//
// The god car: a custom car whose workshop sliders go far past the normal
// range (see GOD_RANGES in carkit.js) and whose boost never runs out.
// Unlock it by hitting a ×10 combo, scoring 100,000 points in one run of
// free roam or the Motorway, or winning a solo Versus match against
// computer drivers; or type the code into the workshop's code box.

const UNLOCKS_KEY = 'smash-lot-unlocks-v1';

/** Codes typed into the workshop's code box, and what each unlocks. */
const CODES = { GOON321: 'god' };

export const GOD_POINTS = 100000;
export const GOD_HINT = `Hit a ×10 combo, score ${GOD_POINTS.toLocaleString('en-US')} points in one run, or win a Versus match against computer drivers. Or enter a code below.`;

/** The god car as it first appears in your garage (then edit it in the workshop). */
export const GOD_DESIGN = {
  id: 'god-car', name: 'God car', style: 'muscle', god: true,
  color: 0xf2c230, trim: 0x111114, accent: 0xfff2b0,
  size: { length: 0.7, width: 0.7, height: 0.35, ride: 0.6, wheels: 0.9 },
  tune: { power: 2.6, weight: 0.9, grip: 1.7, balance: 0.4, boost: 3, gearing: 1.4 },
  engine: 'v8', ability: 'none', weapon: 'none', parts: ['spoiler', 'scoop', 'stripes', 'lightbar'], aerial: true,
};

let unlocked = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(UNLOCKS_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

export function isUnlocked(key) {
  return !!unlocked[key];
}

/** Unlock `key`. Returns true only the first time. */
export function unlock(key) {
  if (unlocked[key]) return false;
  unlocked = { ...unlocked, [key]: true };
  try {
    localStorage.setItem(UNLOCKS_KEY, JSON.stringify(unlocked));
  } catch {
    // Storage blocked (private mode): unlocked for this visit only.
  }
  return true;
}

/** What a typed code unlocks, or null if it isn't one. */
export function codeUnlocks(text) {
  return CODES[String(text).trim().toUpperCase()] ?? null;
}
