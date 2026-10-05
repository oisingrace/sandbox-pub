# Smash Lot

A third-person driving sandbox for the browser, built with three.js and the Rapier physics engine,
with no build step. Pick from seven vehicles (or build your own) and drive around a walled map
(300 × 300 m) where everything can be smashed: two office buildings with glass windows, a gas station, explosive fuel drums, a shipping
container yard, a water tower, giant bowling pins, a fenced grove, brick walls, concrete sheds, a block
tower, crate pyramids, barrels, a domino run, light poles, trees, cones, and the barrier ring itself.

Around the original lot are the outer districts: **downtown** (north-east) with eight office blocks
of two to five storeys and a kicker that launches you into them; **midtown** along the north with
more offices and houses; a **suburban street** of houses with picket fences in the west; an
**industrial** strip in the south with five warehouses, a container yard and a fuel depot; a **ramp
park** in the south-east; a park in the north-west; and a ring road with lamp posts.

**Keeping a big map fast** (`Destruction.stream` in `src/destruction.js`): the physics engine spends
time on every body each step, even sleeping ones, so a map this size would be slow if it were all
live. Each structure (a building, a wall, a crate pile) is a *site*. When a whole site is asleep
and more than 100 m from every car (yours and other players'), its bodies leave the physics world
but it stays drawn exactly where it is; it comes back (still asleep) once a car is within 82 m,
nearest first, a little at a time so it never lands in one frame. Structures far from the start
are created frozen when the map is built. The physics step also no longer rebuilds its
scene-query structure every step, only when something (fire, explosions) needs it. With 5,000
objects on the map, the frame cost is lower than the old 1,800-object lot.

**Ramps and jumps** (`src/terrain.js`):
- A launch kicker off the start line, aimed over the big brick wall.
- Two side kickers: one into a crate pyramid, one over the low wall.
- A gap jump with a landing ramp in the east.
- A tabletop in the north.
- A 4.5 m mega ramp in the west, aimed at the container yard.

**Landings** are physical. In the air the car turns about its middle, and it touches down when its
lowest corner meets the ground. Land roughly upright and it's on its wheels and drivable straight
away, with the body settling onto the ground over a moment (front wheels first, then the rear
drops). Land on a corner and gravity tips it onto its wheels, side or roof, depending on which way it
leans, rocking as it settles. A car resting on its side or roof slides to a stop, then hops back
onto its wheels after about a second (in car football, jump does it at once).

The car's handling model gained a vertical part. It follows the ground, picks up pitch and roll from
the slope, and loses speed climbing. It becomes airborne when the ground drops away faster than gravity
(a ramp lip). In the air, the nose settles toward the direction of travel, and throttle or brake tilt
it. Landing flat keeps your speed, while landing on the nose or a corner scrubs it off. The back and
sides of a ramp are walls. Ramps are also solid in the physics world (made of convex slices), so debris
and parked cars slide off them. Airtime is shown on screen, and big air refills boost.

**Screen quake** (`src/quake.js`) grows with how much is being destroyed around you. Every piece
that breaks or burns adds energy by its mass, explosions add a lot (and are felt from further away),
and debris crashing down adds a little; things far away count for less, and the total fades over
about a second. A crate pyramid gives a light tremble, a brick wall a solid rumble, and a collapsing
building or a chain of fuel drums shakes the whole screen. The motion is a smooth rumble that gets
faster and stronger as it builds, moving and slightly tilting the camera. Your own crashes and hard
landings add short jolts on top. A gamepad rumbles along. Options → Game → Screen shake sets it to
anywhere from Off to 200% on a slider.

**Points and multiplier** (`src/score.js`, free roam): everything you break, burn or blow up scores
by its size (a brick 20, a crate 29, a shipping container 160, an explosion 250), times the
multiplier. Keep destroying, each thing within 2.2 s of the last, and the multiplier climbs:
×2 after 5 in a row, ×3 at 12, ×4 at 25, up to ×10 at 250. Stop too long and the combo cashes in
(with a summary) and the multiplier drops back to ×1. The panel at the top shows your points, the
multiplier (it heats up in colour), the combo timer and the points from your last smash. Online,
the player list ranks everyone by points.

**The Inferno pickup** (`src/flamethrower.js`) has a flamethrower turret in its bed. Hold **X** (or
the left mouse button; B on a gamepad, FIRE on touch) to spray a 15 m arc of fire that splashes
along the ground. Whatever it washes over heats up and then burns away as glowing voxels, the same
burn as the Ember GT: light things catch instantly, heavy ones (containers, the canopy) need a few
seconds of fire, and fuel drums explode. Its tank lasts 7 s and refills while you're not firing;
the dash shows the fuel. Other players' flamethrowers burn things on your screen too.

**Fuel drums** explode when hit hard (or burned by the Ember GT). The blast pushes everything within
9 m outward and up, shatters things close by, shoves the car, and sets off nearby drums a moment later,
so a pile goes up in a chain.

## Motorway

Pick **Motorway** on the main menu for a long drive with free-roam rules (points, combos, V to change
car, your custom car's weapon) on a 2.4 km dual carriageway (`src/motorway.js`):

- **A clear middle:** three lanes each way either side of a painted, hatched central reservation
  (no barrier), so you can use all six lanes and the road ahead is always open.
- **Trouble on the sides:** the hard shoulders and verges have a cluster every 50-75 m: roadworks
  (cones tapering onto the shoulder, barriers, barrels), broken-down lorries (two containers and
  warning cones), runs of concrete barriers, crate piles, oil and fuel drums, roadside signs, trees
  and old brick walls. Lamp posts line both shoulders, and every 400 m an overpass crosses on four
  breakable pillars (a car flying into a deck hits its underside).
- **Jumps:** kicker ramps on the hard shoulder every 290 m, alternating sides, and a big table jump on
  each verge in the middle.
- **Around it:** a wooden fence on each side, embankments and pine trees beyond, and a concrete wall
  with chevrons at each end.
- **Performance:** the road's 800-odd objects use the same streaming as the big free-roam map, so only
  the ones near a car are in the physics world (about 40-140 at a time at full speed).

## Car football

Pick **Car football** on the main menu (next to Free roam and Versus) for a Blue vs Orange match in a stadium
(`src/stadium.js`, `src/football.js`):

- **The stadium:** a 72 × 120 m walled pitch with chamfered corners so the ball never gets stuck, a
  16 m × 5 m goal at each end, glass walls, grandstands full of fans who jump when someone scores, and
  floodlights. Four sideline kickers launch you toward halfway.
- **Still full of things to break:** brick advertising boards along both sidelines, crate pyramids,
  barrel rows beside the goals, concrete posts, slabs, light poles, cones on the halfway line, and fuel
  drums in the corners whose blasts throw the ball (and you) around. A brick wall lines the back of
  each goal, so hard shots smash through it.
- **The ball** is a 1.5 m radius Rapier sphere: light, bouncy and a little floaty for aerials. Cars
  hit it through their real hitboxes.
- **One car for everyone:** car football is played in the **Striker**, a compact car made for it,
  painted in your team's colour. The Striker is also a normal car in free roam, and *Jumps and air
  control* is an option for your own designs in the workshop.
- **The match:** a 3-second countdown at kickoff with cars held on their spots, a 3:00 clock (time
  runs out once the ball is on the ground), golden-goal overtime on a tie, then the winner is shown
  and a new match starts. Each goal sets off a blast in the net, a horn and the crowd; then broken
  pieces are cleared off the pitch and the goal walls are rebuilt, but unbroken things stay where
  they've been knocked to.
- **Solo:** you're Blue against a computer driver (`src/bot.js`). It drives the same car physics,
  lines up behind the ball, goes around it when it's on the wrong side, falls back to defend, and
  reverses out when it gets stuck.
- **Online:** the host picks the mode; joiners play whatever the room is playing, and are put on the
  team with fewer players. The host is the referee: it simulates the ball and the clock and sends
  them 20 times a second. Everyone also simulates the ball locally between updates, and when you hit
  it your own result leads for a moment and is sent to the host, so your touches feel instant. Goals
  are credited to the last player to touch the ball, and the player list shows goals.
- **Jumps and aerials, Rocket League style** (the Striker, or any custom car with *Jumps and air
  control*; `src/physics.js`):
  - **Space** jumps (hold it a moment to go higher). Press it again in the air within 1.4 s for a
    double jump, or with a direction held for a flip that spins the car and shoves it that way
    (W + double jump is a front flip for speed).
  - In the air, **W/S pitch** the nose down/up, **A/D** turn, and **Q + A/D** roll. The car holds
    its attitude when you let go. Boost pushes along the nose and is strong enough to fly.
  - W or S held since take-off don't pitch the car until you release them, so driving off a jump
    with W held doesn't nosedive.
  - Jump on your roof or side to flip back onto your wheels straight away.
  - **Q** is the powerslide (the handbrake) in a car that jumps. Gamepad: A jumps, RB powerslides and air
    rolls, the left stick pitches. Touch screens get a JUMP button.
  - The computer driver jumps at high balls and flips into them.
- **Ball cam** (Y, or BALL on touch screens) is on by default: the camera looks past your car at the
  ball. An arrow at the screen edge points to the ball when it's off screen, and a ring under it
  shows where it'll land.

## Versus

Pick **Versus** on the main menu for an all-out car fight in **the Scrapyard** (`src/vsmap.js`,
`src/versus.js`, `src/weapons.js`). Every car is for itself; whoever wrecks the most cars in five
minutes wins.

- **The Scrapyard:** a 170 m square yard walled in corrugated steel, with stacks of scrapped cars
  outside and floodlights in the corners. In the middle is a raised cross (two table ramps crossing)
  to fight over; each quarter has a kicker. Cover everywhere, and all of it breakable: L-shaped
  container forts with fuel drums tucked inside, concrete block walls, brick walls, jersey barriers,
  crate pyramids, slabs, barrels and lamp poles.
- **Car health:** heavier cars take more punishment (about 100 hit points for the hatchback, 220 for
  the bus). Damaged cars smoke below 40% and burn below 20%. A wrecked car blows up and respawns 3 s
  later at the spawn furthest from everyone, with 2 s of protection (it blinks). The wreck counts for
  whoever last hurt it within 6 s.
- **Damage:** weapons; rams (by how hard the hit was, with most of the blame on whoever drove into
  whom, so T-boning someone hurts them more than you); explosions, including the fuel drums; and hitting
  the walls very hard.
- **Mounted weapons** sit on a turret on the roof that **aims itself** at the enemy most in front of
  you (a red ring marks it). Fire with X, a left click, the B button or FIRE on touch screens.
  - **Machine gun:** every car's own weapon, unlimited. Bullets are real rays: cover stops them,
    and they chip away at whatever they hit (one shot breaks a brick, and a couple set off a fuel drum).
  - **Rockets** (8) home in on your target and blow up on whatever they hit: 45 damage at the centre,
    a 7 m blast that also wrecks cover and sets off drums.
  - **Rocket salvo** (4 salvos of 3).
  - **Flamethrower** (8 s of fuel): burns cars in the stream and sets the scenery on fire, using the
    Inferno's voxel burning. The Inferno pickup has its own flamethrower instead of a gun, on its refilling tank.
  - **Mines** (4) drop behind you, arm after 0.8 s and go off when someone else drives within 3.5 m.
- **Upgrade pads** (nine: the top of the cross, its four ends and the four corners) each offer one
  upgrade, shown by a coloured beam and a label. What a pad offers changes every 20 s, and it refills
  8 s after someone takes it. Better upgrades appear as the match goes on:
  - from the start: rockets, repair (+50% health) and nitro (8 s of unlimited boost);
  - after 1:00: flamethrower, armour (half damage for 15 s) and mines;
  - after 2:30: rocket salvo and double damage (15 s).
- **HUD:** health bar, weapon and ammo, active upgrades with their timers, the clock, a leaderboard
  (wrecks and deaths), a kill feed, health bars over other cars, a red vignette when you're hit, and
  a "Wrecked by…" countdown.
- **Solo:** up to five computer drivers (`VersusBot`), or none to practise alone. Pick how many, their
  skill and their cars on the main menu (under the mode picker) or in Options → Versus; changing them
  mid-match restarts it. Skill sets their aim wobble, damage, firing range, reactions, and whether they
  boost and lay mines: easy bots also hesitate before firing. Cars: a mixed line-up, the same car as
  yours, heavy (bus, pickups) or light (hatchback, coupe, Ember, Striker). They hunt the
  nearest enemy (leading a moving one), ram when close, fire when their target is in their sights,
  drop mines on anyone tailing them, go for a repair when hurt and a weapon when they only have their
  gun, and back out when they get stuck. They fight each other as well as you, and they bump into cover
  instead of driving through it.
- **Online:** each player looks after their own car's health. Whoever fires works out what their
  shot hit and sends the damage to the victim, and a wrecked player announces it. Rockets and mines are
  simulated on every screen, and each screen only damages its own car. Health, weapon, aim and status
  ride along in the regular car updates, so everyone sees each other's health bars, turrets and
  tracers. The host runs the clock, the scores and the pads (a player driving onto a pad asks the host
  for it, so two players can't both take it).

## Custom cars

**Car workshop** (main menu → *Car workshop*) lets players build their own cars:

- **Body:** seven styles (coupe, hatchback, muscle, pickup, van, striker, buggy), each with its own shape,
  engine and base performance. Sliders for length, width, roof height, ride height and wheel size.
- **Paint:** body, trim and glow colours.
- **Parts:** rear wing, hood scoop, bull bar, roof lights, exhaust stacks, racing stripes, roll cage.
- **Jumps and air control:** on or off, like the Striker.
- **Weapon:** machine gun, rockets, rocket salvo, flamethrower (a turret like the Inferno pickup's)
  or mines, mounted on the roof (rockets and mines get a post in a pickup's bed; mines a dispenser at
  the back). Fire it with X, a left click, B or FIRE. In **Versus** it's your car's own weapon instead
  of the machine gun: rockets, salvos and mines come from a magazine (3, 2 and 3) that refills one
  every 2.5, 4.5 and 3.5 s; pickups from the pads still take over while they last. In **free roam**
  you can fire it at the scenery (mines are timed charges there, going off after 2.5 s), and other
  players in the room see it. Designs saved before weapons existed get the machine gun; ones with the
  old flamethrower ability keep their flamethrower.
- **Special:** none, or burner (burns through what it hits, like the Ember GT).
- **Engine and handling:** engine sound, and sliders for power, weight, grip, balance (planted to
  tail-happy) and boost.
- The **stats** (top speed, 0–100 km/h, weight) are measured by actually running the car through the
  handling model, so they're honest, and they update as you tune. A live 3D preview turns behind the
  menu.
- **Save** keeps it in this browser (up to 14); saved cars appear in the car picker and the in-game
  garage, and park in rows behind the start line. **Save and drive** jumps straight in.
- **Share code** gives a short text code; a friend pastes it under *Import* to get a copy.
- **Online**, your design travels with you: other players see and collide with your custom car, and
  if you switch cars mid-game they get the new one.

### The framework (for adding more in code)

A custom car is a plain-data **design** (`src/carkit.js`), safe to save, share and send over the
network; every value is checked and clamped by `cleanDesign`:

```js
{
  id: 'c-abc1234', name: 'Red Menace', style: 'pickup',
  color: 0xc0161c, trim: 0x1c1c22, accent: 0xff6a10,
  size: { length: 0.5, width: 0.5, height: 0.5, ride: 0.5, wheels: 0.5 }, // 0..1 around the style
  tune: { power: 0.9, weight: 0.5, grip: 0.5, balance: 0.5, boost: 0.5 },  // 0..1, 0.5 neutral
  engine: 'v8', ability: 'flamethrower', parts: ['stacks', 'bullbar', 'lightbar'],
}
```

`compileCar(design, home)` turns it into a full vehicle definition, the same shape as the
hand-built cars in `src/vehicles.js`, so the rest of the game can't tell them apart:

- **layout:** real dimensions from the style and size sliders;
- **spec:** the handling model's values (mass from the body's volume and the weight slider, engine
  torque from the style and power slider, tyre grip, rear grip balance, wheelbase, track, wheel
  radius, drag, brakes, boost);
- **hitbox** (body box, cabin box, turret), **camera** fit, **exhaust** positions and the
  **flamethrower** mount;
- **build:** the bodywork for `CarModel`, made from boxes and tapered boxes;
- **stats:** measured top speed and 0–100.

To extend it:

- **A new body style:** add an entry to `STYLES` (base length, width, roof and body height, ride
  height, the cabin's span along the car, roof taper, wheel size, default engine, power; optional
  `bed` or `open`). `buildBody` and the hitbox follow the layout automatically.
- **A new part:** add it to `PARTS` (its label) and draw it in `buildBody` under
  `if (parts.has('yourPart'))`.
- **A new ability:** add it to `ABILITIES` and set the matching flag in `compileCar` (see how
  `burns` and `flamethrower` are set).
- **A new tuning slider:** add it to `TUNE_KEYS` and use `t.yourKey` in the spec.

`src/customs.js` is the registry (`Garage`): built-in cars plus saved designs, and other players'
designs for the session. `src/workshop.js` is the editor UI.

## Audio

Everything is synthesised with Web Audio; there are no sound files (`src/audio.js`).

- **Engines:** three oscillators through distortion and a load-dependent filter, plus intake noise.
  Each vehicle has its own voice: the coupe rasps, the hatchback buzzes, the pickup has a V8 burble,
  the bus clatters like a diesel, and the Ember GT adds a turbine whine. There's a dip on gear shifts,
  and exhaust pops when you lift off at high revs.
- **Speed:** tyre rumble and wind noise rise with speed, plus a boost roar and two-layer tyre squeal.
- **World sounds:** impacts (with a sound per material), burns and explosions are positioned in 3D
  around the camera, so distant crashes are quieter and come from the right side.
- **Mix:** a reverb send for a sense of space, a bus compressor so big pile-ups don't clip, and close
  explosions briefly duck the engine.
- **Robustness:** every value sent to Web Audio is checked and kept in range (one NaN reaching a filter
  or the compressor can silence everything for good in some browsers), and the listener uses the
  camera's own up vector. A watchdog checks twice a second that sound is still coming out: a suspended
  context is resumed (also on the next tap or key press), and if the graph goes silent or produces
  garbage while the engine should be audible, it's thrown away and rebuilt.
- **Menus:** button clicks, and a volume setting in Options → Game.

## Car-to-car collisions

`src/carCollision.js` treats every car as a rectangle the size of its footprint, finds overlaps with
the separating axis test, and resolves them with a rigid-body impulse. The impulse accounts for each
car's mass and yaw inertia, restitution, and friction at the contact point. So a hatchback bounces off
the bus while the bus barely moves, and T-bones and glancing hits spin cars.

- Parked vehicles are left out of Rapier's car contacts (collision groups), because a kinematic car
  would shove them as if it were infinitely heavy. These pairs are resolved here instead, pushing both
  cars.
- Online, each player resolves their own car against the other car's current (extrapolated) position,
  and sends the matching impulse to the car they hit, so both players feel it straight away.

## Multiplayer (peer-to-peer, no server)

Choose **Play online with friends** on the main menu. One player creates a room and gets a 5-letter
code; friends type it in to join (up to 8 players). The game runs on everyone's own computer.

- Browsers connect directly to the host over WebRTC using PeerJS. PeerJS's free public broker only
  introduces players when someone joins; there's no game server to host or pay for.
- Each player sends their car's state 20 times a second as a compact array (`src/multiplayer.js`);
  a parked car only sends 4 a second. Each client has two connections to the host: a reliable one
  for joins, hits and rebuilds, and an unordered one for the car updates, so one slow packet never
  holds up the ones behind it (`src/net.js`).
- The host doesn't forward every update as it arrives. Once per tick it sends each player one bundle
  with everyone else's new car states and the football match state, so traffic grows with the number
  of players instead of its square. Car hits go only to the car that was hit.
- Updates carry the sender's clock, so other players' cars are placed on the timeline by when the
  update was sent, not when it arrived: network jitter doesn't turn into stutter. They're drawn a
  moment in the past (70–300 ms, adapting to each player's connection) and interpolated between
  updates. The delay only changes slowly, so cars never visibly speed up or slow down.
- Remote cars' physics bodies only move when the car moved, so a parked player doesn't keep waking
  up the debris around them, and car-to-car checks skip anyone more than 14 m away.
- Each remote car is also a solid body in your own physics world, so their crashes, burns and
  explosions happen on your screen too. Debris is simulated separately on every computer, so it can
  land a little differently for each player.
- Car-to-car hits use real impulses (see above), and the hitter sends the impulse to the car it hit. Smashes count for whichever car was
  closest, and are shown in the room's player list.
- Only the host can rebuild the arena, and doing so rebuilds it for everyone. A new player joining
  also gives everyone a fresh arena. Online there are no parked vehicles to swap into; pick your car
  on the main menu.
- Some strict networks (some schools, offices and mobile carriers) block direct browser-to-browser
  connections. Getting those players connected would need a paid relay (TURN) server.
- Multiplayer doesn't work inside the claude.ai artifact viewer, which blocks WebRTC. Use the
  downloaded file or a normal web host.
- For local testing, run a PeerJS server (`npx peerjs --port 9000 --host 127.0.0.1`) and open the game
  with `?peerhost=127.0.0.1:9000`.

## Menus and options

The game opens on a main menu: pick a vehicle, then Play. Esc (or P, or Start on a gamepad) pauses,
and the game also pauses automatically when the tab is hidden. Options are saved per browser:

- **Graphics:** quality preset (picked on first visit from the device), resolution, dynamic
  resolution, shadows, view distance, smoke and dust, anti-aliasing, FPS counter.
- **Destruction:** breakage (detailed, simple or off), max debris pieces, debris cleanup time, and
  physics accuracy.
- **Game:** driving assists, the drift helper, sound, volume and screen shake.
- **Versus:** how many computer drivers (none to 5), their skill and their cars.
- **Patch notes** on the main menu list what changed in each update (`src/patchnotes.js`).

## Performance notes

- Vehicle parts are merged into one mesh per material, which halves draw calls.
- At most two debris-world steps run per frame, so slow frames drop time instead of piling up work.
- Dynamic resolution lowers the render scale when the frame rate stays under 45 FPS and raises it
  again once there's headroom.
- The kinematic car body only updates when the car moves, so parked-on debris can fall asleep.
- Debris pieces are capped and fade out after the chosen cleanup time.

## Vehicles

| Vehicle | Mass | 0–100 km/h | Top speed | Character |
| --- | --- | --- | --- | --- |
| Sports coupe | 1250 kg | 5.1 s | 245 km/h | Quick, grippy, easy to drift |
| Hatchback | 1050 kg | 7.2 s | 178 km/h | Light and nimble, tail-happy with assists off |
| Pickup truck | 2100 kg | 6.4 s | 197 km/h | Torquey, leans more, heavier hits |
| School bus | 9000 kg | 18 s | 133 km/h | Slow, and plows through almost anything |
| Ember GT | 1400 kg | 5.4 s | 255 km/h | Burns through objects instead of hitting them |

**Boost** (Shift, gamepad LB, or BST on touch) adds rocket thrust on top of the engine for up to 3 s.
The meter refills over about 9 s, and a little faster every time you smash or burn something.

**The Ember GT** never pushes anything. Each physics step it checks a box around itself, stretched
ahead by its speed, and anything inside burns away before the solver can push it. A burned object is
replaced by glowing voxels that fill its shape (see `src/burn.js`). The burn starts where it was touched
and spreads across the object: each voxel flares white-hot, cools through orange and red to ash, and
drifts up as an ember, with soot and a brief light flash. Burn out the bottom of a building and the
floors above collapse.

The vehicles you aren't driving are parked around the start as physics objects that can be pushed, spun
and flipped. Drive up to one and press **E** to take it over; the vehicle you leave stays parked where
you stopped. Or press **V** (or **Change car** in the pause menu) to open the garage and swap into any
vehicle on the spot: the car you leave parks where the new one was waiting. This works online too. Vehicles are defined in `src/vehicles.js`, each with handling overrides, a collision
hitbox, a parking spot, camera settings, and a body builder.

## Run

The quickest way: open **`games/smash-lot.html`** directly in a browser. It's a single self-contained file
(three.js and Rapier still load from a CDN, so you need an internet connection). To regenerate it after
editing `src/`, run `python3 scripts/build-standalone.py`.

To work on the source in `src/`, serve the folder with any static server and open it:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.)

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Throttle / brake | W / S (hold S at a standstill to reverse) | RT / LT |
| Steer | A / D | Left stick |
| Handbrake (cars with jumps: Q / RB, since Space jumps) | Space | A / RB |
| Boost | Shift | LB |
| Toggle assists | T | |
| Cycle camera (chase / far / hood) | C | X |
| Reset car | R | Y |
| Football: jump / double jump / flip (with a direction) | Space | A |
| Cars with jumps: handbrake / powerslide; in the air, hold to roll with A/D | Q | RB |
| Football, in the air: pitch nose down / up | W / S | Left stick |
| Ball cam on/off (car football) | Y | |
| Fire: flamethrower (Inferno pickup), or your weapon in Versus | X or left click | B |
| Change car (garage, anywhere) | V | |
| Drive a nearby parked vehicle | E | |
| Rebuild arena (football and Versus: new match) | B | |
| Telemetry overlay | F | |
| Mute / help | M / H | |

Phones and tablets get on-screen buttons.

## How the handling works

All of it is in `src/physics.js`. It's a planar bicycle model integrated at a fixed 120 Hz:

- **Tires**: a simplified Pacejka curve gives the lateral force from slip angle, with a peak around 12°
  and a gentle falloff past it, so slides can be held and recovered.
- **Weight transfer**: longitudinal acceleration moves load between the axles. Braking adds front grip,
  and lifting off mid-corner rotates the car.
- **Friction circle**: drive or brake force uses up an axle's lateral grip. Too much throttle on the
  rear-wheel-drive car means power oversteer.
- **Drivetrain**: a torque curve, a 6-speed automatic with shift delays, launch clutch slip, engine braking and reverse.
- **Handbrake**: locks the rear wheels and drops their side grip, for flicks and handbrake turns.
- **Assists** (T): traction control plus a caster-style countersteer. With assists off, the car is fully tail-happy.
- **Drift helper** (Options → Game, 70% by default): once the tail is out, it holds the slide at an angle you
  choose with the steering (into the turn for more angle, up to about 50°; countersteer and it straightens), with
  a yaw correction toward that angle. On the throttle the spinning rear tyres hold less sideways and a push keeps
  the car driving forward, and traction control lets the wheels spin mid-drift. It stops spin-outs, and lifting
  off with the wheel straight ends the drift. Ordinary cornering is untouched. Finished drifts score points in
  free roam and on the motorway. Computer drivers use the plain handling.
- **Speed-sensitive steering**: less lock at speed keeps the front tires near their peak slip.

Every tunable value lives in `DEFAULT_SPEC` at the top of `physics.js`.

## How the destruction works

All of it is in `src/destruction.js`.

- Every object is a Rapier rigid body, drawn with one `InstancedMesh` per object kind so that
  more than 1,000 pieces stay cheap to render.
- The car keeps its own handling model. A kinematic collider follows it to push things around, and
  the contact impulses Rapier reports are fed back into the car, so heavy objects slow it down and spin it.
- Objects with a `fracture` rule split into a grid of smaller pieces when a contact force exceeds their
  `breakForce`. Concrete blocks become 8 chunks, crates become 8 chunks, bricks split into halves,
  poles snap in two, planks and slabs split, and barriers break into three. Smashing something also
  costs the car momentum in proportion to the object's mass.
- Performance safeguards:
  - At most 10 fractures are processed per step.
  - There's a debris budget, and the oldest pieces that are already asleep get evicted first.
  - Debris speed is capped, and pieces that leave the arena are recycled.
  - Each piece is put to sleep once it has been still for 0.7 s.
- The office building is stacked from wall panels, window pillars, glass panes and floor slabs.
  The pillars sit under the centre of each slab so the building stands until you hit it, and glass
  shards fade out after a few seconds.
- The debris world steps at 60 Hz; the car's handling still runs at 120 Hz.

## Files

- `src/physics.js`: vehicle dynamics
- `src/vehicles.js`: the built-in vehicles (the Striker is built from a carkit design) (handling, hitbox, body builder)
- `src/carModel.js`: renders any vehicle, with suspension roll/pitch, wheel spin and steer
- `src/camera.js`: chase / far / hood cameras
- `src/world.js`: ground, backdrop, and the free-roam arena layout
- `src/stadium.js`: the football stadium: scenery, walls, ramps, contents and kickoff spots
- `src/football.js`: the ball, match rules, network snapshots and the scoreboard
- `src/bot.js`: the computer opponent for solo football
- `src/motorway.js`: the Motorway map: road, verges, overpasses, ramps and the obstacles on the sides
- `src/vsmap.js`: the Scrapyard (the Versus map): fence, ramps, cover, pads and spawns
- `src/versus.js`: Versus rules: health, damage, wrecks and respawns, upgrade pads, the HUD, network events, and the computer drivers
- `src/weapons.js`: weapon stats, roof turrets, tracers, rockets and mines
- `src/destruction.js`: rigid-body world, fracturing, and instanced rendering
- `src/effects.js`: skid marks and tire smoke
- `src/burn.js`: the Ember GT's voxel burn effect
- `src/quake.js`: screen quake driven by how much destruction is happening
- `src/flamethrower.js`: the Inferno pickup's flame stream, fuel tank and fire particles
- `src/score.js`: destruction points and the combo multiplier
- `src/carkit.js`: custom car designs: styles, parts, tuning, and compiling a design into a car
- `src/customs.js`: the vehicle registry (built-in, saved custom and other players' cars)
- `src/workshop.js`: the car workshop screens (list, editor, share codes)
- `src/net.js`: peer-to-peer rooms (PeerJS), with the host relaying messages
- `src/multiplayer.js`: other players' cars, smoothing, name tags
- `src/carCollision.js`: car-to-car collisions with momentum-correct impulses
- `src/terrain.js`: ramps, the height lookup the car drives on, and their meshes and colliders
- `src/input.js`: keyboard, gamepad and touch input
- `src/audio.js`: synthesized engine, tire squeal, and per-material impact sounds
- `src/settings.js`: options, presets, and saving them
- `src/menu.js`: main, pause, options and controls screens
- `src/main.js`: game loop, game state and HUD
