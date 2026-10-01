import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Renders any vehicle from `vehicles.js`. The root sits on the ground under
// the CG and faces +Z; the body is a child so it can pitch and roll on its
// "suspension" while the wheels stay planted. Each vehicle supplies a
// `build(kit)` function that adds its bodywork through the kit helpers.

export function taperedBox(w, h, d, topW, topD, topOffsetZ = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * (topW / w));
      pos.setZ(i, pos.getZ(i) * (topD / d) + topOffsetZ);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Collapse a group's direct child meshes into one mesh per material.
 * Vehicles are built from dozens of boxes; merging them cuts draw calls
 * (and shadow-pass draw calls) by roughly 10x.
 */
export function mergeByMaterial(group) {
  const byMat = new Map();
  for (const child of [...group.children]) {
    if (!child.isMesh || child.children.length) continue;
    child.updateMatrix();
    const geo = child.geometry.clone();
    geo.applyMatrix4(child.matrix);
    if (!byMat.has(child.material)) byMat.set(child.material, []);
    byMat.get(child.material).push(geo);
    group.remove(child);
    child.geometry.dispose();
  }
  for (const [mat, geos] of byMat) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const g of geos) g.dispose();
  }
}

let WHEEL_MATS = null;

function makeWheel(radius, width) {
  const wheel = new THREE.Group();
  WHEEL_MATS ||= {
    tire: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.85, roughness: 0.3 }),
    hub: new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 }),
  };
  const { tire: tireMat, rim: rimMat, hub: hubMat } = WHEEL_MATS;

  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 28, 1), tireMat);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  wheel.add(tire);

  // Rim face + spokes on both sides so the spin is readable from any angle.
  for (const side of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.68, radius * 0.68, 0.02, 24), rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.position.x = side * (width / 2 + 0.005);
    wheel.add(rim);
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, radius * 1.15, 0.07), hubMat);
      spoke.position.x = side * (width / 2 + 0.02);
      spoke.rotation.x = (i / 5) * Math.PI;
      wheel.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, 0.04, 12), hubMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.x = side * (width / 2 + 0.03);
    wheel.add(hub);
  }
  mergeByMaterial(wheel);
  return wheel;
}

export class CarModel {
  constructor(def) {
    const spec = def.spec;
    this.def = def;
    this.spec = spec;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);

    const r = spec.wheelRadius;
    const halfTrack = spec.trackWidth / 2;
    const front = spec.cgToFront;
    const rear = -spec.cgToRear;

    const mats = {
      paint: new THREE.MeshStandardMaterial({ color: def.color, metalness: 0.45, roughness: 0.35 }),
      trim: new THREE.MeshStandardMaterial({ color: def.trim ?? 0xf2f2f2, metalness: 0.2, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.7 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x0e1622, metalness: 0.9, roughness: 0.1 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.25 }),
      glow: new THREE.MeshStandardMaterial({ color: 0x2a0d00, emissive: 0xff6a10, emissiveIntensity: 2.2 }),
    };
    this.glowMat = mats.glow;
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.2 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.4 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0 });

    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, typeof mat === 'string' ? mats[mat] : mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.body.add(m);
      return m;
    };
    const kit = {
      THREE, spec, mats, front, rear, r,
      add,
      box: (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z),
      tapered: (w, h, d, topW, topD, off, mat, x, y, z) => add(taperedBox(w, h, d, topW, topD, off), mat, x, y, z),
      /** Head, tail and reverse lights at the given body ends. */
      lights: ({ frontZ, rearZ, y, headX, tailX, headW = 0.42, tailW = 0.5, h = 0.1, rearY = y }) => {
        for (const s of [-1, 1]) {
          add(new THREE.BoxGeometry(headW, h, 0.04), this.headMat, s * headX, y, frontZ + 0.005);
          add(new THREE.BoxGeometry(tailW, h, 0.04), this.tailMat, s * tailX, rearY, rearZ - 0.005);
          add(new THREE.BoxGeometry(0.12, h * 0.8, 0.04), this.reverseMat, s * (tailX - tailW / 2 - 0.12), rearY, rearZ - 0.005);
        }
      },
    };
    def.build(kit);
    mergeByMaterial(this.body);

    // Boost flames: additive cones out of each exhaust, hidden until used.
    this.flames = [];
    const flameColor = def.burns ? new THREE.Color(3.2, 1.2, 0.25) : new THREE.Color(0.6, 1.4, 3.2);
    const flameGeo = new THREE.ConeGeometry(0.11, 1, 10, 1, true);
    flameGeo.translate(0, 0.5, 0); // base at the exhaust, tip 1 m up...
    flameGeo.rotateX(-Math.PI / 2); // ...then laid back along -Z
    for (const [x, y, z] of def.exhaust || []) {
      for (const [scale, opacity] of [[1, 0.55], [0.55, 0.9]]) {
        const mat = new THREE.MeshBasicMaterial({
          color: scale < 1 ? new THREE.Color(3, 3, 3) : flameColor,
          transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        });
        const flame = new THREE.Mesh(flameGeo, mat);
        flame.position.set(x, y, z);
        flame.visible = false;
        flame.userData.base = scale;
        this.body.add(flame);
        this.flames.push(flame);
      }
    }
    this.boostLevel = 0;

    // Wheels: front ones live under a steering pivot.
    this.wheels = [];
    const wheelW = def.wheelWidth ?? 0.26;
    const placements = [
      { x: halfTrack, z: front, front: true },
      { x: -halfTrack, z: front, front: true },
      { x: halfTrack, z: rear, front: false },
      { x: -halfTrack, z: rear, front: false },
    ];
    for (const p of placements) {
      const pivot = new THREE.Group();
      pivot.position.set(p.x - Math.sign(p.x) * wheelW * 0.3, r, p.z);
      const mesh = makeWheel(r, wheelW);
      pivot.add(mesh);
      this.root.add(pivot);
      this.wheels.push({ ...p, pivot, mesh, spin: 0 });
    }

    // Soft blob shadow helps ground the car even outside the shadow map.
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(def.width * 1.4, def.length * 1.2),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, 0.015, (front + rear) / 2);
    blob.renderOrder = 1;
    this.root.add(blob);

    this.roll = 0;
    this.pitch = 0;
  }

  /** Sync visuals to the physics state of the car being driven. */
  update(car, dt) {
    this.root.position.set(car.x, 0, car.z);
    this.root.quaternion.setFromAxisAngle(UP, car.heading);

    // Body roll/pitch from smoothed accelerations (a cheap suspension).
    const soft = this.def.suspension ?? 1;
    const targetRoll = THREE.MathUtils.clamp(car.accelLat * 0.012 * soft, -0.08, 0.08);
    const targetPitch = THREE.MathUtils.clamp(-car.accelLong * 0.008 * soft, -0.06, 0.06);
    const k = 1 - Math.exp(-dt * 8);
    this.roll += (targetRoll - this.roll) * k;
    this.pitch += (targetPitch - this.pitch) * k;
    this.body.rotation.set(this.pitch, 0, this.roll, 'YXZ');
    this.body.position.y = Math.abs(this.roll) * 0.4;

    for (const w of this.wheels) {
      const surfaceSpeed = w.front ? car.frontWheelSpeed : car.rearWheelSpeed;
      w.spin += (surfaceSpeed / car.spec.wheelRadius) * dt;
      w.mesh.rotation.x = w.spin;
      w.pivot.rotation.y = w.front ? car.steer : 0;
    }

    this.tailMat.emissiveIntensity = car.braking > 0.05 || car.handbrake ? 3 : 0.5;
    this.reverseMat.emissiveIntensity = car.gear < 0 ? 2.5 : 0;

    // Boost flames flicker and stretch while boosting.
    const target = car.boosting ? 1 : 0;
    this.boostLevel += (target - this.boostLevel) * (1 - Math.exp(-dt * (target ? 18 : 10)));
    this.time = (this.time || 0) + dt;
    for (const f of this.flames) {
      f.visible = this.boostLevel > 0.03;
      if (!f.visible) continue;
      const flicker = 0.75 + Math.random() * 0.5;
      const len = (0.6 + 1.4 * this.boostLevel) * flicker * f.userData.base;
      const w = (0.7 + 0.5 * this.boostLevel) * f.userData.base;
      f.scale.set(w, w, len);
    }
    // The Ember's accents breathe, and flare while boosting.
    this.glowMat.emissiveIntensity = 1.8 + Math.sin(this.time * 5) * 0.5 + this.boostLevel * 2.5;
  }

  /** Sync visuals to a parked vehicle's rigid body. */
  updateParked(body, dt) {
    for (const f of this.flames) f.visible = false;
    this.boostLevel = 0;
    const t = body.translation();
    const q = body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);
    this.body.rotation.set(0, 0, 0);
    this.body.position.y = 0;
    this.roll = this.pitch = 0;
    // Let the wheels roll along with the body's motion.
    const v = body.linvel();
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(this.root.quaternion);
    const along = v.x * fwd.x + v.z * fwd.z;
    for (const w of this.wheels) {
      w.spin += (along / this.spec.wheelRadius) * dt;
      w.mesh.rotation.x = w.spin;
      w.pivot.rotation.y = 0;
    }
    this.tailMat.emissiveIntensity = 0.2;
    this.reverseMat.emissiveIntensity = 0;
  }

  /** World-space contact points of each wheel, for skid marks and smoke. */
  contactPoints(out = []) {
    this.root.updateMatrixWorld();
    this.wheels.forEach((w, i) => {
      out[i] = out[i] || new THREE.Vector3();
      out[i].set(w.pivot.position.x, 0, w.pivot.position.z).applyMatrix4(this.root.matrixWorld);
      out[i].y = 0;
    });
    return out;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();

let _blob;
function blobTexture() {
  if (_blob) return _blob;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 64, 4, 32, 64, 60);
  grad.addColorStop(0, 'rgba(0,0,0,0.9)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.setTransform(1, 0, 0, 2, 0, -64);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 128);
  return (_blob = new THREE.CanvasTexture(c));
}
