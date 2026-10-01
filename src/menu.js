import { OPTIONS } from './settings.js';

// Main menu, pause menu, options and controls screens. The menu only
// renders UI and reports choices; main.js owns game state.

const TABS = [
  ['graphics', 'Graphics'],
  ['destruction', 'Destruction'],
  ['game', 'Game'],
];

export class Menu {
  /**
   * @param {object} opts
   * @param {Array} opts.vehicles  vehicle definitions
   * @param {() => object} opts.getSettings
   * @param {(key: string, value: any) => void} opts.onSetting
   * @param {() => void} opts.onPlay
   * @param {() => void} opts.onResume
   * @param {() => void} opts.onRebuild
   * @param {() => void} opts.onQuit
   */
  constructor(opts) {
    this.opts = opts;
    this.root = document.getElementById('menu');
    this.screens = {};
    for (const el of this.root.querySelectorAll('.screen')) this.screens[el.dataset.screen] = el;
    this.tab = 'graphics';
    this.backTo = 'main';
    this.vehicleIndex = Math.max(0, opts.vehicles.findIndex((v) => v.id === opts.getSettings().startVehicle));

    const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
    on('btn-play', () => opts.onPlay(this.vehicle));
    on('btn-options', () => this.show('options', 'main'));
    on('btn-controls', () => this.show('controls', 'main'));
    on('btn-resume', () => opts.onResume());
    on('btn-pause-options', () => this.show('options', 'pause'));
    on('btn-pause-controls', () => this.show('controls', 'pause'));
    on('btn-rebuild', () => opts.onRebuild());
    on('btn-quit', () => opts.onQuit());
    on('btn-prev-vehicle', () => this.pickVehicle(-1));
    on('btn-next-vehicle', () => this.pickVehicle(1));
    for (const el of this.root.querySelectorAll('[data-back]')) el.addEventListener('click', () => this.back());

    this.renderVehicle();
    this.renderTabs();
  }

  get vehicle() {
    return this.opts.vehicles[this.vehicleIndex];
  }

  get isOpen() {
    return !this.root.hidden;
  }

  get current() {
    return this.screen;
  }

  /** Show a screen; `from` is where its Back button returns to. */
  show(name, from) {
    this.root.hidden = false;
    document.body.classList.add('in-menu');
    if (from) this.backTo = from;
    for (const [key, el] of Object.entries(this.screens)) el.hidden = key !== name;
    this.screen = name;
    if (name === 'options') this.renderOptions();
    const first = this.screens[name].querySelector('.primary') || this.screens[name].querySelector('button');
    first?.focus({ preventScroll: true });
  }

  hide() {
    this.root.hidden = true;
    document.body.classList.remove('in-menu');
    this.screen = null;
  }

  back() {
    this.show(this.backTo);
  }

  pickVehicle(dir) {
    const n = this.opts.vehicles.length;
    this.vehicleIndex = (this.vehicleIndex + dir + n) % n;
    this.renderVehicle();
    this.opts.onSetting('startVehicle', this.vehicle.id);
  }

  renderVehicle() {
    const v = this.vehicle;
    document.getElementById('vehicle-name').textContent = v.name;
    document.getElementById('vehicle-blurb').textContent = v.blurb;
    const mass = v.spec.mass.toLocaleString('en-US');
    document.getElementById('vehicle-stats').innerHTML =
      `<span><b>${v.stats.top}</b> km/h</span><span><b>${v.stats.accel}</b> s 0–100</span><span><b>${mass}</b> kg</span>`;
    document.getElementById('vehicle-swatch').style.background = `#${v.color.toString(16).padStart(6, '0')}`;
  }

  renderTabs() {
    const bar = document.getElementById('option-tabs');
    bar.innerHTML = '';
    for (const [id, label] of TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { this.tab = id; this.renderOptions(); });
      b.dataset.tab = id;
      bar.appendChild(b);
    }
  }

  renderOptions() {
    const settings = this.opts.getSettings();
    for (const b of document.querySelectorAll('#option-tabs button')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
    }
    const list = document.getElementById('option-list');
    list.innerHTML = '';
    for (const [key, def] of Object.entries(OPTIONS[this.tab])) {
      if (!def.choices.length) continue;
      const row = document.createElement('div');
      row.className = 'opt';
      const text = document.createElement('div');
      text.className = 'opt-text';
      text.innerHTML = `<span class="opt-label"></span>${def.hint ? '<span class="opt-hint"></span>' : ''}`;
      text.querySelector('.opt-label').textContent = def.label;
      if (def.hint) text.querySelector('.opt-hint').textContent = def.hint;
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', def.label);
      for (const [value, label] of def.choices) {
        if (key === 'preset' && value === 'custom' && settings.preset !== 'custom') continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(settings[key] === value));
        b.addEventListener('click', () => {
          this.opts.onSetting(key, value);
          this.renderOptions();
          list.querySelector(`[data-key="${key}"] [aria-checked="true"]`)?.focus({ preventScroll: true });
        });
        seg.appendChild(b);
      }
      row.dataset.key = key;
      row.append(text, seg);
      list.appendChild(row);
    }
  }
}
