// Player options, saved per browser. Graphics presets fill in the
// individual graphics values; changing any one of them switches the
// preset to "custom".

const KEY = 'smash-lot-settings-v1';

export const GRAPHICS_PRESETS = {
  low: { resolution: 0.6, shadows: 'off', viewDistance: 'near', effects: 'low', antialias: false },
  medium: { resolution: 0.85, shadows: 'low', viewDistance: 'medium', effects: 'high', antialias: false },
  high: { resolution: 1, shadows: 'high', viewDistance: 'far', effects: 'high', antialias: true },
};

export const OPTIONS = {
  graphics: {
    preset: { label: 'Quality preset', choices: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['custom', 'Custom']] },
    resolution: { label: 'Resolution', choices: [[0.5, '50%'], [0.6, '60%'], [0.75, '75%'], [0.85, '85%'], [1, '100%'], [1.5, 'Sharp (HiDPI)']] },
    dynamicResolution: { label: 'Dynamic resolution', hint: 'Lowers resolution when the frame rate drops', choices: [[true, 'On'], [false, 'Off']] },
    shadows: { label: 'Shadows', choices: [['off', 'Off'], ['low', 'Low'], ['high', 'High']] },
    viewDistance: { label: 'View distance', choices: [['near', 'Near'], ['medium', 'Medium'], ['far', 'Far']] },
    effects: { label: 'Smoke and dust', choices: [['low', 'Low'], ['high', 'High']] },
    antialias: { label: 'Anti-aliasing', choices: [[true, 'On'], [false, 'Off']] },
    showFps: { label: 'Show FPS', choices: [[true, 'On'], [false, 'Off']] },
  },
  destruction: {
    breakage: { label: 'Breakage', hint: 'Detailed breaks shatter pieces again into smaller ones', choices: [['detailed', 'Detailed'], ['simple', 'Simple'], ['off', 'Off']] },
    debrisLimit: { label: 'Max debris pieces', hint: 'Oldest settled debris is removed past this', choices: [[250, '250'], [500, '500'], [800, '800'], [1300, '1,300']] },
    debrisLifetime: { label: 'Debris cleanup', hint: 'Small pieces fade out after this long', choices: [[0, 'Never'], [60, '60 s'], [20, '20 s']] },
    physicsQuality: { label: 'Physics accuracy', hint: 'Higher keeps tall stacks steadier, costs CPU', choices: [[2, 'Low'], [4, 'Normal'], [6, 'High']] },
  },
  game: {
    assists: { label: 'Driving assists', hint: 'Traction control and countersteer', choices: [[true, 'On'], [false, 'Off']] },
    sound: { label: 'Sound', choices: [[true, 'On'], [false, 'Off']] },
    volume: { label: 'Volume', choices: [[0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, '100%']] },
    startVehicle: { label: 'Vehicle', choices: [] },
    playerName: { label: 'Name', choices: [] },
    mode: { label: 'Game mode', choices: [] },
  },
};

export const DEFAULTS = {
  preset: 'medium',
  ...GRAPHICS_PRESETS.medium,
  dynamicResolution: true,
  showFps: false,
  breakage: 'detailed',
  debrisLimit: 500,
  debrisLifetime: 60,
  physicsQuality: 4,
  assists: true,
  sound: true,
  volume: 0.75,
  startVehicle: 'sports',
  playerName: '',
  mode: 'free',
};

/** A sensible first-run preset from what the device reports. */
function detectPreset() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (touch || cores <= 4) return 'low';
  if (cores >= 8 && devicePixelRatio <= 2) return 'high';
  return 'medium';
}

export function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    saved = null;
  }
  if (saved) return { ...DEFAULTS, ...saved };
  const preset = detectPreset();
  const s = { ...DEFAULTS, preset, ...GRAPHICS_PRESETS[preset] };
  if (preset === 'low') { s.debrisLimit = 250; s.debrisLifetime = 20; }
  if (preset === 'high') { s.debrisLimit = 800; }
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage can be blocked (private mode); settings then last for this visit only.
  }
}

/** Apply one change, keeping the graphics preset consistent. */
export function changeSetting(s, key, value) {
  const next = { ...s, [key]: value };
  if (key === 'preset' && GRAPHICS_PRESETS[value]) Object.assign(next, GRAPHICS_PRESETS[value]);
  else if (key in GRAPHICS_PRESETS.low) next.preset = matchingPreset(next);
  return next;
}

function matchingPreset(s) {
  for (const [name, p] of Object.entries(GRAPHICS_PRESETS)) {
    if (Object.entries(p).every(([k, v]) => s[k] === v)) return name;
  }
  return 'custom';
}
