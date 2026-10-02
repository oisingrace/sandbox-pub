import { OPTIONS } from './settings.js';

// Main menu, pause menu, options and controls screens. The menu only
// renders UI and reports choices; main.js owns game state.

const TABS = [
  ['graphics', 'Graphics'],
  ['destruction', 'Destruction'],
  ['game', 'Game'],
];

export const MODE_NAMES = { free: 'Free roam', football: 'Car football' };
const MODE_BLURBS = {
  free: 'Every wall, tower, window and pole is breakable. More vehicles are parked at the start: press E next to one to drive it. Try the Ember GT: it burns through things instead.',
  football: 'Knock the ball into the orange goal before the clock runs out. You play Blue against a computer driver, or team up online. The sidelines are lined with things to wreck, and the fuel drums in the corners blow the ball around. Press Y to toggle ball cam.',
};

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
    on('btn-garage', () => this.showGarage());
    on('btn-pause-options', () => this.show('options', 'pause'));
    on('btn-pause-controls', () => this.show('controls', 'pause'));
    on('btn-rebuild', () => opts.onRebuild());
    on('btn-quit', () => opts.onQuit());
    on('btn-online', () => this.show('online', 'main'));
    on('btn-host', () => opts.onHost(this.playerName()));
    on('btn-join', () => opts.onJoin(document.getElementById('join-code').value, this.playerName()));
    document.getElementById('join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') opts.onJoin(e.target.value, this.playerName());
    });
    on('btn-leave', () => opts.onLeave());
    on('btn-copy-code', () => this.copyCode());
    on('btn-prev-vehicle', () => this.pickVehicle(-1));
    on('btn-next-vehicle', () => this.pickVehicle(1));
    for (const el of this.root.querySelectorAll('[data-back]')) el.addEventListener('click', () => this.back());
    for (const el of this.root.querySelectorAll('[data-mode]')) {
      el.addEventListener('click', () => {
        opts.onSetting('mode', el.dataset.mode);
        this.renderMode();
        opts.onModePicked?.(el.dataset.mode);
      });
    }
    this.renderMode();

    this.renderVehicle();
    this.renderTabs();
    document.getElementById('player-name').value = opts.getSettings().playerName || '';
  }

  get mode() {
    return this.opts.getSettings().mode === 'football' ? 'football' : 'free';
  }

  renderMode() {
    const mode = this.mode;
    for (const el of this.root.querySelectorAll('[data-mode]')) el.setAttribute('aria-checked', String(el.dataset.mode === mode));
    document.getElementById('mode-blurb').textContent = MODE_BLURBS[mode];
    document.getElementById('room-mode-name').textContent = MODE_NAMES[mode];
  }

  /** The name typed on the online screen (or a generated one). */
  playerName() {
    const input = document.getElementById('player-name');
    let name = input.value.trim().slice(0, 16);
    if (!name) {
      name = `Driver ${Math.floor(10 + Math.random() * 90)}`;
      input.value = name;
    }
    return name;
  }

  setOnlineStatus(message, isError = false) {
    const el = document.getElementById('online-status');
    el.textContent = message;
    el.classList.toggle('error', isError);
  }

  /** Show room details in the pause menu while online. */
  setOnline(online, code, isHost, mode = 'free') {
    document.getElementById('btn-rebuild').textContent = mode === 'football' ? 'Restart match' : 'Rebuild arena';
    document.getElementById('pause-room').hidden = !online;
    document.getElementById('btn-leave').hidden = !online;
    document.getElementById('pause-code').textContent = code || '';
    document.getElementById('pause-role').textContent = isHost ? 'You are hosting' : 'Joined';
    document.getElementById('btn-rebuild').disabled = online && !isHost;
  }

  copyCode() {
    const code = this.opts.onCopyCode();
    const btn = document.getElementById('btn-copy-code');
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
    navigator.clipboard?.writeText(code).then(done, () => {
      // Clipboard blocked: select the code so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('pause-code'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
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

  /** The in-game garage: pick any vehicle and swap into it on the spot. */
  showGarage() {
    const current = this.opts.currentVehicle();
    const list = document.getElementById('garage-list');
    list.replaceChildren(...this.opts.vehicles.map((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'garage-card';
      b.setAttribute('role', 'listitem');
      b.setAttribute('aria-current', String(v.id === current));
      const dot = document.createElement('i');
      dot.style.background = `#${(v.swatch ?? v.color).toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'g-name';
      name.textContent = v.name;
      if (v.id === current) {
        const tag = document.createElement('small');
        tag.textContent = 'Driving';
        name.append(tag);
      }
      const blurb = document.createElement('span');
      blurb.className = 'g-blurb';
      blurb.textContent = v.blurb;
      const stats = document.createElement('span');
      stats.className = 'g-stats';
      stats.innerHTML = `<span><b>${v.stats.top}</b> km/h</span><span><b>${v.stats.accel}</b> s 0–100</span><span><b>${v.spec.mass.toLocaleString('en-US')}</b> kg</span>`;
      b.append(dot, name, blurb, stats);
      b.addEventListener('click', () => {
        this.vehicleIndex = this.opts.vehicles.indexOf(v);
        this.renderVehicle();
        this.opts.onPickVehicle(v);
      });
      return b;
    }));
    this.show('garage', 'pause');
    list.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
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
    document.getElementById('vehicle-swatch').style.background = `#${(v.swatch ?? v.color).toString(16).padStart(6, '0')}`;
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
