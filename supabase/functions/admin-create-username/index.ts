// admin-create-username: reserve a new username so someone can claim it via
// create-account.html (spec §5/§10). Admin-only — enforced server-side from
// the caller's own profile, never trusting anything the client claims about
// its own privileges (spec §10 "normal users must NOT be able to make
// themselves admins").
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, getRequestUser, isAdminUser } from '../_shared/supabaseAdmin.ts';
import { normalizeUsername, isValidUsername } from '../_shared/logic.ts';
import { claimUsername } from '../_shared/accountClaim.ts';

const MIN_PASSWORD_LENGTH = 8;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const admin = createAdminClient();
  const requester = await getRequestUser(req, admin);
  if (!requester || !(await isAdminUser(admin, requester.id))) {
    return jsonResponse({ error: 'Admin access required.' }, 403);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }
  const { username, is_admin = false, password } = body ?? {};

  if (!isValidUsername(username)) {
    return jsonResponse(
      { error: 'Usernames may only contain letters, numbers, underscores, and hyphens (max 32 characters).' },
      400,
    );
  }
  const setPasswordNow = typeof password === 'string' && password.length > 0;
  if (setPasswordNow && password.length < MIN_PASSWORD_LENGTH) {
    return jsonResponse({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
  }

  const normalized = normalizeUsername(username);
  const { data, error } = await admin
    .from('allowed_users')
    .insert({
      username: String(username).trim(),
      normalized_username: normalized,
      is_admin: Boolean(is_admin),
    })
    .select('id, username, is_admin, claimed, is_active, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return jsonResponse({ error: 'That username has already been reserved.' }, 409);
    }
    return jsonResponse({ error: 'Could not reserve username.' }, 500);
  }

  // Admin chose a password up front, so login for this person is already
  // fully set up — no separate visit to create-account.html needed. The
  // username is reserved either way by this point, so a failure here is
  // reported as a warning alongside success rather than an overall error.
  if (setPasswordNow) {
    const claimResult = await claimUsername(admin, normalized, password);
    if (claimResult.error) {
      return jsonResponse(
        { success: true, user: data, password_warning: `Username reserved, but could not set the password: ${claimResult.error}` },
        200,
      );
    }
    return jsonResponse({ success: true, user: { ...data, claimed: true } }, 200);
  }

  return jsonResponse({ success: true, user: data }, 200);
});
