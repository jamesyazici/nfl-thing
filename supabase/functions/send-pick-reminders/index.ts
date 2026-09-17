// send-pick-reminders: emails anyone who hasn't submitted picks yet for
// the current week, at four checkpoints relative to the week's first and
// second games (spec follow-up). Cron-triggered every ~10 minutes (see
// README "Cron setup"), same dual-mode auth as the sync functions so an
// admin can also trigger it manually.
//
// Sending goes through SendGrid's REST API directly (no SDK needed) using
// a single verified sender address (no custom domain required - see
// README). A provider outage or a bad address for one recipient must
// never crash the whole run, same philosophy as sync-prediction-market-odds.
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, assertCronOrAdmin } from '../_shared/supabaseAdmin.ts';
import { computeDueCheckpoints } from '../_shared/logic.ts';

const DEFAULT_SITE_URL = 'https://jamesyazici.github.io/nfl-thing/';

async function sendReminderEmail({ toEmail, username, checkpointLabel }) {
  const apiKey = Deno.env.get('SENDGRID_API_KEY');
  const fromEmail = Deno.env.get('REMINDER_FROM_EMAIL');
  const siteUrl = Deno.env.get('SITE_URL') ?? DEFAULT_SITE_URL;
  if (!apiKey || !fromEmail) {
    return { ok: false, error: 'SENDGRID_API_KEY/REMINDER_FROM_EMAIL not configured.' };
  }

  const subject = `Reminder: ${checkpointLabel} — submit your picks!`;
  const text =
    `Hey ${username},\n\n` +
    `Just a heads up — you haven't submitted your picks yet this week, and it's ${checkpointLabel.toLowerCase()}.\n\n` +
    `Head over to the site to lock them in:\n${siteUrl}\n\n` +
    `— NFL Thing`;

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: fromEmail, name: 'NFL Thing' },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `SendGrid ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const admin = createAdminClient();
  const authResult = await assertCronOrAdmin(req, admin);
  if (!authResult) {
    return jsonResponse({ error: 'Cron secret or admin sign-in required.' }, 403);
  }

  // Admin-only escape hatch for testing the mail pipeline itself, without
  // waiting for a real checkpoint window: sends immediately to everyone
  // who hasn't submitted, and — deliberately — isn't logged to
  // pick_reminders_sent, since it's an explicit one-off action, not a
  // scheduled checkpoint that needs dedup protection against re-firing.
  let force = false;
  if (authResult.mode === 'admin') {
    try {
      const body = await req.json();
      force = body?.force === true;
    } catch {
      // no/invalid JSON body is fine — force just stays false
    }
  }

  try {
    const { data: settings, error: settingsError } = await admin
      .from('app_settings')
      .select('current_season')
      .single();
    if (settingsError || !settings) {
      return jsonResponse({ error: 'app_settings not configured.' }, 500);
    }
    const season = settings.current_season;

    const { data: week, error: weekError } = await admin.rpc('get_current_week', { p_season: season });
    if (weekError || week == null) {
      return jsonResponse({ error: 'Could not determine current week.' }, 500);
    }

    let dueCheckpoints = [];
    if (force) {
      dueCheckpoints = [{ id: null, label: 'right now (admin test send)' }];
    } else {
      const { data: games, error: gamesError } = await admin
        .from('games')
        .select('kickoff_at')
        .eq('season', season)
        .eq('week', week)
        .order('kickoff_at', { ascending: true });
      if (gamesError) return jsonResponse({ error: gamesError.message }, 500);
      if (games && games.length > 0) {
        dueCheckpoints = computeDueCheckpoints(games.map((g) => g.kickoff_at), Date.now());
      }
    }

    if (dueCheckpoints.length === 0) {
      return jsonResponse({ success: true, season, week, due_checkpoints: [], sent: 0 }, 200);
    }

    const [{ data: submissions }, { data: allowedUsers }] = await Promise.all([
      admin.from('weekly_submissions').select('user_id').eq('season', season).eq('week', week),
      admin
        .from('allowed_users')
        .select('auth_user_id, username, email')
        .eq('is_active', true)
        .not('auth_user_id', 'is', null)
        .not('email', 'is', null),
    ]);

    const submittedIds = new Set((submissions ?? []).map((s) => s.user_id));
    const candidates = (allowedUsers ?? []).filter((u) => !submittedIds.has(u.auth_user_id));

    let sent = 0;
    const errors = [];

    for (const checkpoint of dueCheckpoints) {
      if (candidates.length === 0) continue;

      // The forced/manual test checkpoint has no id — it's an explicit
      // one-off, so it skips the dedup log entirely (see the comment
      // where `force` is read above).
      let alreadySentIds = new Set();
      if (checkpoint.id) {
        const { data: alreadySent } = await admin
          .from('pick_reminders_sent')
          .select('user_id')
          .eq('season', season)
          .eq('week', week)
          .eq('checkpoint', checkpoint.id);
        alreadySentIds = new Set((alreadySent ?? []).map((r) => r.user_id));
      }

      for (const user of candidates) {
        if (alreadySentIds.has(user.auth_user_id)) continue;

        const result = await sendReminderEmail({
          toEmail: user.email,
          username: user.username,
          checkpointLabel: checkpoint.label,
        });

        if (result.ok) {
          if (checkpoint.id) {
            await admin.from('pick_reminders_sent').insert({
              season,
              week,
              checkpoint: checkpoint.id,
              user_id: user.auth_user_id,
            });
          }
          sent += 1;
        } else {
          console.warn(`Reminder failed for ${user.username} (${checkpoint.id ?? 'forced'}):`, result.error);
          errors.push({ username: user.username, checkpoint: checkpoint.id ?? 'forced', error: result.error });
        }
      }
    }

    return jsonResponse(
      {
        success: true,
        season,
        week,
        due_checkpoints: dueCheckpoints.map((c) => c.id ?? 'forced'),
        candidates: candidates.length,
        sent,
        errors,
      },
      200,
    );
  } catch (err) {
    return jsonResponse(
      { error: `send-pick-reminders failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});
