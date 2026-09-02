// claim-account: turns an admin-reserved username into a real login (spec
// §8/§9). Called by someone who is NOT signed in yet, so this function has
// verify_jwt = false (see supabase/config.toml) — it does all of its own
// validation using the service-role client. The actual claim logic lives in
// _shared/accountClaim.ts, shared with the admin-driven "set password" path.
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient } from '../_shared/supabaseAdmin.ts';
import { normalizeUsername, isValidUsername } from '../_shared/logic.ts';
import { claimUsername } from '../_shared/accountClaim.ts';

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

  const admin = createAdminClient();
  const result = await claimUsername(admin, normalizeUsername(username), password);

  if (result.error) {
    return jsonResponse({ error: result.error }, result.status);
  }
  return jsonResponse({ success: true, username: result.username }, 200);
});
