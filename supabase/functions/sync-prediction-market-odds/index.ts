// sync-prediction-market-odds: orchestrates the Kalshi/Polymarket provider
// modules and writes the shared prediction_market_mappings/odds tables
// (spec §28/§38/§39). The frontend only ever reads those cached tables —
// it never calls Kalshi/Polymarket directly.
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, assertCronOrAdmin } from '../_shared/supabaseAdmin.ts';
import { normalizeDisplayProbabilities } from '../_shared/logic.ts';
import { syncKalshiOdds } from './kalshiProvider.ts';
import { syncPolymarketOdds } from './polymarketProvider.ts';

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const admin = createAdminClient();
  const authResult = await assertCronOrAdmin(req, admin);
  if (!authResult) {
    return jsonResponse({ error: 'Cron secret or admin sign-in required.' }, 403);
  }

  try {
    const provider = (Deno.env.get('PREDICTION_MARKET_PROVIDER') ?? 'auto').toLowerCase();
    if (!['kalshi', 'polymarket', 'auto'].includes(provider)) {
      return jsonResponse({ error: `Invalid PREDICTION_MARKET_PROVIDER: ${provider}` }, 500);
    }

    // Only bother with games that haven't kicked off yet and are coming up
    // soon (spec §38 "relevant upcoming games") — no point polling markets
    // for a game three months out or one that's already final.
    const now = new Date();
    const horizon = new Date(now.getTime() + 9 * 24 * 60 * 60 * 1000);
    const { data: games, error: gamesError } = await admin
      .from('games')
      .select('id, away_team, home_team, kickoff_at, status')
      .neq('status', 'FINAL')
      .gte('kickoff_at', now.toISOString())
      .lte('kickoff_at', horizon.toISOString());

    if (gamesError) return jsonResponse({ error: gamesError.message }, 500);
    if (!games || games.length === 0) {
      return jsonResponse({ success: true, games_considered: 0, providers_written: {} }, 200);
    }

    const gameIds = games.map((g) => g.id);
    const { data: existingMappings } = await admin
      .from('prediction_market_mappings')
      .select('*')
      .in('game_id', gameIds);

    const mappingsByProvider = { kalshi: new Map(), polymarket: new Map() };
    for (const m of existingMappings ?? []) {
      mappingsByProvider[m.provider]?.set(m.game_id, m);
    }

    const summary = { games_considered: games.length, providers_written: {} };

    const runProvider = async (name, syncFn, gamesForProvider) => {
      let entries = [];
      try {
        entries = await syncFn(gamesForProvider, mappingsByProvider[name]);
      } catch (err) {
        // A provider outage must never break the core app (spec §37) — log
        // and leave whatever odds are already cached untouched.
        console.warn(`${name} sync failed, leaving cached odds in place:`, err);
        summary.providers_written[name] = { error: String(err) };
        return;
      }
      if (entries.length === 0) {
        summary.providers_written[name] = 0;
        return;
      }

      const mappingRows = entries
        .map((e) => ({
          game_id: e.game_id,
          provider: e.provider,
          external_event_id: e.external_event_id,
          away_market_id: e.away_market_id,
          home_market_id: e.home_market_id,
          tie_market_id: e.tie_market_id,
          match_confidence: e.match_confidence,
          updated_at: new Date().toISOString(),
        }))
        // Never clobber an admin's manual mapping fix (spec §34).
        .filter((r) => !mappingsByProvider[name].get(r.game_id)?.manually_overridden);

      if (mappingRows.length > 0) {
        await admin
          .from('prediction_market_mappings')
          .upsert(mappingRows, { onConflict: 'game_id,provider' });
      }

      const oddsRows = entries.map((e) => {
        const display = normalizeDisplayProbabilities({
          away: e.away_probability_raw,
          home: e.home_probability_raw,
          tie: e.tie_probability_raw,
        });
        return {
          game_id: e.game_id,
          provider: e.provider,
          away_probability_raw: e.away_probability_raw,
          home_probability_raw: e.home_probability_raw,
          tie_probability_raw: e.tie_probability_raw,
          away_probability_display: display.away,
          home_probability_display: display.home,
          tie_probability_display: display.tie,
          away_bid: e.away_bid,
          away_ask: e.away_ask,
          away_last: e.away_last,
          home_bid: e.home_bid,
          home_ask: e.home_ask,
          home_last: e.home_last,
          tie_bid: e.tie_bid,
          tie_ask: e.tie_ask,
          tie_last: e.tie_last,
          derivation_method: e.derivation_method,
          fetched_at: new Date().toISOString(),
        };
      });
      await admin.from('prediction_market_odds').upsert(oddsRows, { onConflict: 'game_id,provider' });
      summary.providers_written[name] = oddsRows.length;
    };

    if (provider === 'kalshi') {
      await runProvider('kalshi', syncKalshiOdds, games);
    } else if (provider === 'polymarket') {
      await runProvider('polymarket', syncPolymarketOdds, games);
    } else {
      // auto: prefer Kalshi; only ask Polymarket about games Kalshi didn't
      // cover. Never average the two providers together (spec §28).
      await runProvider('kalshi', syncKalshiOdds, games);
      const { data: kalshiRows } = await admin
        .from('prediction_market_odds')
        .select('game_id')
        .eq('provider', 'kalshi')
        .in('game_id', gameIds);
      const kalshiCoveredIds = new Set((kalshiRows ?? []).map((r) => r.game_id));
      const remainingGames = games.filter((g) => !kalshiCoveredIds.has(g.id));
      if (remainingGames.length > 0) {
        await runProvider('polymarket', syncPolymarketOdds, remainingGames);
      } else {
        summary.providers_written.polymarket = 0;
      }
    }

    return jsonResponse({ success: true, ...summary }, 200);
  } catch (err) {
    return jsonResponse(
      { error: `sync-prediction-market-odds failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});
