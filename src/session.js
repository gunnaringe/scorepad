// One shared session: an ordered log of change events in SQLite, fanned out to
// every connected device over hibernatable WebSockets. The server doesn't
// interpret events beyond validating them; each device folds the log with
// public/core.js.
//
// Protocol (JSON messages):
//   client -> { t: 'hello', since, device: { id, label } }   replay after seq
//   client -> { t: 'ev', ev }                                 append an event
//   server -> { t: 'evs', evs: [{ seq, ev }] }                new/replayed events
//   server -> { t: 'devices', list: [{ id, label, since }] }
//   server -> { t: 'error', error, id? }
// Event ids are client-generated; a resent event is deduplicated on its id and
// only echoed back to the sender. Storage is wiped 7 days after the last write.

import { DurableObject } from 'cloudflare:workers';
import { isValidEvent } from '../public/core.js';

const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 20000;
const MAX_EVENT_BYTES = 8 * 1024;
const REPLAY_BATCH = 500;

export class Session extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Tables are recreated after the expiry alarm's deleteAll().
  tables() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`);
  }

  // Never creates tables, so probing a wrong code leaves no storage behind.
  exists() {
    const tables = this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray();
    return tables.length > 0 && this.sql.exec(`SELECT 1 FROM meta WHERE k = 'created'`).toArray().length > 0;
  }

  // Events are never deleted one by one, so the last seq is the count (and,
  // unlike COUNT(*), reads one row).
  count() {
    return this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n;
  }

  async touch() {
    await this.ctx.storage.setAlarm(Date.now() + TTL);
  }

  // RPC from the Worker. False if the code is already taken.
  async create(events) {
    if (this.exists()) return false;
    this.tables();
    this.sql.exec(`INSERT INTO meta (k, v) VALUES ('created', ?)`, String(Date.now()));
    for (const ev of events.slice(0, MAX_EVENTS)) {
      const body = JSON.stringify(ev);
      if (body.length <= MAX_EVENT_BYTES) {
        this.sql.exec(`INSERT INTO events (id, body) VALUES (?, ?) ON CONFLICT DO NOTHING`, ev.id, body);
      }
    }
    await this.touch();
    return true;
  }

  async info() {
    if (!this.exists()) return null;
    const expires = await this.ctx.storage.getAlarm();
    return { count: this.count(), expires };
  }

  async fetch() {
    if (!this.exists()) return new Response('not found', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ device: null, since: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closing.
    }
  }

  // Sockets that have said hello, i.e. are caught up and want broadcasts.
  peers(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.deserializeAttachment()?.device);
  }

  broadcastDevices(except) {
    const list = this.peers(except).map((ws) => {
      const { device, since } = ws.deserializeAttachment();
      return { ...device, since };
    });
    for (const ws of this.peers(except)) this.send(ws, { t: 'devices', list });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_EVENT_BYTES * 2) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!this.exists()) {
      ws.close(4404, 'expired');
      return;
    }

    if (msg.t === 'hello') {
      const device = {
        id: String(msg.device?.id ?? '').slice(0, 64),
        label: String(msg.device?.label ?? '').slice(0, 60),
      };
      ws.serializeAttachment({ ...ws.deserializeAttachment(), device });
      const since = Number.isFinite(msg.since) ? msg.since : 0;
      const rows = this.sql.exec(`SELECT seq, body FROM events WHERE seq > ? ORDER BY seq`, since).toArray();
      for (let i = 0; i < rows.length; i += REPLAY_BATCH) {
        const evs = rows.slice(i, i + REPLAY_BATCH).map((r) => ({ seq: r.seq, ev: JSON.parse(r.body) }));
        this.send(ws, { t: 'evs', evs });
      }
      if (!rows.length) this.send(ws, { t: 'evs', evs: [] });
      this.broadcastDevices();
      return;
    }

    if (msg.t === 'ev') {
      const ev = msg.ev;
      if (!isValidEvent(ev)) return this.send(ws, { t: 'error', error: 'invalid', id: ev?.id });
      const body = JSON.stringify(ev);
      if (body.length > MAX_EVENT_BYTES) return this.send(ws, { t: 'error', error: 'size', id: ev.id });
      const dup = this.sql.exec(`SELECT seq FROM events WHERE id = ?`, ev.id).toArray()[0];
      if (dup) return this.send(ws, { t: 'evs', evs: [{ seq: dup.seq, ev }] });
      if (this.count() >= MAX_EVENTS) return this.send(ws, { t: 'error', error: 'full', id: ev.id });
      const { seq } = this.sql.exec(`INSERT INTO events (id, body) VALUES (?, ?) RETURNING seq`, ev.id, body).one();
      await this.touch();
      const out = { t: 'evs', evs: [{ seq, ev }] };
      for (const peer of this.peers()) this.send(peer, out);
    }
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      // Already closed.
    }
    this.broadcastDevices(ws);
  }

  async webSocketError(ws) {
    this.broadcastDevices(ws);
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4404, 'expired');
      } catch {
        // Ignore.
      }
    }
    await this.ctx.storage.deleteAll();
  }
}
