import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A compact walled arena packed with things to smash. Static scenery here
// is only the ground and the far-off backdrop; everything inside the
// barrier ring is a physics object spawned by `populateArena`.

const SKY = 0x9fc6e8;
export const ARENA_HALF = 150;     // barrier ring sits here
export const DRIVE_LIMIT = 154;    // the car is kept inside this square
export const START = { x: 0, z: -52, heading: 0 };

export function createWorld(scene, renderer) {
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 130, 420);

  scene.add(new THREE.HemisphereLight(0xdcecff, 0x4a4237, 0.9));

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40;
  sc.near = 1; sc.far = 220;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const sunOffset = new THREE.Vector3(-40, 70, -25);

  // Grass beyond the lot.
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x6f8f4e, roughness: 1 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.02;
  grass.receiveShadow = true;
  scene.add(grass);

  // Everything that belongs to the free-roam lot (and not to other maps)
  // goes in this group, so switching maps just hides it.
  const arena = new THREE.Group();
  scene.add(arena);

  // Asphalt lot.
  const lotSize = ARENA_HALF * 2 + 16;
  const asphalt = makeAsphaltTexture(renderer);
  asphalt.repeat.set(lotSize / 16, lotSize / 16);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(lotSize, lotSize),
    new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  arena.add(ground);

  const grid = new THREE.GridHelper(lotSize, lotSize / 8, 0x5b5b60, 0x5b5b60);
  grid.position.y = 0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
  grid.material.depthWrite = false;
  arena.add(grid);

  const paint = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.85, depthWrite: false });
  const yellow = new THREE.MeshBasicMaterial({ color: 0xf2c230, transparent: true, opacity: 0.85, depthWrite: false });
  const flat2 = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1;
    arena.add(m);
  };
  const flat = (geo, mat, x, z, rotY = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, rotY);
    m.position.set(x, 0.02, z);
    m.renderOrder = 1;
    arena.add(m);
  };
  // Start box.
  flat(new THREE.PlaneGeometry(3.2, 0.25), paint, START.x, START.z - 3.2);
  flat(new THREE.PlaneGeometry(0.2, 7), paint, START.x - 1.6, START.z + 0.3);
  flat(new THREE.PlaneGeometry(0.2, 7), paint, START.x + 1.6, START.z + 0.3);
  // Centre circle and hazard stripes in front of the big wall.
  flat(new THREE.RingGeometry(9.8, 10.2, 96), paint, 0, 5);
  for (let x = -9; x <= 9; x += 2) flat(new THREE.PlaneGeometry(0.6, 3), yellow, x, -24, 0.6);
  // Bowling lane leading to the giant pins.
  for (const x of [-43.2, -36.8]) flat(new THREE.PlaneGeometry(0.25, 30), paint, x, -70);
  for (let i = 0; i < 5; i++) flat(new THREE.CircleGeometry(0.3, 12), paint, -42 + i, -62);
  // Gas station forecourt and parking bays in the container yard.
  flat(new THREE.PlaneGeometry(16, 12), new THREE.MeshBasicMaterial({ color: 0x3b3d42, transparent: true, opacity: 0.6, depthWrite: false }), 74, -20);
  for (let z = -26; z <= 6; z += 8) flat(new THREE.PlaneGeometry(14, 0.2), yellow, -76, z);
  // Road markings for the outer districts, merged into one mesh (one draw call).
  const lines = [];
  const dash = (x, z, alongX) => {
    const g = new THREE.PlaneGeometry(alongX ? 3 : 0.25, alongX ? 0.25 : 3);
    g.rotateX(-Math.PI / 2);
    g.translate(x, 0.02, z);
    lines.push(g);
  };
  for (let u = -128; u <= 128; u += 8) { // the ring road, inside the barriers
    dash(u, 132, true); dash(u, -132, true); dash(132, u, false); dash(-132, u, false);
  }
  for (let u = 46; u <= 128; u += 8) { dash(123, u, false); dash(u, 77, true); dash(u, 108, true); } // downtown streets
  for (let u = -76; u <= 82; u += 8) dash(-106, u, false); // the suburban street
  for (let u = -60; u <= 60; u += 8) dash(u, -112, true); // the industrial road
  flat2(mergeGeometries(lines), paint);

  // Distant hills for a horizon.
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x6a8a55, roughness: 1, flatShading: true });
  const rng = mulberry32(3);
  const hills = [];
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rng() * 0.2;
    const d = 260 + rng() * 60;
    const h = 30 + rng() * 50;
    const hill = new THREE.ConeGeometry(55 + rng() * 45, h, 7);
    hill.translate(Math.cos(a) * d, h / 2 - 2, Math.sin(a) * d);
    hills.push(hill);
  }
  const hillMesh = new THREE.Mesh(mergeGeometries(hills), hillMat);
  scene.add(hillMesh);

  const VIEW = { near: [70, 200], medium: [110, 380], far: [150, 650] };
  return {
    arena,
    grass,
    hills: hillMesh, // a ring around the lot: other maps that reach past it hide it
    followSun(target) {
      sun.position.copy(target).add(sunOffset);
      sun.target.position.copy(target);
    },
    /** Apply graphics settings: shadows ('off' | 'low' | 'high') and view distance. */
    setGraphics({ shadows, viewDistance }, camera) {
      sun.castShadow = shadows !== 'off';
      const size = shadows === 'high' ? 2048 : 1024;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      const half = shadows === 'high' ? 40 : 30;
      Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
      sun.shadow.camera.updateProjectionMatrix();
      const [near, far] = VIEW[viewDistance] || VIEW.medium;
      scene.fog.near = near;
      scene.fog.far = far;
      camera.far = far + 50;
      camera.updateProjectionMatrix();
    },
  };
}

// --- Arena contents -------------------------------------------------------

export function populateArena(d) {
  const rng = mulberry32(11);
  const opts = { sleep: true };
  const gap = 0.002;
  // Everything a helper builds is one "site" that freezes and thaws
  // together when it's far from every car (see Destruction.stream).
  const site = (fn) => (...args) => { d.beginSite(); fn(...args); d.endSite(); };

  // Running-bond brick wall: `len` metres long, `rows` high, centred at (x, z).
  const brickWall = site((x, z, yaw, len, rows) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const place = (u, y, kind) => d.spawn(kind, { x: x + u * c, y, z: z - u * s }, yaw, opts);
    for (let r = 0; r < rows; r++) {
      const y = 0.15 + r * (0.3 + gap);
      let u = -len / 2;
      if (r % 2) { place(u + 0.15, y, 'brickHalf'); u += 0.3; }
      while (u + 0.6 <= len / 2 + 1e-6) { place(u + 0.3, y, 'brick'); u += 0.6; }
      if (u < len / 2 - 1e-6) place(u + 0.15, y, 'brickHalf');
    }
  });

  // Hollow building of concrete blocks with a plank roof.
  const shed = site((x, z, w, depth, h) => {
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < depth; j++) {
          const edge = i === 0 || j === 0 || i === w - 1 || j === depth - 1;
          if (!edge) continue;
          const mid = Math.floor(w / 2);
          const door = j === 0 && y < 2 && (i === mid || i === mid - 1);
          if (door) continue;
          // Over the door, one lintel spans from the block left of the
          // opening to the block right of it.
          const lintelRow = j === 0 && y === 2 && i >= mid - 2 && i <= mid + 1;
          if (lintelRow) {
            if (i === mid - 2) d.spawn('lintel', { x: x + (mid - 0.5) - (w - 1) / 2, y: 0.5 + y * (1 + gap), z: z - (depth - 1) / 2 }, 0, opts);
            continue;
          }
          d.spawn('block', { x: x + i - (w - 1) / 2, y: 0.5 + y * (1 + gap), z: z + j - (depth - 1) / 2 }, 0, opts);
        }
      }
    }
    for (let i = 0; i < w; i++) {
      d.spawn('plank', { x: x + i - (w - 1) / 2, y: h + 0.1 + gap, z }, Math.PI / 2, opts);
    }
  });

  const cratePyramid = site((x, z, base) => {
    for (let level = 0; level < base; level++) {
      const n = base - level;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          d.spawn('crate', { x: x + i - (n - 1) / 2, y: 0.5 + level * (1 + gap), z: z + j - (n - 1) / 2 }, 0, opts);
        }
      }
    }
  });

  const tower = site((x, z, size, h) => {
    for (let y = 0; y < h; y++)
      for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
          d.spawn('block', { x: x + i - (size - 1) / 2, y: 0.5 + y * (1 + gap), z: z + j - (size - 1) / 2 }, 0, opts);
  });

  // Random points in a box, at least `minDist` apart.
  const scatter = (cx, cz, half, n, minDist) => {
    const pts = [];
    for (let tries = 0; pts.length < n && tries < n * 60; tries++) {
      const p = { x: cx + (rng() * 2 - 1) * half, z: cz + (rng() * 2 - 1) * half };
      if (pts.every((q) => Math.hypot(p.x - q.x, p.z - q.z) >= minDist)) pts.push(p);
    }
    return pts;
  };

  const barrels = site((x, z, n) => {
    for (const p of scatter(x, z, 2.2, n, 0.75)) d.spawn('barrel', { x: p.x, y: 0.475 + gap, z: p.z }, 0, opts);
  });

  // Three-storey office block, 10 m x 6.8 m.
  // Each storey: a 1.2 m band of wall panels, a 1.5 m band of pillars and
  // glass, then a 0.3 m floor slab spanning front wall to back wall.
  const building = site((cx, cz, floors) => {
    const halfW = 5;
    const halfD = 3.4;
    let layer = 0;
    const lift = () => layer * gap;
    for (let f = 0; f < floors; f++) {
      const y0 = f * 3;
      // Lower band.
      layer++;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 5; i++) {
          d.spawn('panel', { x: cx - halfW + 1 + 2 * i, y: y0 + 0.6 + lift(), z: cz + side * (halfD - 0.2) }, 0, opts);
        }
        for (let j = 0; j < 3; j++) {
          d.spawn('panel', { x: cx + side * (halfW - 0.2), y: y0 + 0.6 + lift(), z: cz - 3 + 1 + 2 * j }, Math.PI / 2, opts);
        }
      }
      // Window band: a pillar in the middle of every 2 m bay (so each slab
      // above is supported under its centre) with a pane either side.
      layer++;
      for (const side of [-1, 1]) {
        const z = cz + side * (halfD - 0.2);
        for (let i = 0; i < 5; i++) {
          const x0 = cx - halfW + 2 * i;
          d.spawn('pillar', { x: x0 + 1, y: y0 + 1.95 + lift(), z }, 0, opts);
          for (const off of [0.375, 1.625]) d.spawn('glass', { x: x0 + off, y: y0 + 1.92 + lift(), z }, 0, opts);
        }
        const x = cx + side * (halfW - 0.2);
        for (let j = 0; j < 3; j++) {
          const z0 = cz - 3 + 2 * j;
          d.spawn('pillar', { x, y: y0 + 1.95 + lift(), z: z0 + 1 }, Math.PI / 2, opts);
          for (const off of [0.375, 1.625]) d.spawn('glass', { x, y: y0 + 1.92 + lift(), z: z0 + off }, Math.PI / 2, opts);
        }
      }
      // Floor slab.
      layer++;
      for (let i = 0; i < 5; i++) {
        d.spawn('floorSlab', { x: cx - halfW + 1 + 2 * i, y: y0 + 2.85 + lift(), z: cz }, 0, opts);
      }
    }
  });
  building(22, 50, 3);

  // The big wall straight ahead of the start.
  brickWall(0, -20, 0, 18, 8);
  // A second, lower wall to the right.
  brickWall(36, 6, Math.PI / 2, 15, 6);
  // A third wall angled across the north-west.
  brickWall(-20, 44, 0.5, 12, 7);

  cratePyramid(-24, -12, 3);
  cratePyramid(26, -34, 3);
  cratePyramid(14, 34, 2);

  tower(0, 26, 3, 6);
  shed(-36, 22, 6, 4, 3);
  shed(42, 40, 6, 4, 3);

  barrels(14, -6, 10);
  barrels(-14, 52, 8);
  barrels(48, -12, 8);

  // Domino arc.
  d.beginSite();
  const dominoCentre = { x: -46, z: -14 };
  const dominoR = 14;
  for (let a = -1.75; a <= 1.75; a += 0.08) {
    const x = dominoCentre.x + Math.cos(a) * dominoR;
    const z = dominoCentre.z + Math.sin(a) * dominoR;
    // Slab thickness runs along the arc so each one tips into the next.
    d.spawn('slab', { x, y: 1.1 + gap, z }, -a - Math.PI / 2, opts);
  }
  d.endSite();

  // Cone slalom from the start line.
  // Cones line the run-up to the start kicker.
  for (const z of [-49, -46, -43]) for (const x of [-3.6, 3.6]) d.spawn('cone', { x, y: 0.3 + gap, z }, 0, opts);
  // Ring of cones around the centre circle.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    d.spawn('cone', { x: Math.cos(a) * 10, y: 0.3 + gap, z: 5 + Math.sin(a) * 10 }, 0, opts);
  }

  // Light poles in two rows.
  for (let z = -40; z <= 50; z += 18) {
    d.spawn('pole', { x: -56, y: 3.5 + gap, z }, 0, opts);
    d.spawn('pole', { x: 56, y: 3.5 + gap, z }, Math.PI, opts);
  }

  // Trees in two corners.
  const grove = site((cx, cz, n) => {
    for (const p of scatter(cx, cz, 7, n, 3.4)) d.spawn('tree', { x: p.x, y: 1.5 + gap, z: p.z }, rng() * Math.PI, opts);
  });
  grove(44, -52, 7);
  grove(-42, 52, 7);

  // --- Outer ring ---------------------------------------------------------

  // A second, smaller office block.
  building(-30, 76, 2);

  // Gas station: canopy on four columns, pumps underneath, fuel drums.
  const gx = 74, gz = -20;
  d.beginSite();
  for (const [dx, dz] of [[-4.5, -3], [4.5, -3], [-4.5, 3], [4.5, 3]]) {
    d.spawn('column', { x: gx + dx, y: 2.25 + gap, z: gz + dz }, 0, opts);
  }
  d.spawn('canopy', { x: gx, y: 4.75 + 2 * gap, z: gz }, 0, opts);
  for (const dx of [-2, 2]) d.spawn('pump', { x: gx + dx, y: 0.9 + gap, z: gz }, 0, opts);
  d.endSite();
  const drums = site((cx, cz, n, spread = 1.6) => {
    for (const p of scatter(cx, cz, spread, n, 0.7)) d.spawn('fuel', { x: p.x, y: 0.45 + gap, z: p.z }, 0, opts);
  });
  drums(83, -8, 8);
  drums(gx - 6, gz + 6, 3, 0.8);
  // A few drums elsewhere to set off chain reactions.
  drums(11, -21.2, 2, 0.5);
  drums(-11, -21.2, 2, 0.5);
  drums(4, 26, 2, 0.5);
  drums(-30, 26.5, 2, 0.5);
  drums(-30, 71, 3, 0.8);

  // Giant bowling pins at the end of the lane (head pin nearest the start).
  d.beginSite();
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i <= row; i++) {
      d.spawn('pin', { x: -40 + (i - row / 2) * 1.25, y: 1.2 + gap, z: -74 - row * 1.1 }, 0, opts);
    }
  }
  d.endSite();

  // Container yard: lanes of containers stacked one to three high.
  const containerYard = site((x0, z0, stacks, yaw = Math.PI / 2) => {
    stacks.forEach((col, ci) => {
      col.forEach((height, ri) => {
        for (let level = 0; level < height; level++) {
          // Lanes 2.8 m apart, containers 8 m apart along a lane.
          const p = yaw === 0 ? { x: x0 + ri * 8, z: z0 + ci * 2.8 } : { x: x0 + ci * 2.8, z: z0 + ri * 8 };
          d.spawn('container', { x: p.x, y: 1.3 + level * (2.6 + gap), z: p.z }, yaw, opts);
        }
      });
    });
  });
  containerYard(-84, -22, [[2, 3, 1], [1, 2, 3], [3, 1, 2], [2, 2, 1]]);

  // Water tower.
  d.beginSite();
  const wx = 72, wz = 72;
  for (const [dx, dz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
    d.spawn('steelLeg', { x: wx + dx, y: 3.5 + gap, z: wz + dz }, 0, opts);
  }
  d.spawn('platform', { x: wx, y: 7.15 + 2 * gap, z: wz }, 0, opts);
  d.spawn('tank', { x: wx, y: 8.6 + 3 * gap, z: wz }, 0, opts);
  d.endSite();

  // Fenced grove in the south-east corner.
  const fx = 62, fz = -76, fw = 16, fd = 12;
  d.beginSite();
  for (let u = -fw / 2 + 1; u < fw / 2; u += 2) {
    d.spawn('fence', { x: fx + u, y: 0.5 + gap, z: fz - fd / 2 }, 0, opts);
    d.spawn('fence', { x: fx + u, y: 0.5 + gap, z: fz + fd / 2 }, 0, opts);
  }
  for (let v = -fd / 2 + 2; v <= fd / 2 - 2; v += 2) { // gap at the corners so panels don't overlap
    d.spawn('fence', { x: fx - fw / 2, y: 0.5 + gap, z: fz + v }, Math.PI / 2, opts);
    d.spawn('fence', { x: fx + fw / 2, y: 0.5 + gap, z: fz + v }, Math.PI / 2, opts);
  }
  for (const p of scatter(fx, fz, 4, 6, 3.4)) d.spawn('tree', { x: p.x, y: 1.5 + gap, z: p.z }, rng() * Math.PI, opts);
  d.endSite();

  // More crates and barrels to plow through on the long runs.
  cratePyramid(-60, -40, 3);
  cratePyramid(60, 20, 2);
  barrels(-62, 30, 8);
  barrels(30, 80, 8);
  brickWall(0, 84, 0, 24, 6);

  // Outer light poles.
  for (let z = -60; z <= 60; z += 30) {
    d.spawn('pole', { x: -84, y: 3.5 + gap, z }, 0, opts);
    d.spawn('pole', { x: 84, y: 3.5 + gap, z }, Math.PI, opts);
  }

  // --- The outer districts (beyond the original lot) ----------------------

  // Downtown, north-east: a block of offices of different heights.
  for (const [x, z, floors] of [[112, 62, 3], [134, 62, 4], [112, 92, 2], [134, 92, 5], [70, 122, 3], [98, 124, 2]]) {
    building(x, z, floors);
  }
  barrels(123, 77, 8);
  drums(123, 106, 4, 1);
  cratePyramid(84, 104, 3);

  // Suburbs, west: a street of houses with picket fences and garden trees.
  const house = site((x, z) => {
    // Walls of facade panels, two rows high (no doorway: an unsupported
    // panel over it would fall at the first knock), then a roof of slabs.
    const halfW = 4, halfD = 3.4; // along z, along x
    for (let row = 0; row < 2; row++) {
      const y = 0.6 + row * (1.2 + gap);
      for (let i = 0; i < 4; i++) {
        const zz = z - halfW + 1 + 2 * i;
        d.spawn('panel', { x: x - halfD + 0.2, y, z: zz }, Math.PI / 2, opts);
        d.spawn('panel', { x: x + halfD - 0.2, y, z: zz }, Math.PI / 2, opts);
      }
      for (let j = 0; j < 3; j++) {
        const xx = x - 3 + 1 + 2 * j;
        d.spawn('panel', { x: xx, y, z: z - halfW + 0.2 }, 0, opts);
        d.spawn('panel', { x: xx, y, z: z + halfW - 0.2 }, 0, opts);
      }
    }
    for (let i = 0; i < 4; i++) d.spawn('floorSlab', { x, y: 2.55 + 2 * gap, z: z - halfW + 1 + 2 * i }, Math.PI / 2, opts);
    for (let i = 0; i < 4; i++) {
      if (i === 1 || i === 2) continue; // garden gate
      d.spawn('fence', { x: x + halfD + 4, y: 0.5 + gap, z: z - 3 + 2 * i }, Math.PI / 2, opts);
    }
    d.spawn('tree', { x: x + halfD + 2, y: 1.5 + gap, z: z + 5.5 }, rng() * Math.PI, opts);
  });
  for (const z of [-62, -36, -10, 16, 42, 68]) house(-124, z);
  barrels(-104, -24, 6);
  drums(-104, 30, 3, 0.8);

  // Industrial south: warehouses, a container yard and a fuel depot.
  shed(-42, -122, 10, 7, 4);
  shed(-6, -128, 10, 7, 4);
  shed(30, -122, 10, 7, 4);
  containerYard(92, -138, [[2, 1, 3], [3, 2, 1], [1, 3, 2]], 0);
  drums(70, -132, 10, 2.4);
  cratePyramid(10, -104, 3);
  cratePyramid(-60, -104, 2);
  tower(-24, -100, 2, 5);

  // Ramp park, south-east, and the long jump into downtown (see terrain.js).
  barrels(120, -78, 10);
  cratePyramid(132, -36, 3);
  brickWall(102, -54, Math.PI / 2, 10, 5);

  // Park, north-west.
  grove(-120, 112, 9);
  grove(-96, 132, 7);
  cratePyramid(-104, 96, 3);
  barrels(-130, 132, 8);

  // Midtown, along the north: more offices and a second street of houses.
  building(-62, 122, 2);
  building(-30, 128, 3);
  for (const x of [0, 22, 44]) house(x - 6, 120);
  barrels(-46, 112, 6);
  // East side: two more office blocks between downtown and the ramp park.
  building(140, 2, 2);
  building(108, -14, 3);
  drums(124, -8, 3, 0.8);
  // Two more warehouses at the west end of the industrial road.
  shed(-80, -128, 10, 7, 4);
  shed(-116, -120, 8, 6, 3);

  // Lamp posts along the ring road.
  for (let u = -130; u <= 130; u += 32) {
    for (const [x, z, yaw] of [[u, 141, 0], [u, -141, 0], [141, u, Math.PI / 2], [-141, u, Math.PI / 2]]) {
      d.spawn('pole', { x, y: 3.5 + gap, z }, yaw, opts);
    }
  }

  // Ring of heavy jersey barriers.
  const seg = 3.15;
  for (let u = -ARENA_HALF + 1.6; u <= ARENA_HALF - 1.6; u += seg) {
    d.spawn('barrier', { x: u, y: 0.45 + gap, z: ARENA_HALF }, Math.PI / 2, opts);
    d.spawn('barrier', { x: u, y: 0.45 + gap, z: -ARENA_HALF }, Math.PI / 2, opts);
    d.spawn('barrier', { x: ARENA_HALF, y: 0.45 + gap, z: u }, 0, opts);
    d.spawn('barrier', { x: -ARENA_HALF, y: 0.45 + gap, z: u }, 0, opts);
  }
}

export function makeAsphaltTexture(renderer) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#56575b';
  g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size);
  const rng = mulberry32(42);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * 34;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(${rng() < 0.5 ? '30,30,32' : '120,120,125'},${0.05 + rng() * 0.08})`;
    g.beginPath();
    g.ellipse(rng() * size, rng() * size, 20 + rng() * 70, 15 + rng() * 50, rng() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(25,25,25,0.35)';
  for (let i = 0; i < 6; i++) {
    g.lineWidth = 1 + rng();
    g.beginPath();
    let x = rng() * size, y = rng() * size;
    g.moveTo(x, y);
    for (let j = 0; j < 8; j++) { x += (rng() - 0.5) * 50; y += (rng() - 0.5) * 50; g.lineTo(x, y); }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
