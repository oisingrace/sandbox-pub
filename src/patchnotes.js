// Patch notes, newest first, shown on the main menu's Patch notes screen.
// Add a new entry at the top for each update.

export const PATCH_NOTES = [
  {
    version: '0.12', date: '2026-10-05', title: 'Drifting, Versus bots, patch notes',
    notes: [
      'Drifting reworked: a drift helper holds the slide at the angle you steer for (into the turn for more angle, countersteer to straighten), keeps you moving on the throttle and stops spin-outs. Lift off with the wheel straight and the drift fades out.',
      'Drift helper strength is in Options → Game (0 is the old raw handling).',
      'Drifts now score points in free roam and on the motorway when they end.',
      'Versus: choose how many computer drivers (none to 5), their skill (easy, normal, hard) and what they drive, on the main menu or in Options → Versus. Changing them mid-match restarts it with the new line-up.',
      'This patch notes screen.',
    ],
  },
  {
    version: '0.11', date: '2026-10-05', title: 'On the website',
    notes: ['Smash Lot is on the games site.'],
  },
  {
    version: '0.10', date: '2026-10-03', title: 'Motorway',
    notes: [
      'New mode: a 2.4 km dual carriageway with a clear middle and trouble on the sides: roadworks, broken-down lorries, barriers, drums, lamp posts, trees and overpass pillars.',
      'Kicker ramps on the hard shoulders and a big jump on each verge.',
    ],
  },
  {
    version: '0.9', date: '2026-10-03', title: 'Custom car weapons, audio fix',
    notes: [
      'Car workshop: pick a roof weapon (machine gun, rockets, rocket salvo, flamethrower or mines). It\'s your own weapon in Versus and fires at the scenery in free roam.',
      'Audio no longer stays silent until a reload: it checks itself and restarts if it ever stops.',
      'The help shows the right handbrake key for cars that jump (Q on the Striker).',
    ],
  },
  {
    version: '0.8', date: '2026-10-02', title: 'Versus',
    notes: [
      'New mode: armed car combat in the Scrapyard. Health, auto-aiming roof weapons, upgrade pads that change over time, five-minute matches, solo against bots or online.',
    ],
  },
  {
    version: '0.7', date: '2026-10-02', title: 'Striker and a bigger map',
    notes: [
      'The Striker: the car football car, also in the garage and the workshop.',
      'Free roam map grown to 300 × 300 m with downtown, suburbs and industrial districts.',
    ],
  },
  {
    version: '0.6', date: '2026-10-02', title: 'Car workshop',
    notes: ['Build your own cars: body style, size, colours, parts, engine and tuning. Share them with a code.'],
  },
  {
    version: '0.5', date: '2026-10-02', title: 'Points and the Inferno',
    notes: [
      'Destruction points with a combo multiplier.',
      'The Inferno pickup with a mounted flamethrower.',
      'Screen quake that grows with the destruction, with a strength slider.',
    ],
  },
  {
    version: '0.4', date: '2026-10-02', title: 'Car football',
    notes: [
      'New mode: Blue vs Orange in a stadium, with jumps, flips and air control.',
      'Cars land properly: they tip, rock and right themselves.',
    ],
  },
  {
    version: '0.3', date: '2026-10-02', title: 'Online',
    notes: [
      'Play online with friends using a room code (no server).',
      'Car-to-car collisions and an in-game garage.',
    ],
  },
  {
    version: '0.2', date: '2026-10-02', title: 'Ramps and explosions',
    notes: ['Ramps and jumps, explosive fuel drums, a bigger arena and new sound.'],
  },
  {
    version: '0.1', date: '2026-10-01', title: 'First drive',
    notes: [
      'The driving sandbox: a walled lot where everything breaks, several cars, boost, and the Ember GT that burns through things.',
      'Menus and graphics options.',
    ],
  },
];
