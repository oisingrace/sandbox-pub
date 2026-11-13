import {
  world,
  system,
  BlockVolume,
  BlockTypes,
  EquipmentSlot,
  EntityInitializationCause,
} from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";

/* ------------------------------------------------------------------ *
 *  CONFIG (saved in the world, edit in-game with /scriptevent wb:...)
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  noBundles: true,
  noGolems: true,
  showBorder: true, // draw a visible particle wall when you are near the border
  noEnd: false, // true = The End is disabled (portals won't open, anyone inside is sent home)
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
const WAND = "wb:settings_wand";
function removeWand(player) {
  const c = player.getComponent("minecraft:inventory")?.container;
  if (!c) return;
  for (let i = 0; i < c.size; i++) if (c.getItem(i)?.typeId === WAND) c.setItem(i, undefined);
}
const isCreative = (player) => world.getPlayers({ gameMode: "creative" }).some((p) => p.id === player.id);

system.runInterval(() => {
  const creative = new Set(world.getPlayers({ gameMode: "creative" }).map((p) => p.id));
  for (const p of world.getAllPlayers()) {
    if (config.noBundles) purgePlayer(p);
    if (!creative.has(p.id)) removeWand(p); // wand is creative-only
  }
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
 *  VISIBLE BORDER (particle wall, shown within 24 blocks of an edge)
 * ------------------------------------------------------------------ */
const WALL_PARTICLE = "minecraft:blue_flame_particle";
system.runInterval(() => {
  if (!config.showBorder) return;
  for (const player of world.getAllPlayers()) {
    const b = borderFor(player.dimension);
    if (!b || !b.enabled) continue;
    const { x, y, z } = player.location;
    const dim = player.dimension;
    const x0 = b.centerX - b.radius, x1 = b.centerX + b.radius;
    const z0 = b.centerZ - b.radius, z1 = b.centerZ + b.radius;
    const R = 24, SPAN = 16;
    const y0 = Math.floor(y) - 6, y1 = Math.floor(y) + 10;
    const alongZ = Math.max(z0, Math.floor(z) - SPAN), alongZ1 = Math.min(z1, Math.floor(z) + SPAN);
    const alongX = Math.max(x0, Math.floor(x) - SPAN), alongX1 = Math.min(x1, Math.floor(x) + SPAN);
    const spawn = (px, py, pz) => {
      try { dim.spawnParticle(WALL_PARTICLE, { x: px, y: py, z: pz }); } catch (e) {}
    };
    // walls at x = x0 / x1 (run along z)
    for (const wx of [x0, x1]) {
      if (Math.abs(x - wx) > R) continue;
      for (let pz = alongZ; pz <= alongZ1; pz += 2) for (let py = y0; py <= y1; py += 2) spawn(wx, py, pz);
    }
    // walls at z = z0 / z1 (run along x)
    for (const wz of [z0, z1]) {
      if (Math.abs(z - wz) > R) continue;
      for (let px = alongX; px <= alongX1; px += 2) for (let py = y0; py <= y1; py += 2) spawn(px, py, wz);
    }
  }
}, 8);

/* ------------------------------------------------------------------ *
 *  DISABLE THE END
 * ------------------------------------------------------------------ */
// Stop portals being opened
world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
  if (!config.noEnd) return;
  if (ev.block.typeId === "minecraft:end_portal_frame" && ev.itemStack?.typeId === "minecraft:ender_eye") {
    ev.cancel = true;
    system.run(() => ev.player.sendMessage("§cThe End is disabled on this world."));
  }
});

// Send anyone already in (or entering) the End back to their spawn
system.runInterval(() => {
  if (!config.noEnd) return;
  for (const p of world.getAllPlayers()) {
    if (p.dimension.id !== "minecraft:the_end" || p.hasTag("wb_bypass")) continue;
    try {
      const sp = p.getSpawnPoint();
      const ow = world.getDimension("overworld");
      if (sp && sp.dimension.id !== "minecraft:the_end") {
        p.teleport({ x: sp.x + 0.5, y: sp.y, z: sp.z + 0.5 }, { dimension: sp.dimension });
      } else {
        const d = world.getDefaultSpawnLocation();
        p.teleport({ x: d.x + 0.5, y: d.y, z: d.z + 0.5 }, { dimension: ow });
      }
      system.runTimeout(() => settle(p), 5);
      p.sendMessage("§cThe End is disabled on this world.");
    } catch (e) {}
  }
}, 10);

/* ------------------------------------------------------------------ *
 *  SETTINGS WAND (creative only) - right-click to open the settings menu
 * ------------------------------------------------------------------ */
const num = (v, fallback) => {
  const n = Number(String(v).trim());
  return String(v).trim() !== "" && Number.isFinite(n) ? Math.floor(n) : fallback;
};

function openSettings(player, tries = 0) {
  const o = config.border.overworld;
  const n = config.border.nether;
  new ModalFormData()
    .title("World Settings")
    .toggle("Block bundles", config.noBundles)
    .toggle("Block village iron golems", config.noGolems)
    .toggle("Disable The End", config.noEnd)
    .toggle("§lOverworld§r border enabled", o.enabled)
    .textField("Overworld radius (blocks, centre to edge)", "3000", String(o.radius))
    .textField("Overworld centre X", "0", String(o.centerX))
    .textField("Overworld centre Z", "0", String(o.centerZ))
    .toggle("Set Overworld centre to my position", false)
    .toggle("§lNether§r border enabled", n.enabled)
    .textField("Nether radius (blocks, centre to edge)", "375", String(n.radius))
    .textField("Nether centre X", "0", String(n.centerX))
    .textField("Nether centre Z", "0", String(n.centerZ))
    .toggle("Set Nether centre to my position", false)
    .toggle("Show visible border wall (particles)", config.showBorder)
    .show(player)
    .then((res) => {
      if (res.canceled) {
        if (res.cancelationReason === "UserBusy" && tries < 20) system.runTimeout(() => openSettings(player, tries + 1), 10);
        return;
      }
      const v = res.formValues;
      config.noBundles = v[0];
      config.noGolems = v[1];
      config.noEnd = v[2];
      o.enabled = v[3];
      o.radius = Math.max(1, num(v[4], o.radius));
      o.centerX = num(v[5], o.centerX);
      o.centerZ = num(v[6], o.centerZ);
      n.enabled = v[8];
      n.radius = Math.max(1, num(v[9], n.radius));
      n.centerX = num(v[10], n.centerX);
      n.centerZ = num(v[11], n.centerZ);
      const here = (key, b, flag) => {
        if (!flag) return;
        if (player.dimension.id === "minecraft:" + key) {
          b.centerX = Math.floor(player.location.x);
          b.centerZ = Math.floor(player.location.z);
        } else player.sendMessage(`§eYou must be in the ${key} to centre its border on yourself.`);
      };
      config.showBorder = v[13];
      here("overworld", o, v[7]);
      here("nether", n, v[12]);
      saveConfig();
      player.sendMessage("§aSettings saved.\n" + status());
    })
    .catch(() => {});
}

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== WAND) return;
  if (!isCreative(ev.source)) return;
  system.run(() => openSettings(ev.source));
});

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
    `The End disabled: ${config.noEnd}`,
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
    case "wb:end":
      if (args[0] === undefined) return reply("§cUsage: /scriptevent wb:end <on|off>  (on = The End disabled)");
      config.noEnd = onOff(args[0]);
      break;
    case "wb:show":
      if (args[0] === undefined) return reply("§cUsage: /scriptevent wb:show <on|off>");
      config.showBorder = onOff(args[0]);
      break;
    case "wb:status":
      return reply(status());
    default:
      return reply("§cUnknown command. Try wb:status, wb:radius, wb:center, wb:enable, wb:bundles, wb:golems");
  }
  saveConfig();
  reply("§aUpdated.\n" + status());
});

