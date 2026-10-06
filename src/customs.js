import { VEHICLES } from './vehicles.js';
import { compileCar, cleanDesign } from './carkit.js';
import { GOD_DESIGN, isUnlocked } from './unlocks.js';

// The vehicle registry: the built-in fleet plus custom cars. Your own
// designs are saved in this browser; other players' designs (received
// online) are compiled too but only kept for the session.

const CUSTOMS_KEY = 'smash-lot-custom-cars-v1';
export const MAX_CUSTOM = 14;

/** Where custom car number `i` parks in free roam: rows behind the start line. */
function customHome(i) {
  return { x: -21 + (i % 7) * 7, z: -64 - Math.floor(i / 7) * 8, heading: 0 };
}

export class Garage {
  constructor() {
    this.designs = [];
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOMS_KEY) || '[]');
      if (Array.isArray(saved)) this.designs = saved.slice(0, MAX_CUSTOM + 1).map((d) => this.allowed(d));
    } catch {
      this.designs = [];
    }
    this.custom = this.designs.map((d, i) => compileCar(d, customHome(i)));
    this.remote = new Map(); // id -> compiled def, other players' designs
  }

  /** A design as this browser may keep it: god mode only once the god car is unlocked. */
  allowed(raw) {
    return cleanDesign(raw?.god && !isUnlocked('god') ? { ...raw, god: false } : raw);
  }

  /** Just unlocked: put the god car in the garage (it doesn't count toward the limit). Returns its vehicle. */
  addGod() {
    const have = this.custom.find((v) => v.id === GOD_DESIGN.id);
    if (have) return have;
    this.designs.push(cleanDesign(GOD_DESIGN));
    this.custom.push(compileCar(this.designs.at(-1), customHome(this.designs.length - 1)));
    this.persist();
    return this.custom.at(-1);
  }

  /** Everything you can drive: built-ins first, then your custom cars. */
  get all() {
    return [...VEHICLES, ...this.custom];
  }

  find(id) {
    return this.all.find((v) => v.id === id) || this.remote.get(id) || null;
  }

  persist() {
    try {
      localStorage.setItem(CUSTOMS_KEY, JSON.stringify(this.designs));
    } catch {
      // Storage blocked (private mode): designs last for this visit only.
    }
  }

  /** Add or update a design. Returns its compiled vehicle. */
  save(raw) {
    const design = this.allowed(raw);
    const i = this.designs.findIndex((d) => d.id === design.id);
    if (i >= 0) {
      this.designs[i] = design;
      this.custom[i] = compileCar(design, customHome(i));
    } else {
      if (this.designs.filter((d) => d.id !== GOD_DESIGN.id).length >= MAX_CUSTOM) throw new Error(`You can keep up to ${MAX_CUSTOM} custom cars. Delete one first.`);
      this.designs.push(design);
      this.custom.push(compileCar(design, customHome(this.designs.length - 1)));
    }
    this.persist();
    return this.custom[this.designs.findIndex((d) => d.id === design.id)];
  }

  remove(id) {
    const i = this.designs.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.designs.splice(i, 1);
    // Parking spots follow the list order, so recompile the rest.
    this.custom = this.designs.map((d, j) => compileCar(d, customHome(j)));
    this.persist();
  }

  /** Another player's design (from the network): compile it for this session. */
  addRemote(raw) {
    if (!raw) return null;
    const design = cleanDesign(raw);
    const local = this.custom.find((v) => v.id === design.id);
    if (local && JSON.stringify(local.design) === JSON.stringify(design)) return local;
    const def = compileCar(design, customHome(0));
    this.remote.set(design.id, def);
    return def;
  }
}
