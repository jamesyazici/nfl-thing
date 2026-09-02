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
  computeRecordAndLast5,
  winRate,
  formatPercent,
  averageFinish,
  formatAvgFinish,
  deriveKalshiProbability,
  derivePolymarketProbability,
  formatProbabilityPercent,
  normalizeDisplayProbabilities,
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
