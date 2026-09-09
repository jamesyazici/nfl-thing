// Deno-side mirror of /shared/logic.js (repo root).
//
// Why a copy instead of a relative import reaching outside supabase/functions/:
// Supabase's function bundler is only guaranteed to package imports that live
// under supabase/functions/, and this file needs to be 100% reliable to
// deploy. Content must stay identical to /shared/logic.js — that file is the
// one covered by tests/logic.test.js (run with `node --test`), so treat it as
// the source of truth and copy changes here after editing it.

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SYNTHETIC_EMAIL_DOMAIN = 'users.family-pickem.invalid';

export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidUsername(raw) {
  const trimmed = String(raw ?? '').trim();
  return USERNAME_PATTERN.test(trimmed);
}

export function syntheticEmailFor(normalizedUsername) {
  return `${normalizedUsername}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export function isForfeited(serverNowIso, kickoffAtIso) {
  return new Date(serverNowIso).getTime() >= new Date(kickoffAtIso).getTime();
}

export function computeWinner(awayScore, homeScore) {
  if (awayScore == null || homeScore == null) return null;
  if (awayScore > homeScore) return 'AWAY';
  if (homeScore > awayScore) return 'HOME';
  return 'TIE';
}

export function gradePick({ selection, forfeited }, winner) {
  if (winner == null) return 'PENDING';
  if (forfeited || selection == null) return 'INCORRECT';
  return selection === winner ? 'CORRECT' : 'INCORRECT';
}

export function buildLast5(resultsChronological) {
  const last5 = resultsChronological.slice(-5);
  const pad = '-'.repeat(Math.max(0, 5 - last5.length));
  return pad + last5.join('');
}

export function formatRecord({ wins, losses, ties }) {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

export function computeRecordAndLast5(resultsChronological) {
  const tally = resultsChronological.reduce(
    (acc, r) => {
      if (r === 'W') acc.wins += 1;
      else if (r === 'L') acc.losses += 1;
      else if (r === 'T') acc.ties += 1;
      return acc;
    },
    { wins: 0, losses: 0, ties: 0 },
  );
  return {
    record: formatRecord(tally),
    last5: buildLast5(resultsChronological),
  };
}

export function winRate(correct, counted) {
  return counted === 0 ? 0 : correct / counted;
}

export function formatPercent(fraction, digits = 1) {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function averageFinish(ranks) {
  if (!ranks.length) return null;
  return ranks.reduce((a, b) => a + b, 0) / ranks.length;
}

export function formatAvgFinish(avg) {
  return avg == null ? '—' : avg.toFixed(2);
}

export function deriveKalshiProbability({ yesBid, yesAsk, lastPrice }) {
  if (yesBid != null && yesAsk != null) {
    return { probability: (yesBid + yesAsk) / 2, method: 'yes_bid_ask_midpoint' };
  }
  if (lastPrice != null) {
    return { probability: lastPrice, method: 'last_price_fallback' };
  }
  return null;
}

export function derivePolymarketProbability({ price }) {
  if (price == null) return null;
  return { probability: price, method: 'current_market_price' };
}

export function formatProbabilityPercent(probability) {
  return probability == null ? '—' : `${Math.round(probability * 100)}%`;
}

export function normalizeDisplayProbabilities(rawProbs) {
  const entries = Object.entries(rawProbs).filter(([, v]) => v != null);
  const sum = entries.reduce((acc, [, v]) => acc + v, 0);
  if (sum <= 0) {
    return Object.fromEntries(Object.keys(rawProbs).map((k) => [k, null]));
  }
  const scaled = entries.map(([k, v]) => {
    const exact = (v / sum) * 100;
    return [k, exact, Math.floor(exact)];
  });
  let remainder = 100 - scaled.reduce((acc, [, , floor]) => acc + floor, 0);
  const byFraction = [...scaled].sort((a, b) => (b[1] - b[2]) - (a[1] - a[2]));
  const rounded = Object.fromEntries(scaled.map(([k, , floor]) => [k, floor]));
  for (const [k] of byFraction) {
    if (remainder <= 0) break;
    rounded[k] += 1;
    remainder -= 1;
  }
  return Object.fromEntries(Object.keys(rawProbs).map((k) => [k, k in rounded ? rounded[k] / 100 : null]));
}

export function normalizeTeamToken(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
