// Kalshi read-only market-data integration (spec §30). No trading, no
// credentials needed — /events, /markets, /series are public endpoints
// (confirmed against https://docs.kalshi.com while building this).
//
// We never hardcode a series ticker (spec §33): discoverNflSeriesTickers()
// looks it up by category/tag each run and every game-to-event match
// requires BOTH team names to appear in the event text — an event that
// doesn't clear that bar is simply skipped, never guessed at.
import { textMentionsTeam, shortLabelMatchesTeam } from '../_shared/teamMeta.ts';
import { deriveKalshiProbability } from '../_shared/logic.ts';

const DEFAULT_BASE = 'https://external-api.kalshi.com/trade-api/v2';

const REJECT_KEYWORDS = [
  'spread', 'handicap', 'total', 'over/under', 'over under', 'prop',
  'first half', '1st half', 'first quarter', '1st quarter', 'exact score',
  'margin', 'season wins', 'division', 'super bowl', 'futures', 'mvp',
];

function isMoneylineText(...parts) {
  const text = parts.join(' ').toLowerCase();
  return !REJECT_KEYWORDS.some((kw) => text.includes(kw));
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalshi request failed (${res.status}): ${url}`);
  return res.json();
}

// A per-game PROP series (field goals, sacks, touchdowns, "game specials",
// viewership, ...) generates its own event with the exact same team-vs-team
// title/subtitle as the real full-game winner series for that same game —
// so matching on event text alone can't tell them apart, and multiple
// candidates for one game would (correctly) be treated as ambiguous and
// skipped. The distinguishing signal is one level up, on the SERIES title:
// the bare game-winner series reads as just "<sport> Game" with nothing
// else added, where every prop series adds a stat/qualifier noun. This
// reasons about the label's shape rather than hardcoding Kalshi's specific
// ticker string.
function isBareGameSeries(title) {
  const stripped = String(title ?? '')
    .toLowerCase()
    .replace(/\bpro(fessional)?\s+football\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return stripped === 'game' || stripped === '';
}

async function discoverNflSeriesTickers(baseUrl) {
  const found = new Set();
  for (const category of ['Sports', 'sports']) {
    try {
      const data = await fetchJson(`${baseUrl}/series?category=${encodeURIComponent(category)}&limit=1000`);
      for (const series of data.series ?? []) {
        // Kalshi's NFL series tickers all contain "NFL" (e.g. KXNFLGAME),
        // but the human-readable title often doesn't literally say "NFL"
        // (e.g. KXNFLGAME's title is just "Professional Football Game") —
        // so the ticker itself has to be part of what we check.
        const text = `${series.ticker ?? ''} ${series.title ?? ''} ${(series.tags ?? []).join(' ')}`.toLowerCase();
        const isNfl = text.includes('nfl') || text.includes('national football league');
        if (isNfl && isBareGameSeries(series.title ?? '')) {
          found.add(series.ticker);
        }
      }
    } catch {
      // try the next candidate category
    }
  }
  return [...found];
}

async function fetchOpenNflEvents(baseUrl) {
  const seriesTickers = await discoverNflSeriesTickers(baseUrl);
  const events = [];
  for (const ticker of seriesTickers) {
    try {
      const data = await fetchJson(
        `${baseUrl}/events?series_ticker=${encodeURIComponent(ticker)}&status=open&with_nested_markets=true&limit=200`,
      );
      events.push(...(data.events ?? []));
    } catch {
      // ignore this series, keep going with the rest
    }
  }
  return events;
}

async function fetchMarketsByTicker(baseUrl, tickers) {
  const wanted = tickers.filter(Boolean);
  if (wanted.length === 0) return [];
  const data = await fetchJson(`${baseUrl}/markets?tickers=${encodeURIComponent(wanted.join(','))}`);
  return data.markets ?? [];
}

function marketProbability(market) {
  return deriveKalshiProbability({
    yesBid: toNumberOrNull(market.yes_bid_dollars ?? market.yes_bid),
    yesAsk: toNumberOrNull(market.yes_ask_dollars ?? market.yes_ask),
    lastPrice: toNumberOrNull(market.last_price_dollars ?? market.last_price),
  });
}

function matchGameToEvent(game, events) {
  const candidates = events.filter((ev) => {
    const text = `${ev.title ?? ''} ${ev.sub_title ?? ''}`;
    return (
      isMoneylineText(ev.title ?? '', ev.sub_title ?? '') &&
      textMentionsTeam(text, game.away_team) &&
      textMentionsTeam(text, game.home_team)
    );
  });
  if (candidates.length !== 1) return null; // ambiguous or no match: don't guess (spec §33)
  return candidates[0];
}

function splitAwayHomeTieMarkets(event, game) {
  const markets = (event.markets ?? []).filter((m) =>
    isMoneylineText(m.title ?? '', m.yes_sub_title ?? '', m.no_sub_title ?? ''),
  );
  // Kalshi's per-team market `title` names BOTH teams (e.g. "New England vs
  // Seattle Pro Football game: Seattle wins?"), so it can't be used to tell
  // which side a specific market is about. `yes_sub_title` names only the
  // one team that market's YES side represents — use that alone.
  const sideLabel = (m) => m.yes_sub_title || m.title || '';
  const tieMarket = markets.find((m) => /\btie\b/i.test(sideLabel(m)));
  const nonTie = markets.filter((m) => m !== tieMarket);
  const awayMarket = nonTie.find((m) => shortLabelMatchesTeam(sideLabel(m), game.away_team));
  const homeMarket = nonTie.find((m) => shortLabelMatchesTeam(sideLabel(m), game.home_team));
  return { awayMarket, homeMarket, tieMarket };
}

function buildResult(game, mappingInfo, awayMarket, homeMarket, tieMarket, confidence) {
  const away = marketProbability(awayMarket);
  const home = marketProbability(homeMarket);
  const tie = tieMarket ? marketProbability(tieMarket) : null;
  return {
    game_id: game.id,
    provider: 'kalshi',
    external_event_id: mappingInfo.external_event_id,
    away_market_id: mappingInfo.away_market_id,
    home_market_id: mappingInfo.home_market_id,
    tie_market_id: mappingInfo.tie_market_id ?? null,
    match_confidence: confidence,
    away_probability_raw: away?.probability ?? null,
    home_probability_raw: home?.probability ?? null,
    tie_probability_raw: tie?.probability ?? null,
    away_bid: toNumberOrNull(awayMarket.yes_bid_dollars ?? awayMarket.yes_bid),
    away_ask: toNumberOrNull(awayMarket.yes_ask_dollars ?? awayMarket.yes_ask),
    away_last: toNumberOrNull(awayMarket.last_price_dollars ?? awayMarket.last_price),
    home_bid: toNumberOrNull(homeMarket.yes_bid_dollars ?? homeMarket.yes_bid),
    home_ask: toNumberOrNull(homeMarket.yes_ask_dollars ?? homeMarket.yes_ask),
    home_last: toNumberOrNull(homeMarket.last_price_dollars ?? homeMarket.last_price),
    tie_bid: tieMarket ? toNumberOrNull(tieMarket.yes_bid_dollars ?? tieMarket.yes_bid) : null,
    tie_ask: tieMarket ? toNumberOrNull(tieMarket.yes_ask_dollars ?? tieMarket.yes_ask) : null,
    tie_last: tieMarket ? toNumberOrNull(tieMarket.last_price_dollars ?? tieMarket.last_price) : null,
    derivation_method: away?.method ?? home?.method ?? null,
  };
}

/**
 * Returns one entry per game we could confidently match, skipping the rest.
 * A game whose `prediction_market_mappings` row has manually_overridden=true
 * uses the admin's chosen market IDs directly instead of re-matching.
 */
export async function syncKalshiOdds(games, existingMappingsByGameId) {
  const baseUrl = Deno.env.get('KALSHI_API_BASE') ?? DEFAULT_BASE;
  const results = [];
  let events = null;

  for (const game of games) {
    const existing = existingMappingsByGameId.get(game.id);

    if (existing?.manually_overridden) {
      try {
        const tickers = [existing.away_market_id, existing.home_market_id, existing.tie_market_id];
        const markets = await fetchMarketsByTicker(baseUrl, tickers);
        const byTicker = new Map(markets.map((m) => [m.ticker, m]));
        const awayMarket = byTicker.get(existing.away_market_id);
        const homeMarket = byTicker.get(existing.home_market_id);
        const tieMarket = existing.tie_market_id ? byTicker.get(existing.tie_market_id) : null;
        if (!awayMarket || !homeMarket) continue;
        results.push(buildResult(game, existing, awayMarket, homeMarket, tieMarket, existing.match_confidence));
      } catch {
        // leave whatever odds are already cached for this game
      }
      continue;
    }

    if (events === null) {
      events = await fetchOpenNflEvents(baseUrl);
    }
    const event = matchGameToEvent(game, events);
    if (!event) continue;

    const { awayMarket, homeMarket, tieMarket } = splitAwayHomeTieMarkets(event, game);
    if (!awayMarket || !homeMarket) continue;

    // Kalshi's market `close_time` is set well AFTER kickoff (it stays open
    // until the game result is final, e.g. ~2 days later for this market
    // type) — not a kickoff-adjacent timestamp, so it can't use a tight
    // tolerance. expected_expiration_time/occurrence_datetime run only a
    // few hours after kickoff when present and are preferred. Either way,
    // division rivals play twice a season many weeks apart, so even a
    // generous same-week tolerance still tells the two meetings apart.
    const referenceTime =
      awayMarket.expected_expiration_time ?? awayMarket.occurrence_datetime ?? awayMarket.close_time ?? event.markets?.[0]?.close_time;
    const hoursDiff = referenceTime
      ? Math.abs(new Date(referenceTime).getTime() - new Date(game.kickoff_at).getTime()) / 3600000
      : null;
    const dateScore = hoursDiff == null ? 0.2 : hoursDiff <= 96 ? 0.4 : 0;
    const confidence = Math.min(1, 0.3 + 0.3 + dateScore);
    if (confidence < 0.7) continue;

    results.push(
      buildResult(
        game,
        {
          external_event_id: event.event_ticker,
          away_market_id: awayMarket.ticker,
          home_market_id: homeMarket.ticker,
          tie_market_id: tieMarket?.ticker ?? null,
        },
        awayMarket,
        homeMarket,
        tieMarket,
        confidence,
      ),
    );
  }

  return results;
}
