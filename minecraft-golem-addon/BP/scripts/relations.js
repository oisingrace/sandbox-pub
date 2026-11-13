// Who is hostile/friendly to whom. Golems are extensions of their owner.
import { teams } from "./store.js";
import { getGolem } from "./store.js";

const inList = (list, name) => {
  if (list.includes(name)) return true;
  const t = teams();
  return list.some((x) => x.startsWith("team:") && (t[x.slice(5)] ?? []).includes(name));
};

// Resolve an entity to the player name it represents (player itself, or golem's owner).
export function principal(entity) {
  if (entity.typeId === "minecraft:player") return entity.name;
  if (entity.typeId === "golem:golem") return getGolem(entity)?.ownerName ?? null;
  return null;
}

export function isHostileTo(data, entity) {
  const who = principal(entity);
  if (!who || who === data.ownerName) return false;
  if (inList(data.friendly, who)) return false;
  return inList(data.hostile, who);
}
export const isGolem = (e) => e.typeId === "golem:golem";
