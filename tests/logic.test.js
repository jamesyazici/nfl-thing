import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername,
  isValidUsername,
  syntheticEmailFor,
  isForfeited,
  computeWinner,
  gradePick,
  buildLast5,
  formatRecord,
  formatExpectedRecord,
  computeRecordAndLast5,
  winRate,
  formatPercent,
  averageFinish,
  formatAvgFinish,
  deriveKalshiProbability,
  derivePolymarketProbability,
  formatProbabilityPercent,
  normalizeDisplayProbabilities,
  standardCompetitionRanks,
  medalForRank,
} from '../shared/logic.js';

test('normalizeUsername trims and lowercases, preserves nothing else', () => {
  assert.equal(normalizeUsername('  Dad  '), 'dad');
  assert.equal(normalizeUsername('SARAH_2'), 'sarah_2');
});

test('isValidUsername enforces charset and length', () => {
  assert.equal(isValidUsername('Dad'), true);
  assert.equal(isValidUsername('sarah-2'), true);
  assert.equal(isValidUsername('a'.repeat(32)), true);
  assert.equal(isValidUsername('a'.repeat(33)), false);
  assert.equal(isValidUsername('bad name'), false);
  assert.equal(isValidUsername('bad!name'), false);
  assert.equal(isValidUsername(''), false);
});

test('syntheticEmailFor builds the internal-only address', () => {
  assert.equal(syntheticEmailFor('dad'), 'dad@users.family-pickem.invalid');
});

test('isForfeited: exact kickoff boundary (spec §43)', () => {
  const kickoff = '2026-10-04T17:00:00.000Z'; // 1:00 PM ET
  assert.equal(isForfeited('2026-10-04T16:59:59.000Z', kickoff), false, '1 second before kickoff is still pickable');
  assert.equal(isForfeited('2026-10-04T17:00:00.000Z', kickoff), true, 'exact kickoff instant is forfeited');
  assert.equal(isForfeited('2026-10-04T17:00:01.000Z', kickoff), true, 'after kickoff is forfeited');
});

test('computeWinner covers AWAY/HOME/TIE/pending', () => {
  assert.equal(computeWinner(24, 17), 'AWAY');
  assert.equal(computeWinner(17, 24), 'HOME');
  assert.equal(computeWinner(20, 20), 'TIE');
  assert.equal(computeWinner(null, null), null);
});

test('gradePick: forfeits and missing selections are always incorrect once graded (spec §52/§53)', () => {
  assert.equal(gradePick({ selection: 'AWAY', forfeited: false }, 'AWAY'), 'CORRECT');
  assert.equal(gradePick({ selection: 'HOME', forfeited: false }, 'AWAY'), 'INCORRECT');
  assert.equal(gradePick({ selection: 'TIE', forfeited: false }, 'TIE'), 'CORRECT');
  assert.equal(gradePick({ selection: null, forfeited: true }, 'AWAY'), 'INCORRECT');
  assert.equal(gradePick({ selection: 'AWAY', forfeited: false }, null), 'PENDING');
});

test('gradePick: a forfeited pick never earns credit, even when the auto-picked HOME team wins', () => {
  // Per explicit request, no exceptions: not submitting on time is always
  // worth 0 points, regardless of the actual game outcome.
  assert.equal(gradePick({ selection: 'HOME', forfeited: true }, 'HOME'), 'INCORRECT');
  assert.equal(gradePick({ selection: 'HOME', forfeited: true }, 'AWAY'), 'INCORRECT');
  assert.equal(gradePick({ selection: 'HOME', forfeited: true }, 'TIE'), 'INCORRECT');
});

test('buildLast5 pads with dashes and keeps only the most recent 5, oldest-left', () => {
  assert.equal(buildLast5([]), '-----');
  assert.equal(buildLast5(['W']), '----W');
  assert.equal(buildLast5(['W', 'W', 'W']), '--WWW');
  assert.equal(buildLast5(['L', 'W', 'W']), '--LWW');
  assert.equal(buildLast5(['W', 'L', 'L', 'W', 'W']), 'WLLWW');
  assert.equal(buildLast5(['T', 'W', 'L', 'L', 'W', 'W']), 'WLLWW', 'only the last 5 are kept, oldest dropped');
});

test('formatRecord omits ties when zero, includes them otherwise (spec §22)', () => {
  assert.equal(formatRecord({ wins: 3, losses: 0, ties: 0 }), '3-0');
  assert.equal(formatRecord({ wins: 3, losses: 1, ties: 1 }), '3-1-1');
  assert.equal(formatRecord({ wins: 0, losses: 0, ties: 0 }), '0-0');
});

test('formatExpectedRecord sums pick probabilities into a decimal record, and reads as "—" with no games or no picks to project', () => {
  assert.equal(formatExpectedRecord(8.7, 16), '8.7-7.3');
  assert.equal(formatExpectedRecord(0.5, 2), '0.5-1.5');
  // Two games picked at 0.35 and 0.45: 0.8 expected wins, 1.2 expected losses.
  assert.equal(formatExpectedRecord(0.35 + 0.45, 2), '0.8-1.2');
  assert.equal(formatExpectedRecord(0, 0), '—');
  // A non-submitter has no picks at all - null, not a fabricated 50/50 guess.
  assert.equal(formatExpectedRecord(null, 16), '—');
});

test('formatExpectedRecord: the two halves always sum to totalGames exactly, even at a .x5 rounding boundary', () => {
  // 8.25 is exactly halfway between 8.2 and 8.3; rounding wins and losses
  // independently could show "8.3-7.8" (sums to 16.1, not 16) - losses
  // must be derived from the already-rounded wins instead.
  assert.equal(formatExpectedRecord(8.25, 16), '8.3-7.7');
  for (let totalGames = 1; totalGames <= 18; totalGames++) {
    for (let i = 0; i <= totalGames * 20; i++) {
      const wins = i / 20;
      const [w, l] = formatExpectedRecord(wins, totalGames).split('-').map(Number);
      assert.equal(Math.round((w + l) * 10) / 10, totalGames, `${wins}/${totalGames} -> ${w}-${l}`);
    }
  }
});

test('computeRecordAndLast5 combines both from one chronological result list', () => {
  const { record, last5 } = computeRecordAndLast5(['W', 'W', 'W']);
  assert.equal(record, '3-0');
  assert.equal(last5, '--WWW');
});

test('winRate: forfeits count against the denominator, not excluded (spec §53)', () => {
  assert.equal(winRate(12, 16), 0.75);
  assert.equal(formatPercent(winRate(12, 16)), '75.0%');
  assert.equal(winRate(0, 0), 0);
});

test('averageFinish: only fed completed weeks, simple mean, lower is better (spec §56/§100)', () => {
  assert.equal(averageFinish([1, 3]), 2);
  assert.equal(formatAvgFinish(averageFinish([1, 3])), '2.00');
  assert.equal(averageFinish([1, 3, 2]), 2);
  assert.equal(averageFinish([]), null);
  assert.equal(formatAvgFinish(null), '—');
});

test('deriveKalshiProbability: bid/ask midpoint preferred over last price (spec §30/§103)', () => {
  const result = deriveKalshiProbability({ yesBid: 0.44, yesAsk: 0.46, lastPrice: 0.5 });
  assert.equal(result.probability, 0.45);
  assert.equal(result.method, 'yes_bid_ask_midpoint');
  assert.equal(formatProbabilityPercent(result.probability), '45%');
});

test('deriveKalshiProbability falls back to last price when book is one-sided/empty', () => {
  const result = deriveKalshiProbability({ yesBid: null, yesAsk: null, lastPrice: 0.55 });
  assert.equal(result.probability, 0.55);
  assert.equal(result.method, 'last_price_fallback');
  assert.equal(deriveKalshiProbability({ yesBid: null, yesAsk: null, lastPrice: null }), null);
});

test('derivePolymarketProbability: current price is used directly, no conversion (spec §31/§103)', () => {
  const result = derivePolymarketProbability({ price: 0.55 });
  assert.equal(result.probability, 0.55);
  assert.equal(formatProbabilityPercent(result.probability), '55%');
  assert.equal(derivePolymarketProbability({ price: null }), null);
});

test('normalizeDisplayProbabilities scales to a clean 100% split without fabricating missing outcomes', () => {
  const out = normalizeDisplayProbabilities({ away: 0.44, tie: 0.019, home: 0.551 });
  const sum = Math.round((out.away + out.tie + out.home) * 100);
  assert.equal(sum, 100);

  const noTie = normalizeDisplayProbabilities({ away: 0.45, tie: null, home: 0.5 });
  assert.equal(noTie.tie, null, 'never fabricate a probability for a market that does not exist');
});

test('standardCompetitionRanks + medalForRank: ties skip the rank below them, per the user\'s own worked examples', () => {
  // "2 people with 4 wins, 1 person with 3, everyone else has 1 or 2":
  // both 4s tie for 1st; the lone 3 is 3rd (rank 2 is skipped), not 2nd.
  const exampleA = [
    { id: 'a', count: 4 }, { id: 'b', count: 4 }, { id: 'c', count: 3 },
    { id: 'd', count: 2 }, { id: 'e', count: 1 },
  ];
  const ranksA = standardCompetitionRanks(exampleA);
  assert.equal(ranksA.get('a'), 1);
  assert.equal(ranksA.get('b'), 1);
  assert.equal(ranksA.get('c'), 3);
  assert.equal(medalForRank(ranksA.get('a')), '🥇');
  assert.equal(medalForRank(ranksA.get('b')), '🥇');
  assert.equal(medalForRank(ranksA.get('c')), '🥉');
  assert.equal(medalForRank(ranksA.get('d')), null, 'below 3rd never medals, even with ranks skipped');

  // "2 people with 4, 2 with 3, and rest have 2": two golds, two bronzes,
  // nobody gets silver.
  const exampleB = [
    { id: 'a', count: 4 }, { id: 'b', count: 4 }, { id: 'c', count: 3 },
    { id: 'd', count: 3 }, { id: 'e', count: 2 }, { id: 'f', count: 2 },
  ];
  const ranksB = standardCompetitionRanks(exampleB);
  assert.equal(medalForRank(ranksB.get('a')), '🥇');
  assert.equal(medalForRank(ranksB.get('b')), '🥇');
  assert.equal(medalForRank(ranksB.get('c')), '🥉');
  assert.equal(medalForRank(ranksB.get('d')), '🥉');
  assert.equal(medalForRank(ranksB.get('e')), null);
});
