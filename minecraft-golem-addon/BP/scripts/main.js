import { world, system, ItemStack, BlockPermutation, EntityComponentTypes } from "@minecraft/server";
import * as S from "./store.js";
import { awakenMenu, modeMenu, lodestoneMenu } from "./forms.js";
import { isHostileTo, isGolem } from "./relations.js";

const GOLEM = "golem:golem";
const DIMS = ["overworld", "nether", "the_end"];
const pendingAwake = new Set();   // ids of golems we spawned on purpose (not turned into statues)
const lastSeen = new Map();       // golem id -> {d, loc, dim}, cached for death handling
const engaged = new Map();        // golem id -> {tid, tick}
const returning = new Map();      // golem id -> stuck counter (sentries walking home)
const dimOf = (id) => world.getDimension(id);
const fighting = (m) => ["guard", "attack", "sentry", "assassin"].includes(m);

// ---------- players ----------
world.afterEvents.playerSpawn.subscribe((e) => S.rememberPlayer(e.player.name));
for (const p of world.getAllPlayers()) S.rememberPlayer(p.name);

// ---------- inventory helpers ----------
function findIron(player) {
  const c = player.getComponent("inventory").container;
  for (let i = 0; i < c.size; i++) if (c.getItem(i)?.typeId === "minecraft:iron_block") return i;
  return -1;
}
function takeOne(player, slot) {
  const c = player.getComponent("inventory").container;
  const it = c.getItem(slot); if (!it) return;
  if (it.amount > 1) { it.amount--; c.setItem(slot, it); } else c.setItem(slot, undefined);
}

// ---------- statue -> golem ----------
function awaken(block, data, player) {
  const dim = block.dimension;
  const loc = { x: block.x + 0.5, y: block.y, z: block.z + 0.5 };
  S.clearStatue(block);
  block.setType("minecraft:air");
  const g = dim.spawnEntity(GOLEM, loc);
  pendingAwake.add(g.id);
  data.dead = false;
  data.home = { x: loc.x, y: loc.y, z: loc.z, dim: dim.id };
  S.setGolem(g, data);
  setOwner(g, player);
  applyMode(g, data.mode);
}
function setOwner(g, player) {
  try { g.getComponent(EntityComponentTypes.Tameable)?.tame(player); } catch { /* owner already set */ }
}

const statueComponent = {
  onPlayerInteract({ block, player }) {
    const data = S.getStatue(block);
    if (!data) return;
    const inv = player.getComponent("inventory").container;
    const held = inv.getItem(player.selectedSlotIndex);
    if (held?.typeId === "minecraft:honeycomb" && !data.waxed) {
      data.waxed = true; S.setStatue(block, data);
      block.setPermutation(block.permutation.withState("golem:waxed", true));
      if (held.amount > 1) { held.amount--; inv.setItem(player.selectedSlotIndex, held); }
      else inv.setItem(player.selectedSlotIndex, undefined);
      player.sendMessage("§eStatue waxed - it will no longer decay.");
      return;
    }
    const unclaimed = !data.owner;
    const newOwner = data.owner !== player.id;
    // Free the very first time (never died); a dead statue, or a takeover of a used one, costs iron.
    const needIron = data.diedOnce && (newOwner || data.dead);
    if (needIron && findIron(player) < 0)
      return player.sendMessage("§cA statue that has died needs an iron block to be reawakened.");
    const base = unclaimed ? { ...S.newGolemData(player), diedOnce: data.diedOnce }
      : newOwner ? { ...S.newGolemData(player), diedOnce: data.diedOnce } : data;
    system.run(() => awakenMenu(player, base, (d) => {
      if (needIron) {
        const slot = findIron(player);
        if (slot < 0) return player.sendMessage("§cYou need an iron block.");
        takeOne(player, slot);
      }
      d.owner = player.id; d.ownerName = player.name;
      awaken(block, d, player);
    }));
  },
};

system.beforeEvents.startup.subscribe((ev) => {
  ev.blockComponentRegistry.registerCustomComponent("golem:statue", statueComponent);
  ev.itemComponentRegistry.registerCustomComponent("golem:commander", {
    onUse(e) { system.run(() => modeMenu(e.source, (m) => commandGolems(e.source, m))); },
  });
});

world.afterEvents.playerPlaceBlock.subscribe((e) => {
  if (e.block.typeId === "golem:statue") S.setStatue(e.block, S.newGolemData(e.player));
});

world.afterEvents.playerBreakBlock.subscribe((e) => {
  if (e.brokenBlockPermutation.type.id !== "golem:statue") return;
  S.clearStatue(e.block);
  const silk = e.itemStackBeforeBreak?.getComponent("enchantable")?.hasEnchantment("silk_touch");
  if (silk) e.dimension.spawnItem(new ItemStack("golem:statue_item", 1), e.block.center());
});

// ---------- modes ----------
function applyMode(g, mode) {
  g.triggerEvent(`golem:set_${mode}`);
  const d = S.getGolem(g); if (!d) return;
  d.mode = mode;
  if (mode === "sentry") d.home = { x: g.location.x, y: g.location.y, z: g.location.z, dim: g.dimension.id };
  S.setGolem(g, d);
  engaged.delete(g.id); returning.delete(g.id);
}
function golemsNear(player, radius) {
  return player.dimension.getEntities({ type: GOLEM, location: player.location, maxDistance: radius })
    .filter((g) => S.getGolem(g)?.owner === player.id);
}
function commandGolems(player, mode) {
  const gs = golemsNear(player, S.COMMAND_RADIUS);
  gs.forEach((g) => { setOwner(g, player); applyMode(g, mode); });
  player.sendMessage(`§a${gs.length} golem(s) set to ${mode}.`);
}

// ---------- lodestone: program awakened golems in range (never statues), make teams ----------
world.afterEvents.playerInteractWithBlock.subscribe((e) => {
  if (e.block.typeId !== "minecraft:lodestone") return;
  const p = e.player;
  system.run(() => lodestoneMenu(p, () => {
    awakenMenu(p, S.newGolemData(p), (d) => {
      const gs = golemsNear(p, S.COMMAND_RADIUS);
      gs.forEach((g) => { const o = S.getGolem(g); S.setGolem(g, { ...o, hostile: d.hostile, friendly: d.friendly }); });
      p.sendMessage(`§aProgrammed ${gs.length} awakened golem(s). Statues can only be programmed when reawakened.`);
    });
  }));
});

// ---------- AI ----------
// Per-golem targeting: the script picks this golem's target, tags it for a few ticks,
// and "hits" the golem as that target. The golem's hurt_by_target behavior (which only
// accepts tagged attackers) then locks onto exactly that entity.
function engage(g, t) {
  const prev = engaged.get(g.id), now = system.currentTick;
  const hasTarget = g.target?.id === t.id; // g.target may be undefined on older runtimes
  if (hasTarget || (prev && prev.tid === t.id && now - prev.tick < 60)) return;
  engaged.set(g.id, { tid: t.id, tick: now });
  t.addTag("golem_target");
  g.applyDamage(1, { cause: "entityAttack", damagingEntity: t });
  const h = g.getComponent("health"); h?.setCurrentValue(Math.min(h.currentValue + 1, h.effectiveMax));
  system.runTimeout(() => { try { t.removeTag("golem_target"); } catch { /* gone */ } }, 6);
}

function surfaceY(dim, x, y, z) { // nearest standable Y within a few blocks of y
  for (let dy = 2; dy >= -4; dy--) {
    const b = dim.getBlock({ x: Math.floor(x), y: Math.floor(y) + dy, z: Math.floor(z) });
    const up = b?.above();
    if (b && !b.isAir && !b.isLiquid && up?.isAir && up.above()?.isAir) return b.y + 1;
  }
  return null;
}

// Sentries walk home in short steps (stand-in for scripted pathfinding, which
// Bedrock doesn't expose); teleport home if stuck for ~3 s.
system.runInterval(() => {
  for (const [id, stuck] of [...returning]) {
    const g = world.getEntity?.(id);
    const d = g?.isValid ? S.getGolem(g) : null;
    if (!d?.home || d.mode !== "sentry") { returning.delete(id); continue; }
    const dim = g.dimension, dx = d.home.x - g.location.x, dz = d.home.z - g.location.z, dist = Math.hypot(dx, dz);
    if (dist < 2) { returning.delete(id); continue; }
    if (g.target) continue; // fighting again
    const step = Math.min(0.5, dist);
    const nx = g.location.x + (dx / dist) * step, nz = g.location.z + (dz / dist) * step;
    const y = surfaceY(dim, nx, g.location.y, nz);
    if (y === null || Math.abs(y - g.location.y) > 1.2) {
      if (stuck >= 8) { g.teleport({ x: d.home.x, y: d.home.y, z: d.home.z }, { dimension: dimOf(d.home.dim.replace("minecraft:", "")) }); returning.delete(id); }
      else returning.set(id, stuck + 1);
      continue;
    }
    g.teleport({ x: nx, y, z: nz }, { facingLocation: { x: d.home.x, y, z: d.home.z } });
    returning.set(id, 0);
  }
}, 2);

system.runInterval(() => {
  for (const dimId of DIMS) {
    const dim = dimOf(dimId);
    for (const g of dim.getEntities({ type: GOLEM })) {
      const d = S.getGolem(g); if (!d) continue;
      lastSeen.set(g.id, { d, loc: g.location, dim: dimId });
      const owner = world.getAllPlayers().find((p) => p.id === d.owner);

      if (d.mode === "follow" || d.mode === "guard") { // dog-style catch up
        if (owner && owner.dimension.id === g.dimension.id &&
            Math.hypot(owner.location.x - g.location.x, owner.location.z - g.location.z) > 24) g.teleport(owner.location);
        else if (!owner || owner.dimension.id !== g.dimension.id) { /* owner away: stay */ }
      }
      if (!fighting(d.mode)) continue;

      const sentry = d.mode === "sentry" && d.home;
      const center = sentry ? { x: d.home.x, y: d.home.y, z: d.home.z } : g.location;
      const range = sentry ? S.SENTRY_RADIUS : d.mode === "attack" || d.mode === "assassin" ? 64 : 24;
      const foes = dim.getEntities({ location: center, maxDistance: range })
        .filter((t) => t.id !== g.id && isHostileTo(d, t));
      const golems = d.mode === "assassin" ? [] : foes.filter(isGolem); // golems fight each other first
      const pool = golems.length ? golems : foes;
      pool.sort((a, b) => dist2(a, g) - dist2(b, g));

      if (pool.length) { returning.delete(g.id); engage(g, pool[0]); }
      else if (sentry && Math.hypot(d.home.x - g.location.x, d.home.z - g.location.z) > 3 && !returning.has(g.id)) {
        returning.set(g.id, 0);
      }
    }
  }
}, 10);
const dist2 = (a, b) => (a.location.x - b.location.x) ** 2 + (a.location.y - b.location.y) ** 2 + (a.location.z - b.location.z) ** 2;

// ---------- death -> dead statue ----------
world.afterEvents.entityDie.subscribe((ev) => {
  const e = ev.deadEntity;
  if (e.typeId !== GOLEM) return;
  const cached = lastSeen.get(e.id); if (!cached) return;
  lastSeen.delete(e.id); engaged.delete(e.id); returning.delete(e.id);
  const dim = dimOf(cached.dim);
  const pos = { x: Math.floor(cached.loc.x), y: Math.floor(cached.loc.y), z: Math.floor(cached.loc.z) };
  system.run(() => {
    let b = dim.getBlock(pos);
    if (b && !b.isAir && !b.isLiquid) b = b.above();
    if (!b) return;
    b.setPermutation(BlockPermutation.resolve("golem:statue", { "golem:dead": true, "golem:waxed": false }));
    S.setStatue(b, { ...cached.d, dead: true, diedOnce: true, waxed: false, diedAt: Date.now() });
  });
});

// ---------- decay of unwaxed dead statues ----------
system.runInterval(() => {
  for (const k of S.allStatueKeys()) {
    const d = JSON.parse(world.getDynamicProperty(k));
    if (!d.dead || d.waxed || Date.now() - d.diedAt < S.DECAY_MS) continue;
    const [, dimId, xyz] = k.split("|");
    const [x, y, z] = xyz.split(",").map(Number);
    const b = dimOf(dimId.replace("minecraft:", "")).getBlock({ x, y, z });
    if (b?.typeId === "golem:statue") b.setType("minecraft:air");
    world.setDynamicProperty(k, undefined);
  }
}, 200);

// ---------- freshly spawned golems (egg / summon / spawner) become statues ----------
const CARD = ["south", "west", "north", "east"];
world.afterEvents.entitySpawn.subscribe((ev) => {
  const g = ev.entity;
  if (!g.isValid || g.typeId !== GOLEM || ev.cause === "Loaded") return;
  if (pendingAwake.delete(g.id) || S.getGolem(g)) return;
  const dim = g.dimension;
  const p = dim.getPlayers({ location: g.location, closest: 1, maxDistance: 16 })[0];
  const data = S.newGolemData(p ?? { id: "", name: "" });
  let b = dim.getBlock(g.location);
  if (b && !b.isAir && !b.isLiquid) b = b.above();
  if (!b) return;
  const yaw = ((g.getRotation().y % 360) + 360) % 360;
  g.remove();
  b.setPermutation(BlockPermutation.resolve("golem:statue",
    { "golem:dead": false, "golem:waxed": false, "minecraft:cardinal_direction": CARD[Math.round(yaw / 90) % 4] }));
  S.setStatue(b, data);
});
