import { STYLES, ENGINES, ABILITIES, WEAPON_MOUNTS, PARTS, SIZE_KEYS, TUNE_KEYS, DEFAULT_DESIGN, cleanDesign, compileCar, designToCode, codeToDesign, newDesignId } from './carkit.js';
import { MAX_CUSTOM } from './customs.js';

// The car workshop: a list of your custom cars, and an editor with a live
// 3D preview (drawn by main.js behind the menu) and measured stats.
//
// Callbacks (all from main.js):
//   garage            the Garage registry (customs.js)
//   show(name)        switch menu screen
//   onPreview(design) draw this design behind the menu (null: stop)
//   onSaved(def)      a design was saved (refresh the fleet)
//   onDeleted(id)
//   onTestDrive(def)  save done; go and drive it

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
};

export class Workshop {
  constructor(opts) {
    this.opts = opts;
    this.list = document.getElementById('workshop-list');
    this.form = document.getElementById('editor-form');
    this.status = document.getElementById('workshop-status');
    this.statsEl = document.getElementById('editor-stats');
    this.design = null;
    this.pending = false;
    document.getElementById('btn-new-car').addEventListener('click', () => this.edit(cleanDesign({ ...DEFAULT_DESIGN, id: newDesignId() })));
    document.getElementById('btn-import-car').addEventListener('click', () => this.importCode());
    document.getElementById('btn-editor-save').addEventListener('click', () => this.save());
    document.getElementById('btn-editor-drive').addEventListener('click', () => this.save(true));
    document.getElementById('btn-editor-share').addEventListener('click', () => this.share());
    document.getElementById('btn-editor-delete').addEventListener('click', () => this.remove());
    document.getElementById('btn-editor-back').addEventListener('click', () => this.open());
  }

  /** The list of your cars. */
  open() {
    this.opts.onPreview(null);
    const { garage } = this.opts;
    this.setStatus('');
    if (!garage.custom.length) {
      this.list.replaceChildren(el('p', { class: 'online-intro', text: 'No custom cars yet. Make one, or paste a code a friend shared.' }));
    } else {
      this.list.replaceChildren(...garage.custom.map((v) => {
        const b = el('button', { type: 'button', class: 'garage-card', role: 'listitem' });
        const dot = el('i');
        dot.style.background = hex(v.color);
        const name = el('span', { class: 'g-name', text: v.name });
        const blurb = el('span', { class: 'g-blurb', text: v.blurb });
        const stats = el('span', { class: 'g-stats' });
        stats.innerHTML = `<span><b>${v.stats.top}</b> km/h</span><span><b>${v.stats.accel}</b> s 0–100</span><span><b>${v.spec.mass.toLocaleString('en-US')}</b> kg</span>`;
        b.append(dot, name, blurb, stats);
        b.addEventListener('click', () => this.edit(v.design));
        return b;
      }));
    }
    document.getElementById('btn-new-car').disabled = garage.custom.length >= MAX_CUSTOM;
    this.opts.show('workshop');
  }

  /** Open the editor on a design (a copy, so Back discards changes). */
  edit(design) {
    this.design = structuredClone(design);
    this.isNew = !this.opts.garage.designs.some((d) => d.id === design.id);
    document.getElementById('btn-editor-delete').hidden = this.isNew;
    this.render();
    this.opts.show('editor');
    this.changed();
  }

  setStatus(msg, error = false) {
    for (const id of ['workshop-status', 'editor-status']) {
      const s = document.getElementById(id);
      s.textContent = msg;
      s.classList.toggle('error', error);
    }
  }

  /**
   * A change was made: update the preview (at most once a frame) and the
   * measured stats (once the sliders stop moving).
   */
  changed() {
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        this.opts.onPreview(this.design);
      });
    }
    this.statsEl.classList.add('stale');
    clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => {
      const def = compileCar(this.design);
      this.statsEl.classList.remove('stale');
      this.statsEl.innerHTML = `<span><b>${def.stats.top}</b> km/h</span><span><b>${def.stats.accel}</b> s 0–100</span><span><b>${def.spec.mass.toLocaleString('en-US')}</b> kg</span>`;
    }, 180);
  }

  render() {
    const d = this.design;
    const rows = [];
    const row = (label, control, hint) => {
      const text = el('div', { class: 'opt-text' }, el('span', { class: 'opt-label', text: label }));
      if (hint) text.append(el('span', { class: 'opt-hint', text: hint }));
      return el('div', { class: 'opt' }, text, control);
    };
    const seg = (label, choices, get, set) => {
      const g = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
      const paint = () => { for (const b of g.children) b.setAttribute('aria-checked', String(b.dataset.v === String(get()))); };
      for (const [v, text] of Object.entries(choices)) {
        const b = el('button', { type: 'button', role: 'radio', text });
        b.dataset.v = v;
        b.addEventListener('click', () => { set(v); paint(); this.changed(); });
        g.append(b);
      }
      paint();
      return g;
    };
    const slider = (obj, key) => {
      const wrap = el('label', { class: 'slider' });
      const input = el('input', { type: 'range', min: 0, max: 1, step: 0.01 });
      input.value = obj[key];
      const out = el('output', { text: `${Math.round(obj[key] * 100)}` });
      input.addEventListener('input', () => { obj[key] = Number(input.value); out.textContent = Math.round(obj[key] * 100); this.changed(); });
      wrap.append(input, out);
      return wrap;
    };
    const head = (text) => el('h3', { class: 'editor-head', text });

    const name = el('input', { type: 'text', maxlength: 22, value: d.name, autocomplete: 'off', 'aria-label': 'Name' });
    name.addEventListener('input', () => { d.name = name.value; });
    rows.push(el('label', { class: 'field' }, el('span', { text: 'Name' }), name));

    rows.push(head('Body'));
    rows.push(row('Style', seg('Style', Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, s.label])), () => d.style, (v) => {
      d.style = v;
      d.engine = STYLES[v].engine; // a sensible engine for the new body
      this.render();
    })));
    const colours = el('div', { class: 'colours' });
    for (const [key, label] of [['color', 'Body'], ['trim', 'Trim'], ['accent', 'Glow']]) {
      const input = el('input', { type: 'color', value: hex(d[key]), 'aria-label': `${label} colour` });
      input.addEventListener('input', () => { d[key] = parseInt(input.value.slice(1), 16); this.changed(); });
      colours.append(el('label', { class: 'colour' }, input, el('span', { text: label })));
    }
    rows.push(row('Colours', colours));
    for (const [k, label] of Object.entries(SIZE_KEYS)) rows.push(row(label, slider(d.size, k)));

    rows.push(head('Parts'));
    const parts = el('div', { class: 'seg parts' });
    for (const [k, label] of Object.entries(PARTS)) {
      const b = el('button', { type: 'button', text: label, 'aria-pressed': String(d.parts.includes(k)) });
      b.addEventListener('click', () => {
        d.parts = d.parts.includes(k) ? d.parts.filter((p) => p !== k) : [...d.parts, k];
        b.setAttribute('aria-pressed', String(d.parts.includes(k)));
        this.changed();
      });
      parts.append(b);
    }
    rows.push(parts);
    rows.push(row('Weapon', seg('Weapon', WEAPON_MOUNTS, () => d.weapon, (v) => { d.weapon = v; }),
      'On the roof. In Versus it is your car\'s own weapon (rockets and mines reload over time); in free roam, fire it at the scenery with X or a click'));
    rows.push(row('Special', seg('Special ability', ABILITIES, () => d.ability, (v) => { d.ability = v; })));
    const jump = el('button', { type: 'button', text: d.aerial ? 'On' : 'Off', 'aria-pressed': String(!!d.aerial) });
    jump.addEventListener('click', () => {
      d.aerial = !d.aerial;
      jump.setAttribute('aria-pressed', String(d.aerial));
      jump.textContent = d.aerial ? 'On' : 'Off';
      this.changed();
    });
    rows.push(row('Jumps and air control', el('div', { class: 'seg' }, jump), 'Like the Striker: Space jumps, double jumps and flips; steer in the air'));

    rows.push(head('Engine and handling'));
    rows.push(row('Engine sound', seg('Engine sound', ENGINES, () => d.engine, (v) => { d.engine = v; })));
    for (const [k, [label, hint]] of Object.entries(TUNE_KEYS)) rows.push(row(label, slider(d.tune, k), hint));

    this.form.replaceChildren(...rows);
  }

  save(drive = false) {
    try {
      const def = this.opts.garage.save(this.design);
      this.design = structuredClone(def.design);
      this.isNew = false;
      document.getElementById('btn-editor-delete').hidden = false;
      this.opts.onSaved(def);
      this.setStatus(`Saved. ${def.name} is in your garage${drive ? '' : ' and parked behind the start line'}.`);
      if (drive) this.opts.onTestDrive(def);
    } catch (err) {
      this.setStatus(err.message, true);
    }
  }

  remove() {
    if (!confirm(`Delete ${this.design.name}?`)) return;
    this.opts.garage.remove(this.design.id);
    this.opts.onDeleted(this.design.id);
    this.open();
  }

  share() {
    const code = designToCode(this.design);
    const box = document.getElementById('editor-code');
    box.hidden = false;
    box.value = code;
    box.select();
    navigator.clipboard?.writeText(code).then(
      () => this.setStatus('Share code copied. Friends can paste it under Import in their workshop.'),
      () => this.setStatus('Copy the code above and send it to a friend.'),
    );
  }

  importCode() {
    const input = document.getElementById('import-code');
    try {
      const design = codeToDesign(input.value);
      input.value = '';
      this.edit(design);
      this.setStatus('Imported. Save it to keep it.');
    } catch {
      this.setStatus('That code didn’t work. Check it was copied completely.', true);
    }
  }
}
