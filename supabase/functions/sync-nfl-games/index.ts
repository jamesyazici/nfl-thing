// sync-nfl-games: pulls the nflverse schedule/results feed and upserts
// public.games (spec §12-§15/§17/§70). Safe to run every 5-10 minutes via
// cron, or trigger manually from admin.html — see assertCronOrAdmin.
//
// Source confirmed live against the real feed while building this (Aug
// 2026): https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv
// Columns used: game_id, season, game_type, week, gameday, gametime,
// away_team, away_score, home_team, home_score. `gametime` is a bare
// "HH:MM" in America/New_York local time paired with `gameday` (date) —
// NOT UTC, and not the browser's zone (spec §15).
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, assertCronOrAdmin } from '../_shared/supabaseAdmin.ts';
import { parseCsv } from '../_shared/csv.ts';
import { computeWinner, isForfeited, buildLast5 } from '../_shared/logic.ts';

const DEFAULT_SCHEDULE_URL =
  'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';

function getEasternOffsetMinutes(gameday) {
  // DST transitions happen at 2am local time, never during an NFL kickoff
  // window, so any daytime instant on this calendar date reports the
  // correct offset for every kickoff on that date.
  const probe = new Date(`${gameday}T18:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(probe);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const match = tzPart.match(/GMT([+-]\d{2}):?(\d{2})?/);
  const hours = match ? Number(match[1]) : -5;
  const minutes = match?.[2] ? Number(match[2]) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

function buildKickoffTimestamp(gameday, gametime) {
  const time = gametime && /^\d{1,2}:\d{2}$/.test(gametime) ? gametime : '13:00';
  const [hh, mm] = time.split(':').map(Number);
  const [y, m, d] = gameday.split('-').map(Number);
  const offsetMinutes = getEasternOffsetMinutes(gameday);
  const utcMillis = Date.UTC(y, m - 1, d, hh, mm) - offsetMinutes * 60000;
  return new Date(utcMillis).toISOString();
}

function tally(results) {
  return results.reduce(
    (acc, r) => {
      if (r === 'W') acc.wins += 1;
      else if (r === 'L') acc.losses += 1;
      else if (r === 'T') acc.ties += 1;
      return acc;
    },
    { wins: 0, losses: 0, ties: 0 },
  );
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const admin = createAdminClient();
  const authResult = await assertCronOrAdmin(req, admin);
  if (!authResult) {
    return jsonResponse({ error: 'Cron secret or admin sign-in required.' }, 403);
  }

  try {
    const { data: settings, error: settingsError } = await admin
      .from('app_settings')
      .select('current_season')
      .single();
    if (settingsError || !settings) {
      return jsonResponse({ error: 'app_settings not configured.' }, 500);
    }
    const currentSeason = settings.current_season;

    const scheduleUrl = Deno.env.get('NFLVERSE_SCHEDULE_URL') ?? DEFAULT_SCHEDULE_URL;
    const csvResponse = await fetch(scheduleUrl);
    if (!csvResponse.ok) {
      return jsonResponse(
        { error: `Failed to fetch nflverse schedule (HTTP ${csvResponse.status}).` },
        502,
      );
    }
    const csvText = await csvResponse.text();
    const rows = parseCsv(csvText);

    const games = rows
      .filter((r) => r.game_type === 'REG' && Number(r.season) === currentSeason)
      .map((r) => {
        const week = Number(r.week);
        const awayScore = r.away_score === '' ? null : Number(r.away_score);
        const homeScore = r.home_score === '' ? null : Number(r.home_score);
        return {
          external_id: r.game_id,
          season: Number(r.season),
          week,
          game_type: 'REG',
          gameday: r.gameday,
          kickoff_at: buildKickoffTimestamp(r.gameday, r.gametime),
          away_team: r.away_team,
          home_team: r.home_team,
          away_score: awayScore,
          home_score: homeScore,
        };
      })
      .filter((g) => g.week >= 1 && g.week <= 18);

    const nowIso = new Date().toISOString();
    for (const g of games) {
      g.winner = computeWinner(g.away_score, g.home_score);
      g.status = g.winner != null ? 'FINAL' : isForfeited(nowIso, g.kickoff_at) ? 'IN_PROGRESS' : 'SCHEDULED';
    }

    // Entering-this-game record/last-5 (spec §22-§24), computed entirely
    // from this same sync pass — no DB round-trip needed since we already
    // have every game for the season in memory.
    const resultsByTeam = new Map();
    const pushResult = (team, week, result) => {
      if (!resultsByTeam.has(team)) resultsByTeam.set(team, []);
      resultsByTeam.get(team).push({ week, result });
    };
    for (const g of games) {
      if (g.status !== 'FINAL') continue;
      pushResult(g.away_team, g.week, g.winner === 'AWAY' ? 'W' : g.winner === 'HOME' ? 'L' : 'T');
      pushResult(g.home_team, g.week, g.winner === 'HOME' ? 'W' : g.winner === 'AWAY' ? 'L' : 'T');
    }
    for (const arr of resultsByTeam.values()) arr.sort((a, b) => a.week - b.week);

    const priorResults = (team, week) =>
      (resultsByTeam.get(team) ?? []).filter((r) => r.week < week).map((r) => r.result);

    const rowsToUpsert = games.map((g) => {
      const awayPrior = priorResults(g.away_team, g.week);
      const homePrior = priorResults(g.home_team, g.week);
      const awayTally = tally(awayPrior);
      const homeTally = tally(homePrior);
      return {
        external_id: g.external_id,
        season: g.season,
        week: g.week,
        game_type: g.game_type,
        gameday: g.gameday,
        kickoff_at: g.kickoff_at,
        away_team: g.away_team,
        home_team: g.home_team,
        away_score: g.away_score,
        home_score: g.home_score,
        status: g.status,
        winner: g.winner,
        away_wins: awayTally.wins,
        away_losses: awayTally.losses,
        away_ties: awayTally.ties,
        home_wins: homeTally.wins,
        home_losses: homeTally.losses,
        home_ties: homeTally.ties,
        away_last_5: buildLast5(awayPrior),
        home_last_5: buildLast5(homePrior),
        last_synced_at: nowIso,
      };
    });

    if (rowsToUpsert.length === 0) {
      return jsonResponse(
        { success: true, season: currentSeason, games_synced: 0, note: 'No REG games found for this season yet.' },
        200,
      );
    }

    const { error: upsertError } = await admin
      .from('games')
      .upsert(rowsToUpsert, { onConflict: 'external_id' });

    if (upsertError) {
      return jsonResponse({ error: `Upsert failed: ${upsertError.message}` }, 500);
    }

    return jsonResponse({ success: true, season: currentSeason, games_synced: rowsToUpsert.length }, 200);
  } catch (err) {
    return jsonResponse({ error: `sync-nfl-games failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});
