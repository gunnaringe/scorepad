# scorepad

Poengblokka (nb) / Scorepad (en): score keeping for card games at
poengblokka.apphub.casa and scorepad.apphub.casa. **Not** the office game app
`scoreboard` (Worker `score`, score.apphub.casa): the two are separate, so
don't reuse its names, D1 database or rate-limit namespace (`1001`).

## Layout

- `public/`: the whole app, no build, no framework, no dependencies, no
  third-party requests. ES modules:
  - `rules.js`: the rules model, scoring, card counts, dealer rotation,
    `summarize()`. Pure functions.
  - `core.js`: the event reducer. State = fold over change events
    (`addPlayer`, `newGame`, `putRound`, `deleteRound`, …).
  - `store.js`: localStorage records and `Live` (WebSocket sync).
  - `app.js`: UI, hash routing, sheets/dialogs. `i18n.js`: strings.
  - `qrcodegen.js`: Nayuki's MIT QR library, transpiled from
    `vendor/qrcodegen.ts` by `scripts/build-qr.sh` (copied from scoreboard).
    Don't edit by hand.
- `src/worker.js`: `/api/*` only (`run_worker_first`). `src/session.js`: the
  `Session` Durable Object. Both import `public/core.js`/`rules.js`; wrangler
  bundles them, so browser and server share one reducer.

## How it works

- **Everything is an event log.** A session record has `events` (confirmed)
  and `pending` (sent but not yet echoed). State is always
  `reduce(events + pending)`. Never store derived values like totals: they're
  recalculated from rounds, which is what makes editing old rounds safe.
- **The reducer must never throw** and must sanitize everything: events come
  from other devices. Add an event type in `EVENT_TYPES` and `HANDLERS`, and
  keep old events valid (no breaking renames: logs live up to 7 days on the
  server and forever in localStorage).
- **One game model.** A game is `{ name, rules, players, rounds }`. `rules`
  is a flat object (defaults in `DEFAULT_RULES`): `entry` (`scores` | `bids` |
  `contract`) picks the round form, `cards` the card sequence, and the rest
  are scoring/end parameters. Fritt/Selbuvist/Amerikaner are just `PRESETS`
  (partial rule objects); `matchPreset()` tells whether rules are unchanged.
  Nothing branches on a preset name, only on rule values. Add a rule by giving
  it a default, an i18n label (`rule.<key>`; a test checks), a field in
  `ruleFields()` and a line in `rulesSummary()`. `sanitizeRules()` enforces
  types, enums and ranges. Rules can change mid-game (`updateGame`, the same
  form at `#/s/:sid/g/:gid/edit`) and every round is rescored.
- **Rounds** are upserted by id via `putRound`. Bid games first store
  `{ bids }` (or `{ contract }` for Amerikaner) and the round shows as
  pending; then `{ bids, tricks }`. `isComplete()` decides which, and only the
  last round can be pending: the reducer enforces it by merging a `putRound`
  with an unknown id into an unfinished last round (two devices entering the
  same bids → last write wins, nothing stranded). Contract rounds store tricks only for players
  outside the contract; kurtier + partner get the remainder.
- **Sync:** one Durable Object per code (`idFromName(code)`), SQLite table
  `events(seq, id UNIQUE, body)`. Clients send `hello {since}` and get a
  replay, then live `evs` broadcasts. Events are deduplicated on the
  client-generated id, so resending `pending` on reconnect is safe. A gap in
  `seq` makes the client reconnect. Hibernatable WebSockets (`acceptWebSocket`,
  device info in `serializeAttachment`), plus `ping`/`pong` as an auto-response.
  Every write moves the alarm to now + 7 days, and the alarm runs `deleteAll()`.
  `exists()` never creates tables, so probing a wrong code leaves no storage.
  Only `POST /api/session` creates a session.
- **Expired session:** the client sees close code 4404 (or a 404 from
  `GET /api/session/:code` after a failed connect), keeps a local copy
  (`expired: true`) and can share again with a new code.
- **Round sheet** (`openRound`/`form`): every list in it uses `bidOrder()`
  (left of the dealer first), so rows never move between the bid and trick
  sheets. Entered values are a draft in localStorage (`scorepad-sheet-v1`)
  until saved or discarded; the backdrop only closes an untouched sheet,
  Escape/back asks first, and `renderGame` reopens a leftover draft. Tricks
  start from the bids (`form.prefilled`, outlined chips). "Lagre" is never
  `disabled`: it's `aria-disabled` and, when tapped, marks what's missing.
  If another device changes the round while the sheet is open
  (`sheetSig`/`checkStale`), saving is blocked until "Oppdater".
- **Devices aren't players.** Connections are listed only under Settings →
  Connection. The dashboard is a view mode (`#/s/:sid/dash`, or
  `/s/CODE?view=dashboard` from a link), not a role.
- **Routes:** hash-based (`#/s/:sid/g/:gid`). `/s/CODE` reaches `index.html`
  through the SPA fallback; `boot()` joins and swaps to the hash route.
- **i18n:** `I18N.no` / `I18N.en`, same keys (a test checks). `t()` returns
  plain text, `tt()` HTML-escaped. Player names are user text, so always go
  through `esc()`/`tt()`.
- **Themes:** custom properties per `html[data-theme]` in `styles.css`. Only
  the theme blocks set colors. Hytte gets the knitted band and candle glow.
- **Sticky table:** `.table-scroll` is the only scroller in the game view
  (`#view` is a 100dvh flex column), so `thead`/`tfoot`/first column stick
  inside it in both directions. Sticky cells need opaque backgrounds.
- **Service worker:** network-first for everything (it's several modules, and
  a stale mix after a deploy would break). Bump `CACHE` only when the
  precache list changes; add new modules to `PRECACHE`.

## Testing

- `npm test`: rules, reducer and i18n (node:test).
- `npx wrangler dev`, then `BASE=http://localhost:8787 node scripts/smoke.mjs`:
  a browser end-to-end check (sticky table, Amerikaner, two devices sharing,
  offline queue). Needs `npm i --no-save playwright`. If Playwright's
  browser version isn't installed, point `PWCHROME` at an existing
  `~/.cache/ms-playwright/chromium_headless_shell-*/…/chrome-headless-shell`.
  Screenshots go to `/tmp/shots`.

## Deploy

Cloudflare Worker `scorepad` (never rename it: the custom domains are bound to
it), Workers Builds on push to `main`. Agent sessions can't deploy by hand
(Cloudflare credentials there are read-only). Free plan: SQLite-backed Durable
Objects only, which this uses.
