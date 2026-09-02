// claim-account: turns an admin-reserved username into a real login (spec
// §8/§9). Called by someone who is NOT signed in yet, so this function has
// verify_jwt = false (see supabase/config.toml) — it does all of its own
// validation using the service-role client.
import { corsHeaders, jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient } from '../_shared/supabaseAdmin.ts';
import { normalizeUsername, isValidUsername, syntheticEmailFor } from '../_shared/logic.ts';

const MIN_PASSWORD_LENGTH = 8;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const { username, password } = body ?? {};

  if (!isValidUsername(username)) {
    return jsonResponse(
      { error: 'Usernames may only contain letters, numbers, underscores, and hyphens (max 32 characters).' },
      400,
    );
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return jsonResponse({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
  }

  const normalized = normalizeUsername(username);
  const admin = createAdminClient();

  // Friendly-error pre-check (spec §78). The actual race-condition-safe gate
  // is the conditional UPDATE below — this SELECT only decides *which*
  // error message to show when the straightforward case applies.
  const { data: existing, error: lookupError } = await admin
    .from('allowed_users')
    .select('claimed, is_active')
    .eq('normalized_username', normalized)
    .maybeSingle();

  if (lookupError) {
    return jsonResponse({ error: 'Something went wrong. Please try again.' }, 500);
  }
  if (!existing) {
    return jsonResponse({ error: 'That username has not been invited.' }, 404);
  }
  if (!existing.is_active) {
    return jsonResponse({ error: 'That username has been deactivated. Contact the administrator.' }, 403);
  }
  if (existing.claimed) {
    return jsonResponse({ error: 'That account has already been created.' }, 409);
  }

  // Atomic claim (spec §9/§97-O): only one concurrent request's UPDATE can
  // match `claimed = false`, so exactly one caller ever gets a row back.
  const { data: claimRow, error: claimError } = await admin
    .from('allowed_users')
    .update({ claimed: true, claimed_at: new Date().toISOString() })
    .eq('normalized_username', normalized)
    .eq('claimed', false)
    .eq('is_active', true)
    .select('id, username, is_admin')
    .maybeSingle();

  if (claimError) {
    return jsonResponse({ error: 'Something went wrong. Please try again.' }, 500);
  }
  if (!claimRow) {
    return jsonResponse({ error: 'That account has already been created.' }, 409);
  }

  const email = syntheticEmailFor(normalized);
  const { data: authResult, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: claimRow.username, normalized_username: normalized },
  });

  if (authError || !authResult?.user) {
    // Compensate: release the claim so the username isn't stuck locked forever.
    await admin
      .from('allowed_users')
      .update({ claimed: false, claimed_at: null })
      .eq('id', claimRow.id);
    return jsonResponse({ error: 'Could not create account. Please try again.' }, 500);
  }

  await admin.from('allowed_users').update({ auth_user_id: authResult.user.id }).eq('id', claimRow.id);

  const { error: profileError } = await admin.from('profiles').insert({
    id: authResult.user.id,
    username: claimRow.username,
    normalized_username: normalized,
    is_admin: claimRow.is_admin,
    is_active: true,
  });

  if (profileError) {
    return jsonResponse(
      { error: 'Account created but profile setup failed. Contact the administrator.' },
      500,
    );
  }

  return jsonResponse({ success: true, username: claimRow.username }, 200);
});
