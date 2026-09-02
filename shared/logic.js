// Pure business logic shared by the frontend, the Supabase Edge Functions, and
// the Node unit tests. No Deno/browser/Node-specific APIs on purpose so this
// one file can be imported unmodified from all three runtimes.
//
// Edge Functions import this file directly by relative path (Deno executes
// plain ESM .js/.ts files natively). The frontend imports it the same way.

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SYNTHETIC_EMAIL_DOMAIN = 'users.family-pickem.invalid';

/** Trim + lowercase a username for storage/lookup as `normalized_username`. */
export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** Validate a *display* username (case preserved) against the allowed charset/length. */
export function isValidUsername(raw) {
  const trimmed = String(raw ?? '').trim();
  return USERNAME_PATTERN.test(trimmed);
}

/** Deterministic synthetic email used internally with Supabase Auth. Never shown to users. */
export function syntheticEmailFor(normalizedUsername) {
  return `${normalizedUsername}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

/**
 * Authoritative pick-lock rule (spec §16/§43): a game is locked for picking
 * the instant server time reaches kickoff. Never pass browser time in here.
 */
export function isForfeited(serverNowIso, kickoffAtIso) {
  return new Date(serverNowIso).getTime() >= new Date(kickoffAtIso).getTime();
}

/** Determine the winner side of a final game, or null if not yet final. */
export function computeWinner(awayScore, homeScore) {
  if (awayScore == null || homeScore == null) return null;
  if (awayScore > homeScore) return 'AWAY';
  if (homeScore > awayScore) return 'HOME';
  return 'TIE';
}

/**
 * Grade a single pick. Forfeits and missing selections always grade as
 * INCORRECT once the winner is known (spec §52/§53) — they never inflate a
 * user's denominator-only "pending" bucket.
 */
export function gradePick({ selection, forfeited }, winner) {
  if (winner == null) return 'PENDING';
  if (forfeited || selection == null) return 'INCORRECT';
  return selection === winner ? 'CORRECT' : 'INCORRECT';
}

/**
 * Build the 5-character Last-5 string (oldest→newest, left-padded with '-')
 * from a chronological array of 'W'/'L'/'T' for games strictly before the
 * matchup being displayed (spec §23/§24).
 */
export function buildLast5(resultsChronological) {
  const last5 = resultsChronological.slice(-5);
  const pad = '-'.repeat(Math.max(0, 5 - last5.length));
  return pad + last5.join('');
}

/** Format a wins/losses/ties tally as "3-0" or "3-1-1" (ties omitted when zero, spec §22). */
export function formatRecord({ wins, losses, ties }) {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

/**
 * Given a team's chronological prior-game results ('W'/'L'/'T') entering a
 * matchup, return both the record and the Last-5 string in one pass.
 */
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

/** Season pick win rate: forfeits/misses count against the denominator (spec §53/§54). */
export function winRate(correct, counted) {
  return counted === 0 ? 0 : correct / counted;
}

export function formatPercent(fraction, digits = 1) {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Average weekly finishing position across completed weeks only (spec §56). Lower is better. */
export function averageFinish(ranks) {
  if (!ranks.length) return null;
  return ranks.reduce((a, b) => a + b, 0) / ranks.length;
}

export function formatAvgFinish(avg) {
  return avg == null ? '—' : avg.toFixed(2);
}

/**
 * Kalshi displayed probability: midpoint of best YES bid/ask (spec §30),
 * falling back to last traded price when one side of the book is missing.
 * Bid/ask/last are all 0..1 dollar fractions. Returns null if nothing usable.
 */
export function deriveKalshiProbability({ yesBid, yesAsk, lastPrice }) {
  if (yesBid != null && yesAsk != null) {
    return { probability: (yesBid + yesAsk) / 2, method: 'yes_bid_ask_midpoint' };
  }
  if (lastPrice != null) {
    return { probability: lastPrice, method: 'last_price_fallback' };
  }
  return null;
}

/** Polymarket displayed probability: current market price is already the implied probability (spec §31). */
export function derivePolymarketProbability({ price }) {
  if (price == null) return null;
  return { probability: price, method: 'current_market_price' };
}

export function formatProbabilityPercent(probability) {
  return probability == null ? '—' : `${Math.round(probability * 100)}%`;
}

/**
 * Optional display-only normalization (spec §36): scale raw mutually-exclusive
 * outcome probabilities so they read as a clean whole-percent split, using
 * largest-remainder rounding so the displayed percents sum to 100. Never
 * fabricates a probability for a key that was null in the input.
 */
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

/** Loose token normalization used when matching team names/aliases from external APIs. */
export function normalizeTeamToken(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
