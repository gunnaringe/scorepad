// Game rules and scoring. Pure functions, shared by the browser and the
// session Durable Object (src/session.js imports this file). Scores are always
// computed from the rounds, never stored, so editing an old round, or the
// rules mid-game, is safe.
//
// Every game has the same shape: a name plus a `rules` object. Presets
// (Fritt, Selbuwhist, Amerikaner) are just starting points for the rules.

export const DEFAULT_RULES = {
  // How a round is entered:
  //   scores   - a number per player
  //   bids     - everyone bids tricks, then tricks taken (Selbuwhist, Oh Hell)
  //   contract - the highest bidder (kurtier) and a partner against the rest
  //              (Amerikaner)
  entry: 'scores',
  // Cards dealt per round:
  //   none   - not fixed
  //   fixed  - cardsFixed every round
  //   varies - cardsFrom → cardsTurn → cardsTo, one card at a time. The
  //            turning card is played twice (10→1→10 is 20 rounds), unless
  //            cardsTo equals cardsTurn: then it's one way (10→1).
  //   deck   - the whole deck, 52 ÷ players
  cards: 'none',
  cardsFixed: 10,
  cardsFrom: 10,
  cardsTurn: 1,
  cardsTo: 10,
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
  // Lowest allowed bid in tricks (0 = no minimum).
  minBid: 0,
  // Whether the kurtier may bid every trick alone (marked 🌟). Bidding
  // every trick *with* a partner is an ordinary bid.
  allAlone: true,
  // What a made 🌟 scores, and what a failed one loses (per `fail`). 0 =
  // score it like an ordinary bid of every trick.
  allAlonePoints: 52,
  othersPerTrick: 1,
  // End: when the card sequence runs out, when someone reaches `target`
  // (0 = no target), or when the game is ended by hand.
  target: 0,
  lowWins: false,
};

export const PRESETS = {
  free: {},
  selbuvist: { entry: 'bids', cards: 'varies', cardsFrom: 10, cardsTurn: 1, cardsTo: 10 },
  amerikaner: { entry: 'contract', cards: 'deck', target: 52 },
};

export const PRESET_IDS = Object.keys(PRESETS);

const CHOICES = {
  entry: ['scores', 'bids', 'contract'],
  cards: ['none', 'fixed', 'varies', 'deck'],
  fail: ['minus', 'zero'],
};
const CARDS = [1, 52];
const RANGES = { cardsFixed: CARDS, cardsFrom: CARDS, cardsTurn: CARDS, cardsTo: CARDS, minBid: [0, 52], allAlonePoints: [0, 1000], target: [0, 100000] };

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

// Rules saved before cards became "none/fixed/varies/deck" used 'updown',
// 'downup' and a shared maxCards. Convert on read; stored events stay as is.
function upgradeRules(raw) {
  const r = { ...raw };
  const max = Number.isFinite(r.maxCards) ? r.maxCards : 10;
  if (r.cards === 'updown') Object.assign(r, { cards: 'varies', cardsFrom: 1, cardsTurn: max, cardsTo: 1 });
  else if (r.cards === 'downup') Object.assign(r, { cards: 'varies', cardsFrom: max, cardsTurn: 1, cardsTo: max });
  else if (r.cards === 'fixed' && 'maxCards' in r && r.cardsFixed === undefined) r.cardsFixed = max;
  delete r.maxCards;
  return r;
}

// Keeps only known rules of the right type and range, so events from other
// devices can't smuggle in junk.
export function sanitizeRules(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const raw = upgradeRules(input);
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

// a, a±1, … b (inclusive).
function leg(a, b) {
  const out = [];
  const step = a <= b ? 1 : -1;
  for (let x = a; ; x += step) {
    out.push(x);
    if (x === b) return out;
  }
}

// The cards per round for "varies" rules, or null.
export function sequence(rules) {
  if (rules.cards !== 'varies') return null;
  const first = leg(rules.cardsFrom, rules.cardsTurn);
  return rules.cardsTo === rules.cardsTurn ? first : [...first, ...leg(rules.cardsTurn, rules.cardsTo)];
}

// Cards dealt to each player in round i (0-based), or null if not fixed.
export function cardsFor(game, i) {
  const r = rulesOf(game);
  const n = game.players.length;
  switch (r.cards) {
    case 'varies':
      return sequence(r)[i] ?? null;
    case 'fixed':
      return r.cardsFixed;
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
  return sequence(rulesOf(game))?.length ?? null;
}

// The most cards dealt per player in any round (for "enough cards?").
export function maxCardsPerRound(rules, players) {
  if (rules.cards === 'none') return rules.entry === 'contract' ? Math.floor(52 / Math.max(1, players)) : 0;
  if (rules.cards === 'deck') return Math.floor(52 / Math.max(1, players));
  if (rules.cards === 'fixed') return rules.cardsFixed;
  return Math.max(rules.cardsFrom, rules.cardsTurn, rules.cardsTo);
}

// Most cards per player the deck allows for this many players.
export const deckFit = (players) => Math.floor(52 / Math.max(1, players));

// The same rules with every card number limited to `max` (the fix for "not
// enough cards").
export function capCards(rules, max) {
  const cap = (n) => Math.max(1, Math.min(n, max));
  return {
    ...rules,
    cardsFixed: cap(rules.cardsFixed),
    cardsFrom: cap(rules.cardsFrom),
    cardsTurn: cap(rules.cardsTurn),
    cardsTo: cap(rules.cardsTo),
  };
}

// Which card options make sense for a round type.
export const cardOptions = (entry) => ({ scores: [], bids: ['none', 'fixed', 'varies', 'deck'], contract: ['deck', 'fixed'] }[entry]);

// After changing the round type: drop a card option that no longer applies.
export function fitCardsToEntry(rules) {
  const opts = cardOptions(rules.entry);
  if (rules.cards !== 'none' && !opts.includes(rules.cards)) return { ...rules, cards: opts.includes('deck') ? 'deck' : 'none' };
  if (rules.entry === 'scores') return { ...rules, cards: 'none' };
  if (rules.entry === 'contract' && rules.cards === 'none') return { ...rules, cards: 'deck' };
  return rules;
}

export const minPlayers = (rules) => (rules.entry === 'contract' ? 3 : rules.entry === 'bids' ? 2 : 1);
export const MAX_PLAYERS = 12;

// Why these players can't play by these rules, or null.
export function playerProblem(rules, players) {
  const min = minPlayers(rules);
  if (players < min) return { key: 'rules.tooFew', min };
  if (players > MAX_PLAYERS) return { key: 'rules.tooMany', max: MAX_PLAYERS };
  const cards = maxCardsPerRound(rules, players);
  if (cards * players > 52) return { key: 'rules.deck', cards, max: Math.floor(52 / cards), fit: deckFit(players) };
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
  return Math.min(tricksTotal(game, i), Math.max(1, r.minBid));
}

// Scores for round i, { pid: points }, or null if it isn't complete. A
// round's `override` replaces the computed score for those players.
export function scoreRound(game, round, i = game.rounds.indexOf(round)) {
  const out = computeRound(game, round, i);
  if (out && round.override) {
    for (const pid of game.players) if (Number.isInteger(round.override[pid])) out[pid] = round.override[pid];
  }
  return out;
}

// A 🌟 bid: every trick, alone, where the rules allow it.
export function isAllAlone(game, contract, i) {
  return rulesOf(game).allAlone && !!contract && contract.partner === null
    && Number.isInteger(contract.bid) && contract.bid >= tricksTotal(game, i);
}

// The scores the rules give, before any override.
export function computeRound(game, round, i = game.rounds.indexOf(round)) {
  if (!isComplete(game, round)) return null;
  const r = rulesOf(game);
  const out = {};
  if (r.entry === 'scores') {
    for (const pid of game.players) out[pid] = round.scores[pid] ?? 0;
  } else if (r.entry === 'bids') {
    for (const pid of game.players) {
      // Joined after this round: nothing to score.
      if (!(pid in round.tricks)) {
        out[pid] = 0;
        continue;
      }
      const bid = round.bids?.[pid] ?? 0;
      const got = round.tricks[pid];
      const off = Math.abs(got - bid);
      out[pid] = (off === 0 ? r.hitBase + r.hitPerTrick * bid : -r.missPerTrick * off) + r.trickPoints * got;
    }
  } else {
    const { kurtier, partner, bid } = round.contract;
    const made = teamTricks(game, round, i) >= bid;
    // A 🌟 has its own value (never doubled); otherwise the bid itself.
    const star = isAllAlone(game, round.contract, i);
    const worth = star && r.allAlonePoints > 0 ? r.allAlonePoints : bid;
    const team = made ? worth : r.fail === 'zero' ? 0 : -worth;
    for (const pid of game.players) out[pid] = (round.tricks[pid] ?? 0) * r.othersPerTrick;
    out[kurtier] = r.doubleKurtier && !star ? team * 2 : team;
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
