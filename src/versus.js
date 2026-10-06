import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { CarModel } from './carModel.js';
import { WEAPONS, WEAPON_CODES, turretMount, carPoint, aimDir, rayCar, carBounds, mountTurret, Arsenal } from './weapons.js';
import { PADS, SPAWNS, YARD } from './vsmap.js';
import { nameTag } from './multiplayer.js';
import { FlameTank, nozzle, streamPoint } from './flamethrower.js';

// Versus: everyone against everyone in the Scrapyard. Cars have health;
// they fight with roof-mounted weapons (a machine gun to start with,
// better ones from the upgrade pads), by ramming, and by blowing up the
// fuel drums next to each other. A wrecked car respawns a few seconds
// later; the most wrecks when the clock runs out wins.
//
// Upgrade pads change what they offer every so often, and the longer the
// match goes the better the upgrades get (see VS_TIERS).
//
// Online, each player owns their own car's health: whoever fires works out
// what their shot hit and sends the damage to the victim ('dmg'), and the
// victim announces its own wreck ('wreck'). Rockets and mines are
// simulated on every screen; each screen damages only its own car. The
// host (the referee) runs the clock, the scores and the pads.

export const VS = {
  matchTime: 300,
  endTime: 8,
  respawn: 3,
  invuln: 2,
  credit: 6,       // seconds a hit still counts for the wreck
  padRotate: 20,   // a pad offers something else after this long
  padEmpty: 8,     // and refills this long after someone takes its upgrade
};

export const ITEMS = {
  rockets: { label: 'Rockets', weapon: true, color: 0xff5a36, tier: 0 },
  repair: { label: 'Repair', color: 0x46d17a, tier: 0 },
  nitro: { label: 'Nitro', color: 0x3fc8ff, tier: 0, time: 8 },
  flamer: { label: 'Flamethrower', weapon: true, color: 0xff9a1f, tier: 1 },
  armour: { label: 'Armour', color: 0xc8ced8, tier: 1, time: 15 },
  mines: { label: 'Mines', weapon: true, color: 0xffd23f, tier: 1 },
  salvo: { label: 'Rocket salvo', weapon: true, color: 0xff2d55, tier: 2 },
  double: { label: 'Double damage', color: 0xb36bff, tier: 2, time: 15 },
};
const ITEM_CODES = Object.keys(ITEMS);
/** Match time (seconds played) at which each tier of upgrades appears. */
const VS_TIERS = [0, 60, 150];

export const BOT_NAMES = ['Rex', 'Vex', 'Moxie', 'Gnasher', 'Torque', 'Clunk'];

/**
 * How good the computer drivers are. spread: aim wobble (× the gun's);
 * damage: × what they deal; reach: × how far away they open fire;
 * think: seconds between picking targets; mines: whether they lay them;
 * boost: how keen they are on boost (distance to target before they use it).
 */
export const BOT_SKILL = {
  easy: { spread: 3, damage: 0.6, reach: 0.6, think: 1.1, mines: false, boostAt: 60, fireChance: 0.55 },
  normal: { spread: 1, damage: 1, reach: 1, think: 0.5, mines: true, boostAt: 35, fireChance: 1 },
  hard: { spread: 0.5, damage: 1.25, reach: 1.2, think: 0.25, mines: true, boostAt: 22, fireChance: 1 },
};

/** Hit points: bigger, heavier cars take more punishment. */
export function maxHpFor(def) {
  return Math.round(Math.max(90, Math.min(220, 80 + def.spec.mass / 50)));
}

const _vsA = new THREE.Vector3();
const _vsB = new THREE.Vector3();
const _vsC = new THREE.Vector3();
const _vsD = new THREE.Vector3();
const _vsE = new THREE.Vector3();
const _vsRight = new THREE.Vector3();
const _vsScreen = new THREE.Vector3();
const _vsNz = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };
const vsClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const vsWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const vsRound = (v) => Math.round(v * 100) / 100;

function escapeVs(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export class Versus {
  /**
   * @param {object} o
   *   scene, destruction, audio
   *   me()        { id, name, def, car, model } for our own car
   *   remotes()   the multiplayer remotes map (id -> { name, def, model, proxy, seen })
   *   net         the Net (online, isHost, sendEvent)
   *   terrain()   the current terrain
   *   respawnMe(spot)
   *   fx          { explosion(pos, size), smoke(pos), dust(pos), toast(msg), kick(amount) }
   */
  constructor(o) {
    Object.assign(this, o);
    this.arsenal = new Arsenal(o.scene);
    this.fighters = new Map();
    this.bots = [];
    this.active = false;
    this.listeners = {};
    this.seq = 0;
    this.time = 0;
    this.scores = new Map();
    this.feed = [];
    this.pendingDmg = new Map();
    this.dmgTimer = 0;
    this.vignette = 0;
    this.hitFlash = 0;
    const $ = (id) => document.getElementById(id);
    this.hud = {
      root: $('vs-hud'), hpFill: $('vs-hp-fill'), hpText: $('vs-hp-text'), weapon: $('vs-weapon-name'),
      ammo: $('vs-ammo'), buffs: $('vs-buffs'), clock: $('vs-clock'), kills: $('vs-kills'), board: $('vs-board'),
      feed: $('vs-feed'), lock: $('vs-lock'), vignette: $('vs-vignette'), wrecked: $('vs-wrecked'),
      banner: $('banner'), top: $('vs-top'),
    };
    this.boardSig = '';
    this.buffSig = '';
    this.buildPads();
    this.resetMatch();
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event] || []) fn(...args);
  }

  get authority() {
    return !this.net.online || this.net.isHost;
  }

  get myId() {
    return this.net.online ? this.net.id : 'me';
  }

  /**
   * Turn Versus on or off. `sandbox` is free roam: only weapons (for cars
   * that have one fitted), fired at the scenery; no health, pads or match.
   */
  setActive(on, sandbox = false) {
    const was = this.active && !this.sandbox;
    this.arsenal.clear();
    if (!on || sandbox) this.removeBots();
    for (const f of this.fighters.values()) this.dropFighter(f);
    this.fighters.clear();
    this.active = on;
    this.sandbox = on && sandbox;
    const match = on && !sandbox;
    this.hud.root.hidden = !match;
    this.hud.root.classList.toggle('sandbox', this.sandbox);
    this.hud.top.hidden = !match;
    this.hud.board.hidden = !match;
    this.hud.feed.hidden = !match;
    for (const p of this.pads) p.group.visible = match;
    this.hud.lock.hidden = true;
    this.hud.wrecked.classList.remove('show');
    this.hud.vignette.style.opacity = 0;
    if (was && !match) this.setBanner('');
  }

  // --- Match ----------------------------------------------------------------

  resetMatch() {
    this.phase = 'play';
    this.timeLeft = VS.matchTime;
    this.endTimer = 0;
    this.tier = 0;
    this.scores.clear();
    this.scoresDirty = true;
    this.feed = [];
    this.renderFeed();
    this.matchNo = (this.matchNo || 0) + 1;
  }

  /** A fresh match: clear the field, reset scores and pads, everyone to a spawn. */
  reset() {
    this.arsenal.clear();
    this.resetMatch();
    const terrain = this.terrain();
    for (const p of this.sandbox ? [] : this.pads) {
      p.y = terrain.heightAt(p.x, p.z);
      p.group.position.set(p.x, p.y, p.z);
      this.setPadItem(p, this.authority ? this.randomItem(0, null) : null);
      p.timer = VS.padRotate * (0.5 + Math.random() * 0.5);
    }
    this.syncFighters();
    const used = new Set();
    let i = 0;
    for (const f of this.fighters.values()) {
      this.reviveFighter(f);
      if (!f.local) continue;
      f.invuln = 0;
      if (f.me) continue; // already on its start spot (see startSpot)
      // Bots spread out over the other spawns.
      let k = 1 + (i++ * 3) % (SPAWNS.length - 1);
      while (used.has(k)) k = k % (SPAWNS.length - 1) + 1;
      used.add(k);
      this.placeFighter(f, SPAWNS[k]);
    }
    this.setBanner('');
  }

  isWrecked(id) {
    return this.active && !!this.fighters.get(id)?.wrecked;
  }

  /** Our own start spot (online: by join order, so players start apart). */
  startSpot(slot) {
    return SPAWNS[slot % SPAWNS.length];
  }

  randomItem(tier, not) {
    const pool = ITEM_CODES.filter((k) => ITEMS[k].tier <= tier && k !== not);
    return pool[(Math.random() * pool.length) | 0];
  }

  score(id) {
    let s = this.scores.get(id);
    if (!s) this.scores.set(id, (s = { k: 0, d: 0 }));
    return s;
  }

  // --- Bots -----------------------------------------------------------------

  /** Solo: add computer drivers in the given cars, at a skill level (see BOT_SKILL). */
  addBots(defs, skill = 'normal') {
    this.removeBots();
    defs.forEach((def, i) => {
      const id = `bot${i + 1}`;
      const bot = new VersusBot(id, BOT_NAMES[i % BOT_NAMES.length], def, this.terrain(), BOT_SKILL[skill] || BOT_SKILL.normal);
      const tag = nameTag(bot.name, def);
      tag.position.set(0, carBounds(def).hi[1] + 1.1, 0);
      bot.model.root.add(tag);
      this.scene.add(bot.model.root);
      const r = this.destruction.addRemoteCar(id, def, bot.car);
      r.react = true; // bumps into cover instead of driving through it
      this.bots.push(bot);
    });
  }

  removeBots() {
    for (const b of this.bots) {
      this.scene.remove(b.model.root);
      b.model.dispose();
      this.destruction.removeRemoteCar(b.id);
      const f = this.fighters.get(b.id);
      if (f) { this.dropFighter(f); this.fighters.delete(b.id); }
    }
    this.bots = [];
  }

  /** Bot cars hit by cover this world step: push them back. */
  botReactions() {
    for (const b of this.bots) {
      const r = this.destruction.remoteCars?.get(b.id)?.reaction;
      if (r && r.total > 0) b.car.applyImpulse(r.jx, r.jz, r.torque);
    }
  }

  // --- Fighters -------------------------------------------------------------

  newFighter(id, name, def, model, opts) {
    const f = {
      id, name, def, model, ...opts,
      maxHp: maxHpFor(def), hp: maxHpFor(def), special: null, ammo: 0, cooldown: 0,
      flaming: false, shooting: false, aimYaw: 0, aimPitch: 0, target: null,
      buffs: { armour: 0, double: 0, nitro: 0 }, invuln: 0, wrecked: false, respawnIn: 0,
      lastBy: null, lastAt: -99, smokeT: 0, turretKey: null, turret: null, bar: makeBar(this.scene),
      tank: def.flamethrower ? new FlameTank() : null,
      mag: WEAPONS[def.weapon]?.mag ?? 0, // the car's own rockets/mines: a magazine that refills
    };
    return f;
  }

  dropFighter(f) {
    if (f.turret && f.turret !== f.model.weaponTurret) f.turret.root.parent?.remove(f.turret.root);
    if (f.model.weaponTurret) {
      f.model.weaponTurret.root.visible = true;
      f.model.weaponTurret.yaw.rotation.y = 0;
      f.model.weaponTurret.pitch.rotation.x = 0;
    }
    f.turret = null;
    f.turretKey = null;
    this.scene.remove(f.bar.bg, f.bar.fill);
  }

  /** Keep the fighter list matching who's here (us, bots, other players). */
  syncFighters() {
    const me = this.me();
    const seen = new Set();
    const keep = (id, name, def, model, opts) => {
      seen.add(id);
      let f = this.fighters.get(id);
      if (f && (f.def !== def || f.model !== model)) {
        this.dropFighter(f);
        const was = f;
        f = this.newFighter(id, name, def, model, opts);
        if (!was.wrecked) f.hp = Math.min(f.maxHp, was.hp * f.maxHp / was.maxHp);
        this.fighters.set(id, f);
      } else if (!f) {
        f = this.newFighter(id, name, def, model, opts);
        this.fighters.set(id, f);
      }
      f.name = name;
      return f;
    };
    keep(me.id, me.name, me.def, me.model, { local: true, me: true, car: me.car }).car = me.car;
    for (const b of this.bots) keep(b.id, b.name, b.def, b.model, { local: true, bot: b, car: b.car });
    for (const r of this.remotes().values()) keep(r.id, r.name, r.def, r.model, { local: false, remote: r, car: r.proxy }).car = r.proxy;
    for (const [id, f] of this.fighters) {
      if (!seen.has(id)) { this.dropFighter(f); this.fighters.delete(id); }
    }
  }

  reviveFighter(f) {
    f.hp = f.maxHp;
    f.wrecked = false;
    f.special = null;
    f.ammo = 0;
    f.cooldown = 0;
    f.buffs = { armour: 0, double: 0, nitro: 0 };
    f.invuln = VS.invuln;
    f.lastBy = null;
    if (f.tank) f.tank.level = 1;
    f.mag = WEAPONS[f.def.weapon]?.mag ?? 0;
  }

  placeFighter(f, spot) {
    if (f.me) this.respawnMe(spot);
    else if (f.bot) {
      f.car.reset(spot.x, spot.z, spot.heading);
      f.bot.stuck = f.bot.reversing = 0;
      f.model.damage?.repair();
    }
  }

  /** The spawn furthest from everyone still fighting. */
  safestSpawn(self) {
    let best = SPAWNS[0], bestD = -1;
    for (const s of SPAWNS) {
      let d = Infinity;
      for (const f of this.fighters.values()) {
        if (f === self || f.wrecked || (f.remote && !f.remote.seen)) continue;
        d = Math.min(d, Math.hypot(f.car.x - s.x, f.car.z - s.z));
      }
      d += Math.random() * 6;
      if (d > bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** The weapon a fighter fires right now: its pickup while it has ammo, else its own. */
  weaponOf(f) {
    if (f.special && f.ammo > 0) return f.special;
    if (f.def.flamethrower) return 'inferno';
    return WEAPONS[f.def.weapon] ? f.def.weapon : 'mg';
  }

  centreOf(f, out) {
    const b = carBounds(f.def);
    return out.set(f.car.x, (f.car.y || 0) + (b.lo[1] + b.hi[1]) / 2, f.car.z);
  }

  /** Auto-aim: the enemy most in front of us, within range and a forward cone. */
  pickTarget(f, range) {
    if (this.sandbox) return null; // free roam: just shoot where you're pointing
    const c = f.car;
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    let best = null, bestScore = Infinity;
    for (const o of this.fighters.values()) {
      if (o === f || o.wrecked || (o.remote && !o.remote.seen)) continue;
      const dx = o.car.x - c.x, dz = o.car.z - c.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range || dist < 0.5) continue;
      const cos = (dx * fx + dz * fz) / dist;
      if (cos < 0.8) continue;
      const score = dist + (1 - cos) * 120;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  // --- Damage -----------------------------------------------------------------

  /** `amount` of damage to fighter `o`, credited to `by` (a fighter id, or null). */
  hurt(o, amount, by, kind = '') {
    if (!o || o.wrecked || !(amount > 0) || this.phase !== 'play' || this.sandbox) return;
    if (by === this.myId && !o.me) {
      this.hitFlash = 0.12;
      if (kind !== 'blast') this.audio.hitTick();
    }
    if (!o.local) {
      // Another player's car: they keep their own health. Send it on.
      this.pendingDmg.set(o.id, (this.pendingDmg.get(o.id) || 0) + amount);
      return;
    }
    if (o.invuln > 0) return;
    if (o.buffs.armour > 0) amount *= 0.5;
    o.hp -= amount;
    if (by && by !== o.id) { o.lastBy = by; o.lastAt = this.time; }
    if (o.me) {
      this.vignette = Math.min(1, this.vignette + amount / 30);
      this.fx.kick(Math.min(0.4, amount * 0.01));
    }
    if (o.hp <= 0) this.wreck(o);
  }

  /** Damage multiplier for `f`'s attacks. */
  power(f) {
    return (f.buffs?.double > 0 ? 2 : 1) * (f.bot?.skill.damage ?? 1);
  }

  /** An explosion at `pos`: hurts (and shoves) our own cars nearby. */
  explosionDamage(at, radius, max, by) {
    const pos = _vsE.copy(at); // the loop below reuses the scratch vectors
    for (const f of this.fighters.values()) {
      if (!f.local || f.wrecked) continue;
      const c = this.centreOf(f, _vsA);
      const d = c.distanceTo(pos);
      if (d >= radius) continue;
      let dmg = max * Math.pow(1 - d / radius, 0.7);
      if (by === f.id) dmg *= 0.5; // your own blasts hurt you less
      this.hurt(f, dmg, by, 'blast');
      if (f.bot) {
        // Our car gets its shove from Destruction.blast; bots need theirs.
        const m = f.car.spec.mass;
        const dv = 9 * (1 - d / radius) * Math.min(1, 1600 / m);
        const dx = f.car.x - pos.x, dz = f.car.z - pos.z, l = Math.hypot(dx, dz) || 1;
        f.car.applyImpulse((dx / l) * dv * m, (dz / l) * dv * m, (Math.random() - 0.5) * m * 2);
      }
    }
  }

  /**
   * A ram. `dv` is the speed change the hit gave fighter `id`; `n` is the
   * direction it was pushed; the share of the blame goes to whoever was
   * driving into whom.
   */
  rammed(id, by, dv, nx, nz, myVel, otherVel) {
    const f = this.fighters.get(id);
    if (!f?.local || dv < 3) return;
    const mine = Math.max(0, -(myVel.x * nx + myVel.z * nz));
    const theirs = Math.max(0, otherVel.x * nx + otherVel.z * nz);
    const share = theirs / (mine + theirs + 0.5);
    this.hurt(f, (dv - 3) * 4.5 * (0.35 + share), by, 'ram');
  }

  /** Hitting a wall. */
  crashed(id, speed) {
    const f = this.fighters.get(id);
    if (f?.local && speed > 11) this.hurt(f, (speed - 11) * 2, f.lastAt > this.time - VS.credit ? f.lastBy : null, 'crash');
  }

  wreck(o) {
    o.hp = 0;
    o.wrecked = true;
    o.respawnIn = VS.respawn;
    o.flaming = o.shooting = false;
    o.special = null;
    o.ammo = 0;
    o.car.velX = o.car.velZ = 0;
    o.car.yawRate = 0;
    const by = o.lastBy && this.time - o.lastAt < VS.credit ? o.lastBy : null;
    if (this.net.online && o.me) this.net.sendEvent({ type: 'wreck', by });
    this.recordWreck(o.id, by);
  }

  /** Every screen: someone was wrecked (fx, feed, and the referee's scores). */
  recordWreck(id, by) {
    const f = this.fighters.get(id);
    if (this.authority) {
      this.score(id).d++;
      if (by && by !== id) this.score(by).k++;
      this.scoresDirty = true;
    }
    const name = (x) => this.fighters.get(x)?.name || 'Someone';
    this.feed.push({ text: by && by !== id ? `<b>${escapeVs(name(by))}</b> wrecked <b>${escapeVs(name(id))}</b>` : `<b>${escapeVs(name(id))}</b> wrecked themselves`, at: this.time, mine: by === this.myId || id === this.myId });
    if (this.feed.length > 5) this.feed.shift();
    this.renderFeed();
    if (f) {
      const pos = this.centreOf(f, new THREE.Vector3());
      this.fx.explosion(pos, 1.3);
      this.destruction.blast(pos, 5);
      if (f.me) this.wreckedBy = by && by !== id ? name(by) : null;
    }
    if (by === this.myId && id !== this.myId) this.fx.toast(`You wrecked ${name(id)}`);
  }

  respawn(f) {
    this.reviveFighter(f);
    this.placeFighter(f, this.safestSpawn(f));
  }

  // --- Weapons ------------------------------------------------------------------

  shootMG(f, real) {
    const spec = WEAPONS.mg;
    const mount = carPoint(f.car, turretMount(f.def), _vsA);
    const spread = spec.spread * (f.bot?.skill.spread ?? 1);
    const dir = aimDir(f.aimYaw + (Math.random() - 0.5) * spread * 2, f.aimPitch + (Math.random() - 0.5) * spread, _vsB);
    const origin = _vsC.copy(mount).addScaledVector(dir, 0.95);
    origin.y += 0.28;
    let best = spec.range, victim = null;
    for (const o of this.fighters.values()) {
      if (o === f || o.wrecked || (o.remote && !o.remote.seen)) continue;
      const t = rayCar(origin, dir, best, o.car, carBounds(o.def));
      if (t >= 0 && t < best) { best = t; victim = o; }
    }
    const w = this.destruction.shoot(origin, dir, best);
    let entity = null;
    if (w) { best = w.dist; victim = null; entity = w.entity; }
    const end = _vsD.copy(origin).addScaledVector(dir, best);
    this.arsenal.tracer(origin, end);
    this.arsenal.flash(origin, 0.8, 0xffd27a, 0.04);
    this.audio.gun(origin, f.me ? 0.8 : 1);
    if (victim) {
      this.arsenal.flash(end, 0.9, 0xffb050, 0.07);
      if (real) this.hurt(victim, spec.damage * this.power(f), f.id, 'mg');
    } else if (best < spec.range - 0.01) {
      this.arsenal.flash(end, 0.5, 0xfff0c0, 0.06);
      if (entity) this.destruction.damageEntity(entity, spec.damage, end, dir);
      else if (Math.random() < 0.4) this.fx.dust(end);
    }
  }

  fireRockets(f, w, target) {
    const spec = WEAPONS[w];
    const n = spec.perShot || 1;
    const mount = carPoint(f.car, turretMount(f.def), new THREE.Vector3());
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? (i - (n - 1) / 2) * 0.16 : 0;
      const dir = aimDir(f.aimYaw + spread, f.aimPitch + 0.05, new THREE.Vector3());
      const pos = mount.clone().addScaledVector(dir, 0.8);
      pos.y += 0.3;
      const r = {
        id: `${f.id}:${++this.seq}`, owner: f.id, target: target?.id ?? null, kind: w,
        pos, vel: dir.multiplyScalar(spec.speed), speed: spec.speed, turn: spec.turn,
        damage: spec.damage * this.power(f), radius: spec.radius,
      };
      this.arsenal.fireRocket(r);
      if (this.net.online && f.me) {
        this.net.sendEvent({ type: 'fx', k: 'r', i: r.id, w, t: r.target, d: r.damage, p: [pos.x, pos.y, pos.z].map(vsRound), v: [r.vel.x, r.vel.y, r.vel.z].map(vsRound) });
      }
    }
    this.audio.rocket(mount);
    this.arsenal.flash(mount, 1.4, 0xff9a50, 0.08);
  }

  dropMine(f) {
    const b = carBounds(f.def);
    const p = carPoint(f.car, [0, 0, b.lo[2] - 1.1], new THREE.Vector3());
    p.y = this.terrain().heightAt(p.x, p.z);
    const spec = WEAPONS.mines;
    const m = { id: `${f.id}:${++this.seq}`, owner: f.id, pos: p, arm: spec.arm, damage: spec.damage * this.power(f) };
    this.arsenal.dropMine(m);
    // At most six of anyone's mines lie about at once.
    const mine = this.arsenal.mines.filter((x) => x.owner === f.id && !x.dead);
    if (mine.length > 6) this.arsenal.removeMine(mine[0]);
    if (this.net.online && f.me) this.net.sendEvent({ type: 'fx', k: 'm', i: m.id, d: m.damage, p: [p.x, p.y, p.z].map(vsRound) });
  }

  detonateRocket(r) {
    this.fx.explosion(r.pos, 0.8);
    this.destruction.blast(r.pos, r.radius);
    this.explosionDamage(r.pos, r.radius, r.damage, r.owner);
  }

  detonateMine(m, tell) {
    if (m.dead) return;
    this.arsenal.removeMine(m);
    const pos = m.pos.clone();
    pos.y += 0.5;
    this.fx.explosion(pos, 1);
    this.destruction.blast(pos, WEAPONS.mines.radius);
    this.explosionDamage(pos, WEAPONS.mines.radius, m.damage, m.owner);
    if (tell && this.net.online) this.net.sendEvent({ type: 'fx', k: 'b', i: m.id });
  }

  /** Fire stream from a fighter's nozzle: burns the cars it reaches. */
  flameDamage(f, dt) {
    nozzle(f.car, turretMount(f.def), _vsNz);
    const dps = WEAPONS.inferno.dps * this.power(f);
    for (const o of this.fighters.values()) {
      if (o === f || o.wrecked || (o.remote && !o.remote.seen)) continue;
      const c = this.centreOf(o, _vsC);
      const reach = Math.max(o.def.width, 1.8) * 0.5;
      for (let d = 1.5; d <= WEAPONS.inferno.range; d += 1.5) {
        const p = streamPoint(_vsNz.pos, _vsNz.dir, d);
        if (p.distanceTo(c) < reach + 0.6 + d * 0.09) {
          this.hurt(o, dps * dt, f.id, 'flame');
          break;
        }
      }
    }
  }

  /** Everyone firing flamethrowers this frame, for the fire effect and burning. */
  flamers() {
    const out = [];
    for (const f of this.fighters.values()) {
      if (f.wrecked) continue;
      const on = f.local ? f.flaming : f.car.firing;
      if (on) out.push({ key: f.id, car: f.car, mount: turretMount(f.def) });
    }
    return out;
  }

  // --- Pads ---------------------------------------------------------------------

  buildPads() {
    this.pads = PADS.map((p, i) => {
      const group = new THREE.Group();
      group.visible = false;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.9, 0.12, 32), new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6, metalness: 0.4 }));
      base.position.y = 0.06;
      base.receiveShadow = true;
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.08, 8, 48), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.14;
      const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 9, 24, 1, true), beamMat);
      beam.position.y = 4.6;
      const iconMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0.3 });
      const icon = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), iconMat);
      icon.position.y = 1.7;
      icon.castShadow = true;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
      label.scale.set(4, 1, 1);
      label.position.y = 3.1;
      label.renderOrder = 9;
      group.add(base, ring, beam, icon, label);
      this.scene.add(group);
      return { i, x: p.x, z: p.z, y: 0, item: null, timer: 0, group, ring, ringMat, beam, beamMat, icon, iconMat, label, askedUntil: 0, pulse: 0 };
    });
  }

  setPadItem(p, item) {
    if (p.item === item) return;
    p.item = item;
    const show = !!item;
    p.icon.visible = p.beam.visible = p.label.visible = show;
    if (show) {
      const c = ITEMS[item].color;
      p.ringMat.color.setHex(c);
      p.beamMat.color.setHex(c);
      p.iconMat.color.setHex(c);
      p.iconMat.emissive.setHex(c);
      p.label.material.map = labelTexture(ITEMS[item].label, c);
      p.label.material.needsUpdate = true;
      p.pulse = 1;
    } else {
      p.ringMat.color.setHex(0x555a62);
    }
  }

  updatePads(dt) {
    if (this.authority && this.phase === 'play') {
      for (const p of this.pads) {
        p.timer -= dt;
        if (p.timer <= 0) {
          this.setPadItem(p, this.randomItem(this.tier, p.item));
          p.timer = VS.padRotate;
        }
      }
    }
    const t = this.time;
    for (const p of this.pads) {
      p.icon.rotation.y = t * 1.6;
      p.icon.position.y = 1.7 + Math.sin(t * 2.2 + p.i) * 0.18;
      p.pulse = Math.max(0, p.pulse - dt * 2);
      p.icon.scale.setScalar(1 + p.pulse * 0.6);
      p.beamMat.opacity = 0.12 + Math.sin(t * 3 + p.i) * 0.04 + p.pulse * 0.3;
    }
  }

  /** Cars of ours on a pad with an upgrade: take it (or ask the referee for it). */
  checkPickups() {
    if (this.phase !== 'play') return;
    for (const f of this.fighters.values()) {
      if (!f.local || f.wrecked) continue;
      for (const p of this.pads) {
        if (!p.item) continue;
        if (Math.hypot(f.car.x - p.x, f.car.z - p.z) > 3.2 || Math.abs((f.car.y || 0) - p.y) > 2.5) continue;
        if (this.authority) {
          const item = p.item;
          this.setPadItem(p, null);
          p.timer = VS.padEmpty;
          this.giveItem(f, item);
        } else if (f.me && this.time > p.askedUntil) {
          p.askedUntil = this.time + 0.6;
          this.net.sendEvent({ type: 'take', to: 'host', pad: p.i, item: p.item });
        }
      }
    }
  }

  giveItem(f, item) {
    const it = ITEMS[item];
    if (!it) return;
    if (it.weapon) {
      f.special = item;
      f.ammo = WEAPONS[item].ammo;
      f.cooldown = Math.min(f.cooldown, 0.2);
    } else if (item === 'repair') {
      f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.5);
    } else {
      f.buffs[item] = it.time;
      if (item === 'nitro') f.car.boost = 1;
    }
    if (f.me) {
      this.audio.pickup();
      this.fx.toast(it.weapon ? `${it.label}: ${WEAPONS[item].ammo}${item === 'flamer' ? ' s of fuel' : item === 'salvo' ? ' salvos' : ''}` : item === 'repair' ? 'Repaired' : `${it.label} for ${it.time} s`);
    }
  }

  // --- Per frame -------------------------------------------------------------------

  /**
   * Run the match for a frame. `wantFire` is our fire button; `camera`
   * places the health bars and the lock-on marker.
   */
  update(dt, wantFire, camera) {
    if (!this.active) return;
    this.syncFighters();
    this.time += dt;

    // The referee runs the clock (not in free roam).
    if (this.authority && !this.sandbox) {
      if (this.phase === 'play') {
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        if (this.timeLeft <= 0) {
          this.phase = 'ended';
          this.endTimer = VS.endTime;
          this.emit('ended');
        }
      } else if (this.phase === 'ended') {
        this.endTimer -= dt;
        if (this.endTimer <= 0) this.emit('restart');
      }
    }
    // Better upgrades as the match goes on.
    const played = VS.matchTime - this.timeLeft;
    const tier = VS_TIERS.filter((t) => played >= t).length - 1;
    if (tier > this.tier && !this.sandbox) {
      this.tier = tier;
      const names = ITEM_CODES.filter((k) => ITEMS[k].tier === tier).map((k) => ITEMS[k].label);
      this.fx.toast(`New upgrades on the pads: ${names.join(', ')}`);
      this.audio.beep(true);
    }
    if (!this.sandbox) this.updatePads(dt);

    for (const f of this.fighters.values()) {
      if (f.local) this.updateLocal(f, dt, f.me ? wantFire : f.bot.wantFire);
      else this.updateRemote(f, dt);
    }
    if (!this.sandbox) this.checkPickups();

    // Rockets fly; mines wait.
    this.arsenal.update(dt, {
      targetOf: (r) => {
        const t = r.target != null ? this.fighters.get(r.target) : null;
        return t && !t.wrecked ? this.centreOf(t, _vsD) : null;
      },
      rocketHits: (r, from, to) => this.rocketHits(r, from, to),
      trail: (pos, vel) => this.fx.smoke(pos, vel),
    });
    for (const r of this.arsenal.spent()) this.detonateRocket(r);
    for (const m of this.arsenal.mines) {
      if (m.dead || m.age < m.arm) continue;
      // Free roam: mines are timed charges for blowing things up.
      if (this.sandbox) {
        if (m.age > 2.5) this.detonateMine(m, m.owner === this.myId);
        continue;
      }
      for (const f of this.fighters.values()) {
        if (!f.local || f.wrecked || f.id === m.owner) continue;
        if (Math.hypot(f.car.x - m.pos.x, f.car.z - m.pos.z) < WEAPONS.mines.trigger && Math.abs((f.car.y || 0) - m.pos.y) < 2) {
          this.detonateMine(m, true);
          break;
        }
      }
    }
    this.arsenal.mines = this.arsenal.mines.filter((m) => !m.dead);

    // Online: send the damage we did, ten times a second.
    this.dmgTimer -= dt;
    if (this.dmgTimer <= 0 && this.pendingDmg.size) {
      this.dmgTimer = 0.1;
      for (const [to, a] of this.pendingDmg) this.net.sendEvent({ type: 'dmg', to, a: Math.round(a * 10) / 10 });
      this.pendingDmg.clear();
    }
    if (this.sandbox) this.updateSandboxHud();
    else this.updateHud(dt, camera);
  }

  /** Free roam: just the weapon and its ammo, for a car that has one. */
  updateSandboxHud() {
    const me = this.fighters.get(this.myId);
    const armed = !!me?.def.weapon && !me.def.flamethrower;
    this.hud.root.hidden = !armed;
    if (armed) this.renderWeapon(me);
  }

  /** The weapon panel: name, and ammo (or how full the magazine is). */
  renderWeapon(me) {
    const h = this.hud;
    const w = this.weaponOf(me);
    const spec = WEAPONS[w];
    h.weapon.textContent = spec.label;
    h.weapon.style.color = `#${spec.color.toString(16).padStart(6, '0')}`;
    const own = !(me.special && me.ammo > 0);
    h.ammo.textContent = w === 'mg' ? '∞'
      : w === 'inferno' ? `${Math.round(me.tank.level * 100)}%`
        : !own ? (w === 'flamer' ? `${Math.ceil(me.ammo)} s` : `×${me.ammo}`)
          : `${Math.floor(me.mag)} / ${spec.mag}`;
  }

  updateLocal(f, dt, wantFire) {
    const car = f.car;
    // Free roam: only cars with a weapon fitted fire (the Inferno's
    // flamethrower is handled with its tank in main.js there).
    if (this.sandbox && (!f.def.weapon || f.def.flamethrower)) {
      f.shooting = f.flaming = false;
      return;
    }
    if (f.wrecked) {
      f.respawnIn -= dt;
      f.flaming = f.shooting = false;
      if (f.respawnIn <= 0 && this.phase === 'play') this.respawn(f);
      this.visuals(f, dt);
      return;
    }
    f.invuln = Math.max(0, f.invuln - dt);
    for (const k of Object.keys(f.buffs)) f.buffs[k] = Math.max(0, f.buffs[k] - dt);
    if (f.buffs.nitro > 0) car.boost = 1;

    const w = this.weaponOf(f);
    const spec = WEAPONS[w];
    const target = this.pickTarget(f, spec.range || 70);
    f.target = target?.id ?? null;
    const mount = carPoint(car, turretMount(f.def), _vsA);
    if (target) {
      const c = this.centreOf(target, _vsB);
      f.aimYaw = Math.atan2(c.x - mount.x, c.z - mount.z);
      f.aimPitch = Math.atan2(c.y - mount.y - 0.3, Math.hypot(c.x - mount.x, c.z - mount.z));
    } else {
      f.aimYaw = car.heading;
      f.aimPitch = (car.pitch || 0) - 0.02;
    }

    f.cooldown = Math.max(-0.05, f.cooldown - dt);
    f.flaming = f.shooting = false;
    const fire = wantFire && this.phase === 'play';
    if (w === 'inferno') {
      f.flaming = f.tank.update(dt, fire);
    } else if (fire) {
      if (w === 'mg') {
        f.shooting = true;
        while (f.cooldown <= 0) { this.shootMG(f, true); f.cooldown += spec.interval; }
      } else if (w === 'rockets' || w === 'salvo' || w === 'mines') {
        // A pickup's ammo first; the car's own weapon uses its magazine.
        const own = !(f.special && f.ammo > 0);
        if (f.cooldown <= 0 && (!own || f.mag >= 1)) {
          if (w === 'mines') this.dropMine(f);
          else this.fireRockets(f, w, target);
          if (own) f.mag -= 1;
          else f.ammo--;
          f.cooldown = spec.interval;
        }
      } else if (w === 'flamer') {
        f.flaming = true;
        f.ammo = Math.max(0, f.ammo - dt);
      }
    }
    if (f.flaming) this.flameDamage(f, dt);
    if (f.special && f.ammo <= 0) f.special = null;
    // The car's own magazine refills one shot at a time.
    const own = WEAPONS[f.def.weapon];
    if (own?.mag && f.mag < own.mag) f.mag = Math.min(own.mag, f.mag + dt / own.reload);
    if (f.me && !this.sandbox) car.firing = f.flaming;
    this.visuals(f, dt);
  }

  /** Another player's car: show their shots (the damage is theirs to work out). */
  updateRemote(f, dt) {
    const p = f.car;
    f.hp = p.hp ?? f.maxHp;
    f.wrecked = !!(p.vf & 1);
    f.invuln = p.vf & 2 ? 1 : 0;
    f.buffs.armour = p.vf & 4 ? 1 : 0;
    f.buffs.double = p.vf & 8 ? 1 : 0;
    f.aimYaw = p.ay ?? p.heading;
    f.aimPitch = p.ap ?? 0;
    f.special = p.wc > 0 && p.wc < 5 ? WEAPON_CODES[p.wc] : null;
    f.ammo = f.special ? 1 : 0;
    f.cooldown -= dt;
    if (p.vf & 16 && !f.wrecked && f.remote.seen) {
      while (f.cooldown <= 0) { this.shootMG(f, false); f.cooldown += WEAPONS.mg.interval; }
    } else {
      f.cooldown = Math.max(0, f.cooldown);
    }
    this.visuals(f, dt);
  }

  /** Turret, health bar, smoke and fire when hurt, and hiding wrecks. */
  visuals(f, dt) {
    if (this.sandbox && !f.def.weapon) return; // free roam: leave unarmed cars alone
    const model = f.model;
    const shown = f.remote ? f.remote.seen : true;
    model.root.visible = shown && !f.wrecked && !(f.invuln > 0 && Math.floor(this.time * 10) % 2 === 0);
    // Turret for the current weapon: the car's own (custom cars), or one
    // for a pickup. The Inferno's flamethrower is part of its body.
    const w = this.weaponOf(f);
    const key = w === 'inferno' ? null : w;
    if (key !== f.turretKey) {
      const own = model.weaponTurret;
      if (f.turret && f.turret !== own) f.turret.root.parent?.remove(f.turret.root);
      if (own && key === own.key) f.turret = own;
      else f.turret = key ? mountTurret(model.root, f.def, key) : null;
      if (own) own.root.visible = f.turret === own;
      f.turretKey = key;
    }
    if (f.turret && f.turretKey !== 'mines') {
      f.turret.yaw.rotation.y = vsWrap(f.aimYaw - f.car.heading);
      f.turret.pitch.rotation.x = -vsClamp(f.aimPitch - (f.car.pitch || 0), -0.4, 0.5);
    }
    // Smoke below 40% health, fire below 20%.
    const frac = f.hp / f.maxHp;
    f.smokeT -= dt;
    if (!f.wrecked && shown && frac < 0.4 && f.smokeT <= 0) {
      f.smokeT = frac < 0.2 ? 0.05 : 0.12;
      const b = carBounds(f.def);
      const p = carPoint(f.car, [0, b.hi[1] * 0.8, b.hi[2] * 0.55], _vsC);
      this.fx.smoke(p, { x: f.car.velX * 0.5, z: f.car.velZ * 0.5 }, frac < 0.2);
      if (frac < 0.2) this.arsenal.flash(p, 1.1 + Math.random() * 0.6, 0xff7a20, 0.14);
    }
  }

  /** Does a rocket flying from `from` to `to` hit anything? Returns the point, or null. */
  rocketHits(r, from, to) {
    for (const f of this.fighters.values()) {
      if (f.id === r.owner || f.wrecked || (f.remote && !f.remote.seen)) continue;
      // Closest approach along this frame's path (a slow frame can be metres long).
      const c = this.centreOf(f, _vsC);
      const seg = _vsD.subVectors(to, from);
      const len2 = seg.lengthSq() || 1e-9;
      const k = vsClamp(((c.x - from.x) * seg.x + (c.y - from.y) * seg.y + (c.z - from.z) * seg.z) / len2, 0, 1);
      const hit = from.clone().addScaledVector(seg, k);
      if (hit.distanceTo(c) < Math.max(1.6, f.def.width * 0.8)) return hit;
    }
    const d = _vsD.subVectors(to, from);
    const len = d.length();
    if (len > 1e-4) {
      const hit = this.destruction.shoot(from, d.multiplyScalar(1 / len), len);
      if (hit) return from.clone().addScaledVector(d, hit.dist);
    }
    const ground = this.terrain().heightAt(to.x, to.z);
    if (to.y < ground + 0.1) return new THREE.Vector3(to.x, ground + 0.2, to.z);
    return null;
  }

  // --- Online -------------------------------------------------------------------------

  /** Extra fields for our car's network state: health, weapon, aim and flags. */
  encodeMe() {
    const f = this.fighters.get(this.myId);
    if (!f) return null;
    const flags = (f.wrecked ? 1 : 0) | (f.invuln > 0 ? 2 : 0) | (f.buffs.armour > 0 ? 4 : 0) | (f.buffs.double > 0 ? 8 : 0) | (f.shooting ? 16 : 0);
    return [Math.ceil(f.hp), WEAPON_CODES.indexOf(this.weaponOf(f)), vsRound(f.aimYaw), vsRound(f.aimPitch), flags];
  }

  /** A versus event from another player. */
  onEvent(id, e) {
    if (!this.active || (this.sandbox && e.type !== 'fx')) return;
    if (e.type === 'dmg') {
      this.hurt(this.fighters.get(this.myId), e.a, id, 'net');
    } else if (e.type === 'wreck') {
      this.recordWreck(id, e.by);
    } else if (e.type === 'take' && this.authority) {
      const p = this.pads[e.pad];
      if (p && p.item && p.item === e.item) {
        this.setPadItem(p, null);
        p.timer = VS.padEmpty;
        this.net.sendEvent({ type: 'grant', to: id, item: e.item });
      }
    } else if (e.type === 'grant') {
      const me = this.fighters.get(this.myId);
      if (me && !me.wrecked) this.giveItem(me, e.item);
    } else if (e.type === 'fx') {
      if (e.k === 'r') {
        const [x, y, z] = e.p, [vx, vy, vz] = e.v;
        const spec = WEAPONS[e.w] || WEAPONS.rockets;
        const r = {
          id: e.i, owner: id, target: e.t, kind: e.w, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(vx, vy, vz),
          speed: spec.speed, turn: spec.turn, damage: e.d, radius: spec.radius,
        };
        this.arsenal.fireRocket(r);
        this.audio.rocket(r.pos);
      } else if (e.k === 'm') {
        const [x, y, z] = e.p;
        this.arsenal.dropMine({ id: e.i, owner: id, pos: new THREE.Vector3(x, y, z), arm: WEAPONS.mines.arm, damage: e.d });
      } else if (e.k === 'b') {
        const m = this.arsenal.mines.find((x) => x.id === e.i);
        if (m) this.detonateMine(m, false);
      }
    }
  }

  /** Referee: match state for everyone. */
  snapshot(full) {
    const m = {
      vs: 1, n: this.matchNo, ph: this.phase, tl: vsRound(this.timeLeft), et: vsRound(this.endTimer),
      pads: this.pads.map((p) => (p.item ? ITEM_CODES.indexOf(p.item) : -1)),
    };
    if (full || this.scoresDirty) {
      m.sc = [...this.scores].map(([id, s]) => [id, s.k, s.d]);
      this.scoresDirty = false;
    }
    return m;
  }

  applySnapshot(m) {
    if (!m.vs) return;
    const was = this.phase;
    this.phase = m.ph;
    this.timeLeft = m.tl;
    this.endTimer = m.et;
    if (was === 'play' && m.ph === 'ended') this.emit('ended');
    m.pads.forEach((code, i) => this.setPadItem(this.pads[i], code >= 0 ? ITEM_CODES[code] : null));
    if (m.sc) {
      this.scores = new Map(m.sc.map(([id, k, d]) => [id, { k, d }]));
    }
  }

  // --- HUD ---------------------------------------------------------------------------

  setBanner(html, cls = '') {
    const key = html + '|' + cls;
    if (key === this.bannerKey) return;
    this.bannerKey = key;
    const el = this.hud.banner;
    el.innerHTML = html;
    el.className = cls;
    el.classList.toggle('show', !!html);
  }

  renderFeed() {
    this.hud.feed.innerHTML = this.feed.map((e) => `<li class="${e.mine ? 'mine' : ''}">${e.text}</li>`).join('');
  }

  /** The leaderboard: [{ id, name, k, d }] best first. */
  standings() {
    const rows = [];
    for (const f of this.fighters.values()) {
      const s = this.scores.get(f.id) || { k: 0, d: 0 };
      rows.push({ id: f.id, name: f.name, k: s.k, d: s.d, me: !!f.me, color: f.def.swatch ?? f.def.color });
    }
    rows.sort((a, b) => b.k - a.k || a.d - b.d);
    return rows;
  }

  updateHud(dt, camera) {
    const h = this.hud;
    const me = this.fighters.get(this.myId);
    if (!me) return;
    const frac = Math.max(0, me.hp / me.maxHp);
    h.hpFill.style.width = `${frac * 100}%`;
    h.hpFill.dataset.level = frac < 0.25 ? 'low' : frac < 0.5 ? 'mid' : 'ok';
    h.hpText.textContent = `${Math.ceil(Math.max(0, me.hp))} / ${me.maxHp}`;
    this.renderWeapon(me);
    const buffs = Object.entries(me.buffs).filter(([, t]) => t > 0).map(([k, t]) => `${k}:${Math.ceil(t)}`).join(',');
    if (buffs !== this.buffSig) {
      this.buffSig = buffs;
      h.buffs.innerHTML = Object.entries(me.buffs).filter(([, t]) => t > 0)
        .map(([k, t]) => `<span style="--c:#${ITEMS[k].color.toString(16).padStart(6, '0')}">${ITEMS[k].label} <b>${Math.ceil(t)}</b></span>`).join('');
    }
    const t = Math.ceil(this.timeLeft);
    h.clock.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    h.clock.classList.toggle('low', this.timeLeft <= 30 && this.phase === 'play');
    const rows = this.standings();
    const mine = this.scores.get(this.myId) || { k: 0 };
    h.kills.textContent = `${mine.k} wreck${mine.k === 1 ? '' : 's'}`;
    const sig = JSON.stringify(rows.map((r) => [r.name, r.k, r.d, r.me]));
    if (sig !== this.boardSig) {
      this.boardSig = sig;
      h.board.innerHTML = rows.map((r) => `<li class="${r.me ? 'me' : ''}"><i style="background:#${r.color.toString(16).padStart(6, '0')}"></i><span>${escapeVs(r.name)}</span><b>${r.k}</b><small>${r.d}</small></li>`).join('');
    }
    // Kill feed entries fade after a while.
    const before = this.feed.length;
    this.feed = this.feed.filter((e) => this.time - e.at < 6);
    if (this.feed.length !== before) this.renderFeed();

    // Damage vignette, and a low-health pulse.
    this.vignette = Math.max(0, this.vignette - dt * 1.6);
    const pulse = !me.wrecked && frac < 0.25 ? 0.25 + Math.sin(this.time * 6) * 0.12 : 0;
    h.vignette.style.opacity = Math.min(0.9, this.vignette * 0.8 + pulse).toFixed(3);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    h.lock.classList.toggle('hit', this.hitFlash > 0);

    // Wrecked: who did it and when we're back.
    if (me.wrecked && this.phase === 'play') {
      h.wrecked.innerHTML = `${this.wreckedBy ? `Wrecked by <b>${escapeVs(this.wreckedBy)}</b>` : 'Wrecked'}<small>Back in ${Math.max(1, Math.ceil(me.respawnIn))}</small>`;
      h.wrecked.classList.add('show');
    } else {
      h.wrecked.classList.remove('show');
    }

    if (this.phase === 'ended') {
      const win = rows[0];
      const draw = rows.length > 1 && rows[1].k === win.k && rows[1].d === win.d;
      this.setBanner(draw ? `Draw<small>${win.k} wrecks each</small>` : `${escapeVs(win.me ? 'You win' : `${win.name} wins`)}<small>${win.k} wreck${win.k === 1 ? '' : 's'}</small>`, 'goal vs');
    } else {
      this.setBanner('');
    }

    // Lock-on marker over our target, and health bars over everyone else.
    camera.updateMatrixWorld();
    _vsRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const target = me.target != null && !me.wrecked ? this.fighters.get(me.target) : null;
    if (target) {
      const p = _vsScreen.copy(this.centreOf(target, _vsA)).project(camera);
      if (p.z < 1) {
        h.lock.hidden = false;
        h.lock.style.transform = `translate(${(p.x * 0.5 + 0.5) * innerWidth}px, ${(-p.y * 0.5 + 0.5) * innerHeight}px)`;
      } else h.lock.hidden = true;
    } else {
      h.lock.hidden = true;
    }
    for (const f of this.fighters.values()) {
      const bar = f.bar;
      bar.bg.visible = bar.fill.visible = !f.me && !f.wrecked && (!f.remote || f.remote.seen)
        && Math.hypot(camera.position.x - f.car.x, camera.position.z - f.car.z) < 90;
      if (!bar.bg.visible) continue;
      const top = carBounds(f.def).hi[1] + (f.car.y || 0) + 1.75;
      const fr = Math.max(0, f.hp / f.maxHp);
      bar.bg.position.set(f.car.x, top, f.car.z).addScaledVector(_vsRight, -0.9);
      bar.fill.position.copy(bar.bg.position).addScaledVector(_vsRight, 0.04);
      bar.fill.scale.set(1.72 * fr, 0.12, 1);
      bar.fill.material.color.setHex(fr < 0.25 ? 0xff3b30 : fr < 0.5 ? 0xffb020 : 0x46d17a);
    }
  }
}

/** A floating health bar: a dark back and a coloured fill, left-anchored. */
function makeBar(scene) {
  const mk = (color, opacity, sx, sy, order) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, opacity, depthTest: false, toneMapped: false }));
    s.center.set(0, 0.5);
    s.scale.set(sx, sy, 1);
    s.renderOrder = order;
    s.visible = false;
    scene.add(s);
    return s;
  };
  return { bg: mk(0x0c0e12, 0.7, 1.8, 0.22, 11), fill: mk(0x46d17a, 1, 1.72, 0.12, 12) };
}

const labelCache = new Map();
function labelTexture(text, color) {
  const key = `${text}|${color}`;
  if (labelCache.has(key)) return labelCache.get(key);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  const w = Math.min(248, g.measureText(text).width + 32);
  g.fillStyle = 'rgba(12, 14, 18, 0.75)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 10, w, 44, 22);
  g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33, w - 20);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  labelCache.set(key, tex);
  return tex;
}

// --- Computer drivers ------------------------------------------------------------

/**
 * A Versus bot. It hunts the nearest enemy (leading a moving one), rams
 * when it's close, fires when the target's in its sights, drops mines on
 * anyone tailing it, heads for a repair when it's hurt and for a weapon
 * when it only has its gun, and backs out when it gets stuck.
 */
export class VersusBot {
  constructor(id, name, def, terrain, skill = BOT_SKILL.normal) {
    this.id = id;
    this.name = name;
    this.def = def;
    this.skill = skill;
    // driftAssist 0: the AI is tuned for the plain handling.
    this.car = new CarPhysics({ ...def.spec, assists: true, driftAssist: 0 }, terrain);
    this.car.aerial = !!def.aerial;
    this.model = new CarModel(def);
    this.stuck = 0;
    this.reversing = 0;
    this.wantFire = false;
    this.retarget = 0;
    this.goal = null;
    this.wander = null;
    this.input = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, jump: false };
  }

  /** Decide this frame's controls. */
  think(dt, vs) {
    const f = vs.fighters.get(this.id);
    const c = this.car;
    const inp = this.input;
    this.wantFire = false;
    if (!f || f.wrecked || vs.phase !== 'play') {
      Object.assign(inp, { steer: 0, throttle: 0, brake: 1, handbrake: true, boost: false });
      return;
    }
    // Pick what to go after a few times a second.
    this.retarget -= dt;
    if (this.retarget <= 0) {
      this.retarget = this.skill.think * (0.8 + Math.random() * 0.6);
      this.goal = this.chooseGoal(f, vs);
    }
    let tx, tz, charge = false;
    const g = this.goal;
    if (g?.fighter && !g.fighter.wrecked) {
      const t = g.fighter.car;
      const d = Math.hypot(t.x - c.x, t.z - c.z);
      const lead = Math.min(1.2, d / 40);
      tx = t.x + (t.velX || 0) * lead;
      tz = t.z + (t.velZ || 0) * lead;
      charge = d < 22;
    } else if (g?.pad) {
      tx = g.pad.x;
      tz = g.pad.z;
    } else {
      if (!this.wander || Math.hypot(this.wander.x - c.x, this.wander.z - c.z) < 8) {
        this.wander = { x: (Math.random() * 2 - 1) * 60, z: (Math.random() * 2 - 1) * 60 };
      }
      tx = this.wander.x;
      tz = this.wander.z;
    }
    const L = YARD.half - 6;
    tx = vsClamp(tx, -L, L);
    tz = vsClamp(tz, -L, L);

    const dx = tx - c.x, dz = tz - c.z;
    const err = vsWrap(Math.atan2(dx, dz) - c.heading);
    const speed = c.speed;

    // Unstick: pushing but not moving for a moment -> reverse out.
    if (this.reversing > 0) {
      this.reversing -= dt;
      Object.assign(inp, { throttle: 0, brake: 1, steer: -Math.sign(err) || 1, handbrake: false, boost: false });
    } else {
      if (inp.throttle > 0.5 && speed < 1.5 && !c.airborne) this.stuck += dt;
      else this.stuck = Math.max(0, this.stuck - dt * 2);
      if (this.stuck > 0.8) {
        this.stuck = 0;
        this.reversing = 0.8 + Math.random() * 0.5;
        this.retarget = 0;
      }
      inp.steer = vsClamp(err * 2.4, -1, 1);
      const sharp = Math.abs(err);
      inp.throttle = sharp > 1.4 && speed > 12 ? 0.3 : 1;
      inp.brake = sharp > 2 && speed > 16 ? 0.6 : 0;
      inp.handbrake = sharp > 1.2 && speed > 8 && speed < 26;
      inp.boost = !c.airborne && sharp < 0.2 && ((charge && this.skill.mines) || Math.hypot(dx, dz) > this.skill.boostAt) && c.boost > 0.2;
    }

    // Weapons: fire at whatever the auto-aim has.
    const w = vs.weaponOf(f);
    if (w === 'mines') {
      if (!this.skill.mines) return;
      for (const o of vs.fighters.values()) {
        if (o === f || o.wrecked) continue;
        const ox = o.car.x - c.x, oz = o.car.z - c.z;
        const d = Math.hypot(ox, oz);
        if (d < 16 && (ox * Math.sin(c.heading) + oz * Math.cos(c.heading)) / d < -0.6) { this.wantFire = true; break; }
      }
    } else if (f.target != null) {
      const t = vs.fighters.get(f.target);
      const d = t ? Math.hypot(t.car.x - c.x, t.car.z - c.z) : 999;
      const reach = (w === 'flamer' || w === 'inferno' ? 13 : w === 'mg' ? 55 : 80) * this.skill.reach;
      // Easy bots hesitate: they only fire some of the time.
      if (this.fireRoll === undefined || Math.random() < dt * 2) this.fireRoll = Math.random();
      this.wantFire = d < reach && this.fireRoll < this.skill.fireChance;
    }
  }

  chooseGoal(f, vs) {
    const c = this.car;
    const near = (want) => {
      let best = null, bd = Infinity;
      for (const p of vs.pads) {
        if (!p.item || !want(p.item)) continue;
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < bd) { bd = d; best = p; }
      }
      return best ? { pad: best, d: bd } : null;
    };
    const hurt = f.hp / f.maxHp < 0.45;
    if (hurt) {
      const r = near((it) => it === 'repair' || it === 'armour');
      if (r && r.d < 90) return { pad: r.pad };
    }
    if (!f.special) {
      const w = near((it) => ITEMS[it].weapon || it === 'double');
      if (w && w.d < 40) return { pad: w.pad };
    }
    // The nearest enemy, preferring ones that aren't protected.
    let best = null, bd = Infinity;
    for (const o of vs.fighters.values()) {
      if (o === f || o.wrecked || (o.remote && !o.remote.seen)) continue;
      const d = Math.hypot(o.car.x - c.x, o.car.z - c.z) + (o.invuln > 0 ? 40 : 0);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) return { fighter: best };
    const any = near(() => true);
    return any ? { pad: any.pad } : null;
  }

  step(dt) {
    this.car.step(dt, this.input);
  }
}
