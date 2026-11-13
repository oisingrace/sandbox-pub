import { world, system, ItemStack, BlockPermutation, EntityComponentTypes } from "@minecraft/server";
import * as S from "./store.js";
import { awakenMenu, modeMenu, lodestoneMenu } from "./forms.js";
import { isHostileTo, isGolem, principal } from "./relations.js";

const GOLEM = "golem:golem";
const lastSeen = new Map(); // golem id -> {data, loc, dim}  (cached for death handling)
const dimOf = (id) => world.getDimension(id);

// ---------- players ----------
world.afterEvents.playerSpawn.subscribe((e) => S.rememberPlayer(e.player.name));
for (const p of world.getAllPlayers()) S.rememberPlayer(p.name);

// ---------- statue block ----------
function awaken(block, data, player) {
  const dim = block.dimension;
  const loc = { x: block.x + 0.5, y: block.y, z: block.z + 0.5 };
  S.clearStatue(block);
  block.setType("minecraft:air");
  const g = dim.spawnEntity(GOLEM, loc);
  const t = g.getComponent(EntityComponentTypes.Tameable);
  t?.tame(player);
  data.dead = false;
  data.home = { x: loc.x, y: loc.y, z: loc.z, dim: dim.id };
  S.setGolem(g, data);
  applyMode(g, data.mode);
}

function hasIron(player) {
  const inv = player.getComponent("inventory").container;
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === "minecraft:iron_block") return i;
  return -1;
}

const statueComponent = {
  onPlayerInteract(ev) {
    const { block, player } = ev;
    const data = S.getStatue(block);
    if (!data) return;
    const held = player.getComponent("inventory").container.getItem(player.selectedSlotIndex);
    if (held?.typeId === "minecraft:honeycomb" && !data.waxed) {
      data.waxed = true; S.setStatue(block, data);
      block.setPermutation(block.permutation.withState("golem:waxed", true));
      held.amount > 1 ? (held.amount--) : null;
      player.sendMessage("§eStatue waxed - it will no longer decay.");
      return;
    }
    const newOwner = data.owner !== player.id;
    const needIron = data.diedOnce && (newOwner || data.dead);
    let slot = -1;
    if (needIron) {
      slot = hasIron(player);
      if (slot < 0) return player.sendMessage("§cA dead statue needs an iron block to be reawakened.");
    }
    system.run(() => awakenMenu(player, newOwner ? { ...S.newGolemData(player), diedOnce: data.diedOnce } : data, (d) => {
      if (needIron) {
        const c = player.getComponent("inventory").container;
        const it = c.getItem(slot);
        if (!it) return;
        it.amount > 1 ? (it.amount--, c.setItem(slot, it)) : c.setItem(slot, undefined);
      }
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

// Placed statue (fresh from item) belongs to the placer; first awakening is free.
world.afterEvents.playerPlaceBlock.subscribe((e) => {
  if (e.block.typeId === "golem:statue") S.setStatue(e.block, S.newGolemData(e.player));
});

// Break: no drop unless silk touch.
world.afterEvents.playerBreakBlock.subscribe((e) => {
  if (e.brokenBlockPermutation.type.id !== "golem:statue") return;
  S.clearStatue(e.block);
  const tool = e.itemStackBeforeBreak;
  const silk = tool?.getComponent("enchantable")?.hasEnchantment("silk_touch");
  if (silk) e.dimension.spawnItem(new ItemStack("golem:statue_item", 1), e.block.center());
});

// ---------- modes ----------
const EVENTS = { passive: "passive", follow: "follow", guard: "guard", attack: "attack", sentry: "sentry", assassin: "attack" };
function applyMode(g, mode) {
  g.triggerEvent(`golem:set_${EVENTS[mode]}`);
  const d = S.getGolem(g); if (!d) return;
  d.mode = mode;
  if (mode === "sentry") d.home = { x: g.location.x, y: g.location.y, z: g.location.z, dim: g.dimension.id };
  S.setGolem(g, d);
}

function golemsNear(player, radius) {
  return player.dimension.getEntities({ type: GOLEM, location: player.location, maxDistance: radius })
    .filter((g) => S.getGolem(g)?.owner === player.id);
}
function commandGolems(player, mode) {
  const gs = golemsNear(player, S.COMMAND_RADIUS);
  gs.forEach((g) => applyMode(g, mode));
  player.sendMessage(`§a${gs.length} golem(s) set to ${mode}.`);
}

// ---------- lodestone: program golems & statues in radius ----------
world.afterEvents.playerInteractWithBlock.subscribe((e) => {
  if (e.block.typeId !== "minecraft:lodestone") return;
  const p = e.player;
  system.run(() => lodestoneMenu(p, () => {
    const gs = golemsNear(p, S.COMMAND_RADIUS);
    const base = S.newGolemData(p);
    awakenMenu(p, base, (d) => {
      gs.forEach((g) => { const o = S.getGolem(g); S.setGolem(g, { ...o, hostile: d.hostile, friendly: d.friendly }); });
      p.sendMessage(`§aProgrammed ${gs.length} golem(s).`);
      // TODO: dead statues in range need an iron block each (diedOnce) to reprogram.
    });
  }));
});

// ---------- AI tick ----------
system.runInterval(() => {
  const hot = new Set();
  for (const dimId of ["overworld", "nether", "the_end"]) {
    const dim = dimOf(dimId);
    const gs = dim.getEntities({ type: GOLEM });
    for (const g of gs) {
      const d = S.getGolem(g); if (!d) continue;
      lastSeen.set(g.id, { d, loc: g.location, dim: dimId });
      const fights = ["guard", "attack", "sentry", "assassin"].includes(d.mode);
      if (!fights) continue;
      const owner = world.getAllPlayers().find((p) => p.id === d.owner);
      const range = d.mode === "sentry" ? S.SENTRY_RADIUS : 40;
      const near = dim.getEntities({ location: g.location, maxDistance: range, excludeTypes: [] });
      let golemTargets = [], others = [];
      for (const t of near) {
        if (t.id === g.id || !isHostileTo(d, t)) continue;
        (isGolem(t) ? golemTargets : others).push(t);
      }
      if (d.mode === "assassin") golemTargets = []; // goes straight for enemies
      const list = golemTargets.length ? golemTargets : others; // golems fight each other first
      list.forEach((t) => hot.add(t.id));
      // Sentry/attack movement helper
      if (!list.length && d.mode === "sentry" && d.home) {
        const dx = d.home.x - g.location.x, dz = d.home.z - g.location.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 3) g.applyKnockback({ x: dx / dist, z: dz / dist }, 0.4, 0); // crude; see README TODO
      }
      if (d.mode === "follow" && owner && owner.dimension.id === g.dimension.id &&
          Math.hypot(owner.location.x - g.location.x, owner.location.z - g.location.z) > 24) {
        g.teleport(owner.location); // dog-style catch-up
      }
    }
  }
  // sync golem_target tag
  for (const dimId of ["overworld", "nether", "the_end"]) {
    for (const e of dimOf(dimId).getEntities({ tags: ["golem_target"] })) if (!hot.has(e.id)) e.removeTag("golem_target");
  }
  for (const dimId of ["overworld", "nether", "the_end"]) {
    for (const e of dimOf(dimId).getEntities({})) if (hot.has(e.id)) e.addTag("golem_target");
  }
}, 10);

// ---------- death -> dead statue ----------
world.afterEvents.entityDie.subscribe((ev) => {
  const e = ev.deadEntity;
  if (e.typeId !== GOLEM) return;
  const cached = lastSeen.get(e.id); if (!cached) return;
  lastSeen.delete(e.id);
  const dim = dimOf(cached.dim);
  const pos = { x: Math.floor(cached.loc.x), y: Math.floor(cached.loc.y), z: Math.floor(cached.loc.z) };
  system.run(() => {
    const b = dim.getBlock(pos); if (!b) return;
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
