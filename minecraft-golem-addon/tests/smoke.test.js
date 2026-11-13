import assert from "node:assert/strict";
import { H, world, system, mkEntity, dim, ItemStack } from "@minecraft/server";
import { F } from "@minecraft/server-ui";
import "./_run/main.js";
const S = await import("./_run/store.js");
const { isHostileTo } = await import("./_run/relations.js");

const comps = {};
H.startup.emit({ itemComponentRegistry: { registerCustomComponent: (n, c) => (comps[n] = c) } });
const tick = () => H.tickJobs.forEach((j) => j.fn());
const flush = () => new Promise((r) => setImmediate(r));
const statues = () => H.ents.filter((e) => e.typeId === "golem:statue" && e.isValid);
const golems = () => H.ents.filter((e) => e.typeId === "golem:golem" && e.isValid);
function player(name, items = {}) {
  const p = { id: "p-" + name, name, typeId: "minecraft:player", location: { x: 0, y: 64, z: 0 }, dimension: dim, selectedSlotIndex: 0, msgs: [], tags: new Set(),
    sendMessage(m) { this.msgs.push(m); }, getGameMode: () => "Survival", isValid: true, addTag(t) { this.tags.add(t); }, removeTag(t) { this.tags.delete(t); },
    getComponent: () => ({ container: { size: 9, getItem: (i) => items[i], setItem: (i, v) => (items[i] = v) } }), items };
  H.players.push(p); return p;
}
const form = (fn) => (F.next = (els) => ({ canceled: false, formValues: els.map((e, i) => (e === "label" ? undefined : fn(e, i))) }));
const noop = (e) => (e.startsWith("Extra") ? "" : false);
const interact = (st, p) => (system.currentTick++, world.afterEvents.playerInteractWithEntity.emit({ target: st, player: p, itemStack: p.items[0] }));

const alice = player("Alice"), bob = player("Bob");
world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true }); world.afterEvents.playerSpawn.emit({ player: bob });

// 1. our golem entity spawned by egg/summon becomes a statue entity
const g0 = dim.spawnEntity("golem:golem", { x: 10.5, y: 64, z: 10.5 });
world.afterEvents.entitySpawn.emit({ entity: g0, cause: "Spawned" });
assert.equal(g0.isValid, false); assert.equal(statues().length, 1);
const st1 = statues()[0];
assert.equal(S.getGolem(st1).owner, alice.id, "nearest player owns it");
assert.ok(st1.events.includes("golem:set_fresh"));

// 2. first awakening is free; menu data is applied
form((e) => (e === "Bob" ? true : e.includes("hostile") && e.startsWith("Extra") ? "Mallory" : noop(e)));
interact(st1, alice); await flush();
assert.equal(statues().length, 0); assert.equal(golems().length, 1);
const g1 = golems()[0], d1 = JSON.parse(g1.props.g);
assert.ok(d1.hostile.includes("Mallory") && d1.hostile.includes("Bob")); assert.equal(d1.programmed, true);

// 3. commander -> guard; hostile player gets tagged by that golem
F.next = () => ({ canceled: false, selection: 2 });
alice.location = { x: 10, y: 64, z: 10 };
system.currentTick++; comps["golem:commander"].onUse({ source: alice }); await flush();
assert.equal(JSON.parse(g1.props.g).mode, "guard"); assert.ok(g1.events.includes("golem:set_guard"));
const mallory = player("Mallory"); mallory.location = { x: 12, y: 64, z: 10 };
tick(); assert.ok(mallory.tags.has("golem_target"));

// 4. guard defends owner against a mob, not a teammate
S.saveTeams({ Red: ["Mallory", "Zed"] });
g1.props.g = JSON.stringify({ ...JSON.parse(g1.props.g), friendly: ["team:Red"], hostile: [] });
const zombie = mkEntity("minecraft:zombie", { x: 11, y: 64, z: 10 }, dim);
world.afterEvents.entityHurt.emit({ hurtEntity: alice, damageSource: { damagingEntity: zombie } });
assert.ok(zombie.tags.has("golem_target"), "guard engages mob");
mallory.tags.clear();
world.afterEvents.entityHurt.emit({ hurtEntity: alice, damageSource: { damagingEntity: mallory } });
assert.ok(!mallory.tags.has("golem_target"), "teammate exempt");

// 5. golem dies -> dead statue entity (same spot), programmed
H.ents = H.ents.filter((e) => e !== g1); g1.isValid = false;
world.afterEvents.entityDie.emit({ deadEntity: g1 });
assert.equal(statues().length, 1);
const dead = statues()[0], dd = S.getGolem(dead);
assert.ok(dd.dead && dd.programmed); assert.ok(dead.events.includes("golem:set_dead"));
assert.deepEqual([dead.location.x, dead.location.z], [10.5, 10.5]);

// 6. reawaken needs iron; with iron it consumes one
form(noop); alice.msgs.length = 0;
interact(dead, alice); await flush();
assert.ok(alice.msgs[0]?.includes("iron"));
alice.items[0] = { typeId: "minecraft:iron_block", amount: 2 };
interact(dead, alice); await flush();
assert.equal(alice.items[0].amount, 1); assert.equal(golems().length, 1); assert.equal(statues().length, 0);

// 7. decay of an unwaxed dead statue; waxed one survives
const g2 = golems()[0]; H.ents = H.ents.filter((e) => e !== g2); g2.isValid = false;
world.afterEvents.entityDie.emit({ deadEntity: g2 });
const decay = H.tickJobs.find((j) => j.n === 200).fn, realNow = Date.now;
decay(); assert.equal(statues().length, 1, "fresh corpse stays");
Date.now = () => realNow() + 3700000;
decay(); assert.equal(statues().length, 0, "decayed after 1h");
world.afterEvents.entityDie.emit({ deadEntity: g2 }); // new dead statue
const waxed = statues()[0]; alice.items[0] = { typeId: "minecraft:honeycomb", amount: 1 };
interact(waxed, alice); alice.items[0] = undefined;
Date.now = () => realNow() + 3700000 * 3; decay(); assert.equal(statues().length, 1, "waxed never decays");
Date.now = realNow;

// 8. silk touch break keeps data on the item; placing it restores the data
const silk = { typeId: "minecraft:diamond_pickaxe", getComponent: () => ({ hasEnchantment: (n) => n === "silk_touch" }) };
alice.items[0] = silk;
H.log.length = 0;
world.afterEvents.entityDie.emit({ deadEntity: waxed, damageSource: { damagingEntity: alice } });
const drop = H.log.find((l) => l[0] === "spawnItem");
assert.ok(drop && JSON.parse(drop[2].d).dead, "silk drop carries data");
H.ents = H.ents.filter((e) => e !== waxed);
world.beforeEvents.playerInteractWithBlock.emit({ itemStack: { typeId: "golem:statue_item", getDynamicProperty: () => drop[2].d }, player: alice, block: { location: { x: 0, y: 0, z: 0 } } });
const placed = dim.spawnEntity("golem:statue", { x: 20, y: 64, z: 20 }); alice.location = { x: 20, y: 64, z: 20 };
world.afterEvents.entitySpawn.emit({ entity: placed, cause: "Spawned" });
assert.ok(S.getGolem(placed).dead && S.getGolem(placed).programmed, "placed item restores data");
alice.items[0] = undefined; placed.remove();

// 9. lodestone: living golem free, dead statue 1 iron, never-programmed statue free; live teams
H.ents.length = 0; alice.location = { x: 10, y: 64, z: 10 };
const live = dim.spawnEntity("golem:golem", { x: 10, y: 64, z: 11 });
live.props.g = JSON.stringify({ owner: alice.id, ownerName: "Alice", hostile: [], friendly: [], mode: "passive", programmed: true });
const mk = (data) => { const s = dim.spawnEntity("golem:statue", { x: 12, y: 64, z: 10 }); s.props.g = JSON.stringify(data); return s; };
mk({ ...S.newGolemData(alice), programmed: true, dead: true, diedAt: Date.now() });
mk(S.newGolemData(alice));
alice.items[0] = { typeId: "minecraft:iron_block", amount: 3 };
let n = 0;
F.next = (els) => (n++ === 0 ? { canceled: false, selection: 0 }
  : { canceled: false, formValues: (() => { let seen = false; return els.map((e) => (e === "label" ? undefined : e.startsWith("Extra") ? "" : e === "Team: Red" && !seen ? (seen = true) : false)); })() });
system.currentTick++; world.afterEvents.playerInteractWithBlock.emit({ block: { typeId: "minecraft:lodestone" }, player: alice, itemStack: undefined }); await flush();
assert.equal(alice.items[0].amount, 2, "only the dead statue cost iron: " + alice.msgs.at(-1));
assert.ok(JSON.parse(live.props.g).hostile.includes("team:Red"));
assert.equal(statues().length, 0); assert.equal(golems().length, 3, "both statues reawakened");
const d = JSON.parse(live.props.g);
assert.equal(isHostileTo(d, { typeId: "minecraft:player", name: "Zed" }), true, "team member hostile via team");
S.saveTeams({ Red: ["Mallory"] });
assert.equal(isHostileTo(d, { typeId: "minecraft:player", name: "Zed" }), false, "team edit applies live");

// 10. pumpkin build: from_player signal, or pumpkin placement + spawn; village golem untouched
const built = dim.spawnEntity("minecraft:iron_golem", { x: 30.5, y: 64, z: 30.5 }); alice.location = { x: 30, y: 64, z: 31 };
world.afterEvents.dataDrivenEntityTrigger.emit({ entity: built, eventId: "minecraft:from_player" });
assert.equal(built.isValid, false); assert.equal(statues().length, 1);
world.beforeEvents.playerInteractWithBlock.emit({ itemStack: { typeId: "minecraft:carved_pumpkin" }, player: alice, block: { typeId: "minecraft:iron_block", location: { x: 40, y: 66, z: 40 } } });
const built2 = dim.spawnEntity("minecraft:iron_golem", { x: 40.5, y: 64, z: 40.5 });
world.afterEvents.entitySpawn.emit({ entity: built2, cause: "Spawned" });
assert.equal(built2.isValid, false); assert.equal(statues().length, 2);
const village = dim.spawnEntity("minecraft:iron_golem", { x: 80.5, y: 64, z: 80.5 });
world.afterEvents.entitySpawn.emit({ entity: village, cause: "Spawned" });
assert.equal(village.isValid, true, "natural golem untouched");
// dedupe: the same click delivered via after+before events only acts once
const shown = F.shown.length;
const st3 = dim.spawnEntity("golem:statue", { x: 90, y: 64, z: 90 }); st3.props.g = JSON.stringify(S.newGolemData(alice));
form(noop); system.currentTick++;
world.afterEvents.playerInteractWithEntity.emit({ target: st3, player: alice, itemStack: undefined });
world.beforeEvents.playerInteractWithEntity.emit({ target: st3, player: alice, itemStack: undefined });
await flush();
assert.equal(F.shown.length - shown, 1, "one menu for one click");
// commander via itemUse event path and sneak-cycle without a menu
system.currentTick++; alice.isSneaking = true; alice.msgs.length = 0;
world.afterEvents.itemUse.emit({ source: alice, itemStack: { typeId: "golem:commander" } });
assert.ok(alice.msgs.at(-1)?.includes("golem(s) set to"), "sneak-use cycles mode: " + alice.msgs.at(-1));
console.log("smoke test OK");
