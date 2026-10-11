# Poengblokka · Scorepad

Score keeping for card games, built for phones at the cabin table:
[poengblokka.apphub.casa](https://poengblokka.apphub.casa)
(also [scorepad.apphub.casa](https://scorepad.apphub.casa)).

- **Games:** every game is a name plus rules. Fritt (free scores), Selbuwhist
  (bid exact tricks, 10→1→10 cards) and Amerikaner (kurtier + partner vs. the
  rest, first to 52) are presets; every rule can be tweaked, also mid-game
  (all rounds are rescored). Bids are entered first and shown while the hand
  is played, then the tricks; the app does the arithmetic.
- **Table:** player names and totals stay visible while you scroll, in both
  directions. Tap any round to edit or delete it. Totals are always
  recalculated.
- **Players:** autocomplete and one-tap chips from recent players, seating
  order and first dealer, "play again" with the dealer moved on one seat.
- **Sessions:** an evening can hold several games. Share it with a QR code and
  everyone with the code sees the tables live and can enter scores. Devices
  aren't tied to players. Shared sessions are deleted from the server after 7
  days without activity; each device keeps its own copy.
- **Dashboard:** any device (a laptop or TV) can show a big live scoreboard.
  It's just a view, not a role.
- **Themes:** Hytte (cabin, default), Kos (a mug of hot chocolate on a
  snowy night), Lys, Mørk, Høy kontrast. **Languages:**
  Norwegian and English.
- Works offline as an installable app. No accounts, no tracking.

## Development

```sh
npm install
npx wrangler dev          # http://localhost:8787, with the session Durable Object
npm test                  # scoring rules, reducer, i18n
```

Plain HTML/CSS/JS in `public/`, no build step. See `CLAUDE.md` for how it fits
together.

## Deploy

Cloudflare Worker `scorepad` with static assets and one SQLite-backed Durable
Object per shared session. Workers Builds deploys on push to `main`. Fits in
the Workers free plan.
