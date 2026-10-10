// Session state as a fold over change events. The same reducer runs in every
// browser and in the session Durable Object, so it must be deterministic and
// must never throw on bad input: events from other devices are untrusted and
// are sanitized here, malformed ones are ignored.

import { PRESETS, sanitizeSettings } from './rules.js';

export const EVENT_TYPES = [
  'addPlayer', 'renamePlayer',
  'newGame', 'updateGame', 'deleteGame', 'endGame',
  'putRound', 'deleteRound',
];

const TYPES = new Set(EVENT_TYPES);
const MAX_PLAYERS = 12;

export function isValidEvent(ev) {
  return !!ev && typeof ev === 'object' && !Array.isArray(ev)
    && typeof ev.id === 'string' && ev.id.length > 0 && ev.id.length <= 64
    && TYPES.has(ev.type);
}

export function emptyState() {
  return { players: {}, playerOrder: [], games: {}, gameOrder: [] };
}

const str = (v, max = 64) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.max(-100000, Math.min(100000, Math.trunc(v))) : null);

function numberMap(raw, players) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const pid of players) {
    const v = int(raw[pid]);
    if (v != null) out[pid] = v;
  }
  return out;
}

function sanitizeRound(raw, game) {
  const id = str(raw?.id);
  if (!id) return null;
  const round = { id };
  const bids = numberMap(raw.bids, game.players);
  const tricks = numberMap(raw.tricks, game.players);
  const scores = numberMap(raw.scores, game.players);
  if (bids) round.bids = bids;
  if (tricks) round.tricks = tricks;
  if (scores) round.scores = scores;
  const c = raw.contract;
  if (c && typeof c === 'object' && game.players.includes(c.kurtier)) {
    round.contract = {
      kurtier: c.kurtier,
      partner: game.players.includes(c.partner) ? c.partner : null,
      bid: int(c.bid) ?? 0,
    };
  }
  return round;
}

function playerList(s, raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw)].filter((pid) => typeof pid === 'string' && s.players[pid]).slice(0, MAX_PLAYERS);
}

const HANDLERS = {
  addPlayer(s, e) {
    const id = str(e.pid);
    const name = str(e.name, 40);
    if (!id || !name || s.players[id]) return;
    s.players[id] = { id, name };
    s.playerOrder.push(id);
  },
  renamePlayer(s, e) {
    const p = s.players[e.pid];
    const name = str(e.name, 40);
    if (p && name) p.name = name;
  },
  newGame(s, e) {
    const id = str(e.gid);
    if (!id || s.games[id] || !PRESETS[e.preset]) return;
    const players = playerList(s, e.players);
    s.games[id] = {
      id,
      preset: e.preset,
      settings: sanitizeSettings(e.preset, e.settings),
      players,
      firstDealer: Math.max(0, int(e.firstDealer) ?? 0) % Math.max(1, players.length),
      rounds: [],
      ended: false,
      createdAt: e.at,
      updatedAt: e.at,
    };
    s.gameOrder.push(id);
  },
  updateGame(s, e) {
    const g = s.games[e.gid];
    if (!g) return;
    if (e.settings) g.settings = sanitizeSettings(g.preset, { ...g.settings, ...e.settings });
    if (e.players) {
      const players = playerList(s, e.players);
      if (players.length) g.players = players;
    }
    if (e.firstDealer != null) g.firstDealer = Math.max(0, int(e.firstDealer) ?? 0) % Math.max(1, g.players.length);
  },
  deleteGame(s, e) {
    if (!s.games[e.gid]) return;
    delete s.games[e.gid];
    s.gameOrder = s.gameOrder.filter((id) => id !== e.gid);
  },
  endGame(s, e) {
    const g = s.games[e.gid];
    if (g) g.ended = !!e.ended;
  },
  putRound(s, e) {
    const g = s.games[e.gid];
    if (!g) return;
    const round = sanitizeRound(e.round, g);
    if (!round) return;
    const i = g.rounds.findIndex((r) => r.id === round.id);
    if (i >= 0) g.rounds[i] = round;
    else g.rounds.push(round);
  },
  deleteRound(s, e) {
    const g = s.games[e.gid];
    if (g) g.rounds = g.rounds.filter((r) => r.id !== e.rid);
  },
};

export function applyEvent(s, ev) {
  if (!isValidEvent(ev)) return s;
  try {
    HANDLERS[ev.type](s, ev);
    const g = s.games[ev.gid];
    if (g && Number.isFinite(ev.at)) g.updatedAt = Math.max(g.updatedAt || 0, ev.at);
    if (Number.isFinite(ev.at)) s.updatedAt = Math.max(s.updatedAt || 0, ev.at);
  } catch {
    // Ignore: one bad event must not break the session for everyone.
  }
  return s;
}

export function reduce(events) {
  const s = emptyState();
  for (const ev of events) applyEvent(s, ev);
  return s;
}

export function newId() {
  return crypto.randomUUID();
}
