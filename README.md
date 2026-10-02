# Smash Lot

A third-person driving sandbox for the browser, built with three.js and the Rapier physics engine,
with no build step. Pick from five vehicles and drive around a walled arena (180 × 180 m) where everything can be
smashed: two office buildings with glass windows, a gas station, explosive fuel drums, a shipping
container yard, a water tower, giant bowling pins, a fenced grove, brick walls, concrete sheds, a block
tower, crate pyramids, barrels, a domino run, light poles, trees, cones, and the barrier ring itself.

**Ramps and jumps** (`src/terrain.js`):
- A launch kicker off the start line, aimed over the big brick wall.
- Two side kickers: one into a crate pyramid, one over the low wall.
- A gap jump with a landing ramp in the east.
- A tabletop in the north.
- A 4.5 m mega ramp in the west, aimed at the container yard.

The car's handling model gained a vertical part. It follows the ground, picks up pitch and roll from
the slope, and loses speed climbing. It becomes airborne when the ground drops away faster than gravity
(a ramp lip). In the air, the nose settles toward the direction of travel, and throttle or brake tilt
it. Landing flat keeps your speed, while landing on the nose or a corner scrubs it off. The back and
sides of a ramp are walls. Ramps are also solid in the physics world (made of convex slices), so debris
and parked cars slide off them. Airtime is shown on screen, and big air refills boost.

**Fuel drums** explode when hit hard (or burned by the Ember GT). The blast pushes everything within
9 m outward and up, shatters things close by, shoves the car, and sets off nearby drums a moment later,
so a pile goes up in a chain.

## Car football

Pick **Car football** on the main menu (next to Free roam) for a Blue vs Orange match in a stadium
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
- **Ball cam** (Y, or BALL on touch screens) is on by default: the camera looks past your car at the
  ball. An arrow at the screen edge points to the ball when it's off screen, and a ring under it
  shows where it'll land.

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
- Each player sends their car's state 20 times a second (`src/net.js`). Other players' cars are drawn
  100 ms behind and smoothed between updates (`src/multiplayer.js`).
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
- **Game:** driving assists and sound.

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

The quickest way: open **`smash-lot.html`** directly in a browser. It's a single self-contained file
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
| Handbrake | Space | A / RB |
| Boost | Shift | LB |
| Toggle assists | T | B |
| Cycle camera (chase / far / hood) | C | X |
| Reset car | R | Y |
| Ball cam on/off (car football) | Y | |
| Change car (garage, anywhere) | V | |
| Drive a nearby parked vehicle | E | |
| Rebuild arena (football: new match) | B | |
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
- `src/vehicles.js`: the five vehicles (handling, hitbox, body builder)
- `src/carModel.js`: renders any vehicle, with suspension roll/pitch, wheel spin and steer
- `src/camera.js`: chase / far / hood cameras
- `src/world.js`: ground, backdrop, and the free-roam arena layout
- `src/stadium.js`: the football stadium: scenery, walls, ramps, contents and kickoff spots
- `src/football.js`: the ball, match rules, network snapshots and the scoreboard
- `src/bot.js`: the computer opponent for solo football
- `src/destruction.js`: rigid-body world, fracturing, and instanced rendering
- `src/effects.js`: skid marks and tire smoke
- `src/burn.js`: the Ember GT's voxel burn effect
- `src/net.js`: peer-to-peer rooms (PeerJS), with the host relaying messages
- `src/multiplayer.js`: other players' cars, smoothing, name tags
- `src/carCollision.js`: car-to-car collisions with momentum-correct impulses
- `src/terrain.js`: ramps, the height lookup the car drives on, and their meshes and colliders
- `src/input.js`: keyboard, gamepad and touch input
- `src/audio.js`: synthesized engine, tire squeal, and per-material impact sounds
- `src/settings.js`: options, presets, and saving them
- `src/menu.js`: main, pause, options and controls screens
- `src/main.js`: game loop, game state and HUD
