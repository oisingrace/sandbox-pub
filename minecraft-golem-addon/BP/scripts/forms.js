import { system } from "@minecraft/server";
import { ModalFormData, ActionFormData } from "@minecraft/server-ui";
import { knownPlayers, teams, saveTeams, MODES } from "./store.js";

// Forms fail with "UserBusy" if chat/another screen is open; retry for a few seconds.
async function show(form, player) {
  for (let i = 0; i < 20; i++) {
    const r = await form.show(player);
    if (!r.canceled || r.cancelationReason !== "UserBusy") return r;
    await new Promise((res) => system.runTimeout(res, 10));
  }
  return { canceled: true };
}
const split = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// Reawakening menu. `data` is mutated and returned via callback.
export async function awakenMenu(player, data, onDone) {
  const players = knownPlayers().filter((n) => n !== data.ownerName);
  const tnames = Object.keys(teams());
  const f = new ModalFormData().title("Program Golem");
  f.label("Hostile to (players who have joined, and teams):");
  players.forEach((n) => f.toggle(n, { defaultValue: data.hostile.includes(n) }));
  tnames.forEach((t) => f.toggle(`Team: ${t}`, { defaultValue: data.hostile.includes(`team:${t}`) }));
  f.textField("Extra hostile usernames (comma separated)", "Steve, Alex", { defaultValue: "" });
  f.label("Friendly to:");
  tnames.forEach((t) => f.toggle(`Team: ${t}`, { defaultValue: data.friendly.includes(`team:${t}`) }));
  players.forEach((n) => f.toggle(n, { defaultValue: data.friendly.includes(n) }));
  f.textField("Extra friendly usernames (comma separated)", "Steve, Alex", { defaultValue: "" });
  const r = await show(f, player);
  if (r.canceled) return;
  // formValues has one entry per element; labels come back undefined, so walk it in order.
  let i = 1; // skip first label
  const hostile = [], friendly = [];
  players.forEach((n) => { if (r.formValues[i++]) hostile.push(n); });
  tnames.forEach((t) => { if (r.formValues[i++]) hostile.push(`team:${t}`); });
  hostile.push(...split(r.formValues[i++]));
  i++; // second label
  tnames.forEach((t) => { if (r.formValues[i++]) friendly.push(`team:${t}`); });
  players.forEach((n) => { if (r.formValues[i++]) friendly.push(n); });
  friendly.push(...split(r.formValues[i++]));
  onDone({ ...data, hostile, friendly });
}

export async function modeMenu(player, onPick) {
  const f = new ActionFormData().title("Golem Commander").body("Set mode for all your golems nearby");
  MODES.forEach((m) => f.button(m[0].toUpperCase() + m.slice(1)));
  const r = await show(f, player);
  if (!r.canceled) onPick(MODES[r.selection]);
}

// Lodestone: program every golem in radius + manage teams.
export async function lodestoneMenu(player, onProgram) {
  const f = new ActionFormData().title("Lodestone").button("Program golems in range").button("Create / edit team");
  const r = await show(f, player);
  if (r.canceled) return;
  if (r.selection === 0) return onProgram();
  const t = teams();
  const g = new ModalFormData().title("Team")
    .textField("Team name", "Red")
    .textField("Members (comma separated, replaces list)", "Steve, Alex");
  const rr = await show(g, player);
  if (rr.canceled || !rr.formValues[0]) return;
  t[rr.formValues[0]] = split(rr.formValues[1]);
  saveTeams(t);
  player.sendMessage(`§aTeam ${rr.formValues[0]} saved.`);
}
