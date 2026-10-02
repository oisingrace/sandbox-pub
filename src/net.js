// Peer-to-peer multiplayer over WebRTC (PeerJS). No game server: the
// player who creates a room is the host, everyone else connects straight
// to the host's browser, and the host relays messages between players.
// PeerJS's free public broker is only used to introduce browsers to each
// other when someone joins.
//
// Messages are small JSON objects:
//   hello   { name, vehicle }            client -> host on connect
//   welcome { id, players, mode }        host -> client (mode: the room's game mode)
//   joined  { id, name, vehicle }        host -> everyone
//   left    { id }                       host -> everyone
//   state   { id, s }                    car state, ~20 per second
//   event   { id, e }                    one-off events (arena rebuild, ...)
//   match   { m }                        host -> everyone: football ball and score

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
  host(name, vehicle, mode = 'free') {
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
          this.players.set('host', { name, vehicle });
          peer.on('connection', (conn) => this.acceptClient(conn));
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
        this.players.set(id, { name: msg.name, vehicle: msg.vehicle });
        conn.send({ t: 'welcome', id, players, mode: this.mode });
        this.relay({ t: 'joined', id, name: msg.name, vehicle: msg.vehicle }, id);
        this.emit('joined', id, msg.name, msg.vehicle);
      } else if (msg.t === 'state' || msg.t === 'event') {
        msg.id = conn.peer; // trust the connection, not the message
        this.relay(msg, conn.peer);
        this.dispatch(msg);
      }
    });
    const drop = () => {
      if (!this.conns.has(conn.peer)) return;
      this.conns.delete(conn.peer);
      this.players.delete(conn.peer);
      this.relay({ t: 'left', id: conn.peer });
      this.emit('left', conn.peer);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  /** Join a room by code. Resolves once the host has welcomed us. */
  join(code, name, vehicle) {
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
        conn.on('open', () => conn.send({ t: 'hello', name, vehicle }));
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
            this.players.set(msg.id, { name, vehicle });
            resolve(code);
            for (const [id, p] of Object.entries(msg.players)) this.emit('joined', id, p.name, p.vehicle);
            return;
          }
          if (msg.t === 'joined') {
            this.players.set(msg.id, { name: msg.name, vehicle: msg.vehicle });
            this.emit('joined', msg.id, msg.name, msg.vehicle);
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

  dispatch(msg) {
    if (msg.t === 'state') this.emit('state', msg.id, msg.s);
    else if (msg.t === 'event') this.emit('event', msg.id, msg.e);
    else if (msg.t === 'match') this.emit('match', msg.m);
  }

  /** Host: send to every client except `except`. */
  relay(msg, except) {
    for (const [id, conn] of this.conns) if (id !== except && conn.open) conn.send(msg);
  }

  /** Send our car state (host broadcasts it; clients send it to the host). */
  sendState(s) {
    const msg = { t: 'state', id: this.id, s };
    if (this.isHost) this.relay(msg);
    else this.conns.get('host')?.open && this.conns.get('host').send(msg);
  }

  /** Host: football match state for everyone. */
  sendMatch(m) {
    if (this.isHost) this.relay({ t: 'match', m });
  }

  sendEvent(e) {
    const msg = { t: 'event', id: this.id, e };
    if (this.isHost) this.relay(msg);
    else this.conns.get('host')?.open && this.conns.get('host').send(msg);
  }

  leave() {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
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
