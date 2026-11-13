import { world, system, ItemStack, BlockPermutation, EntityComponentTypes } from "@minecraft/server";
import * as S from "./store.js";
import { awakenMenu, modeMenu, lodestoneMenu } from "./forms.js";
import { isHostileTo, isFriendlyTo, isGolem } from "./relations.js";

const GOLEM = "golem:golem";
const DIMS = ["overworld", "nether", "the_end"];
const pendingAwake = new Set();   // ids of golems we spawned on purpose (not turned into statues)
const lastSeen = new Map();       // golem id -> {d, loc, dim}, cached for death handling
const engaged = new Map();        // golem id -> {tid, tick}
const returning = new Map();      // golem id -> {g, stuck} (sentries walking home)
const dimOf = (id) => world.getDimension(id);
const fighting = (m) => ["guard", "attack", "sentry", "assassin"].includes(m);

// ---------- players ----------
world.afterEvents.playerSpawn.subscribe((e) => S.rememberPlayer(e.player.name));
system.run(() => { for (const p of world.getAllPlayers()) S.rememberPlayer(p.name); }); // not allowed during early execution

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
    const data = S.getStatue(block) ?? S.newGolemData({ id: "", name: "" }); // e.g. /setblock'd statue
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
    const newOwner = data.owner !== player.id;
    // The first programming is free; every later one (i.e. after the golem has died) costs an iron block.
    const needIron = data.programmed;
    if (needIron && findIron(player) < 0)
      return player.sendMessage("§cThis statue has been programmed before - reawakening it needs an iron block.");
    const base = newOwner ? { ...S.newGolemData(player), programmed: data.programmed } : data;
    system.run(() => awakenMenu(player, base, (d) => {
      if (needIron) {
        const slot = findIron(player);
        if (slot < 0) return player.sendMessage("§cYou need an iron block.");
        takeOne(player, slot);
      }
      d.owner = player.id; d.ownerName = player.name; d.programmed = true;
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

// A silk-touched statue item carries its data (so breaking+placing can't skip the iron block rule).
const carried = new Map(); // player id -> data JSON from the item being placed
world.beforeEvents.playerPlaceBlock.subscribe((e) => {
  const j = e.itemStack?.typeId === "golem:statue_item" ? e.itemStack.getDynamicProperty("d") : undefined;
  if (j) carried.set(e.player.id, j); else carried.delete(e.player.id);
});
world.afterEvents.playerPlaceBlock.subscribe((e) => {
  if (e.block.typeId !== "golem:statue") return;
  const j = carried.get(e.player.id); carried.delete(e.player.id);
  let data = null; try { data = j ? JSON.parse(j) : null; } catch { /* ignore */ }
  if (!data) return S.setStatue(e.block, S.newGolemData(e.player));
  S.setStatue(e.block, data);
  let p = e.block.permutation;
  if (data.dead) p = p.withState("golem:dead", true);
  if (data.waxed) p = p.withState("golem:waxed", true);
  e.block.setPermutation(p);
});

world.afterEvents.playerBreakBlock.subscribe((e) => {
  if (e.brokenBlockPermutation.type.id !== "golem:statue") return;
  const data = S.getStatue(e.block);
  S.clearStatue(e.block);
  const silk = e.itemStackBeforeBreak?.getComponent("enchantable")?.hasEnchantment("silk_touch");
  if (!silk) return;
  const item = new ItemStack("golem:statue_item", 1);
  if (data) item.setDynamicProperty("d", JSON.stringify(data));
  e.dimension.spawnItem(item, e.block.center());
});

// ---------- modes ----------
function applyMode(g, mode) {
  g.triggerEvent(`golem:set_${mode}`);
  const d = S.getGolem(g); if (!d) return;
  d.mode = mode;
  if (mode === "sentry") d.home = { x: g.location.x, y: g.location.y, z: g.location.z, dim: g.dimension.id };
  S.setGolem(g, d);
  engaged.delete(g.id); returning.delete(g.id);
  lastSeen.set(g.id, { d, loc: g.location, dim: g.dimension.id.replace("minecraft:", "") });
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
function statuesNear(player, radius) {
  const out = [];
  for (const r of S.allStatues()) {
    if (r.dim !== player.dimension.id.replace("minecraft:", "")) continue;
    if (Math.hypot(r.x - player.location.x, r.y - player.location.y, r.z - player.location.z) > radius) continue;
    if (r.data.owner && r.data.owner !== player.id && r.data.programmed) continue; // others' used statues are off limits; never-programmed ones are fair game
    const b = player.dimension.getBlock({ x: r.x, y: r.y, z: r.z });
    if (b?.typeId === "golem:statue") out.push(b);
  }
  return out;
}

// Living golems can't be edited; only statues are programmed, and a golem stays as programmed until it
// dies. The lodestone is the exception: it re-programs living golems and reawakens statues in range,
// Living golems are free; dead statues cost 1 iron block each (free if never programmed).
// Teams edited at the lodestone take effect immediately: lists reference teams by name.
world.afterEvents.playerInteractWithBlock.subscribe((e) => {
  if (e.block.typeId !== "minecraft:lodestone" || e.itemStack) return; // empty hand only, so building next to it still works
  const p = e.player;
  system.run(() => lodestoneMenu(p, () => {
    awakenMenu(p, S.newGolemData(p), (d) => {
      let live = 0, woken = 0, skipped = 0;
      const pay = (programmed) => {
        if (!programmed) return true;
        const slot = findIron(p);
        if (slot < 0) return false;
        takeOne(p, slot); return true;
      };
      for (const g of golemsNear(p, S.COMMAND_RADIUS)) {
        const o = S.getGolem(g); // living golems are reprogrammed for free
        S.setGolem(g, { ...o, hostile: d.hostile, friendly: d.friendly, programmed: true }); live++;
      }
      for (const b of statuesNear(p, S.COMMAND_RADIUS)) {
        const sd = S.getStatue(b); if (!sd) continue;
        if (!pay(sd.programmed)) { skipped++; continue; }
        awaken(b, { ...sd, owner: p.id, ownerName: p.name, hostile: d.hostile, friendly: d.friendly, programmed: true }, p);
        woken++;
      }
      p.sendMessage(`§aReprogrammed ${live} living golem(s) and reawakened ${woken} statue(s).` +
        (skipped ? ` §c${skipped} skipped - out of iron blocks.` : ""));
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
    const up = b?.above(), up2 = up?.above();
    const free = (k) => k && !k.isSolid && !k.isLiquid;
    if (b?.isSolid && free(up) && free(up2)) return b.y + 1;
  }
  return null;
}

// Sentries walk home in short steps (stand-in for scripted pathfinding, which
// Bedrock doesn't expose); teleport home if stuck for ~3 s.
system.runInterval(() => {
  for (const [id, st] of [...returning]) {
    const g = st.g, d = g.isValid ? S.getGolem(g) : null;
    if (!d?.home || d.mode !== "sentry") { returning.delete(id); continue; }
    const dim = g.dimension, dx = d.home.x - g.location.x, dz = d.home.z - g.location.z, dist = Math.hypot(dx, dz);
    if (dist < 2) { returning.delete(id); continue; }
    const step = Math.min(0.5, dist);
    const nx = g.location.x + (dx / dist) * step, nz = g.location.z + (dz / dist) * step;
    const y = surfaceY(dim, nx, g.location.y, nz);
    if (y === null || Math.abs(y - g.location.y) > 1.2) {
      if (st.stuck >= 40) { g.teleport({ x: d.home.x, y: d.home.y, z: d.home.z }, { dimension: dimOf(d.home.dim.replace("minecraft:", "")) }); returning.delete(id); }
      else st.stuck++;
      continue;
    }
    g.teleport({ x: nx, y, z: nz }, { facingLocation: { x: d.home.x, y, z: d.home.z } });
    st.stuck = 0;
  }
}, 2);

system.runInterval(() => {
  const players = world.getAllPlayers();
  for (const dimId of DIMS) {
    const dim = dimOf(dimId);
    for (const g of dim.getEntities({ type: GOLEM })) {
      const d = S.getGolem(g); if (!d) continue;
      lastSeen.set(g.id, { d, loc: g.location, dim: dimId });
      const owner = players.find((p) => p.id === d.owner);

      if ((d.mode === "follow" || d.mode === "guard") && owner && owner.dimension.id === g.dimension.id &&
          Math.hypot(owner.location.x - g.location.x, owner.location.z - g.location.z) > 24) {
        g.teleport({ x: owner.location.x + 1.5, y: owner.location.y, z: owner.location.z }); // dog-style catch up
      }
      if (!fighting(d.mode)) continue;

      const sentry = d.mode === "sentry" && d.home;
      const center = sentry ? { x: d.home.x, y: d.home.y, z: d.home.z } : g.location;
      const range = sentry ? S.SENTRY_RADIUS : d.mode === "attack" || d.mode === "assassin" ? 64 : 24;
      // only players and golems can ever be foes, so don't scan every entity
      const cand = [...dim.getPlayers({ location: center, maxDistance: range }),
        ...dim.getEntities({ type: GOLEM, location: center, maxDistance: range })];
      const foes = cand.filter((t) => t.id !== g.id && isHostileTo(d, t) &&
        !(t.typeId === "minecraft:player" && t.getGameMode() === "Spectator"));
      const golems = d.mode === "assassin" ? [] : foes.filter(isGolem); // golems fight each other first
      const pool = golems.length ? golems : foes;
      pool.sort((a, b) => dist2(a, g) - dist2(b, g));

      if (pool.length) { returning.delete(g.id); engage(g, pool[0]); }
      else if (sentry && Math.hypot(d.home.x - g.location.x, d.home.z - g.location.z) > 3 && !returning.has(g.id)) {
        returning.set(g.id, { g, stuck: 0 });
      }
    }
  }
}, 10);
const dist2 = (a, b) => (a.location.x - b.location.x) ** 2 + (a.location.y - b.location.y) ** 2 + (a.location.z - b.location.z) ** 2;

// ---------- guard: defend the owner against anything that hurts them ----------
// Friendly-list members (teammates), the owner's own golems and the owner are exempt.
world.afterEvents.entityHurt.subscribe((ev) => {
  const victim = ev.hurtEntity;
  if (victim.typeId !== "minecraft:player") return;
  const attacker = ev.damageSource?.damagingEntity;
  if (!attacker || attacker.id === victim.id) return;
  for (const g of victim.dimension.getEntities({ type: GOLEM, location: victim.location, maxDistance: 40 })) {
    const d = S.getGolem(g);
    if (!d || d.owner !== victim.id || d.mode !== "guard") continue;
    if (isFriendlyTo(d, attacker)) continue;
    engage(g, attacker);
  }
});

// ---------- death -> dead statue ----------
world.afterEvents.entityDie.subscribe((ev) => {
  const e = ev.deadEntity;
  let id, live = null, loc = null;
  try { if (e.typeId !== GOLEM) return; id = e.id; live = S.getGolem(e); loc = e.location; } catch { /* entity already invalid */ }
  const cached = lastSeen.get(id);
  const data = live ?? cached?.d, where = loc ?? cached?.loc;
  const dimName = (cached?.dim) ?? (() => { try { return e.dimension.id.replace("minecraft:", ""); } catch { return "overworld"; } })();
  lastSeen.delete(id); engaged.delete(id); returning.delete(id);
  if (!data || !where) return;
  const dim = dimOf(dimName);
  const pos = { x: Math.floor(where.x), y: Math.floor(where.y), z: Math.floor(where.z) };
  system.run(() => {
    let b = dim.getBlock(pos);
    for (let i = 0; b && !b.isAir && !b.isLiquid && i < 4; i++) b = b.above(); // find free spot
    if (!b) return;
    b.setPermutation(BlockPermutation.resolve("golem:statue", { "golem:dead": true, "golem:waxed": false }));
    S.setStatue(b, { ...data, dead: true, programmed: true, waxed: false, diedAt: Date.now() });
  });
});

// ---------- decay of unwaxed dead statues ----------
system.runInterval(() => {
  for (const r of S.allStatues()) {
    const b = dimOf(r.dim).getBlock({ x: r.x, y: r.y, z: r.z });
    if (!b) continue; // chunk not loaded: try again later
    if (b.typeId !== "golem:statue") { S.dropStatueRecord(r); continue; } // orphaned record
    const d = r.data;
    if (!d.dead || d.waxed || Date.now() - d.diedAt < S.DECAY_MS) continue;
    b.setType("minecraft:air");
    S.dropStatueRecord(r);
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
