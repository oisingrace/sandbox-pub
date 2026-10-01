# Drift Lot

A third-person driving sandbox for the browser, built with three.js. There's no
build step. For now it covers the car and its handling, driven around an open 3D lot.

## Run

Serve the folder with any static server and open it:

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
| Reset | R | Y |
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

## Files

- `src/physics.js`: vehicle dynamics
- `src/carModel.js`: procedural car mesh, suspension roll/pitch, wheel spin and steer
- `src/camera.js`: chase / far / hood cameras
- `src/world.js`: ground, scenery, knockable cones
- `src/effects.js`: skid marks and tire smoke
- `src/input.js`: keyboard, gamepad and touch input
- `src/audio.js`: synthesized engine and tire squeal
- `src/main.js`: game loop and HUD
