# Golem Commanders (Bedrock add-on) — v0.1 scaffold

Behavior pack (`BP/`) + resource pack (`RP/`). Copy each into `development_behavior_packs` / `development_resource_packs`.
Uses `@minecraft/server` 2.0.0 and `@minecraft/server-ui` 2.0.0. **Untested in-game so far** — only JSON/JS syntax checked.

## Implemented
- **Statue block** (`golem:statue`, item `golem:statue_item`, stack size 1). Right-click opens the reawakening menu:
  hostile list (every player who has joined + free-text usernames) and friendly list (teams + players + free text).
- **Golem** (`golem:golem`): iron-golem look, modes via entity component groups.
- **Golem Commander** (`golem:commander`): right-click picks a mode for all your golems within 32 blocks.
  Modes: passive, follow, guard, attack, sentry, assassin.
- Follow: teleports to owner when >24 blocks away. Sentry: remembers its spot, engages within 100 blocks, walks home.
- Hostility: golems are extensions of their owner (hostile to a player ⇒ hostile to their golems). Golems target golems first; assassin skips golems.
- Death: golem becomes a dead statue (keeps data, `diedOnce`). Unwaxed dead statues decay after 1 h (wall clock); honeycomb waxes.
  Mining gives nothing; silk touch drops the (unstackable) statue item.
- Reawakening a statue that has died once, or taking one over as a new owner, costs 1 iron block. First awakening is free.
- **Lodestone**: program all golems in 32 blocks, and create/edit teams.

## Programming rules (v0.4)
- Only **statues** are programmed (reawakening menu: hostile to players/teams, friendly to teams/players, plus typed usernames).
  A living golem keeps its program until it dies; the commander only changes its *mode*.
- First programming of a golem is free. Reawakening any statue that was programmed before (i.e. a dead golem) costs 1 iron block.
- **Lodestone** (empty hand): programs every living golem of yours within 32 blocks and reawakens your statues in range with the
  chosen program, costing 1 iron block each (free if that golem was never programmed). It also manages **teams**.
  Lists reference teams by name, so editing a team's members updates every golem using it immediately.
- A silk-touched statue item carries its data (dead / waxed / programmed), so break-and-replace can't dodge the iron cost.

## v0.5
- **Guard** follows its owner and attacks anything that hurts them (mobs, players, other golems) - except the owner's own golems and
  anyone on that golem's friendly list (teams included).
- **Golem Commander recipe:** 4 iron nuggets (shapeless, crafting table).
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
  and statue facing (if statues face away from you, swap the north/south and east/west rotations in `BP/blocks/statue.json`).
- Statue block is scaled to fit Bedrock's block-size limit (about 1.8 blocks tall vs the golem's 2.7).
- Dead statues use a slumped-head model, not a different texture.
- Sentry walk-home is stepped teleporting (no scripted pathfinding in Bedrock).
