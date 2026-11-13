// Persistent data: world dynamic properties.
// Golem/statue data shape: { owner, ownerName, hostile:[names], friendly:[names|"team:X"],
//   mode, home:{x,y,z,dim}, diedOnce, dead, waxed, diedAt }
import { world } from "@minecraft/server";

const read = (k, d) => { try { const v = world.getDynamicProperty(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const write = (k, v) => world.setDynamicProperty(k, JSON.stringify(v));

export const MODES = ["passive", "follow", "guard", "attack", "sentry", "assassin"];
export const SENTRY_RADIUS = 100;
export const COMMAND_RADIUS = 32;
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

// Statue data is sharded over a few world properties (a property holds ~32k chars,
// and long per-statue property names are risky), keyed "<dim>:<x>,<y>,<z>".
const SHARDS = 8;
const shortDim = (d) => d.replace("minecraft:", "");
const keyOf = (b) => `${shortDim(b.dimension.id)}:${b.x},${b.y},${b.z}`;
const shardOf = (b) => `st${(((b.x >> 4) * 31 + (b.z >> 4)) % SHARDS + SHARDS) % SHARDS}`;
export const getStatue = (b) => read(shardOf(b), {})[keyOf(b)] ?? null;
export function setStatue(b, d) { const m = read(shardOf(b), {}); m[keyOf(b)] = d; write(shardOf(b), m); }
export function clearStatue(b) { const m = read(shardOf(b), {}); if (delete m[keyOf(b)]) write(shardOf(b), m); }
// [{dim, x, y, z, data}] for every stored statue
export function allStatues() {
  const out = [];
  for (let i = 0; i < SHARDS; i++) {
    for (const [k, data] of Object.entries(read(`st${i}`, {}))) {
      const [dim, xyz] = k.split(":"); const [x, y, z] = xyz.split(",").map(Number);
      out.push({ dim, x, y, z, data });
    }
  }
  return out;
}
export function dropStatueRecord({ dim, x, y, z }) {
  const b = { dimension: { id: dim }, x, y, z };
  clearStatue(b);
}

export const getGolem = (e) => { try { const v = e.getDynamicProperty("g"); return v ? JSON.parse(v) : null; } catch { return null; } };
export const setGolem = (e, d) => e.setDynamicProperty("g", JSON.stringify(d));
