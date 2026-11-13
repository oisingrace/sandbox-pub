import { world, system, ItemStack, EntityComponentTypes } from "@minecraft/server";
import * as S from "./store.js";
import { VERSION } from "./version.js";
import { awakenMenu, modeMenu, lodestoneMenu } from "./forms.js";
import { isHostileTo, isFriendlyTo, isGolem } from "./relations.js";

const GOLEM = "golem:golem";
const STATUE = "golem:statue";
const DIMS = ["overworld", "nether", "the_end"];
const pendingAwake = new Set();   // ids of golems we spawned on purpose (not turned into statues)
const pendingStatue = new Set();  // ids of statues we spawned on purpose (data already set)
const statueCache = new Map();    // statue id -> data, so a destroyed statue can still drop its item with data
const lastSeen = new Map();       // golem id -> {d, loc, dim}, cached for death handling
const engaged = new Map();        // golem id -> {tid, tick}
const returning = new Map();      // golem id -> {g, stuck} (sentries walking home)
// Errors in any handler are shown in chat (testing in-game is slow; this makes failures visible) instead of dying silently.
const safe = (name, fn) => (...a) => {
  try { return fn(...a); } catch (e) { try { world.sendMessage(`§c[Golems] ${name} failed: ${e?.message ?? e}`); } catch { /* ignore */ } }
};
// One missing/renamed API must not take the whole add-on down: failures are collected and shown on join.
const problems = [];
const on = (sig, name, fn, opts) => {
  try {
    if (!sig?.subscribe) throw new Error("this event does not exist in this game version");
    return sig.subscribe(safe(name, fn), opts);
  } catch (e) { problems.push(`${name}: ${e?.message ?? e}`); }
};
const runInterval = (fn, n) => system.runInterval(safe("interval", fn), n);
const flag = (k) => world.getDynamicProperty(k) === true;
const dbg = (m) => { if (flag("golem_debug")) world.sendMessage(`§7[Golems] ${m}`); };
const dimOf = (id) => world.getDimension(id);
const fighting = (m) => ["guard", "attack", "sentry", "assassin"].includes(m);

// ---------- players ----------
on(world.afterEvents.playerSpawn, "playerSpawn", (e) => {
  S.rememberPlayer(e.player.name);
  if (!e.initialSpawn) return;
  e.player.sendMessage(`§a[Golems] v${VERSION} script loaded.`);
  try { e.player.onScreenDisplay.setActionBar(`§aGolem Commanders v${VERSION} running`); } catch { /* not available */ }
  if (problems.length) e.player.sendMessage(`§c[Golems] ${problems.length} feature(s) disabled:\n- ${problems.join("\n- ")}`);
});
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

// ---------- statues are entities (golem:statue): full-size model, data lives on the entity ----------
const rot = (e) => { try { return e.getRotation(); } catch { return { x: 0, y: 0 }; } };

// Create a statue entity (used for new-built golems and for dead golems).
function makeStatue(dim, loc, rotation, data) {
  const st = dim.spawnEntity(STATUE, loc);
  pendingStatue.add(st.id);
  S.setGolem(st, data);
  st.setRotation?.({ x: 0, y: rotation.y });
  st.triggerEvent(data.dead ? "golem:set_dead" : "golem:set_fresh");
  statueCache.set(st.id, data);
  return st;
}

// statue entity -> living golem
function awaken(statue, data, player) {
  const dim = statue.dimension, loc = { ...statue.location }, r = rot(statue);
  statueCache.delete(statue.id);
  statue.remove();
  const g = dim.spawnEntity(GOLEM, loc);
  pendingAwake.add(g.id);
  g.setRotation?.({ x: 0, y: r.y });
  data.dead = false; data.waxed = false;
  data.home = { x: loc.x, y: loc.y, z: loc.z, dim: dim.id };
  S.setGolem(g, data);
  setOwner(g, player);
  applyMode(g, data.mode);
}
function setOwner(g, player) {
  try { g.getComponent(EntityComponentTypes.Tameable)?.tame(player); } catch { /* owner already set */ }
}

function statueInteract(statue, player, held) {
  const data = S.getGolem(statue) ?? S.newGolemData({ id: "", name: "" });
  if (held?.typeId === "minecraft:honeycomb" && !data.waxed) {
    data.waxed = true; S.setGolem(statue, data); statueCache.set(statue.id, data);
    const inv = player.getComponent("inventory").container;
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
  const base = newOwner ? { ...S.newGolemData(player), programmed: data.programmed, dead: data.dead, diedAt: data.diedAt } : data;
  system.run(() => awakenMenu(player, base, (d) => {
    if (!statue.isValid) return;
    if (needIron) {
      const slot = findIron(player);
      if (slot < 0) return player.sendMessage("§cYou need an iron block.");
      takeOne(player, slot);
    }
    d.owner = player.id; d.ownerName = player.name; d.programmed = true;
    awaken(statue, d, player);
  }));
}
on(world.afterEvents.playerInteractWithEntity, "statueInteract", (e) => {
  dbg(`interact with ${e.target.typeId}`);
  if (e.target.typeId === STATUE) statueInteract(e.target, e.player, e.itemStack);
});

on(system.beforeEvents.startup, "startup", (ev) => {
  ev.itemComponentRegistry.registerCustomComponent("golem:commander", {
    onUse(e) { dbg("commander used"); system.run(() => modeMenu(e.source, (m) => commandGolems(e.source, m))); },
  });
});

// A silk-touched statue item carries its data (so break + place can't skip the iron block rule).
const carried = new Map(); // player id -> data JSON from the statue item they just used
on(world.beforeEvents.playerInteractWithBlock, "carry", (e) => {
  const j = e.itemStack?.typeId === "golem:statue_item" ? e.itemStack.getDynamicProperty("d") : undefined;
  if (j) carried.set(e.player.id, j); else carried.delete(e.player.id);
});

// Hitting a statue breaks it (it is invulnerable to everything else). Only silk touch keeps it as an item.
on(world.afterEvents.entityHurt, "statueHurt", (ev) => {
  const e = ev.hurtEntity;
  if (e.typeId === STATUE) { const d = S.getGolem(e); if (d) statueCache.set(e.id, d); }
});
on(world.afterEvents.entityDie, "statueDie", (ev) => {
  const e = ev.deadEntity;
  let id, loc, dim, d = null;
  try { if (e.typeId !== STATUE) return; id = e.id; loc = e.location; dim = e.dimension; d = S.getGolem(e); } catch { if (id === undefined) return; }
  d = d ?? statueCache.get(id); statueCache.delete(id);
  const by = ev.damageSource?.damagingEntity;
  if (!d || !loc || !by || by.typeId !== "minecraft:player") return;
  const held = by.getComponent("inventory")?.container?.getItem(by.selectedSlotIndex);
  if (!held?.getComponent("enchantable")?.hasEnchantment("silk_touch")) return;
  const item = new ItemStack("golem:statue_item", 1);
  item.setDynamicProperty("d", JSON.stringify(d));
  (dim ?? dimOf("overworld")).spawnItem(item, loc);
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

// ---------- lodestone ----------
function statuesNear(player, radius) {
  return player.dimension.getEntities({ type: STATUE, location: player.location, maxDistance: radius })
    .filter((st) => {
      const d = S.getGolem(st); if (!d) return false;
      // others' used statues are off limits; never-programmed ones are fair game
      return !d.owner || d.owner === player.id || !d.programmed;
    });
}

// Living golems can't be edited by hand; their program is fixed until they die. The lodestone is the
// exception: it reprograms living golems for free and reawakens statues in range with the chosen
// program (dead/programmed statues cost 1 iron block each, never-programmed ones are free).
// Teams edited at the lodestone take effect immediately: lists reference teams by name.
on(world.afterEvents.playerInteractWithBlock, "lodestone", (e) => {
  if (e.block.typeId === "minecraft:lodestone") dbg(`lodestone clicked${e.itemStack ? " (hand not empty: ignored)" : ""}`);
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
        const o = S.getGolem(g);
        S.setGolem(g, { ...o, hostile: d.hostile, friendly: d.friendly, programmed: true }); live++;
      }
      for (const st of statuesNear(p, S.COMMAND_RADIUS)) {
        const sd = S.getGolem(st); if (!sd) continue;
        if (!pay(sd.programmed)) { skipped++; continue; }
        awaken(st, { ...sd, owner: p.id, ownerName: p.name, hostile: d.hostile, friendly: d.friendly, programmed: true }, p);
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
runInterval(() => {
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

runInterval(() => {
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
on(world.afterEvents.entityHurt, "entityHurt", (ev) => {
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
on(world.afterEvents.entityDie, "golemDie", (ev) => {
  const e = ev.deadEntity;
  let id, live = null, loc = null, r = { x: 0, y: 0 };
  try { if (e.typeId !== GOLEM) return; id = e.id; live = S.getGolem(e); loc = e.location; r = rot(e); } catch { /* entity already invalid */ }
  const cached = lastSeen.get(id);
  const data = live ?? cached?.d, where = loc ?? cached?.loc;
  const dimName = (cached?.dim) ?? (() => { try { return e.dimension.id.replace("minecraft:", ""); } catch { return "overworld"; } })();
  lastSeen.delete(id); engaged.delete(id); returning.delete(id);
  if (!data || !where) return;
  system.run(() => makeStatue(dimOf(dimName), where, r,
    { ...data, dead: true, programmed: true, waxed: false, diedAt: Date.now() }));
});

// ---------- decay of unwaxed dead statues (loaded chunks only; checked against wall clock) ----------
runInterval(() => {
  for (const dimId of DIMS) {
    for (const st of dimOf(dimId).getEntities({ type: STATUE })) {
      const d = S.getGolem(st);
      if (!d?.dead || d.waxed || Date.now() - d.diedAt < S.DECAY_MS) continue;
      statueCache.delete(st.id);
      st.remove();
    }
  }
}, 200);

// ---------- new golems become statues ----------
// Covers: our golem entity (egg / summon), and the classic build (iron blocks + carved pumpkin)
// which would otherwise produce a plain vanilla iron golem.
const PUMPKINS = ["minecraft:carved_pumpkin", "minecraft:lit_pumpkin"];
const pumpkinPlaced = []; // {player, tick, loc, dim}
function notePumpkin(player, loc, via) {
  pumpkinPlaced.push({ player, tick: system.currentTick, loc: { ...loc }, dim: player.dimension.id });
  if (pumpkinPlaced.length > 8) pumpkinPlaced.shift();
  dbg(`pumpkin seen (${via}) by ${player.name}`);
}
// Several signals, because the vanilla golem can appear before/after any single one of them fires.
on(world.beforeEvents.playerPlaceBlock, "pumpkinPlace", (e) => { if (PUMPKINS.includes(e.itemStack?.typeId)) notePumpkin(e.player, e.block.location, "place"); });
on(world.beforeEvents.playerInteractWithBlock, "pumpkinUse", (e) => { if (PUMPKINS.includes(e.itemStack?.typeId)) notePumpkin(e.player, e.block.location, "use"); });
on(world.afterEvents.playerPlaceBlock, "pumpkinPlaced", (e) => {
  if (PUMPKINS.includes(e.block.typeId) || e.block.isAir) notePumpkin(e.player, e.block.location, "placed");
});

// /scriptevent golem:selftest     -> one-shot check of entities, events and menus (results in chat)
async function selfTest(p) {
  const say = (ok, m) => p.sendMessage(`${ok ? "§a✔" : "§c✘"} §f${m}`);
  p.sendMessage(`§e[Golems] self-test, script v${VERSION}`);
  say(problems.length === 0, problems.length ? `disabled features: ${problems.join("; ")}` : "all event hooks registered");
  for (const [type, pend] of [[STATUE, pendingStatue], [GOLEM, pendingAwake]]) {
    try { const e = p.dimension.spawnEntity(type, p.location); pend.add(e.id); S.setGolem(e, S.newGolemData(p)); e.remove(); say(true, `${type} can be spawned (definition accepted)`); }
    catch (err) { say(false, `${type} cannot be spawned: ${err?.message ?? err}`); }
  }
  say(true, `item hook: use the Golem Commander and expect "commander used" with golem:debug on`);
  say(true, `statues in range: ${p.dimension.getEntities({ type: STATUE, location: p.location, maxDistance: 32 }).length}, golems: ${p.dimension.getEntities({ type: GOLEM, location: p.location, maxDistance: 32 }).length}`);
  say(true, "opening a test menu...");
  const { ActionFormData } = await import("@minecraft/server-ui");
  const r = await new ActionFormData().title("Golems self-test").body("Menus work. Close this.").button("OK").show(p);
  say(!r.canceled || r.cancelationReason === "UserClosed", `menu result: ${r.canceled ? "canceled (" + r.cancelationReason + ")" : "submitted"}`);
}

// /scriptevent golem:debug        -> toggle chat diagnostics
// /scriptevent golem:convert_all  -> toggle "every newly spawned vanilla iron golem near a player becomes a statue"
on(system.afterEvents.scriptEventReceive, "scriptEvent", (e) => {
  if (e.id === "golem:selftest" && e.sourceEntity?.typeId === "minecraft:player") { selfTest(e.sourceEntity).catch((err) => e.sourceEntity.sendMessage(`§c[Golems] self-test failed: ${err?.message ?? err}`)); return; }
  for (const [id, key, label] of [["golem:debug", "golem_debug", "debug"], ["golem:convert_all", "golem_convert_all", "convert-all"]]) {
    if (e.id !== id) continue;
    const v = !flag(key); world.setDynamicProperty(key, v);
    world.sendMessage(`§e[Golems] ${label} ${v ? "ON" : "OFF"}`);
  }
});

function toStatue(g, owner) {
  if (!g.isValid) return; // already converted via another signal
  const dim = g.dimension, loc = { ...g.location }, r = rot(g);
  // Spawn the statue FIRST: if that fails (e.g. entity definition rejected) the original golem stays and the error shows in chat.
  const st = makeStatue(dim, loc, r, S.newGolemData(owner ?? { id: "", name: "" }));
  g.remove();
  const msg = `§e[Golems] Statue created at ${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)}. (If you can't see it: /testfor @e[type=golem:statue])`;
  (owner?.sendMessage ? owner : { sendMessage: (m) => world.sendMessage(m) }).sendMessage(msg);
  return st;
}
const nearestPlayer = (g, d = 16) => g.dimension.getPlayers({ location: g.location, closest: 1, maxDistance: d })[0];

// Most reliable signal: the vanilla iron golem fires "minecraft:from_player" when a player builds it.
on(world.afterEvents.dataDrivenEntityTrigger, "fromPlayer", (ev) => {
  dbg("vanilla iron golem fired from_player");
  toStatue(ev.entity, nearestPlayer(ev.entity));
}, { entityTypes: ["minecraft:iron_golem"], eventTypes: ["minecraft:from_player"] });

on(world.afterEvents.entitySpawn, "entitySpawn", (ev) => {
  const g = ev.entity;
  if (!g.isValid || ev.cause === "Loaded") return;
  if (g.typeId === "minecraft:iron_golem") {
    dbg(`iron golem spawned (cause ${ev.cause}); recent pumpkins: ${pumpkinPlaced.length}`);
    const i = pumpkinPlaced.findIndex((p) => system.currentTick - p.tick <= 20 && p.dim === g.dimension.id &&
      Math.hypot(p.loc.x - g.location.x, p.loc.y - g.location.y, p.loc.z - g.location.z) <= 8);
    if (i >= 0) return toStatue(g, pumpkinPlaced.splice(i, 1)[0].player);
    if (flag("golem_convert_all")) { const near = nearestPlayer(g); if (near) return toStatue(g, near); }
    return;
  }
  if (g.typeId === GOLEM) {
    if (pendingAwake.delete(g.id) || S.getGolem(g)) return;
    return toStatue(g, nearestPlayer(g));
  }
  if (g.typeId === STATUE) { // placed from the item, spawn egg or /summon
    if (pendingStatue.delete(g.id) || S.getGolem(g)) return;
    const p = nearestPlayer(g, 8);
    let data = null;
    const j = p && carried.get(p.id); if (p) carried.delete(p.id);
    try { data = j ? JSON.parse(j) : null; } catch { /* ignore */ }
    data = data ?? S.newGolemData(p ?? { id: "", name: "" });
    S.setGolem(g, data); statueCache.set(g.id, data);
    g.triggerEvent(data.dead ? "golem:set_dead" : "golem:set_fresh");
  }
});
