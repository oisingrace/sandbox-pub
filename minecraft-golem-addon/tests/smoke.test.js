import assert from "node:assert/strict";
import { H, world, system, mkEntity, dim, ItemStack } from "@minecraft/server";
import { F } from "@minecraft/server-ui";
import "./_run/main.js";

const comps = {}; // register custom components via the fake startup event
H.startup.emit({ blockComponentRegistry: { registerCustomComponent: (n, c) => (comps[n] = c) }, itemComponentRegistry: { registerCustomComponent: (n, c) => (comps[n] = c) } });
const tick = () => H.tickJobs.forEach((j) => j.fn());
const inv = (items) => ({ getComponent: () => ({ container: { size: 9, getItem: (i) => items[i], setItem: (i, v) => (items[i] = v) } }), items });
function player(name, items = {}) {
  const p = { id: "p-" + name, name, location: { x: 0, y: 64, z: 0 }, dimension: dim, selectedSlotIndex: 0, msgs: [], sendMessage(m) { this.msgs.push(m); }, getGameMode: () => "Survival", isValid: true,
    getComponent: () => ({ container: { size: 9, getItem: (i) => items[i], setItem: (i, v) => (items[i] = v) } }), items };
  H.players.push(p); return p;
}
const flush = () => new Promise((r) => setImmediate(r));
const block = (x, y, z) => dim.getBlock({ x, y, z });

// 1. a freshly spawned golem becomes a statue
const alice = player("Alice"), bob = player("Bob");
world.afterEvents.playerSpawn.emit({ player: alice }); world.afterEvents.playerSpawn.emit({ player: bob });
const g0 = dim.spawnEntity("golem:golem", { x: 10.5, y: 64, z: 10.5 });
world.afterEvents.entitySpawn.emit({ entity: g0, cause: "Spawned" });
assert.equal(g0.isValid, false, "fresh golem removed");
assert.equal(block(10, 64, 10).typeId, "golem:statue");

// 2. first awakening is free, menu result applied, golem spawned with data
F.next = (els) => ({ canceled: false, formValues: els.map((e) => (e === "label" ? undefined : e === "Bob" ? true : e.startsWith("Extra") ? (e.includes("hostile") ? "Mallory" : "") : false)) });
comps["golem:statue"].onPlayerInteract({ block: block(10, 64, 10), player: alice });
await flush();
const g1 = H.ents.find((e) => e.typeId === "golem:golem");
assert.ok(g1, "golem awakened");
const d1 = JSON.parse(g1.props.g);
assert.ok(d1.hostile.includes("Mallory"), "extra hostile name parsed: " + JSON.stringify(d1));
assert.equal(d1.programmed, true);
assert.equal(block(10, 64, 10).typeId, "minecraft:air");

// 3. commander sets mode; guard mode engages a hostile player (per-golem tagging)
F.next = (els) => ({ canceled: false, selection: 2 });
alice.location = { x: 10, y: 64, z: 10 };
comps["golem:commander"].onUse({ source: alice });
await flush();
assert.equal(JSON.parse(g1.props.g).mode, "guard");
assert.ok(g1.events.includes("golem:set_guard"));
const mallory = player("Mallory"); mallory.location = { x: 12, y: 64, z: 10 }; mallory.addTag = (t) => (mallory.t = t); mallory.removeTag = () => {};
mallory.typeId = "minecraft:player"; alice.typeId = bob.typeId = "minecraft:player";
tick();
assert.equal(mallory.t, "golem_target", "hostile player tagged");

// 4. death -> dead statue with iron rule
H.ents = H.ents.filter((e) => e !== g1);
world.afterEvents.entityDie.emit({ deadEntity: g1 });
const sb = dim.getBlock({ x: 10, y: 64, z: 10 });
assert.equal(sb.typeId, "golem:statue", "statue placed at death spot");
const sd = JSON.parse(Object.values(H.props).filter((v) => v.includes("overworld:")).join("").slice(0));
// 5. reawaken without iron fails, with iron works and consumes it
F.next = (els) => ({ canceled: false, formValues: els.map((e) => (e === "label" ? undefined : e.startsWith("Extra") ? "" : false)) });
H.ents.length = 0; alice.msgs.length = 0;
comps["golem:statue"].onPlayerInteract({ block: sb, player: alice });
await flush();
assert.ok(alice.msgs[0]?.includes("iron"), "needs iron: " + alice.msgs);
alice.items[0] = { typeId: "minecraft:iron_block", amount: 2 };
comps["golem:statue"].onPlayerInteract({ block: sb, player: alice });
await flush();
assert.equal(alice.items[0].amount, 1, "one iron consumed");
assert.ok(H.ents.find((e) => e.typeId === "golem:golem"), "reawakened");

// 6. decay of unwaxed dead statue, skipped when waxed/unloaded
const g2 = H.ents.find((e) => e.typeId === "golem:golem");
H.ents = H.ents.filter((e) => e !== g2);
world.afterEvents.entityDie.emit({ deadEntity: g2 });
const decay = H.tickJobs.find((j) => j.n === 200).fn;
decay(); assert.equal(block(10, 64, 10).typeId, "golem:statue", "not decayed yet");
const realNow = Date.now; Date.now = () => realNow() + 3700000;
decay(); assert.equal(block(10, 64, 10).typeId, "minecraft:air", "decayed after 1h");
Date.now = realNow;

// 7. lodestone: living golem reprogram costs 1 iron, statue in range gets reawakened for 1 iron each
alice.location = { x: 10, y: 64, z: 10 };
H.ents.length = 0;
const live = dim.spawnEntity("golem:golem", { x: 10, y: 64, z: 11 });
live.props.g = JSON.stringify({ owner: alice.id, ownerName: "Alice", hostile: [], friendly: [], mode: "guard", programmed: true });
const st = block(12, 64, 10); st.setPermutation({ type: { id: "golem:statue" }, states: {} });
import("./_run/store.js").then(async (S) => {
  S.setStatue(st, { ...S.newGolemData(alice), programmed: true, dead: true });
  alice.items[0] = { typeId: "minecraft:iron_block", amount: 3 };
  let n = 0;
  F.next = (els) => (n++ === 0 ? { canceled: false, selection: 0 }
    : { canceled: false, formValues: (() => { let seen = false; return els.map((e) => (e === "label" ? undefined : e.startsWith("Extra") ? "" : e === "Team: Red" && !seen ? (seen = true) : false)); })() });
  S.saveTeams({ Red: ["Mallory"] });
  H.players.length = 0; H.players.push(alice);
  world.afterEvents.playerInteractWithBlock.emit({ block: { typeId: "minecraft:lodestone" }, player: alice, itemStack: undefined });
  await flush();
  assert.equal(alice.items[0].amount, 1, "2 iron spent (1 live + 1 statue): " + alice.msgs.at(-1));
  assert.ok(JSON.parse(live.props.g).hostile.includes("team:Red"), "living golem reprogrammed with team");
  assert.equal(H.ents.filter((e) => e.typeId === "golem:golem").length, 2, "statue reawakened");
  // real-time teams: membership change alters hostility without touching the golem
  const { isHostileTo } = await import("./_run/relations.js");
  const d = JSON.parse(live.props.g);
  assert.equal(isHostileTo(d, { typeId: "minecraft:player", name: "Zed" }), false);
  S.saveTeams({ Red: ["Mallory", "Zed"] });
  assert.equal(isHostileTo(d, { typeId: "minecraft:player", name: "Zed" }), true, "team edit applies live");
  // first-ever programming is free
  const fresh = block(14, 64, 10); fresh.setPermutation({ type: { id: "golem:statue" }, states: {} });
  S.setStatue(fresh, S.newGolemData(alice));
  alice.items[0] = undefined; n = 1;
  world.afterEvents.playerInteractWithBlock.emit({ block: { typeId: "minecraft:lodestone" }, player: alice, itemStack: undefined });
  await flush();
  assert.ok(alice.msgs.at(-1).includes("reawakened"), "free first program: " + alice.msgs.at(-1));
  H.ents.filter((e) => e.typeId === "golem:golem").forEach((e) => (e.props.g = e.props.g.replace('"guard"', '"passive"')));
  // guard defends owner against a zombie but not a teammate
  const guard = dim.spawnEntity("golem:golem", { x: 0, y: 64, z: 0 });
  guard.props.g = JSON.stringify({ owner: alice.id, ownerName: "Alice", hostile: [], friendly: ["team:Red"], mode: "guard", programmed: true });
  alice.typeId = "minecraft:player"; alice.dimension = dim; alice.location = { x: 1, y: 64, z: 0 };
  const zombie = mkEntity("minecraft:zombie", { x: 2, y: 64, z: 0 }, dim);
  const mate = { id: "m", typeId: "minecraft:player", name: "Mallory", addTag() { this.hit = true; }, removeTag() {} };
  alice.id = "p-Alice";
  world.afterEvents.entityHurt.emit({ hurtEntity: alice, damageSource: { damagingEntity: zombie } });
  assert.ok(zombie.tags.has("golem_target"), "guard engages mob hurting owner");
  world.afterEvents.entityHurt.emit({ hurtEntity: alice, damageSource: { damagingEntity: mate } });
  assert.ok(!mate.hit, "teammate exempt");
  console.log("smoke test OK");
});

