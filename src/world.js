import * as THREE from 'three';

// An open lot to drive around: textured asphalt, painted markings,
// a cone slalom + skidpad, and distant scenery for a sense of speed.

const SKY = 0x9fc6e8;

export function createWorld(scene, renderer) {
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 150, 650);

  const hemi = new THREE.HemisphereLight(0xdcecff, 0x4a4237, 0.9);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
  sc.near = 1; sc.far = 200;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const sunOffset = new THREE.Vector3(-40, 70, -25);

  // --- Ground ---------------------------------------------------------
  const asphalt = makeAsphaltTexture(renderer);
  const groundSize = 2400;
  asphalt.repeat.set(groundSize / 16, groundSize / 16);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Large grid lines every 20 m so motion is always readable.
  const grid = new THREE.GridHelper(groundSize, groundSize / 20, 0x5b5b60, 0x5b5b60);
  grid.position.y = 0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.material.depthWrite = false;
  scene.add(grid);

  const paint = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.85, depthWrite: false });
  const yellow = new THREE.MeshBasicMaterial({ color: 0xf2c230, transparent: true, opacity: 0.85, depthWrite: false });
  const flat = (geo, mat, x, z, rotY = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, rotY);
    m.position.set(x, 0.02, z);
    m.renderOrder = 1;
    scene.add(m);
    return m;
  };

  // Start box.
  flat(new THREE.PlaneGeometry(3.2, 0.25), paint, 0, -3.2);
  flat(new THREE.PlaneGeometry(0.2, 7), paint, -1.6, 0.3);
  flat(new THREE.PlaneGeometry(0.2, 7), paint, 1.6, 0.3);

  // Long straight with dashed centre line heading +Z.
  for (let z = 10; z < 600; z += 12) flat(new THREE.PlaneGeometry(0.25, 6), yellow, 0, z);
  for (const x of [-7, 7]) flat(new THREE.PlaneGeometry(0.25, 590), paint, x, 305);

  // Skidpad rings.
  const skid = { x: -70, z: 60 };
  flat(new THREE.RingGeometry(29.8, 30.2, 128), paint, skid.x, skid.z);
  flat(new THREE.RingGeometry(17.8, 18.2, 96), paint, skid.x, skid.z);

  // Distant scenery: low hills and blocky buildings.
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x6f8f5a, roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
    const d = 520 + Math.random() * 120;
    const h = 40 + Math.random() * 70;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(70 + Math.random() * 60, h, 7), hillMat);
    hill.position.set(Math.cos(a) * d, h / 2 - 2, Math.sin(a) * d);
    scene.add(hill);
  }
  const bldMats = [0xb9b4aa, 0x8f9aa6, 0xc9b79c, 0x7d8590].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }),
  );
  const rng = mulberry32(7);
  for (let i = 0; i < 60; i++) {
    const a = rng() * Math.PI * 2;
    const d = 160 + rng() * 260;
    const w = 10 + rng() * 25;
    const h = 8 + rng() * 45;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 10 + rng() * 25), bldMats[i % bldMats.length]);
    b.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
    if (Math.abs(b.position.x) < 30 && b.position.z > 0) b.position.x += 80; // keep the straight clear
    b.rotation.y = rng() * Math.PI;
    b.castShadow = false;
    b.receiveShadow = true;
    scene.add(b);
  }
  // Light poles along the straight for speed reference.
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 0.6, roughness: 0.4 });
  const poleGeo = new THREE.CylinderGeometry(0.1, 0.14, 8, 8);
  for (let z = 20; z < 600; z += 40) {
    for (const x of [-10, 10]) {
      const p = new THREE.Mesh(poleGeo, poleMat);
      p.position.set(x, 4, z);
      p.castShadow = true;
      scene.add(p);
    }
  }

  const cones = new Cones(scene);
  // Slalom off to the right of the start.
  for (let i = 0; i < 10; i++) cones.add(40, 20 + i * 14);
  // Skidpad perimeter.
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    cones.add(skid.x + Math.cos(a) * 18, skid.z + Math.sin(a) * 18);
  }
  // Gate at the end of the straight.
  for (let x = -6; x <= 6; x += 2) cones.add(x, 600);

  return {
    cones,
    followSun(target) {
      sun.position.copy(target).add(sunOffset);
      sun.target.position.copy(target);
    },
  };
}

// --- Knockable cones ---------------------------------------------------

class Cones {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.geo = buildConeGeometry();
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  }

  add(x, z) {
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.castShadow = true;
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);
    this.items.push({
      mesh, home: new THREE.Vector3(x, 0, z),
      vel: new THREE.Vector3(), spin: new THREE.Vector3(), awake: false,
    });
  }

  reset() {
    for (const c of this.items) {
      c.mesh.position.copy(c.home);
      c.mesh.rotation.set(0, 0, 0);
      c.vel.set(0, 0, 0);
      c.spin.set(0, 0, 0);
      c.awake = false;
    }
  }

  /** Hit-test against the car's footprint and integrate loose cones. */
  update(dt, car) {
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);
    const halfLen = 2.3;
    const halfWid = 1.0;
    const offsetZ = (car.spec.cgToFront - car.spec.cgToRear) / 2;
    let hits = 0;

    for (const c of this.items) {
      const p = c.mesh.position;
      const dx = p.x - car.x;
      const dz = p.z - car.z;
      if (dx * dx + dz * dz < 16 && p.y < 1) {
        const fwd = dx * sinH + dz * cosH - offsetZ;
        const lat = dx * cosH - dz * sinH;
        if (Math.abs(fwd) < halfLen + 0.2 && Math.abs(lat) < halfWid + 0.2 && car.speed > 0.5) {
          const v = car.speed;
          const side = Math.sign(lat) || 1;
          c.vel.set(car.velX * 1.15, 1.5 + v * 0.12, car.velZ * 1.15);
          // Shove sideways out of the car's path.
          c.vel.x += cosH * side * (1.5 + v * 0.25);
          c.vel.z += -sinH * side * (1.5 + v * 0.25);
          c.spin.set((Math.random() - 0.5) * v, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * v);
          p.y = Math.max(p.y, 0.05);
          c.awake = true;
          hits++;
        }
      }

      if (!c.awake) continue;
      c.vel.y -= 9.81 * dt;
      p.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (p.y <= 0) {
        p.y = 0;
        if (c.vel.y < -1) {
          c.vel.y *= -0.35;
        } else {
          c.vel.y = 0;
        }
        const f = Math.exp(-dt * 4);
        c.vel.x *= f;
        c.vel.z *= f;
        c.spin.multiplyScalar(f);
        if (c.vel.lengthSq() < 0.01 && c.spin.lengthSq() < 0.01) {
          c.awake = false;
          // Settle lying on its side if it was tipped over.
          const tipped = Math.abs(Math.cos(c.mesh.rotation.x) * Math.cos(c.mesh.rotation.z)) < 0.7;
          if (tipped) {
            c.mesh.rotation.set(Math.PI / 2, c.mesh.rotation.y, 0, 'YXZ');
            p.y = 0.15;
          } else {
            c.mesh.rotation.x = 0;
            c.mesh.rotation.z = 0;
          }
        }
      }
    }
    return hits;
  }
}

function buildConeGeometry() {
  const parts = [];
  const color = (geo, hex) => {
    const c = new THREE.Color(hex);
    const arr = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo.toNonIndexed ? geo.toNonIndexed() : geo;
  };
  const base = new THREE.BoxGeometry(0.5, 0.05, 0.5);
  base.translate(0, 0.025, 0);
  parts.push(color(base, 0xff5a1f));
  const lower = new THREE.CylinderGeometry(0.13, 0.2, 0.25, 16, 1, true);
  lower.translate(0, 0.175, 0);
  parts.push(color(lower, 0xff5a1f));
  const band = new THREE.CylinderGeometry(0.09, 0.13, 0.17, 16, 1, true);
  band.translate(0, 0.385, 0);
  parts.push(color(band, 0xf5f5f5));
  const tip = new THREE.CylinderGeometry(0.02, 0.09, 0.2, 16);
  tip.translate(0, 0.57, 0);
  parts.push(color(tip, 0xff5a1f));
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function mergeGeometries(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o);
    nor.set(g.attributes.normal.array, o);
    col.set(g.attributes.color.array, o);
    o += g.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function makeAsphaltTexture(renderer) {
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
  // Patches and cracks for variety.
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
