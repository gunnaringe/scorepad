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
  are scoring/end parameters. Fritt/Selbuwhist/Amerikaner are just `PRESETS`
  (partial rule objects); `matchPreset()` tells whether rules are unchanged.
  Nothing branches on a preset name, only on rule values. Add a rule by giving
  it a default, an i18n label (`rule.<key>`; a test checks), a field in
  `ruleFields()` and a line in `rulesSummary()`. `sanitizeRules()` enforces
  types, enums and ranges. Rules can change mid-game (`updateGame`, the same
  form at `#/s/:sid/g/:gid/edit`) and every round is rescored.
- **Cards per round** (`cards`): `none` | `fixed` (`cardsFixed`) | `varies`
  (`cardsFrom` → `cardsTurn` → `cardsTo`, one card at a time, the turning
  card played twice; `cardsTo == cardsTurn` = one way) | `deck` (52 ÷
  players). `cardOptions(entry)` says what a round type offers (Poeng: none;
  Kurtier og makker: deck/fixed). Rules saved with the old `updown`/`downup`
  + `maxCards` are converted when read (`upgradeRules`). When the deck is too
  small `playerProblem` returns `fit` and the form offers "Sett maks til N"
  (`capCards`).
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
- **Players mid-game:** the edit form (`#/s/:sid/g/:gid/edit`) changes
  players too (`updateGame.players`); names are tap-to-rename (`renamePlayer`,
  for the whole session). Its dealer marker means "deals now" and is stored
  back as `firstDealer`. A player added later scores 0 for earlier rounds (bid
  rounds without their tricks score 0); a removed player's entries stay in
  the rounds and count again if they're added back.
- **Ending:** a game is done when the card sequence runs out, someone
  reaches `target`, or it's ended by hand (`endGame`: the link under the
  last round or the menu). Done games show `resultsHtml()` (podium for the
  top three, ties share a medal, then the rest) instead of the table, with a
  Tabell/Resultat toggle; the big screen shows the same podium.
- **No layout jumps:** things that appear later get their space up front.
  The info line has a fixed two-line height, the sheet summary reserves two
  lines, and the Amerikaner partner buttons are always rendered (grey until a
  kurtier is picked, the kurtier's own spot kept as a gap). The "next row"
  marker is a box-shadow, never padding. Keep it that way when adding UI.
- **Compact forms:** number rules are label-above fields in a 6-column grid
  (`.rule-group`), switches and pick lists take a row; hints are collected
  under the group. The min bid is our own `.mini-stepper`, not a `<select>`.
- **Short names:** `shortNames()` abbreviates long player names in table
  headers to unique initials (limit shrinks with player count); tapping the
  header shows the full name in a toast.
- **Paper texture:** Hytte and Kos lay `public/themes/paper.svg` (fine grain
  and faint fibres, mostly transparent) over their cream surfaces via
  `--paper-tex` and `background-image`, at the end of `styles.css`. A new
  cream surface in those themes should get the texture too; the other themes
  stay flat.
- **Sharing:** the bar's `.chip-slot` is a share button (unshared) or the
  code chip (shared); both open the share dialog (`renderShare()`: share, or
  QR, code and link — nothing else). Connections (status, devices, leave) are
  only in Settings (`refreshConnection()`), for a shared game night.
- **Devices aren't players.** The big screen is a view mode
  (`#/s/:sid/dash`, or `/s/CODE?view=dashboard` from a link), not a role.
- **🌟 bids:** a contract with `partner: null` and `bid >= tricks` is
  "every trick, alone" (`isAllAlone()`), only where `allAlone` is on. Bidding
  every trick *with* a partner is an ordinary bid. The sheet shows the 🌟 as
  its own option after the number chips. It scores `allAlonePoints` (52 for
  Amerikaner; made = +, failed = − or 0 per `fail`; 0 = like a normal bid),
  never doubled; reaching the target (52) ends the game.
- **Overrides:** a scored round can carry `override: { pid: points }`
  ("Overstyr poeng" in the sheet); `scoreRound()` applies it on top of
  `computeRound()`. Undo strips it with the tricks.
- **Confirmations** use `ask()` (the `#ask` dialog), never `confirm()` or
  `prompt()`.
- **Routes:** hash-based (`#/s/:sid/g/:gid`). `/s/CODE` reaches `index.html`
  through the SPA fallback; `boot()` joins and swaps to the hash route.
- **i18n:** `I18N.no` / `I18N.en`, same keys (a test checks). `t()` returns
  plain text, `tt()` HTML-escaped. Player names are user text, so always go
  through `esc()`/`tt()`.
- **Themes:** custom properties per `html[data-theme]` in `styles.css`. Only
  the theme blocks set colors. Hytte is the inside of a cabin (light knotty-pine panelling,
  `public/themes/panel.svg`, dimmed by lamp-light gradients; the bars are the
  same boards stained darker; text on the light wall is dark and sits on
  cream paper labels, see the "Light wall" rules at the end of `styles.css`;
  the Selbu wool band `public/themes/knit.svg` under bars, the cabin scene
  `public/themes/hytte.svg` on the home screen and big screen);
  Kos (`cozy`) a waffle-grid texture, snow and `public/themes/cozy.svg`
  (a heart waffle with jam) on the home screen and the big screen.
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
