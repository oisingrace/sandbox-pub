import { ModalFormData, ActionFormData } from "@minecraft/server-ui";
import { knownPlayers, teams, saveTeams, MODES } from "./store.js";

const split = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// Reawakening menu. `data` is mutated and returned via callback.
export async function awakenMenu(player, data, onDone) {
  const players = knownPlayers().filter((n) => n !== data.ownerName);
  const tnames = Object.keys(teams());
  const f = new ModalFormData().title("Reawaken Golem");
  f.label("Hostile to (players who have joined):");
  players.forEach((n) => f.toggle(n, { defaultValue: data.hostile.includes(n) }));
  f.textField("Extra hostile usernames (comma separated)", "Steve, Alex", { defaultValue: "" });
  f.label("Friendly to:");
  tnames.forEach((t) => f.toggle(`Team: ${t}`, { defaultValue: data.friendly.includes(`team:${t}`) }));
  players.forEach((n) => f.toggle(n, { defaultValue: data.friendly.includes(n) }));
  f.textField("Extra friendly usernames (comma separated)", "Steve, Alex", { defaultValue: "" });
  const r = await f.show(player);
  if (r.canceled) return;
  // formValues includes labels as undefined entries; filter by index math.
  let i = 1; // after label
  const hostile = [], friendly = [];
  players.forEach((n) => { if (r.formValues[i++]) hostile.push(n); });
  hostile.push(...split(r.formValues[i++]));
  i++; // label
  tnames.forEach((t) => { if (r.formValues[i++]) friendly.push(`team:${t}`); });
  players.forEach((n) => { if (r.formValues[i++]) friendly.push(n); });
  friendly.push(...split(r.formValues[i++]));
  onDone({ ...data, hostile, friendly });
}

export async function modeMenu(player, onPick) {
  const f = new ActionFormData().title("Golem Commander").body("Set mode for all your golems nearby");
  MODES.forEach((m) => f.button(m[0].toUpperCase() + m.slice(1)));
  const r = await f.show(player);
  if (!r.canceled) onPick(MODES[r.selection]);
}

// Lodestone: program every golem in radius + manage teams.
export async function lodestoneMenu(player, onProgram) {
  const f = new ActionFormData().title("Lodestone").button("Program golems in range").button("Create / edit team");
  const r = await f.show(player);
  if (r.canceled) return;
  if (r.selection === 0) return onProgram();
  const t = teams();
  const g = new ModalFormData().title("Team")
    .textField("Team name", "Red")
    .textField("Members (comma separated, replaces list)", "Steve, Alex");
  const rr = await g.show(player);
  if (rr.canceled || !rr.formValues[0]) return;
  t[rr.formValues[0]] = split(rr.formValues[1]);
  saveTeams(t);
  player.sendMessage(`§aTeam ${rr.formValues[0]} saved.`);
}
