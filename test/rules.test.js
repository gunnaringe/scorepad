import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../public/core.js';
import { scoreRound, computeRound, minBid, summarize, cardsFor, bidBalance, tricksTotal, presetRules, matchPreset, playerProblem, sanitizeRules } from '../public/rules.js';

const players = (...names) => names.map((n) => ({ id: `ev-${n}`, type: 'addPlayer', pid: n, name: n.toUpperCase() }));
const game = (preset, pids, rules = {}, extra = {}) => ({ id: 'ev-g', type: 'newGame', gid: 'g', name: preset, rules: { ...presetRules(preset), ...rules }, players: pids, at: 1, ...extra });
let n = 0;
const round = (r) => ({ id: `ev-r${n++}`, type: 'putRound', gid: 'g', round: r, at: 2 });

test('selbuvist: exact hit is 10 + bid, miss is 0', () => {
  const s = reduce([...players('a', 'b', 'c'), game('selbuvist', ['a', 'b', 'c']),
    round({ id: 'r1', bids: { a: 1, b: 0, c: 0 }, tricks: { a: 1, b: 0, c: 0 } }),
    round({ id: 'r2', bids: { a: 2, b: 0, c: 1 }, tricks: { a: 1, b: 0, c: 1 } })]);
  const g = s.games.g;
  assert.deepEqual(scoreRound(g, g.rounds[1]), { a: 0, b: 10, c: 11 });
  assert.deepEqual(summarize(g).totals, { a: 11, b: 20, c: 21 });
});

test('selbuvist: penalty variant and card sequence', () => {
  const s = reduce([...players('a', 'b'), game('selbuvist', ['a', 'b'], { missPerTrick: 1, cards: 'downup' }),
    round({ id: 'r1', bids: { a: 3, b: 5 }, tricks: { a: 5, b: 5 } })]);
  const g = s.games.g;
  assert.deepEqual(scoreRound(g, g.rounds[0]), { a: -2, b: 15 });
  assert.equal(cardsFor(g, 0), 10);
  assert.equal(cardsFor(g, 10), 1);
  assert.equal(bidBalance(g, { a: 3, b: 5 }, 0), -2);
});

test('selbuvist: pending bids are not scored and mark the current round', () => {
  const s = reduce([...players('a', 'b'), game('selbuvist', ['a', 'b']),
    round({ id: 'r1', bids: { a: 1, b: 0 }, tricks: { a: 1, b: 0 } }),
    round({ id: 'r2', bids: { a: 1, b: 1 } })]);
  const sum = summarize(s.games.g);
  assert.equal(sum.pending.id, 'r2');
  assert.equal(sum.current, 1);
  assert.equal(sum.cards, 9);
  assert.deepEqual(sum.totals, { a: 11, b: 10 });
});

test('amerikaner: made contract, others score tricks', () => {
  const s = reduce([...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd']),
    round({ id: 'r1', contract: { kurtier: 'a', partner: 'c', bid: 8 }, tricks: { b: 3, d: 2 } })]);
  const g = s.games.g;
  assert.equal(tricksTotal(g, 0), 13);
  assert.deepEqual(scoreRound(g, g.rounds[0]), { a: 8, b: 3, c: 8, d: 2 });
});

test('amerikaner: failed contract is -bid, or 0 as house rule', () => {
  const evs = [...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd']),
    round({ id: 'r1', contract: { kurtier: 'a', partner: 'c', bid: 9 }, tricks: { b: 3, d: 2 } })];
  const g = reduce(evs).games.g;
  assert.deepEqual(scoreRound(g, g.rounds[0]), { a: -9, b: 3, c: -9, d: 2 });
  const g2 = reduce([...evs, { id: 'ev-u', type: 'updateGame', gid: 'g', rules: { fail: 'zero' } }]).games.g;
  assert.deepEqual(scoreRound(g2, g2.rounds[0]), { a: 0, b: 3, c: 0, d: 2 });
});

test('amerikaner: taking every trick alone is just the top bid; minimum bid', () => {
  const s = reduce([...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd']),
    round({ id: 'r1', contract: { kurtier: 'a', partner: null, bid: 13 }, tricks: { b: 0, c: 0, d: 0 } })]);
  const g = s.games.g;
  assert.equal(summarize(g).totals.a, 13);
  assert.equal(summarize(g).done, false);
  assert.equal(minBid(g, 0), 1);
  const g2 = reduce([...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd'], { minBid: 7 })]).games.g;
  assert.equal(minBid(g2, 0), 7);
  const g3 = reduce([...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd'], { minBid: 40 })]).games.g;
  assert.equal(minBid(g3, 0), 13);
});

test('overridden scores replace the computed ones, and only for those players', () => {
  const s = reduce([...players('a', 'b'), game('selbuvist', ['a', 'b']),
    round({ id: 'r1', bids: { a: 1, b: 0 }, tricks: { a: 1, b: 0 }, override: { b: -5, ghost: 9 } })]);
  const g = s.games.g;
  assert.deepEqual(g.rounds[0].override, { b: -5 });
  assert.deepEqual(computeRound(g, g.rounds[0]), { a: 11, b: 10 });
  assert.deepEqual(summarize(g).totals, { a: 11, b: -5 });
});

test('editing and deleting an old round recalculates totals', () => {
  const base = [...players('a', 'b'), game('free', ['a', 'b']),
    round({ id: 'r1', scores: { a: 5, b: 1 } }),
    round({ id: 'r2', scores: { a: 2, b: 7 } })];
  assert.deepEqual(summarize(reduce(base).games.g).totals, { a: 7, b: 8 });
  const edited = reduce([...base, round({ id: 'r1', scores: { a: -5, b: 1 } })]).games.g;
  assert.deepEqual(summarize(edited).totals, { a: -3, b: 8 });
  assert.equal(edited.rounds.length, 2);
  const deleted = reduce([...base, { id: 'ev-d', type: 'deleteRound', gid: 'g', rid: 'r2' }]).games.g;
  assert.deepEqual(summarize(deleted).totals, { a: 5, b: 1 });
});

test('ranking ties and low-wins', () => {
  const s = reduce([...players('a', 'b', 'c'), game('free', ['a', 'b', 'c'], { lowWins: true, target: 10 }),
    round({ id: 'r1', scores: { a: 4, b: 4, c: 11 } })]);
  const sum = summarize(s.games.g);
  assert.deepEqual(sum.ranks, { a: 1, b: 1, c: 3 });
  assert.equal(sum.done, true);
  assert.deepEqual(sum.winners, ['a', 'b']);
});

test('reducer ignores junk without throwing', () => {
  const s = reduce([null, 42, { id: 'x', type: 'nope' }, { id: 'y', type: 'putRound', gid: 'missing' },
    ...players('a'), { id: 'z', type: 'newGame', gid: 'g', players: ['a', 'ghost', 'a'], rules: { lowWins: 'yes', evil: 1, entry: 'nope', maxCards: 999 } },
    { id: 'w', type: 'putRound', gid: 'g', round: { id: 'r', scores: { a: 'NaN', ghost: 4 } } }]);
  assert.deepEqual(s.games.g.players, ['a']);
  assert.deepEqual(s.games.g.rules, { maxCards: 52 });
  assert.deepEqual(s.games.g.rounds[0], { id: 'r', scores: {} });
});

test('presets are just rules; edits stop matching', () => {
  assert.equal(matchPreset(presetRules('selbuvist')), 'selbuvist');
  assert.equal(matchPreset({ ...presetRules('selbuvist'), maxCards: 7 }), null);
  assert.equal(matchPreset({}), 'free');
});

test('mixed rules: bids with fixed cards and trick points; ending by hand', () => {
  const s = reduce([...players('a', 'b', 'c'), game('free', ['a', 'b', 'c'], { entry: 'bids', cards: 'fixed', maxCards: 5, trickPoints: 1, hitBase: 5, hitPerTrick: 0 }),
    round({ id: 'r1', bids: { a: 2, b: 1, c: 1 }, tricks: { a: 2, b: 3, c: 0 } })]);
  const g = s.games.g;
  assert.equal(cardsFor(g, 3), 5);
  assert.deepEqual(scoreRound(g, g.rounds[0]), { a: 7, b: 3, c: 0 });
  assert.equal(summarize(g).done, false);
  const ended = reduce([...players('a', 'b', 'c'), game('free', ['a', 'b', 'c'], { entry: 'bids', cards: 'fixed', maxCards: 5, trickPoints: 1, hitBase: 5, hitPerTrick: 0 }),
    round({ id: 'r1', bids: { a: 2, b: 1, c: 1 }, tricks: { a: 2, b: 3, c: 0 } }), { id: 'ev-end', type: 'endGame', gid: 'g', ended: true }]).games.g;
  const sum = summarize(ended);
  assert.equal(sum.done, true);
  assert.deepEqual(sum.sorted, ['a', 'b', 'c']);
  assert.deepEqual(sum.winners, ['a']);
});

test('changing rules mid-game rescores old rounds', () => {
  const base = [...players('a', 'b'), game('selbuvist', ['a', 'b']), round({ id: 'r1', bids: { a: 1, b: 0 }, tricks: { a: 0, b: 1 } })];
  assert.deepEqual(summarize(reduce(base).games.g).totals, { a: 0, b: 0 });
  const g = reduce([...base, { id: 'ev-u2', type: 'updateGame', gid: 'g', rules: { missPerTrick: 2 }, name: 'Kveld' }]).games.g;
  assert.deepEqual(summarize(g).totals, { a: -2, b: -2 });
  assert.equal(g.name, 'Kveld');
});

test('player count checks follow the rules', () => {
  assert.equal(playerProblem(presetRules('selbuvist'), 6).key, 'rules.deck');
  assert.equal(playerProblem(presetRules('selbuvist'), 5), null);
  assert.equal(playerProblem(presetRules('amerikaner'), 2).key, 'rules.tooFew');
  assert.equal(playerProblem(presetRules('free'), 1), null);
  assert.deepEqual(sanitizeRules({ entry: 'bids', cards: 'x', target: -5 }), { entry: 'bids', target: 0 });
});

test('two devices starting the same round merge instead of stranding one', () => {
  const s = reduce([...players('a', 'b'), game('selbuvist', ['a', 'b']),
    round({ id: 'fromB', bids: { a: 1, b: 0 } }),
    round({ id: 'fromA', bids: { a: 0, b: 1 } })]);
  const g = s.games.g;
  assert.equal(g.rounds.length, 1);
  assert.deepEqual(g.rounds[0], { id: 'fromB', bids: { a: 0, b: 1 } });
  const sum = summarize(g);
  assert.equal(sum.pending.id, 'fromB');
  assert.equal(sum.cards, 10);
});

test('players can be added, removed and renamed mid-game', () => {
  const base = [...players('a', 'b', 'c'), game('selbuvist', ['a', 'b']),
    round({ id: 'r1', bids: { a: 1, b: 0 }, tricks: { a: 1, b: 0 } })];
  const g = reduce([...base, { id: 'ev-p', type: 'updateGame', gid: 'g', players: ['a', 'b', 'c'], firstDealer: 2 }]).games.g;
  assert.deepEqual(summarize(g).totals, { a: 11, b: 10, c: 0 });
  assert.equal(g.firstDealer, 2);
  const s2 = reduce([...base, { id: 'ev-r', type: 'renamePlayer', pid: 'a', name: 'Anne' }, { id: 'ev-q', type: 'updateGame', gid: 'g', players: ['a'] }]);
  assert.equal(s2.players.a.name, 'Anne');
  assert.deepEqual(summarize(s2.games.g).totals, { a: 11 });
});
