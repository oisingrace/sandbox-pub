# Smash Lot

A third-person driving sandbox for the browser, built with three.js and the Rapier physics engine,
with no build step. Drive a tuned rear-wheel-drive car around a compact walled arena where everything
can be smashed: brick walls, concrete sheds, a block tower, crate pyramids, barrels, a domino run,
light poles, trees, cones, and the barrier ring itself.

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
| Toggle assists | T | B |
| Cycle camera (chase / far / hood) | C | X |
| Reset car | R | Y |
| Rebuild arena | B | |
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
- The debris world steps at 60 Hz; the car's handling still runs at 120 Hz.

## Files

- `src/physics.js`: vehicle dynamics
- `src/carModel.js`: procedural car mesh, suspension roll/pitch, wheel spin and steer
- `src/camera.js`: chase / far / hood cameras
- `src/world.js`: ground, backdrop, and the arena layout
- `src/destruction.js`: rigid-body world, fracturing, and instanced rendering
- `src/effects.js`: skid marks and tire smoke
- `src/input.js`: keyboard, gamepad and touch input
- `src/audio.js`: synthesized engine, tire squeal, and per-material impact sounds
- `src/main.js`: game loop and HUD
