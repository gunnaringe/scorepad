// API for shared sessions. Static files never reach this Worker (see
// run_worker_first in wrangler.jsonc).
//
//   POST /api/session              { events } -> { code }   create from local state
//   GET  /api/session/:code        -> { ok, count } | 404   does it exist?
//   GET  /api/session/:code/ws     WebSocket, handled by the Session object

import { Session } from './session.js';
import { isValidEvent } from '../public/core.js';

export { Session };

// No 0/O, 1/I/L: codes get read aloud and typed from a screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const MAX_BODY = 1024 * 1024;

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

async function limited(req, env) {
  if (!env.JOIN_LIMIT) return false;
  const key = req.headers.get('cf-connecting-ip') ?? 'local';
  const { success } = await env.JOIN_LIMIT.limit({ key });
  return !success;
}

const stub = (env, code) => env.SESSIONS.get(env.SESSIONS.idFromName(code));

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);

    if (pathname === '/api/session') {
      if (req.method !== 'POST') return json({ error: 'method' }, 405);
      if (await limited(req, env)) return json({ error: 'rate' }, 429);
      if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'size' }, 413);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'json' }, 400);
      }
      const events = Array.isArray(body?.events) ? body.events.filter(isValidEvent) : [];
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        if (await stub(env, code).create(events)) return json({ code });
      }
      return json({ error: 'busy' }, 503);
    }

    const m = pathname.match(/^\/api\/session\/([^/]+)(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'not found' }, 404);
      if (await limited(req, env)) return json({ error: 'rate' }, 429);
      if (m[2]) {
        if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'upgrade' }, 426);
        return stub(env, code).fetch(req);
      }
      const info = await stub(env, code).info();
      return info ? json({ ok: true, ...info }) : json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found' }, 404);
  },
};
