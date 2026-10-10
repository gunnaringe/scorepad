// Local persistence and live sync.
//
// A session record is an event log: `events` are confirmed (all of them for a
// solo session; numbered by the server, up to `lastSeq`, for a shared one) and
// `pending` are local events the server hasn't echoed yet. State is always
// reduce(events + pending), so offline edits just wait in `pending` and are
// resent on reconnect (the server deduplicates on event id).

import { reduce, newId } from './core.js';

const K_INDEX = 'scorepad-sessions-v1';
const K_SESSION = (id) => `scorepad-session-v1-${id}`;
const K_SETTINGS = 'scorepad-settings-v1';
const K_PLAYERS = 'scorepad-players-v1';
const K_DEVICE = 'scorepad-device-v1';

const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode: the app keeps working in memory.
  }
};

// --- Settings ----------------------------------------------------------------

export const defaultSettings = () => ({ lang: 'auto', theme: 'hytte', wake: false });

export function loadSettings() {
  return { ...defaultSettings(), ...read(K_SETTINGS, {}) };
}

export function saveSettings(s) {
  write(K_SETTINGS, s);
}

// --- Recent players (this device only) ---------------------------------------

export function recentPlayers() {
  const all = Object.values(read(K_PLAYERS, {}));
  // Recency first, frequency as tie-breaker within the same day.
  return all.sort((a, b) => Math.floor(b.lastUsed / 864e5) - Math.floor(a.lastUsed / 864e5) || b.count - a.count || b.lastUsed - a.lastUsed);
}

export function rememberPlayers(names) {
  const all = read(K_PLAYERS, {});
  const now = Date.now();
  for (const name of names) {
    const key = name.toLocaleLowerCase();
    const p = all[key] ?? { name, count: 0 };
    all[key] = { name, count: p.count + 1, lastUsed: now };
  }
  write(K_PLAYERS, all);
}

export function forgetPlayer(name) {
  const all = read(K_PLAYERS, {});
  delete all[name.toLocaleLowerCase()];
  write(K_PLAYERS, all);
}

// --- Device ------------------------------------------------------------------

export function deviceId() {
  let id = read(K_DEVICE, null);
  if (!id) write(K_DEVICE, (id = newId()));
  return id;
}

// "iPhone · Safari", "Linux · Firefox": enough to tell devices apart.
export function deviceLabel(ua = navigator.userAgent) {
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '?';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

// --- Session records ---------------------------------------------------------

export function listSessions() {
  return read(K_INDEX, [])
    .map((id) => read(K_SESSION(id), null))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(id) {
  return read(K_SESSION(id), null);
}

export function saveSession(rec) {
  rec.updatedAt = Date.now();
  write(K_SESSION(rec.id), rec);
  const index = read(K_INDEX, []);
  if (!index.includes(rec.id)) write(K_INDEX, [...index, rec.id]);
}

export function deleteSession(id) {
  localStorage.removeItem(K_SESSION(id));
  write(K_INDEX, read(K_INDEX, []).filter((x) => x !== id));
}

export function newSession({ code = null, events = [] } = {}) {
  const now = Date.now();
  const rec = { id: newId(), code, createdAt: now, updatedAt: now, events, pending: [], lastSeq: 0, expired: false };
  saveSession(rec);
  return rec;
}

export function findByCode(code) {
  return listSessions().find((s) => s.code === code && !s.expired) ?? null;
}

// --- API ---------------------------------------------------------------------

export async function sessionExists(code) {
  const res = await fetch(`/api/session/${code}`, { cache: 'no-store' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// --- Live session ------------------------------------------------------------

export class Live {
  constructor(rec, onChange) {
    this.rec = rec;
    this.onChange = onChange;
    this.status = 'offline'; // offline | connecting | online
    this.devices = [];
    this.ws = null;
    this.retry = 0;
    this.closed = false;
    this.recompute();
    if (this.shared) this.connect();
    this.wake = () => {
      if (this.shared && this.status === 'offline' && document.visibilityState === 'visible') this.connect(true);
    };
    addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }

  get shared() {
    return !!this.rec.code && !this.rec.expired;
  }

  recompute() {
    this.state = reduce([...this.rec.events, ...this.rec.pending]);
  }

  changed(what = 'state') {
    if (what === 'state') {
      this.recompute();
      saveSession(this.rec);
    }
    this.onChange?.(what);
  }

  dispatch(fields) {
    const ev = { ...fields, id: newId(), at: Date.now() };
    if (this.shared) {
      this.rec.pending.push(ev);
      this.sendEvent(ev);
    } else {
      this.rec.events.push(ev);
    }
    this.changed();
    return ev;
  }

  // Turns a solo (or expired) session into a shared one.
  async share() {
    const events = [...this.rec.events, ...this.rec.pending];
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { code } = await res.json();
    // The server numbered the events 1..n in this order.
    Object.assign(this.rec, { code, events, pending: [], lastSeq: events.length, expired: false });
    this.changed();
    this.connect(true);
    return code;
  }

  // Keeps the local copy, stops syncing.
  leave() {
    this.rec.events = [...this.rec.events, ...this.rec.pending];
    this.rec.pending = [];
    this.rec.code = null;
    this.rec.lastSeq = 0;
    this.disconnect();
    this.changed();
  }

  setStatus(status) {
    this.status = status;
    this.onChange?.('status');
  }

  connect(now = false) {
    if (this.closed || !this.shared) return;
    clearTimeout(this.timer);
    if (this.ws) return;
    const delay = now ? 0 : Math.min(15000, 1000 * 2 ** this.retry);
    this.timer = setTimeout(() => this.open(), delay);
  }

  open() {
    if (this.closed || this.ws || !this.shared) return;
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/session/${this.rec.code}/ws`);
    let opened = false;
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', since: this.rec.lastSeq, device: { id: deviceId(), label: deviceLabel() } }));
      for (const ev of this.rec.pending) ws.send(JSON.stringify({ t: 'ev', ev }));
      this.setStatus('online');
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
    };
    ws.onmessage = (m) => this.receive(m.data);
    ws.onclose = async (e) => {
      clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      this.devices = [];
      this.setStatus('offline');
      if (this.closed) return;
      if (e.code === 4404 || (!opened && (await this.gone()))) {
        // Deleted on the server: carry on as a local copy.
        this.rec.expired = true;
        this.leave();
        return;
      }
      this.retry++;
      this.connect();
    };
  }

  // After a failed connect: is the session deleted, or are we just offline?
  async gone() {
    try {
      return !(await sessionExists(this.rec.code));
    } catch {
      return false;
    }
  }

  sendEvent(ev) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'ev', ev }));
  }

  receive(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // 'pong'
    }
    if (msg.t === 'devices') {
      this.devices = msg.list;
      this.onChange?.('devices');
    } else if (msg.t === 'evs') {
      let dirty = false;
      for (const { seq, ev } of msg.evs) {
        if (seq <= this.rec.lastSeq) continue;
        if (seq !== this.rec.lastSeq + 1) {
          // Missed something: reconnect and replay from what we have.
          this.ws?.close(4000, 'gap');
          break;
        }
        this.rec.events.push(ev);
        this.rec.lastSeq = seq;
        this.rec.pending = this.rec.pending.filter((p) => p.id !== ev.id);
        dirty = true;
      }
      if (dirty) this.changed();
    } else if (msg.t === 'error' && msg.id) {
      // Rejected: drop it so it isn't resent forever.
      this.rec.pending = this.rec.pending.filter((p) => p.id !== msg.id);
      this.changed();
    }
  }

  disconnect() {
    clearTimeout(this.timer);
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bye');
    this.devices = [];
    this.status = 'offline';
  }

  close() {
    this.closed = true;
    this.disconnect();
    removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
  }
}
