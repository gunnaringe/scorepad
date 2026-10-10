import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../public/core.js';
import { scoreRound, summarize, cardsFor, bidBalance, tricksPerHand } from '../public/rules.js';

const players = (...names) => names.map((n) => ({ id: `ev-${n}`, type: 'addPlayer', pid: n, name: n.toUpperCase() }));
const game = (preset, pids, extra = {}) => ({ id: 'ev-g', type: 'newGame', gid: 'g', preset, players: pids, at: 1, ...extra });
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
  const s = reduce([...players('a', 'b'), game('selbuvist', ['a', 'b'], { settings: { penalty: true, order: 'down' } }),
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
  assert.equal(sum.cards, 2);
  assert.deepEqual(sum.totals, { a: 11, b: 10 });
});

test('amerikaner: made contract, others score tricks', () => {
  const s = reduce([...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd']),
    round({ id: 'r1', contract: { kurtier: 'a', partner: 'c', bid: 8 }, tricks: { b: 3, d: 2 } })]);
  const g = s.games.g;
  assert.equal(tricksPerHand(4), 13);
  assert.deepEqual(scoreRound(g, g.rounds[0]), { a: 8, b: 3, c: 8, d: 2 });
});

test('amerikaner: failed contract is -bid, or 0 as house rule', () => {
  const evs = [...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd']),
    round({ id: 'r1', contract: { kurtier: 'a', partner: 'c', bid: 9 }, tricks: { b: 3, d: 2 } })];
  const g = reduce(evs).games.g;
  assert.deepEqual(scoreRound(g, g.rounds[0]), { a: -9, b: 3, c: -9, d: 2 });
  const g2 = reduce([...evs, { id: 'ev-u', type: 'updateGame', gid: 'g', settings: { fail: 'zero' } }]).games.g;
  assert.deepEqual(scoreRound(g2, g2.rounds[0]), { a: 0, b: 3, c: 0, d: 2 });
});

test('amerikaner: amerikaneren scores the target, reaching it ends the game', () => {
  const s = reduce([...players('a', 'b', 'c', 'd'), game('amerikaner', ['a', 'b', 'c', 'd']),
    round({ id: 'r1', contract: { kurtier: 'a', partner: null, bid: 13 }, tricks: { b: 0, c: 0, d: 0 } })]);
  const sum = summarize(s.games.g);
  assert.equal(sum.totals.a, 52);
  assert.equal(sum.done, true);
  assert.deepEqual(sum.winners, ['a']);
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
  const s = reduce([...players('a', 'b', 'c'), game('free', ['a', 'b', 'c'], { settings: { lowWins: true, target: 10 } }),
    round({ id: 'r1', scores: { a: 4, b: 4, c: 11 } })]);
  const sum = summarize(s.games.g);
  assert.deepEqual(sum.ranks, { a: 1, b: 1, c: 3 });
  assert.equal(sum.done, true);
  assert.deepEqual(sum.winners, ['a', 'b']);
});

test('reducer ignores junk without throwing', () => {
  const s = reduce([null, 42, { id: 'x', type: 'nope' }, { id: 'y', type: 'putRound', gid: 'missing' },
    ...players('a'), { id: 'z', type: 'newGame', gid: 'g', preset: 'free', players: ['a', 'ghost', 'a'], settings: { lowWins: 'yes', evil: 1 } },
    { id: 'w', type: 'putRound', gid: 'g', round: { id: 'r', scores: { a: 'NaN', ghost: 4 } } }]);
  assert.deepEqual(s.games.g.players, ['a']);
  assert.deepEqual(s.games.g.settings, {});
  assert.deepEqual(s.games.g.rounds[0], { id: 'r', scores: {} });
});
