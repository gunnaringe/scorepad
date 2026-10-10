// Game rules and scoring. Pure functions, shared by the browser and the
// session Durable Object (src/session.js imports this file). Scores are always
// computed from the rounds, never stored, so editing an old round, or the
// rules mid-game, is safe.
//
// Every game has the same shape: a name plus a `rules` object. Presets
// (Fritt, Selbuvist, Amerikaner) are just starting points for the rules.

export const DEFAULT_RULES = {
  // How a round is entered:
  //   scores   - a number per player
  //   bids     - everyone bids tricks, then tricks taken (Selbuvist, Oh Hell)
  //   contract - the highest bidder (kurtier) and a partner against the rest
  //              (Amerikaner)
  entry: 'scores',
  // Cards dealt per round: none | updown (1→max→1) | downup (max→1→max) |
  // fixed (max every round) | deck (52 ÷ players).
  cards: 'none',
  maxCards: 10,
  // bids: exact hit = hitBase + hitPerTrick × bid, miss = −missPerTrick × off.
  // trickPoints are added per trick taken, hit or miss.
  hitBase: 10,
  hitPerTrick: 1,
  missPerTrick: 0,
  trickPoints: 0,
  // contract: made = +bid to kurtier and partner, failed = −bid (or 0).
  // Everyone else gets othersPerTrick per trick.
  fail: 'minus',
  doubleKurtier: false,
  halfPartner: false,
  minHalf: false,
  othersPerTrick: 1,
  // Taking every trick scores the target, i.e. wins outright.
  allTricksWins: true,
  // End: after `rounds` rounds (0 = when the card sequence runs out, or
  // never), or when someone reaches `target` (0 = no target).
  rounds: 0,
  target: 0,
  lowWins: false,
};

export const PRESETS = {
  free: {},
  selbuvist: { entry: 'bids', cards: 'updown', maxCards: 10 },
  amerikaner: { entry: 'contract', cards: 'deck', target: 52 },
};

export const PRESET_IDS = Object.keys(PRESETS);

const CHOICES = {
  entry: ['scores', 'bids', 'contract'],
  cards: ['none', 'updown', 'downup', 'fixed', 'deck'],
  fail: ['minus', 'zero'],
};
const RANGES = { maxCards: [1, 52], rounds: [0, 500], target: [0, 100000] };

export const presetRules = (id) => ({ ...DEFAULT_RULES, ...PRESETS[id] });

export const rulesOf = (game) => ({ ...DEFAULT_RULES, ...game.rules });

// Which preset these rules are, unchanged, if any.
export function matchPreset(rules) {
  const r = { ...DEFAULT_RULES, ...rules };
  return PRESET_IDS.find((id) => {
    const p = presetRules(id);
    return Object.keys(p).every((k) => p[k] === r[k]);
  }) ?? null;
}

// Keeps only known rules of the right type and range, so events from other
// devices can't smuggle in junk.
export function sanitizeRules(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, def] of Object.entries(DEFAULT_RULES)) {
    const v = raw[k];
    if (typeof v !== typeof def) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      const [lo, hi] = RANGES[k] ?? [-1000, 1000];
      out[k] = Math.max(lo, Math.min(hi, Math.trunc(v)));
    } else if (typeof v === 'string') {
      if (CHOICES[k]?.includes(v)) out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sequence(rules) {
  const up = Array.from({ length: rules.maxCards }, (_, i) => i + 1);
  const down = [...up].reverse();
  if (rules.cards === 'updown') return [...up, ...down];
  if (rules.cards === 'downup') return [...down, ...up];
  return null;
}

// Cards dealt to each player in round i (0-based), or null if not fixed.
export function cardsFor(game, i) {
  const r = rulesOf(game);
  const n = game.players.length;
  switch (r.cards) {
    case 'updown':
    case 'downup':
      return sequence(r)[i] ?? null;
    case 'fixed':
      return r.maxCards;
    case 'deck':
      return n ? Math.floor(52 / n) : null;
    default:
      return r.entry === 'contract' && n ? Math.floor(52 / n) : null;
  }
}

// Tricks in a contract round: the cards each player holds.
export function tricksTotal(game, i) {
  return cardsFor(game, i) ?? Math.floor(52 / Math.max(1, game.players.length));
}

export function totalRounds(game) {
  const r = rulesOf(game);
  if (r.rounds > 0) return r.rounds;
  return sequence(r)?.length ?? null;
}

// The most cards dealt per player in any round (for "enough cards?").
export function maxCardsPerRound(rules, players) {
  if (rules.cards === 'none') return rules.entry === 'contract' ? Math.floor(52 / Math.max(1, players)) : 0;
  if (rules.cards === 'deck') return Math.floor(52 / Math.max(1, players));
  return rules.maxCards;
}

export const minPlayers = (rules) => (rules.entry === 'contract' ? 3 : rules.entry === 'bids' ? 2 : 1);
export const MAX_PLAYERS = 12;

// Why these players can't play by these rules, or null.
export function playerProblem(rules, players) {
  const min = minPlayers(rules);
  if (players < min) return { key: 'rules.tooFew', min };
  if (players > MAX_PLAYERS) return { key: 'rules.tooMany', max: MAX_PLAYERS };
  const cards = maxCardsPerRound(rules, players);
  if (cards * players > 52) return { key: 'rules.deck', cards, max: Math.floor(52 / cards) };
  if (rules.cards === 'deck' && cards < 1) return { key: 'rules.tooMany', max: 52 };
  return null;
}

export function dealerFor(game, i) {
  const n = game.players.length;
  if (!n) return null;
  return game.players[((game.firstDealer ?? 0) + i) % n];
}

// Whether the round has everything needed to be scored.
export function isComplete(game, round) {
  const { entry } = rulesOf(game);
  if (entry === 'scores') return !!round.scores;
  if (entry === 'contract') return !!(round.contract && round.tricks);
  return !!round.tricks;
}

// Contract rounds: kurtier + partner take whatever the others didn't.
export function teamTricks(game, round, i) {
  const { kurtier, partner } = round.contract;
  let others = 0;
  for (const pid of game.players) {
    if (pid !== kurtier && pid !== partner) others += round.tricks?.[pid] ?? 0;
  }
  return tricksTotal(game, i) - others;
}

export function minBid(game, i) {
  const r = rulesOf(game);
  if (r.entry !== 'contract') return 0;
  return r.minHalf ? Math.ceil(tricksTotal(game, i) / 2) : 1;
}

// Scores for round i, { pid: points }, or null if it isn't complete.
export function scoreRound(game, round, i = game.rounds.indexOf(round)) {
  if (!isComplete(game, round)) return null;
  const r = rulesOf(game);
  const out = {};
  if (r.entry === 'scores') {
    for (const pid of game.players) out[pid] = round.scores[pid] ?? 0;
  } else if (r.entry === 'bids') {
    for (const pid of game.players) {
      const bid = round.bids?.[pid] ?? 0;
      const got = round.tricks[pid] ?? 0;
      const off = Math.abs(got - bid);
      out[pid] = (off === 0 ? r.hitBase + r.hitPerTrick * bid : -r.missPerTrick * off) + r.trickPoints * got;
    }
  } else {
    const { kurtier, partner, bid } = round.contract;
    const made = teamTricks(game, round, i) >= bid;
    const team = made ? bid : r.fail === 'zero' ? 0 : -bid;
    for (const pid of game.players) out[pid] = (round.tricks[pid] ?? 0) * r.othersPerTrick;
    const all = made && bid >= tricksTotal(game, i);
    out[kurtier] = all && r.allTricksWins && r.target > 0 ? r.target : r.doubleKurtier ? team * 2 : team;
    if (partner && partner !== kurtier) out[partner] = r.halfPartner ? Math.trunc(team / 2) : team;
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
  const r = rulesOf(game);
  const totals = Object.fromEntries(game.players.map((pid) => [pid, 0]));
  const rows = [];
  let pending = null;
  game.rounds.forEach((round, i) => {
    const scores = scoreRound(game, round, i);
    if (scores) {
      for (const pid of game.players) totals[pid] += scores[pid] ?? 0;
    } else if (i === game.rounds.length - 1) {
      pending = round;
    }
    rows.push({ round, index: i, scores, cards: cardsFor(game, i), dealer: dealerFor(game, i) });
  });
  const { sorted, ranks } = rank(game.players, totals, r.lowWins);
  const completed = rows.filter((row) => row.scores).length;
  // The round being played or about to be entered.
  const current = pending ? game.rounds.length - 1 : game.rounds.length;
  const max = totalRounds(game);
  // Reaching the target ends the game; with lowWins the lowest total wins then.
  const done = game.ended
    || (max != null && completed >= max)
    || (r.target > 0 && game.players.some((pid) => totals[pid] >= r.target));
  const leaders = sorted.filter((pid) => ranks[pid] === 1);
  return {
    rows, totals, ranks, sorted, leaders, pending, completed, current,
    cards: cardsFor(game, current),
    dealer: dealerFor(game, current),
    totalRounds: max,
    done,
    winners: done ? leaders : [],
  };
}

// Bid total against the cards in round i: >0 overbid, null if unknown.
export function bidBalance(game, bids, i) {
  const cards = cardsFor(game, i);
  if (cards == null) return null;
  let sum = 0;
  for (const pid of game.players) sum += bids?.[pid] ?? 0;
  return sum - cards;
}
