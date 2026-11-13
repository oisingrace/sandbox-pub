import {
  world,
  system,
  BlockVolume,
  BlockTypes,
  EquipmentSlot,
  EntityInitializationCause,
} from "@minecraft/server";

/* ------------------------------------------------------------------ *
 *  CONFIG (saved in the world, edit in-game with /scriptevent wb:...)
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  noBundles: true,
  noGolems: true,
  scanRadius: 16, // how far around each player containers are scanned for bundles
  border: {
    // radius = distance from centre to the edge (so radius 3000 = 6000x6000 square)
    overworld: { enabled: true, centerX: 0, centerZ: 0, radius: 3000 },
    // Nether border is OFF by default: players can only reach it via portals,
    // and coming back through a portal to outside the Overworld border
    // drops you at the nearest Overworld border point. Turn on if you want one.
    nether: { enabled: false, centerX: 0, centerZ: 0, radius: 375 },
  },
};

function loadConfig() {
  try {
    const raw = world.getDynamicProperty("wb:config");
    if (typeof raw === "string") {
      const saved = JSON.parse(raw);
      return {
        ...DEFAULTS,
        ...saved,
        border: {
          overworld: { ...DEFAULTS.border.overworld, ...(saved.border?.overworld ?? {}) },
          nether: { ...DEFAULTS.border.nether, ...(saved.border?.nether ?? {}) },
        },
      };
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULTS));
}
let config = loadConfig();
function saveConfig() {
  world.setDynamicProperty("wb:config", JSON.stringify(config));
}

/* ------------------------------------------------------------------ *
 *  BUNDLE REMOVAL
 * ------------------------------------------------------------------ */
const BUNDLE_RE = /^minecraft:([a-z_]+_)?bundle$/; // bundle + all 16 dyed colours
const isBundle = (id) => BUNDLE_RE.test(id);

const CONTAINER_RE =
  /^minecraft:(.*_)?(chest|barrel|hopper|dropper|dispenser|furnace|smoker|brewing_stand|crafter|decorated_pot|shulker_box)$/;
let containerTypeIds;
function getContainerTypeIds() {
  if (!containerTypeIds) {
    containerTypeIds = BlockTypes.getAll()
      .map((t) => t.id)
      .filter((id) => CONTAINER_RE.test(id) && id !== "minecraft:ender_chest");
  }
  return containerTypeIds;
}

function purgeContainer(container) {
  let removed = 0;
  if (!container) return 0;
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (item && isBundle(item.typeId)) {
      container.setItem(i, undefined);
      removed++;
    }
  }
  return removed;
}

function purgePlayer(player) {
  purgeContainer(player.getComponent("minecraft:inventory")?.container);
  try {
    const eq = player.getComponent("minecraft:equippable");
    const off = eq?.getEquipment(EquipmentSlot.Offhand);
    if (off && isBundle(off.typeId)) eq.setEquipment(EquipmentSlot.Offhand, undefined);
  } catch (e) {}
}

// Fast loop: player inventories (covers crafting output, pickups, shift-click, creative menu)
system.runInterval(() => {
  if (!config.noBundles) return;
  for (const p of world.getAllPlayers()) purgePlayer(p);
}, 2);

// Slow loop: dropped items, mobs/minecarts with inventories, nearby storage blocks
system.runInterval(() => {
  if (!config.noBundles) return;
  for (const p of world.getAllPlayers()) {
    const dim = p.dimension;
    const loc = p.location;

    try {
      for (const e of dim.getEntities({ location: loc, maxDistance: 64 })) {
        if (e.typeId === "minecraft:player") continue;
        if (e.typeId === "minecraft:item") {
          const stack = e.getComponent("minecraft:item")?.itemStack;
          if (stack && isBundle(stack.typeId)) e.remove();
        } else {
          purgeContainer(e.getComponent("minecraft:inventory")?.container);
        }
      }
    } catch (e) {}

    try {
      const r = config.scanRadius;
      const { min, max } = dim.heightRange;
      const from = { x: Math.floor(loc.x) - r, y: Math.max(min, Math.floor(loc.y) - r), z: Math.floor(loc.z) - r };
      const to = { x: Math.floor(loc.x) + r, y: Math.min(max - 1, Math.floor(loc.y) + r), z: Math.floor(loc.z) + r };
      const found = dim.getBlocks(new BlockVolume(from, to), { includeTypes: getContainerTypeIds() }, true);
      for (const pos of found.getBlockLocationIterator()) {
        const block = dim.getBlock(pos);
        purgeContainer(block?.getComponent("minecraft:inventory")?.container);
      }
    } catch (e) {}
  }
}, 20);

// Dropped bundles removed the moment they appear
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (!config.noBundles || entity.typeId !== "minecraft:item") return;
  system.run(() => {
    try {
      const stack = entity.getComponent("minecraft:item")?.itemStack;
      if (stack && isBundle(stack.typeId)) entity.remove();
    } catch (e) {}
  });
});

/* ------------------------------------------------------------------ *
 *  NO VILLAGE IRON GOLEMS
 * ------------------------------------------------------------------ */
// Player-built golems are kept: a golem that appears with a player standing
// within 6 blocks is treated as player-built. Everything else is removed.
world.afterEvents.entitySpawn.subscribe(({ entity, cause }) => {
  if (!config.noGolems || entity.typeId !== "minecraft:iron_golem") return;
  if (cause === EntityInitializationCause.Loaded || cause === EntityInitializationCause.Transformed) return;
  system.run(() => {
    try {
      const nearPlayer = entity.dimension.getPlayers({ location: entity.location, maxDistance: 6 }).length > 0;
      if (!nearPlayer) entity.remove();
    } catch (e) {}
  });
});

/* ------------------------------------------------------------------ *
 *  WORLD BORDER
 * ------------------------------------------------------------------ */
const lastWarn = new Map();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function borderFor(dim) {
  const key = dim.id.replace("minecraft:", "");
  return key === "overworld" || key === "nether" ? config.border[key] : undefined;
}

function blockAt(dim, x, y, z) {
  try {
    return dim.getBlock({ x, y, z });
  } catch (e) {
    return undefined;
  }
}

function findSafeY(dim, x, y, z) {
  const { min, max } = dim.heightRange;
  const sy = Math.floor(y);
  for (let d = 0; d <= 48; d++) {
    for (const yy of d === 0 ? [sy] : [sy + d, sy - d]) {
      if (yy <= min || yy >= max - 2) continue;
      const feet = blockAt(dim, x, yy, z);
      const head = blockAt(dim, x, yy + 1, z);
      const below = blockAt(dim, x, yy - 1, z);
      if (feet?.isAir && head?.isAir && below && !below.isAir && !below.isLiquid) return yy;
    }
  }
  return undefined;
}

function settle(player, tries = 0) {
  try {
    if (!player.isValid()) return;
    const { x, y, z } = player.location;
    const feet = blockAt(player.dimension, Math.floor(x), Math.floor(y), Math.floor(z));
    if (!feet) {
      if (tries < 10) system.runTimeout(() => settle(player, tries + 1), 5);
      return;
    }
    if (feet.isAir) return;
    const safe = findSafeY(player.dimension, Math.floor(x), y, Math.floor(z));
    if (safe !== undefined) player.teleport({ x, y: safe, z }, { dimension: player.dimension });
  } catch (e) {}
}

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (player.hasTag("wb_bypass")) continue;
    const b = borderFor(player.dimension);
    if (!b || !b.enabled) continue;

    const { x, y, z } = player.location;
    const dx = x - b.centerX;
    const dz = z - b.centerZ;
    const lim = b.radius - 1.5; // keep players just inside the edge
    const inside = Math.abs(dx) <= b.radius && Math.abs(dz) <= b.radius;

    if (inside) {
      const edge = b.radius - Math.max(Math.abs(dx), Math.abs(dz));
      if (edge < 8) player.onScreenDisplay.setActionBar(`§eWorld border ${Math.ceil(edge)} blocks away`);
      continue;
    }

    // Outside the border (walked, ender-pearled, or arrived through a portal):
    // send to the nearest border point.
    const nx = Math.floor(b.centerX + clamp(dx, -lim, lim)) + 0.5;
    const nz = Math.floor(b.centerZ + clamp(dz, -lim, lim)) + 0.5;
    const ny = findSafeY(player.dimension, Math.floor(nx), y, Math.floor(nz)) ?? y;
    try {
      player.teleport({ x: nx, y: ny, z: nz }, { dimension: player.dimension });
      system.runTimeout(() => settle(player), 5);
      const now = system.currentTick;
      if (now - (lastWarn.get(player.id) ?? -100) > 40) {
        player.sendMessage("§cYou reached the world border and were moved back to its nearest edge.");
        lastWarn.set(player.id, now);
      }
    } catch (e) {}
  }
}, 5);

/* ------------------------------------------------------------------ *
 *  IN-GAME COMMANDS  (/scriptevent <id> <message>, needs cheats/op)
 * ------------------------------------------------------------------ */
const DIMS = { overworld: "overworld", normal: "overworld", nether: "nether" };
const onOff = (s) => ["on", "true", "yes", "1", "enable", "enabled"].includes(String(s).toLowerCase());

function status() {
  const f = (n, b) =>
    `${n}: ${b.enabled ? "ON" : "off"}, centre ${b.centerX},${b.centerZ}, radius ${b.radius} (${b.radius * 2}x${b.radius * 2})`;
  return [
    `Bundles blocked: ${config.noBundles}  |  Village golems blocked: ${config.noGolems}`,
    f("Overworld border", config.border.overworld),
    f("Nether border", config.border.nether),
  ].join("\n");
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const id = ev.id;
  if (!id.startsWith("wb:")) return;
  const args = ev.message.trim().split(/\s+/).filter(Boolean);
  const reply = (m) => (ev.sourceEntity?.typeId === "minecraft:player" ? ev.sourceEntity.sendMessage(m) : world.sendMessage(m));
  const dimKey = DIMS[(args[0] ?? "").toLowerCase()];

  switch (id) {
    case "wb:radius": {
      const n = Number(args[1]);
      if (!dimKey || !(n >= 1)) return reply("§cUsage: /scriptevent wb:radius <overworld|nether> <blocks>");
      config.border[dimKey].radius = Math.floor(n);
      break;
    }
    case "wb:center": {
      const x = Number(args[1]), z = Number(args[2]);
      if (!dimKey || Number.isNaN(x) || Number.isNaN(z)) return reply("§cUsage: /scriptevent wb:center <overworld|nether> <x> <z>");
      config.border[dimKey].centerX = Math.floor(x);
      config.border[dimKey].centerZ = Math.floor(z);
      break;
    }
    case "wb:enable": {
      if (!dimKey || args[1] === undefined) return reply("§cUsage: /scriptevent wb:enable <overworld|nether> <on|off>");
      config.border[dimKey].enabled = onOff(args[1]);
      break;
    }
    case "wb:bundles":
      if (args[0] === undefined) return reply("§cUsage: /scriptevent wb:bundles <on|off>  (on = bundles blocked)");
      config.noBundles = onOff(args[0]);
      break;
    case "wb:golems":
      if (args[0] === undefined) return reply("§cUsage: /scriptevent wb:golems <on|off>  (on = golems blocked)");
      config.noGolems = onOff(args[0]);
      break;
    case "wb:status":
      return reply(status());
    default:
      return reply("§cUnknown command. Try wb:status, wb:radius, wb:center, wb:enable, wb:bundles, wb:golems");
  }
  saveConfig();
  reply("§aUpdated.\n" + status());
});

