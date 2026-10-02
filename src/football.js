import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PITCH, TEAM_COLORS, goalWall } from './stadium.js';

// Car football: the ball, the match (kickoff, clock, goals, overtime) and
// its HUD. One computer is the referee: the player in solo, the host
// online. The referee simulates the ball and runs the clock; everyone else
// gets snapshots (see `snapshot` / `applySnapshot`) and simulates the ball
// locally between them so their own hits feel instant.

export const BALL_RADIUS = 1.5;
const BALL_MASS = 60;
const MAX_BALL_SPEED = 42;
const MATCH_TIME = 180;
const KICKOFF_TIME = 3;
const GOAL_TIME = 3;
const END_TIME = 7;
export const TEAM_NAMES = ['Blue', 'Orange'];
const TEAM_CSS = ['#4d94ff', '#ff8a2a'];

const roundFb = (v) => Math.round(v * 100) / 100;

export class Football {
  constructor({ scene, destruction }) {
    this.scene = scene;
    this.destruction = destruction;
    this.mesh = ballMesh();
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.marker = groundMarker();
    this.marker.visible = false;
    scene.add(this.marker);
    this.entity = null;
    this.active = false;
    this.referee = true;
    this.listeners = {};
    this.teams = new Map(); // player id -> 0 (Blue) | 1 (Orange)
    this.goals = new Map(); // player id -> goals scored this match
    this.names = new Map(); // player id -> display name
    this.resetMatchState();
    this.hud = {
      root: document.getElementById('scoreboard'),
      blue: document.getElementById('score-blue'),
      orange: document.getElementById('score-orange'),
      clock: document.getElementById('match-clock'),
      banner: document.getElementById('banner'),
      arrow: document.getElementById('ball-arrow'),
    };
    this.bannerText = '';
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event] || []) fn(...args);
  }

  resetMatchState() {
    this.score = [0, 0];
    this.phase = 'kickoff';
    this.timer = KICKOFF_TIME;
    this.timeLeft = MATCH_TIME;
    this.overtime = false;
    this.kickoffs = 0;
    this.goalCount = 0;
    this.lastGoal = null;
    this.lastTouch = null;
    this.touchingNow = new Set();
    this.goals.clear();
  }

  /** Turn football on or off (switching game modes). */
  setActive(on) {
    this.active = on;
    this.mesh.visible = on;
    this.marker.visible = on;
    this.hud.root.hidden = !on;
    if (!on) {
      this.setBanner('');
      this.hud.arrow.hidden = true;
    }
  }

  // --- Ball body ---------------------------------------------------------

  /** Create the ball in the (fresh) physics world. */
  spawnBall(pos = { x: 0, y: BALL_RADIUS, z: 0 }, vel = null) {
    const world = this.destruction.world;
    // Only remove the old ball if it lives in this world: after a rebuild
    // the old world is gone, and its handles mean other bodies here.
    if (this.entity && this.entity.world === world) {
      this.destruction.unregister(this.entity);
      world.removeRigidBody(this.entity.body);
    }
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(0.12)
      .setAngularDamping(0.4)
      .setGravityScale(0.8) // a touch floaty, for aerials
      .setCcdEnabled(true);
    if (vel) desc.setLinvel(vel.x, vel.y, vel.z);
    const body = world.createRigidBody(desc);
    const collider = world.createCollider(
      RAPIER.ColliderDesc.ball(BALL_RADIUS).setMass(BALL_MASS).setFriction(0.5).setRestitution(0.62)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(BALL_MASS * 3 / (1 / 60)),
      body,
    );
    this.entity = {
      kind: { name: 'ball', mass: BALL_MASS, material: 'ball', noBurn: true },
      body, colliders: [collider], alive: true, ball: true, world,
    };
    this.destruction.register(this.entity);
    this.collider = collider;
  }

  get body() {
    return this.entity?.body;
  }

  /** Ball state as plain numbers. */
  get ball() {
    const b = this.body;
    if (!b) return { x: 0, y: BALL_RADIUS, z: 0, vx: 0, vy: 0, vz: 0 };
    const t = b.translation(), v = b.linvel();
    return { x: t.x, y: t.y, z: t.z, vx: v.x, vy: v.y, vz: v.z };
  }

  placeBall(x, y, z, vx = 0, vy = 0, vz = 0, q = null) {
    const b = this.body;
    if (!b) return;
    b.setTranslation({ x, y, z }, true);
    b.setLinvel({ x: vx, y: vy, z: vz }, true);
    if (q) b.setRotation(q, true);
    else b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // --- Match flow (referee only) ------------------------------------------

  /** Start a fresh match (the arena has just been rebuilt). */
  startMatch() {
    this.resetMatchState();
    this.kickoff();
  }

  kickoff() {
    this.phase = 'kickoff';
    this.timer = KICKOFF_TIME;
    this.kickoffs++;
    this.lastTouch = null;
    this.placeBall(0, BALL_RADIUS, 0);
    this.tidy();
    this.emit('kickoff');
  }

  /**
   * Between goals: clear broken pieces off the pitch and rebuild the brick
   * walls at the back of each goal. Unbroken things stay where they are.
   */
  tidy() {
    const d = this.destruction;
    const { halfX: X, halfZ: Z, goalHalf: G } = PITCH;
    d.despawnWhere((e, t) => (e.fragment && Math.abs(t.x) < X && Math.abs(t.z) < Z + 8)
      || (Math.abs(t.z) > Z && Math.abs(t.x) < G + 0.5 && (e.kind.name === 'brick' || e.kind.name === 'brickHalf')));
    for (const sz of [-1, 1]) goalWall(d, sz);
  }

  /** Physics-rate update, after the world step. */
  step(dt) {
    const b = this.body;
    if (!b) return;
    // Cap the speed so squeezes and blasts can't fire it into orbit.
    const v = b.linvel();
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > MAX_BALL_SPEED) {
      const k = MAX_BALL_SPEED / sp;
      b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
    }
    this.trackTouches();
    if (!this.referee || !this.active) return;
    const t = b.translation();
    // Escaped somehow: drop it back in at the centre.
    if (Math.abs(t.x) > PITCH.halfX + 6 || Math.abs(t.z) > PITCH.halfZ + PITCH.goalDepth + 6 || t.y < -4) {
      this.placeBall(0, 12, 0);
      return;
    }
    if (this.phase === 'kickoff') {
      // Keep the ball on the spot until the whistle.
      this.placeBall(0, BALL_RADIUS, 0);
      return;
    }
    if (this.phase !== 'play') return;
    const { halfZ: Z, goalHalf: G, goalHeight: H } = PITCH;
    if (Math.abs(t.z) > Z + BALL_RADIUS && Math.abs(t.x) < G && t.y < H) {
      this.scoreGoal(t.z > 0 ? 0 : 1, t);
    }
  }

  /** Who touched the ball last (for goal credit). */
  trackTouches() {
    const world = this.destruction.world;
    const owners = new Map();
    if (this.destruction.carBody) owners.set(this.destruction.carBody.handle, this.myId);
    for (const [id, r] of this.destruction.remoteCars || []) if (r.body) owners.set(r.body.handle, id);
    const now = new Set();
    world.contactPairsWith(this.collider, (other) => {
      const body = other.parent();
      const id = body && owners.get(body.handle);
      if (id === undefined) return;
      world.contactPair(this.collider, other, (manifold) => {
        if (manifold.numContacts() > 0) now.add(id);
      });
    });
    for (const id of now) {
      if (!this.touchingNow.has(id)) this.emit('touch', id);
      this.lastTouch = id;
    }
    if (now.size) {
      // The ball sits higher than most bonnets, so plain contacts scoop it
      // up a lot; keep hits mostly driven along the ground.
      const b = this.body;
      const v = b.linvel();
      const maxUp = Math.hypot(v.x, v.z) * 0.35 + 4;
      if (v.y > maxUp) b.setLinvel({ x: v.x, y: maxUp, z: v.z }, true);
    }
    this.touchingNow = now;
  }

  scoreGoal(team, pos) {
    this.score[team]++;
    this.goalCount++;
    const by = this.lastTouch;
    const own = by != null && this.teams.get(by) !== undefined && this.teams.get(by) !== team;
    if (by != null && !own) this.goals.set(by, (this.goals.get(by) || 0) + 1);
    this.lastGoal = { team, by: by ?? null, own, x: roundFb(pos.x), y: roundFb(pos.y), z: roundFb(pos.z) };
    this.phase = 'goal';
    this.timer = GOAL_TIME;
    this.emit('goal', this.lastGoal);
  }

  /** Frame-rate update: clock and phases (referee), HUD (everyone). */
  update(dt, camera) {
    if (!this.active) return;
    if (this.referee) this.runClock(dt);
    else if (this.phase === 'play' && !this.overtime) this.timeLeft = Math.max(0, this.timeLeft - dt);
    this.syncMesh();
    this.goTimer = (this.goTimer || 0) - dt;
    this.updateHud(camera);
  }

  runClock(dt) {
    this.timer -= dt;
    if (this.phase === 'kickoff') {
      if (this.timer <= 0) {
        this.phase = 'play';
        this.emit('go');
      }
    } else if (this.phase === 'play') {
      if (!this.overtime) {
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        // Time's up once the ball is on the ground (no buzzer-beater robbed mid-air).
        if (this.timeLeft <= 0 && this.ball.y < BALL_RADIUS + 0.6) {
          if (this.score[0] === this.score[1]) {
            this.overtime = true;
            this.emit('overtime');
          } else {
            this.phase = 'ended';
            this.timer = END_TIME;
            this.emit('ended', this.score[0] > this.score[1] ? 0 : 1);
          }
        }
      }
    } else if (this.phase === 'goal') {
      if (this.timer <= 0) {
        if (this.overtime || (this.timeLeft <= 0 && this.score[0] !== this.score[1])) {
          this.phase = 'ended';
          this.timer = END_TIME;
          this.emit('ended', this.score[0] > this.score[1] ? 0 : 1);
        } else {
          this.kickoff();
        }
      }
    } else if (this.phase === 'ended') {
      if (this.timer <= 0) this.emit('restart');
    }
  }

  // --- Network -----------------------------------------------------------

  /**
   * Referee: the match state for other players. Teams and goal tallies are
   * only included when they change, or every so often when `full`.
   */
  snapshot(full = false) {
    const b = this.body;
    const t = b.translation(), v = b.linvel(), q = b.rotation();
    const m = {
      b: [t.x, t.y, t.z, v.x, v.y, v.z, q.x, q.y, q.z, q.w].map(roundFb),
      ph: this.phase, tm: roundFb(this.timer), tl: roundFb(this.timeLeft), ot: this.overtime ? 1 : 0,
      s: this.score, k: this.kickoffs, gc: this.goalCount, lg: this.lastGoal,
    };
    const teams = [...this.teams], goals = [...this.goals];
    const roster = JSON.stringify([teams, goals]);
    if (full || roster !== this.sentRoster) {
      m.teams = teams;
      m.goals = goals;
      this.sentRoster = roster;
    }
    return m;
  }

  /**
   * Everyone else: take the referee's state. `ownTouch` is true while our
   * own car has just hit the ball: then our local ball is the better guess
   * and the referee will follow what we send.
   */
  applySnapshot(m, ownTouch) {
    const prevPhase = this.phase;
    this.phase = m.ph;
    this.timer = m.tm;
    this.timeLeft = m.tl;
    this.overtime = !!m.ot;
    this.score = m.s;
    if (m.teams) this.teams = new Map(m.teams);
    if (m.goals) this.goals = new Map(m.goals);
    if (m.k !== this.kickoffs) {
      this.kickoffs = m.k;
      this.emit('kickoff');
    }
    if (m.gc > this.goalCount) {
      this.goalCount = m.gc;
      this.lastGoal = m.lg;
      if (m.lg) this.emit('goal', m.lg);
    } else if (m.gc < this.goalCount) {
      this.goalCount = m.gc; // a new match started
    }
    if (prevPhase === 'kickoff' && m.ph === 'play') this.emit('go');
    if (prevPhase !== 'ended' && m.ph === 'ended') this.emit('ended', m.s[0] > m.s[1] ? 0 : 1);
    if (!this.body || ownTouch) return;
    const [x, y, z, vx, vy, vz, qx, qy, qz, qw] = m.b;
    // Correct our local ball toward the referee's, a little ahead to make
    // up for the delay. Small errors blend; big ones snap.
    const lead = 0.05;
    const tx = x + vx * lead, ty = Math.max(BALL_RADIUS * 0.9, y + vy * lead), tz = z + vz * lead;
    const cur = this.body.translation();
    const err = Math.hypot(tx - cur.x, ty - cur.y, tz - cur.z);
    const k = err > 4 ? 1 : 0.35;
    this.placeBall(cur.x + (tx - cur.x) * k, cur.y + (ty - cur.y) * k, cur.z + (tz - cur.z) * k, vx, vy, vz, { x: qx, y: qy, z: qz, w: qw });
  }

  /** Our ball state for the referee after we hit it. */
  ballMessage() {
    const b = this.body;
    const t = b.translation(), v = b.linvel();
    return [t.x, t.y, t.z, v.x, v.y, v.z].map(roundFb);
  }

  /** Referee: a player hit the ball on their screen; trust their result. */
  takeBall(id, arr) {
    if (!this.body || this.phase === 'kickoff') return;
    const [x, y, z, vx, vy, vz] = arr;
    this.placeBall(x, y, z, vx, vy, vz, this.body.rotation());
    this.lastTouch = id;
  }

  // --- Visuals -----------------------------------------------------------

  syncMesh() {
    const b = this.body;
    if (!b) return;
    const t = b.translation(), q = b.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    this.mesh.visible = this.phase !== 'goal' || this.timer > GOAL_TIME - 0.05;
    // Ring on the ground under the ball, so you can judge where it'll land.
    const h = Math.max(0, t.y - BALL_RADIUS);
    this.marker.position.set(t.x, 0.03, t.z);
    this.marker.visible = h > 0.6 && this.mesh.visible;
    const s = 1 + Math.min(1.5, h * 0.05);
    this.marker.scale.set(s, s, s);
    this.marker.material.opacity = Math.max(0.25, 0.85 - h * 0.03);
  }

  setBanner(text, cls = '') {
    const key = text + '|' + cls;
    if (key === this.bannerText) return;
    this.bannerText = key;
    const el = this.hud.banner;
    el.innerHTML = text;
    el.className = cls;
    el.classList.toggle('show', !!text);
  }

  updateHud(camera) {
    const h = this.hud;
    h.blue.textContent = this.score[0];
    h.orange.textContent = this.score[1];
    if (this.overtime) {
      h.clock.textContent = 'OT';
    } else {
      const t = Math.ceil(this.timeLeft);
      h.clock.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }
    h.clock.classList.toggle('low', !this.overtime && this.timeLeft <= 30 && this.phase === 'play');
    if (this.phase === 'kickoff') {
      this.setBanner(String(Math.max(1, Math.ceil(this.timer))), 'count');
    } else if (this.phase === 'goal' && this.lastGoal) {
      const g = this.lastGoal;
      const who = g.by != null ? this.names.get(g.by) : null;
      const line = g.own ? `Own goal${who ? ` by ${escapeHtml(who)}` : ''}` : who ? `${escapeHtml(who)} scores` : `${TEAM_NAMES[g.team]} scores`;
      this.setBanner(`GOAL!<small>${line}</small>`, `goal team${g.team}`);
    } else if (this.phase === 'ended') {
      const w = this.score[0] > this.score[1] ? 0 : 1;
      this.setBanner(`${TEAM_NAMES[w]} wins<small>${this.score[0]} – ${this.score[1]}</small>`, `goal team${w}`);
    } else if (this.goTimer > 0) {
      this.setBanner('GO!', 'count');
    } else {
      this.setBanner('');
    }

    // Arrow at the screen edge pointing at the ball when it's off screen.
    const a = h.arrow;
    if (!camera || this.phase === 'goal') { a.hidden = true; return; }
    const p = _fbScreen.copy(this.mesh.position).project(camera);
    const behind = _fbView.copy(this.mesh.position).applyMatrix4(camera.matrixWorldInverse).z > 0;
    const onScreen = !behind && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95;
    a.hidden = onScreen;
    if (onScreen) return;
    let x = p.x, y = p.y;
    if (behind) { x = -x; y = -y; }
    const ang = Math.atan2(y, x);
    const k = 0.86 / Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
    const sx = (Math.cos(ang) * k * 0.5 + 0.5) * innerWidth;
    const sy = (-Math.sin(ang) * k * 0.5 + 0.5) * innerHeight;
    a.style.transform = `translate(${sx}px, ${sy}px) rotate(${-ang}rad)`;
  }

  showGo() {
    this.goTimer = 0.9;
  }
}

const _fbScreen = new THREE.Vector3();
const _fbView = new THREE.Vector3();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A white ball with twelve dark spots, like a classic football. */
function ballMesh() {
  const geo = new THREE.IcosahedronGeometry(BALL_RADIUS, 4);
  const spots = new THREE.IcosahedronGeometry(1, 0).attributes.position;
  const dirs = [];
  for (let i = 0; i < spots.count; i++) {
    const d = new THREE.Vector3().fromBufferAttribute(spots, i).normalize();
    if (!dirs.some((o) => o.distanceTo(d) < 1e-3)) dirs.push(d);
  }
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const near = Math.max(...dirs.map((d) => d.dot(v)));
    const c = near > 0.93 ? 0.08 : 0.95;
    colors.set([c, c, c * 1.02], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.05, flatShading: true }));
  mesh.castShadow = true;
  return mesh;
}

function groundMarker() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(BALL_RADIUS * 0.8, BALL_RADIUS, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 2;
  return ring;
}

/** Coloured glow under a car showing its team. */
export function teamGlow(def, team) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(def.width * 2.4, def.length * 1.7),
    new THREE.MeshBasicMaterial({ map: tex, color: TEAM_COLORS[team], transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.04;
  glow.renderOrder = 2;
  glow.name = 'teamGlow';
  return glow;
}

/** Add, recolour or remove (team = null) a car model's team glow. */
export function setTeamGlow(model, def, team) {
  const old = model.root.getObjectByName('teamGlow');
  if (old && old.userData.team === team) return;
  if (old) model.root.remove(old);
  if (team == null) return;
  const glow = teamGlow(def, team);
  glow.userData.team = team;
  model.root.add(glow);
}

export { TEAM_CSS };
