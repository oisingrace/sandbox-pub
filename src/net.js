// Peer-to-peer multiplayer over WebRTC (PeerJS). No game server: the
// player who creates a room is the host, everyone else connects straight
// to the host's browser, and the host relays messages between players.
// PeerJS's free public broker is only used to introduce browsers to each
// other when someone joins.
//
// Each client has two connections to the host:
//  - a reliable, ordered one for things that must arrive (joins, leaves,
//    car hits, arena rebuilds), and
//  - a "fast" unordered one for the ~20-per-second updates. Unordered means
//    one slow packet never holds up the ones behind it (no head-of-line
//    blocking); stale updates are recognised by timestamp and dropped.
// The host doesn't forward each car update the moment it arrives: once per
// tick it sends every client one bundle with everyone's newest state (and
// the football match state), so traffic grows with players, not players².
//
// Messages are small JSON objects:
//   hello   { name, vehicle, car }       client -> host on connect (car: custom design, or null)
//   welcome { id, players, mode }        host -> client (mode: the room's game mode)
//   joined  { id, name, vehicle, car }   host -> everyone
//   left    { id }                       host -> everyone
//   event   { id, e }                    one-off events; `e.to` sends to one player only
//   state   { s }                        fast, client -> host: our car (see multiplayer.js)
//   ball    { b }                        fast, client -> host: the football after we hit it
//   tick    { q, l: [[id, s]...], m }    fast, host -> client: everyone else's new car states + match

const PREFIX = 'smashlot-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return s;
}

/** PeerJS options. `?peerhost=host:port` points at a self-hosted broker (for testing). */
function peerOptions() {
  const custom = new URLSearchParams(location.search).get('peerhost');
  if (!custom) return { debug: 0 };
  const [host, port] = custom.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: false, debug: 0, config: { iceServers: [] } };
}

export class Net {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.id = null;
    this.conns = new Map(); // host: peerId -> connection; client: 'host' -> connection
    this.fast = new Map(); // same keys: the unordered connections
    this.latest = new Map(); // host: id -> car states received but not yet sent on
    this.tickSeq = 0;
    this.lastTick = 0;
    this.players = new Map(); // id -> { name, vehicle }
    this.handlers = {};
  }

  get online() {
    return !!this.peer && !!this.id;
  }

  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }

  /** Create a room. Resolves with the room code. */
  host(name, vehicle, mode = 'free', car = null) {
    if (!window.Peer) return Promise.reject(new Error('Multiplayer library failed to load.'));
    return new Promise((resolve, reject) => {
      const attempt = (tries) => {
        const code = randomCode();
        const peer = new window.Peer(PREFIX + code, peerOptions());
        peer.on('open', () => {
          this.peer = peer;
          this.isHost = true;
          this.code = code;
          this.id = 'host';
          this.mode = mode;
          this.players.set('host', { name, vehicle, car });
          peer.on('connection', (conn) => (conn.metadata?.fast ? this.acceptFast(conn) : this.acceptClient(conn)));
          resolve(code);
        });
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && tries < 5) {
            peer.destroy();
            attempt(tries + 1);
          } else if (!this.peer) {
            peer.destroy();
            reject(friendlyError(err));
          } else {
            this.emit('error', friendlyError(err));
          }
        });
        peer.on('disconnected', () => peer.reconnect?.());
      };
      attempt(0);
    });
  }

  /** Host side: a new player connected. */
  acceptClient(conn) {
    conn.on('data', (msg) => {
      if (msg.t === 'hello') {
        const id = conn.peer;
        this.conns.set(id, conn);
        const players = Object.fromEntries(this.players);
        const car = msg.car && typeof msg.car === 'object' ? msg.car : null; // checked by carkit.cleanDesign
        this.players.set(id, { name: msg.name, vehicle: msg.vehicle, car });
        conn.send({ t: 'welcome', id, players, mode: this.mode });
        this.relay({ t: 'joined', id, name: msg.name, vehicle: msg.vehicle, car }, id);
        this.emit('joined', id, msg.name, msg.vehicle, car);
      } else if (msg.t === 'event') {
        msg.id = conn.peer; // trust the connection, not the message
        const to = msg.e?.to;
        if (to && to !== 'host') this.sendTo(to, msg);
        else if (!to) this.relay(msg, conn.peer);
        if (!to || to === 'host') this.dispatch(msg);
      } else {
        this.fromClient(conn.peer, msg);
      }
    });
    const drop = () => {
      if (!this.conns.has(conn.peer)) return;
      this.conns.delete(conn.peer);
      this.fast.get(conn.peer)?.close();
      this.fast.delete(conn.peer);
      this.latest.delete(conn.peer);
      this.players.delete(conn.peer);
      this.relay({ t: 'left', id: conn.peer });
      this.emit('left', conn.peer);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  /** Host side: a client's fast (unordered) connection. */
  acceptFast(conn) {
    this.fast.set(conn.peer, conn);
    conn.on('data', (msg) => {
      msg.fast = 1;
      this.fromClient(conn.peer, msg);
    });
    conn.on('close', () => { if (this.fast.get(conn.peer) === conn) this.fast.delete(conn.peer); });
  }

  /** Host: a high-rate message from a client (on either connection). */
  fromClient(id, msg) {
    if (!this.conns.has(id)) return;
    if (msg.t === 'state') {
      // Keep every update since the last bundle (not just the newest), so
      // receivers get the full 20 per second to interpolate between.
      const list = this.latest.get(id) || [];
      if (list.length < 4) list.push(msg.s);
      this.latest.set(id, list);
      this.emit('state', id, msg.s);
    } else if (msg.t === 'ball') {
      this.emit('ball', id, msg.b);
    }
  }

  /** Join a room by code. Resolves once the host has welcomed us. */
  join(code, name, vehicle, car = null) {
    if (!window.Peer) return Promise.reject(new Error('Multiplayer library failed to load.'));
    code = code.trim().toUpperCase();
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(undefined, peerOptions());
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        peer.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Could not reach that room. Check the code and try again.')), 15000);
      peer.on('error', (err) => {
        if (!settled) { clearTimeout(timer); fail(friendlyError(err)); } else this.emit('error', friendlyError(err));
      });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        conn.on('open', () => conn.send({ t: 'hello', name, vehicle, car }));
        conn.on('data', (msg) => {
          if (msg.t === 'welcome' && !settled) {
            settled = true;
            clearTimeout(timer);
            this.peer = peer;
            this.isHost = false;
            this.code = code;
            this.id = msg.id;
            this.mode = msg.mode || 'free';
            this.conns.set('host', conn);
            this.players = new Map(Object.entries(msg.players));
            this.players.set(msg.id, { name, vehicle, car });
            this.openFast(peer, code);
            resolve(code);
            for (const [id, p] of Object.entries(msg.players)) this.emit('joined', id, p.name, p.vehicle, p.car);
            return;
          }
          if (msg.t === 'joined') {
            this.players.set(msg.id, { name: msg.name, vehicle: msg.vehicle, car: msg.car });
            this.emit('joined', msg.id, msg.name, msg.vehicle, msg.car);
          } else if (msg.t === 'left') {
            this.players.delete(msg.id);
            this.emit('left', msg.id);
          } else {
            this.dispatch(msg);
          }
        });
        conn.on('close', () => {
          if (!settled) return;
          this.emit('hostLeft');
          this.leave();
        });
      });
    });
  }

  /** Client: open the second, unordered connection to the host. */
  openFast(peer, code) {
    const fast = peer.connect(PREFIX + code, { reliable: false, serialization: 'json', metadata: { fast: 1 } });
    fast.on('data', (msg) => {
      msg.fast = 1;
      this.dispatch(msg);
    });
    fast.on('close', () => { if (this.fast.get('host') === fast) this.fast.delete('host'); });
    this.fast.set('host', fast);
  }

  dispatch(msg) {
    if (msg.t === 'tick') {
      for (const [id, s] of msg.l) this.emit('state', id, s);
      // Match state only from bundles newer than the last one we used.
      if (msg.m && msg.q > this.lastTick) this.emit('match', msg.m);
      this.lastTick = Math.max(this.lastTick, msg.q);
    } else if (msg.t === 'event') {
      this.emit('event', msg.id, msg.e);
    }
  }

  /** Host: send to every client except `except`. */
  relay(msg, except) {
    for (const [id, conn] of this.conns) if (id !== except && conn.open) conn.send(msg);
  }

  sendTo(id, msg) {
    const conn = this.conns.get(id);
    if (conn?.open) conn.send(msg);
  }

  /** High-rate message to one peer: the fast connection, or the reliable one until it's open. */
  sendFast(id, msg) {
    const conn = this.fast.get(id);
    if (conn?.open) conn.send(msg);
    else this.sendTo(id, msg);
  }

  /** Client: our car state, to the host. */
  sendState(s) {
    this.sendFast('host', { t: 'state', s });
  }

  /** Client: our copy of the football after we hit it. */
  sendBall(b) {
    this.sendFast('host', { t: 'ball', b });
  }

  /**
   * Host, once per network tick: send each client one bundle with the new
   * states of every other car (our own `own` included) and the football
   * match state `m`, if any.
   */
  flush(own, m = null) {
    if (own) this.latest.set(this.id, [own]);
    if (!this.latest.size && !m) return;
    const q = ++this.tickSeq;
    const all = [];
    for (const [id, list] of this.latest) for (const s of list) all.push([id, s]);
    this.latest.clear();
    for (const id of this.conns.keys()) {
      const l = all.filter(([from]) => from !== id);
      if (l.length || m) this.sendFast(id, m ? { t: 'tick', q, l, m } : { t: 'tick', q, l });
    }
  }

  sendEvent(e) {
    const msg = { t: 'event', id: this.id, e };
    if (!this.isHost) this.sendTo('host', msg);
    else if (e.to) this.sendTo(e.to, msg);
    else this.relay(msg);
  }

  leave() {
    for (const conn of [...this.conns.values(), ...this.fast.values()]) conn.close();
    this.conns.clear();
    this.fast.clear();
    this.latest.clear();
    this.tickSeq = this.lastTick = 0;
    this.players.clear();
    this.peer?.destroy();
    this.peer = null;
    this.id = null;
    this.code = null;
    this.mode = null;
    this.isHost = false;
  }
}

function friendlyError(err) {
  const messages = {
    'peer-unavailable': 'No room with that code. Check it and try again.',
    network: 'Could not reach the multiplayer service. Check your connection.',
    'server-error': 'The multiplayer service is having trouble. Try again in a moment.',
    'socket-error': 'Could not reach the multiplayer service. Check your connection.',
    'browser-incompatible': 'This browser does not support multiplayer.',
  };
  return new Error(messages[err?.type] || err?.message || 'Something went wrong with multiplayer.');
}
