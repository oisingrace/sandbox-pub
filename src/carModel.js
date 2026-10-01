import * as THREE from 'three';

// Procedural low-poly sports car. The root sits on the ground under the
// CG and faces +Z; the body is a child so it can pitch and roll on its
// "suspension" while the wheels stay planted.

const PAINT = 0xd7263d;

function taperedBox(w, h, d, topW, topD, topOffsetZ = 0) {
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

function makeWheel(radius, width) {
  const wheel = new THREE.Group();
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.85, roughness: 0.3 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 });

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
  return wheel;
}

export class CarModel {
  constructor(spec) {
    this.spec = spec;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);

    const r = spec.wheelRadius;
    const halfTrack = spec.trackWidth / 2;
    const front = spec.cgToFront;
    const rear = -spec.cgToRear;

    const paint = new THREE.MeshStandardMaterial({ color: PAINT, metalness: 0.45, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.7 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0e1622, metalness: 0.9, roughness: 0.1 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.25 });

    const add = (geo, mat, x, y, z, parent = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // Main hull: lower skirt + shoulder line.
    const bodyLen = 4.3;
    const bodyCenterZ = (front + rear) / 2 + 0.05;
    add(new THREE.BoxGeometry(1.8, 0.38, bodyLen), paint, 0, 0.55, bodyCenterZ);
    add(taperedBox(1.8, 0.16, bodyLen - 0.1, 1.68, bodyLen - 0.5, -0.05), paint, 0, 0.82, bodyCenterZ);
    // Hood bulge.
    add(taperedBox(1.0, 0.06, 1.3, 0.8, 1.1), paint, 0, 0.92, front + 0.25);
    // Cabin + glasshouse.
    add(taperedBox(1.62, 0.5, 2.0, 1.26, 1.05, -0.12), glass, 0, 1.13, bodyCenterZ - 0.25);
    add(taperedBox(1.3, 0.04, 1.08, 1.24, 1.0), paint, 0, 1.38, bodyCenterZ - 0.37);
    // Bumpers / splitter / diffuser.
    add(new THREE.BoxGeometry(1.84, 0.16, 0.18), dark, 0, 0.42, bodyCenterZ + bodyLen / 2);
    add(new THREE.BoxGeometry(1.84, 0.18, 0.18), dark, 0, 0.43, bodyCenterZ - bodyLen / 2);
    add(new THREE.BoxGeometry(1.5, 0.03, bodyLen - 0.4), dark, 0, 0.35, bodyCenterZ);
    // Grille.
    add(new THREE.BoxGeometry(0.9, 0.16, 0.02), dark, 0, 0.56, bodyCenterZ + bodyLen / 2 + 0.005);
    // Rear wing.
    const wingZ = bodyCenterZ - bodyLen / 2 + 0.22;
    add(new THREE.BoxGeometry(1.7, 0.04, 0.32), dark, 0, 1.14, wingZ);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.24, 0.12), dark, s * 0.6, 1.02, wingZ);
    // Mirrors.
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.18, 0.1, 0.12), paint, s * 0.93, 1.0, bodyCenterZ + 0.55);
    // Exhaust tips.
    for (const s of [-1, 1]) {
      const tip = add(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 12), chrome, s * 0.45, 0.4, bodyCenterZ - bodyLen / 2 - 0.08);
      tip.rotation.x = Math.PI / 2;
    }

    // Lights.
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.2 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.4 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0 });
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.42, 0.1, 0.04), this.headMat, s * 0.62, 0.68, bodyCenterZ + bodyLen / 2 + 0.005);
      add(new THREE.BoxGeometry(0.5, 0.1, 0.04), this.tailMat, s * 0.6, 0.68, bodyCenterZ - bodyLen / 2 - 0.005);
      add(new THREE.BoxGeometry(0.12, 0.08, 0.04), this.reverseMat, s * 0.22, 0.68, bodyCenterZ - bodyLen / 2 - 0.005);
    }

    // Wheels: front ones live under a steering pivot.
    this.wheels = [];
    const wheelW = 0.26;
    const placements = [
      { x: halfTrack, z: front, front: true, left: true },
      { x: -halfTrack, z: front, front: true, left: false },
      { x: halfTrack, z: rear, front: false, left: true },
      { x: -halfTrack, z: rear, front: false, left: false },
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
    const blobTex = makeBlobTexture();
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 5.2),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, 0.015, bodyCenterZ);
    blob.renderOrder = 1;
    this.root.add(blob);

    this.roll = 0;
    this.pitch = 0;
  }

  /** Sync visuals to the physics state. */
  update(car, dt) {
    this.root.position.set(car.x, 0, car.z);
    this.root.rotation.y = car.heading;

    // Body roll/pitch from smoothed accelerations (a cheap suspension).
    const targetRoll = THREE.MathUtils.clamp(car.accelLat * 0.012, -0.08, 0.08);
    const targetPitch = THREE.MathUtils.clamp(-car.accelLong * 0.008, -0.06, 0.06);
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

function makeBlobTexture() {
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
  return new THREE.CanvasTexture(c);
}
