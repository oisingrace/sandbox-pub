# Golem Commanders (Bedrock add-on) — v0.1 scaffold

Behavior pack (`BP/`) + resource pack (`RP/`). Copy each into `development_behavior_packs` / `development_resource_packs`.
Uses `@minecraft/server` 2.0.0 and `@minecraft/server-ui` 2.0.0. **Untested in-game so far** — only JSON/JS syntax checked.

## Implemented
- **Statue entity** (`golem:statue`, item `golem:statue_item`, stack size 1). Right-click opens the reawakening menu:
  hostile list (every player who has joined + free-text usernames) and friendly list (teams + players + free text).
- **Golem** (`golem:golem`): iron-golem look, modes via entity component groups.
- **Golem Commander** (`golem:commander`): right-click picks a mode for all your golems within 32 blocks.
  Modes: passive, follow, guard, attack, sentry, assassin.
- Follow: teleports to owner when >24 blocks away. Sentry: remembers its spot, engages within 100 blocks, walks home.
- Hostility: golems are extensions of their owner (hostile to a player ⇒ hostile to their golems). Golems target golems first; assassin skips golems.
- Death: golem becomes a dead statue (keeps data, `diedOnce`). Unwaxed dead statues decay after 1 h (wall clock); honeycomb waxes.
  Hitting a statue breaks it and drops nothing; breaking it with a silk touch tool drops the (unstackable) statue item carrying its data.
- Reawakening a statue that has died once, or taking one over as a new owner, costs 1 iron block. First awakening is free.
- **Lodestone**: program all golems in 32 blocks, and create/edit teams.

## Building
`python3 build.py` stamps `VERSION` into both manifests (pack names show it in Minecraft) and writes `../golem-commanders-v<VERSION>.mcaddon`. Bump `VERSION` each build so Minecraft accepts the import as an upgrade.

## Statues are entities (v0.9)
Statues are now entities, not blocks: they use the real full-size iron golem model, store their data on the entity (no
per-block records), keep their rotation, are invulnerable except to player hits, and don't need the block-model size hacks.
New-built statues stand with vines; dead ones slump with cracks (overlay model + texture). Dead unwaxed statues decay after
1 hour (checked in loaded chunks). Pumpkin builds are caught via the vanilla `minecraft:from_player` event as well as pumpkin placement.

## Programming rules (v0.4)
- Programs are set in the reawakening menu (hostile to players/teams, friendly to teams/players, plus typed usernames). A living golem
  keeps its program until the lodestone changes it (free) or it dies; the commander only changes its *mode*.
- First programming of a golem is free. Reawakening any statue that was programmed before (i.e. a dead golem) costs 1 iron block.
- **Lodestone** (empty hand): reprograms every living golem of yours within 32 blocks for free, and reawakens statues in range with the
  chosen program; dead (previously programmed) statues cost 1 iron block each, never-programmed ones are free. It also manages **teams**.
  Lists reference teams by name, so editing a team's members updates every golem using it immediately.
- A silk-touched statue item carries its data (dead / waxed / programmed), so break-and-replace can't dodge the iron cost.

## v0.5
- **Guard** follows its owner and attacks anything that hurts them (mobs, players, other golems) - except the owner's own golems and
  anyone on that golem's friendly list (teams included).
- **Golem Commander recipe:** 4 iron nuggets (shapeless, crafting table).
- **Building a golem the classic way** (iron blocks + carved pumpkin) makes a statue instead of a vanilla iron golem (village golems are untouched).
- First programming is free whether done by hand or with the lodestone (also for never-programmed statues placed by someone else).

## Review fixes (v0.4)
Statue data is sharded over 8 world properties (long property names are risky); no world access during early execution;
form retry when the player's UI is busy; decay no longer deletes records of unloaded chunks; death uses live golem data;
cheaper AI scan (players + golems only); spectators ignored; explicit per-face UVs so the scaled statue model isn't distorted;
own render controller + walk animation (no dependency on vanilla controllers); tameable item fixed; block hidden from creative
menu (the statue item places it); lodestone needs an empty hand; min engine 1.21.100.

## Testing without Minecraft
`tests/run.sh` runs a smoke test against fake `@minecraft/*` modules (spawn->statue, awaken, modes, targeting tag, death,
iron rule, decay, lodestone costs, live teams). It checks the add-on's logic, not the real game API.

## Still unverified / limitations
- Real-game behaviour is untested: the `applyDamage`-as-target trick, `tame()` + `follow_owner`, 128px texture in the terrain atlas,
  that `dataDrivenEntityTrigger` fires `minecraft:from_player` for a pumpkin-built golem, and that `entity_placer` places the statue item.
- Statue looks: new-built statues stand upright with green vines; dead ones have a slumped head and dark cracks (generated overlay texture, placeholder art). The dead/slumped model is reconstructed from the iron golem's geometry, so its proportions may be slightly off.
- Sentry walk-home is stepped teleporting (no scripted pathfinding in Bedrock).

## In-game diagnostics (v0.8.1)
- Errors in any handler now print in chat as `[Golems] <handler> failed: ...`.
- `/scriptevent golem:debug` toggles chat diagnostics (pumpkin seen, iron golem spawned, ...).
- `/scriptevent golem:convert_all` toggles a fallback: every newly spawned vanilla iron golem within 16 blocks of a player becomes a statue.
