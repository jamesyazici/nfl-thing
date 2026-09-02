// submit-picks: the ONLY way picks are ever written (spec §42-§47). All of
// the actual forfeit/lock logic lives in the public.submit_weekly_picks
// Postgres function (migration 0009) so it runs as one atomic,
// database-clock-authoritative transaction; this function is just the
// authenticated entry point.
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, getRequestUser } from '../_shared/supabaseAdmin.ts';

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const admin = createAdminClient();
  const user = await getRequestUser(req, admin);
  if (!user) {
    return jsonResponse({ error: 'Sign in required.' }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }
  const { season, week, selections } = body ?? {};

  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18) {
    return jsonResponse({ error: 'A valid season and week (1-18) are required.' }, 400);
  }
  if (!Array.isArray(selections)) {
    return jsonResponse({ error: 'selections must be an array of { game_id, selection }.' }, 400);
  }

  // p_user_id comes from the verified JWT above, never from the request
  // body — a client cannot submit picks on someone else's behalf
  // (spec §97-K).
  const { data, error } = await admin.rpc('submit_weekly_picks', {
    p_user_id: user.id,
    p_season: season,
    p_week: week,
    p_selections: selections,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('ALREADY_SUBMITTED')) {
      return jsonResponse({ error: 'You have already submitted picks for this week.' }, 409);
    }
    if (message.includes('NO_GAMES_FOR_WEEK')) {
      return jsonResponse({ error: 'No games are scheduled for that week yet.' }, 404);
    }
    if (message.includes('MISSING_SELECTION')) {
      return jsonResponse(
        { error: 'You must choose an outcome for every game that has not started yet.' },
        400,
      );
    }
    return jsonResponse({ error: 'Could not submit picks. Please try again.' }, 500);
  }

  return jsonResponse({ success: true, picks: data }, 200);
});
