// Game presets and scoring. Pure functions, shared by the browser and the
// session Durable Object (src/session.js imports this file). Scores are always
// computed from the rounds, never stored, so editing an old round is safe.

export const PRESETS = {
  // A number per player per round.
  free: {
    min: 1, max: 12,
    defaults: { lowWins: false, target: 0 },
  },
  // Selbu-whist: 20 rounds of 1..10..1 cards, bid the exact number of tricks.
  // Exact hit = 10 + bid, miss = 0 (or minus the difference as a variant).
  selbuvist: {
    min: 2, max: 5, bids: true,
    defaults: { order: 'up', penalty: false, hook: false },
  },
  // Amerikaner: the highest bidder (kurtier) calls a partner by asking for a
  // card. Made contract = +bid to both, failed = -bid (house rule: 0). Everyone
  // else gets a point per trick. First to 52 wins.
  amerikaner: {
    min: 3, max: 6, contract: true,
    defaults: { target: 52, fail: 'minus', doubleKurtier: false, halfPartner: false, minHalf: false },
  },
  // Bid-based with a configurable formula.
  custom: {
    min: 2, max: 10, bids: true,
    defaults: { hitBase: 10, hitPerTrick: 1, missPerTrick: 0, lowWins: false },
  },
};

export const PRESET_IDS = Object.keys(PRESETS);

export function settingsFor(game) {
  return { ...PRESETS[game.preset].defaults, ...game.settings };
}

// Keeps only known settings with the default's type, so events from other
// devices can't smuggle in junk.
export function sanitizeSettings(preset, raw) {
  const defaults = PRESETS[preset]?.defaults ?? {};
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    const v = raw?.[k];
    if (typeof v !== typeof def) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = Math.max(-1000, Math.min(100000, Math.trunc(v)));
    } else if (typeof v === 'string') {
      out[k] = v.slice(0, 20);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const SELBU_UP = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const SELBU_DOWN = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function tricksPerHand(players) {
  return Math.floor(52 / players);
}

// Cards dealt to each player in round i (0-based), or null if the preset
// doesn't fix it.
export function cardsFor(game, i) {
  if (game.preset === 'selbuvist') {
    const seq = settingsFor(game).order === 'down' ? SELBU_DOWN : SELBU_UP;
    return seq[i] ?? null;
  }
  if (game.preset === 'amerikaner') return tricksPerHand(game.players.length);
  return null;
}

export function totalRounds(game) {
  return game.preset === 'selbuvist' ? SELBU_UP.length : null;
}

export function lowWins(game) {
  return !!settingsFor(game).lowWins;
}

export function dealerFor(game, i) {
  const n = game.players.length;
  if (!n) return null;
  return game.players[((game.firstDealer ?? 0) + i) % n];
}

// Whether the round has everything needed to be scored.
export function isComplete(game, round) {
  if (game.preset === 'free') return !!round.scores;
  if (game.preset === 'amerikaner') return !!(round.contract && round.tricks);
  return !!round.tricks;
}

// Amerikaner: tricks taken by kurtier + partner are whatever the others
// didn't take.
export function teamTricks(game, round) {
  const { kurtier, partner } = round.contract;
  const total = tricksPerHand(game.players.length);
  let others = 0;
  for (const pid of game.players) {
    if (pid !== kurtier && pid !== partner) others += round.tricks?.[pid] ?? 0;
  }
  return total - others;
}

export function minBid(game) {
  if (game.preset !== 'amerikaner') return 0;
  const total = tricksPerHand(game.players.length);
  return settingsFor(game).minHalf ? Math.ceil(total / 2) : 1;
}

// Scores for one round, { pid: points }, or null if it isn't complete.
export function scoreRound(game, round) {
  if (!isComplete(game, round)) return null;
  const s = settingsFor(game);
  const out = {};
  switch (game.preset) {
    case 'free':
      for (const pid of game.players) out[pid] = round.scores[pid] ?? 0;
      break;
    case 'selbuvist':
    case 'custom':
      for (const pid of game.players) {
        const bid = round.bids?.[pid] ?? 0;
        const got = round.tricks[pid] ?? 0;
        const diff = Math.abs(got - bid);
        if (game.preset === 'selbuvist') {
          out[pid] = diff === 0 ? 10 + bid : s.penalty ? -diff : 0;
        } else {
          out[pid] = diff === 0 ? s.hitBase + s.hitPerTrick * bid : -s.missPerTrick * diff;
        }
      }
      break;
    case 'amerikaner': {
      const { kurtier, partner, bid } = round.contract;
      const total = tricksPerHand(game.players.length);
      const made = teamTricks(game, round) >= bid;
      let team = made ? bid : s.fail === 'zero' ? 0 : -bid;
      for (const pid of game.players) out[pid] = round.tricks[pid] ?? 0;
      // "Amerikaneren": bidding and taking every trick wins the game outright.
      const amerikaneren = made && bid >= total;
      out[kurtier] = amerikaneren ? s.target : s.doubleKurtier ? team * 2 : team;
      if (partner && partner !== kurtier) {
        out[partner] = s.halfPartner ? Math.trunc(team / 2) : team;
      }
      break;
    }
  }
  return out;
}

// Standard competition ranking (1, 1, 3) by total.
function rank(players, totals, low) {
  const sorted = [...players].sort((a, b) => (low ? totals[a] - totals[b] : totals[b] - totals[a]));
  const ranks = {};
  sorted.forEach((pid, i) => {
    const prev = sorted[i - 1];
    ranks[pid] = i > 0 && totals[prev] === totals[pid] ? ranks[prev] : i + 1;
  });
  return { sorted, ranks };
}

// Everything the table, round entry and dashboard need about a game.
export function summarize(game) {
  const low = lowWins(game);
  const totals = Object.fromEntries(game.players.map((pid) => [pid, 0]));
  const rows = [];
  let pending = null;
  game.rounds.forEach((round, i) => {
    const scores = scoreRound(game, round);
    if (scores) {
      for (const pid of game.players) totals[pid] += scores[pid] ?? 0;
    } else if (i === game.rounds.length - 1) {
      pending = round;
    }
    rows.push({
      round, index: i, scores,
      cards: cardsFor(game, i),
      dealer: dealerFor(game, i),
      running: { ...totals },
    });
  });
  const { sorted, ranks } = rank(game.players, totals, low);
  const completed = rows.filter((r) => r.scores).length;
  // The round being played or about to be entered.
  const current = pending ? game.rounds.length - 1 : game.rounds.length;
  const s = settingsFor(game);
  const max = totalRounds(game);
  let done = false;
  if (max != null) done = completed >= max;
  // Reaching the target ends the game; with lowWins the lowest total wins then.
  else if (s.target > 0) done = game.players.some((pid) => totals[pid] >= s.target);
  const leaders = sorted.filter((pid) => ranks[pid] === 1);
  return {
    rows, totals, ranks, sorted, leaders, pending, completed,
    current,
    cards: cardsFor(game, current),
    dealer: dealerFor(game, current),
    totalRounds: max,
    done: done || game.ended,
    winners: done || game.ended ? leaders : [],
    gap: (pid) => Math.abs(totals[pid] - totals[sorted[0]]),
  };
}

// Selbuvist/custom bid sum against the cards in the round: >0 overbid.
export function bidBalance(game, bids, i) {
  const cards = cardsFor(game, i);
  if (cards == null) return null;
  let sum = 0;
  for (const pid of game.players) sum += bids?.[pid] ?? 0;
  return sum - cards;
}
