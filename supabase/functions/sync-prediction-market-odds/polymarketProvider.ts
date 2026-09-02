// Polymarket read-only market-data integration (spec §31), via the public
// Gamma API (no auth, confirmed against https://docs.polymarket.com while
// building this: base https://gamma-api.polymarket.com, GET /events with
// tag_slug filtering). Same "don't guess" matching discipline as Kalshi.
import { textMentionsTeam } from '../_shared/teamMeta.ts';
import { derivePolymarketProbability } from '../_shared/logic.ts';

const DEFAULT_BASE = 'https://gamma-api.polymarket.com';

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

function parseJsonArrayField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polymarket request failed (${res.status}): ${url}`);
  return res.json();
}

async function fetchNflEvents(baseUrl) {
  const params = new URLSearchParams({ tag_slug: 'nfl', closed: 'false', limit: '200' });
  try {
    const data = await fetchJson(`${baseUrl}/events?${params.toString()}`);
    return Array.isArray(data) ? data : (data.events ?? []);
  } catch {
    return [];
  }
}

async function fetchMarketById(baseUrl, id) {
  try {
    return await fetchJson(`${baseUrl}/markets/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

function marketOutcomeProbabilities(market) {
  const outcomes = parseJsonArrayField(market.outcomes);
  const prices = parseJsonArrayField(market.outcomePrices).map((p) => toNumberOrNull(p));
  return { outcomes, prices };
}

function matchGameToMarket(game, events) {
  const candidates = [];
  for (const event of events) {
    for (const market of event.markets ?? []) {
      const text = `${event.title ?? ''} ${market.question ?? ''} ${market.groupItemTitle ?? ''}`;
      if (!isMoneylineText(text)) continue;
      const { outcomes } = marketOutcomeProbabilities(market);
      if (outcomes.length < 2 || outcomes.length > 3) continue;
      const awayIdx = outcomes.findIndex((o) => textMentionsTeam(o, game.away_team));
      const homeIdx = outcomes.findIndex((o) => textMentionsTeam(o, game.home_team));
      if (awayIdx === -1 || homeIdx === -1 || awayIdx === homeIdx) continue;
      candidates.push({ event, market, outcomes, awayIdx, homeIdx });
    }
  }
  if (candidates.length !== 1) return null; // ambiguous or no match: don't guess (spec §33)
  return candidates[0];
}

function buildResultFromMarket(game, mappingInfo, market, awayIdx, homeIdx, confidence) {
  const { outcomes, prices } = marketOutcomeProbabilities(market);
  const tieIdx = outcomes.findIndex((o, i) => i !== awayIdx && i !== homeIdx && /tie/i.test(String(o)));

  const away = derivePolymarketProbability({ price: prices[awayIdx] ?? null });
  const home = derivePolymarketProbability({ price: prices[homeIdx] ?? null });
  const tie = tieIdx >= 0 ? derivePolymarketProbability({ price: prices[tieIdx] ?? null }) : null;

  return {
    game_id: game.id,
    provider: 'polymarket',
    external_event_id: mappingInfo.external_event_id,
    away_market_id: mappingInfo.away_market_id,
    home_market_id: mappingInfo.home_market_id,
    tie_market_id: mappingInfo.tie_market_id ?? null,
    match_confidence: confidence,
    away_probability_raw: away?.probability ?? null,
    home_probability_raw: home?.probability ?? null,
    tie_probability_raw: tie?.probability ?? null,
    away_bid: toNumberOrNull(market.bestBid),
    away_ask: toNumberOrNull(market.bestAsk),
    away_last: toNumberOrNull(market.lastTradePrice),
    home_bid: null,
    home_ask: null,
    home_last: null,
    tie_bid: null,
    tie_ask: null,
    tie_last: null,
    derivation_method: away?.method ?? home?.method ?? null,
  };
}

/**
 * Same shape/contract as kalshiProvider's syncKalshiOdds: returns one entry
 * per confidently-matched game, honors manually_overridden mappings by
 * fetching that exact market id instead of re-matching.
 */
export async function syncPolymarketOdds(games, existingMappingsByGameId) {
  const baseUrl = Deno.env.get('POLYMARKET_GAMMA_API_BASE') ?? DEFAULT_BASE;
  const results = [];
  let events = null;

  for (const game of games) {
    const existing = existingMappingsByGameId.get(game.id);

    if (existing?.manually_overridden) {
      const market = await fetchMarketById(baseUrl, existing.away_market_id);
      if (!market) continue;
      const { outcomes } = marketOutcomeProbabilities(market);
      const awayIdx = outcomes.findIndex((o) => textMentionsTeam(o, game.away_team));
      const homeIdx = outcomes.findIndex((o) => textMentionsTeam(o, game.home_team));
      if (awayIdx === -1 || homeIdx === -1) continue;
      results.push(buildResultFromMarket(game, existing, market, awayIdx, homeIdx, existing.match_confidence));
      continue;
    }

    if (events === null) {
      events = await fetchNflEvents(baseUrl);
    }
    const match = matchGameToMarket(game, events);
    if (!match) continue;

    const startDate = match.event.startDate;
    const hoursDiff = startDate
      ? Math.abs(new Date(startDate).getTime() - new Date(game.kickoff_at).getTime()) / 3600000
      : null;
    const dateScore = hoursDiff == null ? 0.2 : hoursDiff <= 30 ? 0.4 : 0;
    const confidence = Math.min(1, 0.3 + 0.3 + dateScore);
    if (confidence < 0.7) continue;

    results.push(
      buildResultFromMarket(
        game,
        {
          external_event_id: String(match.event.id ?? match.event.slug ?? ''),
          // Polymarket's moneyline is one market with two outcomes, so both
          // "away" and "home" markets are really the same market id — the
          // outcome index (not a separate market) tells them apart.
          away_market_id: String(match.market.id ?? match.market.conditionId ?? ''),
          home_market_id: String(match.market.id ?? match.market.conditionId ?? ''),
          tie_market_id: null,
        },
        match.market,
        match.awayIdx,
        match.homeIdx,
        confidence,
      ),
    );
  }

  return results;
}
