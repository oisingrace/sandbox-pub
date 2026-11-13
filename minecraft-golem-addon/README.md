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

## v0.3 changes
- **Per-golem targeting:** the script picks each golem's target (nearest foe, golems first, assassin skips golems), tags it briefly and
  "hits" the golem as that target so its `hurt_by_target` locks on. No more global target tag.
- **Sentry:** home point is set when made sentry; it walks home in short steps and teleports home if stuck (Bedrock has no scripted pathfinding).
- **Lodestone:** programs awakened golems only. Statues (including dead ones) can only be programmed through the reawakening menu, which still costs an iron block if the golem has died.
- **Assassin:** own component group (faster), ignores golems.
- **Art:** generated item icons, and dead statues use a slumped-head model.
- Owner is re-applied with `tame()` whenever a mode is set.

## Still unverified / limitations
- Everything is untested in-game; the targeting trick (`applyDamage` as the target) is the part most likely to need tweaking.
- Statue block is scaled to fit Bedrock's block-size limit (about 1.8 blocks tall vs the golem's 2.7).
- Dead statues use a different model, not a different texture (needs hand-made art).
