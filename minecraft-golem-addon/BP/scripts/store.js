// Persistent data: world dynamic properties (known players, teams) and entity dynamic properties (golems and statues).
// Golem/statue data shape: { owner, ownerName, hostile:[names], friendly:[names|"team:X"],
//   mode, home:{x,y,z,dim}, diedOnce, dead, waxed, diedAt }
import { world } from "@minecraft/server";

const read = (k, d) => { try { const v = world.getDynamicProperty(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const write = (k, v) => world.setDynamicProperty(k, JSON.stringify(v));

export const MODES = ["passive", "follow", "guard", "attack", "sentry", "assassin"];
export const SENTRY_RADIUS = 100;
export const COMMAND_RADIUS = 32;   // default commander range and lodestone range
export const SUMMON_COST = 2;       // iron INGOTS per golem summoned with the commander
export const DECAY_MS = 3600000; // 1 hour (wall clock, survives reloads)

export const knownPlayers = () => read("known", []);
export function rememberPlayer(name) {
  const k = knownPlayers();
  if (!k.includes(name)) { k.push(name); write("known", k); }
}

// teams: { teamName: [playerNames] }
export const teams = () => read("teams", {});
export const saveTeams = (t) => write("teams", t);

export const newGolemData = (player) => ({
  owner: player.id, ownerName: player.name, hostile: [], friendly: [],
  mode: "passive", home: null, programmed: false, dead: false, waxed: false, diedAt: 0,
});

export const getGolem = (e) => { try { const v = e.getDynamicProperty("g"); return v ? JSON.parse(v) : null; } catch { return null; } };
export const setGolem = (e, d) => e.setDynamicProperty("g", JSON.stringify(d));
