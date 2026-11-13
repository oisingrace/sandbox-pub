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

## Known gaps / TODO
1. Target tag `golem_target` is global, not per golem (a golem may attack someone only a different owner's golem is hostile to). Needs per-golem targeting.
2. Sentry "walk home" uses crude `applyKnockback`; replace with proper navigation.
3. Lodestone doesn't yet reprogram dead statues (iron-block cost) or handle statues in range.
4. Placeholder textures/geometry for the statue and commander (vanilla stone/stick).
5. Awakened statue reuses owner `tame()`; verify follow_owner works with the script-set owner.
6. Assassin currently shares attack's AI group; needs its own tuning.
