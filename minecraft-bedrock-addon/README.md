# No Bundles + World Border (Bedrock add-on)

Behaviour pack using the Script API (`@minecraft/server` 1.15.0, Minecraft 1.21.50+).
Install: open `NoBundlesWorldBorder.mcaddon` (or copy `NoBundlesWorldBorder_BP` into `development_behavior_packs`), add to the world. No experiments needed.

## What it does
- **Bundles**: all 17 bundle types are deleted from player inventories/offhand (so crafting one gives nothing), dropped items, chests, barrels, shulker boxes, hoppers, furnaces, droppers, dispensers, crafters, decorated pots, minecarts and mobs with inventories (scanned within 16 blocks of players).
- **Golems**: iron golems spawning without a player within 6 blocks are removed (village spawns). Player-built golems survive.
- **World border**: separate, customisable square border for Overworld and Nether. Anyone outside it (walking, pearls, or coming back through a portal) is teleported to the nearest point on the border. Nether border is off by default; add the tag `wb_bypass` to exempt a player.

## Commands (need cheats/op)
```
/scriptevent wb:status
/scriptevent wb:radius overworld 2000      (radius = centre to edge)
/scriptevent wb:center overworld 0 0
/scriptevent wb:enable nether on
/scriptevent wb:radius nether 250
/scriptevent wb:bundles on|off             (on = bundles blocked)
/scriptevent wb:golems on|off              (on = golems blocked)
```
Settings are saved in the world.

## Known limits
- Bundles can't be stopped from being crafted (ingredients are consumed) – the result is deleted instead. Bundles inside item-form shulker boxes, ender chests, and item frames can't be reached by the Script API.
- The golem "player-built" check is a proximity heuristic; untested in-game.
