// admin-manage-user: deactivate/reactivate a claimed account, release a
// claimed username back to unclaimed, or set a user's password directly
// (spec §10, extended per request: admin can choose family members'
// passwords instead of requiring self-service create-account.html).
// Admin-only.
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, getRequestUser, isAdminUser } from '../_shared/supabaseAdmin.ts';
import { claimUsername } from '../_shared/accountClaim.ts';

const VALID_ACTIONS = ['deactivate', 'reactivate', 'release', 'set_password'];
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
  const { allowed_user_id, action, delete_auth_user = true, password } = body ?? {};

  if (!allowed_user_id || !VALID_ACTIONS.includes(action)) {
    return jsonResponse({ error: 'A valid allowed_user_id and action are required.' }, 400);
  }

  const { data: target, error: lookupError } = await admin
    .from('allowed_users')
    .select('id, auth_user_id, normalized_username, is_active')
    .eq('id', allowed_user_id)
    .maybeSingle();

  if (lookupError || !target) {
    return jsonResponse({ error: 'User not found.' }, 404);
  }

  if (action === 'set_password') {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return jsonResponse({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
    }
    if (target.auth_user_id) {
      // Already claimed — reset the existing login's password directly.
      const { error: updateError } = await admin.auth.admin.updateUserById(target.auth_user_id, { password });
      if (updateError) return jsonResponse({ error: 'Could not update password.' }, 500);
      return jsonResponse({ success: true, mode: 'reset' }, 200);
    }
    // Not yet claimed — claim it right now with the admin-chosen password,
    // through the exact same race-safe path create-account.html uses.
    if (!target.is_active) {
      return jsonResponse({ error: 'This username is deactivated — reactivate it first.' }, 400);
    }
    const result = await claimUsername(admin, target.normalized_username, password);
    if (result.error) return jsonResponse({ error: result.error }, result.status);
    return jsonResponse({ success: true, mode: 'claimed' }, 200);
  }

  if (action === 'deactivate' || action === 'reactivate') {
    const nextActive = action === 'reactivate';
    await admin.from('allowed_users').update({ is_active: nextActive }).eq('id', target.id);
    if (target.auth_user_id) {
      await admin.from('profiles').update({ is_active: nextActive }).eq('id', target.auth_user_id);
      // Ban/unban at the Auth level too, so a deactivated user can't just
      // keep signing in with their existing session/password.
      await admin.auth.admin.updateUserById(target.auth_user_id, {
        ban_duration: nextActive ? 'none' : '876000h',
      });
    }
    return jsonResponse({ success: true }, 200);
  }

  // action === 'release': undo a claim entirely so the username can be
  // claimed again from scratch. We remove the underlying auth user (unless
  // explicitly told not to) because Supabase Auth won't let a new account
  // reuse the same synthetic email while the old one still exists.
  if (target.auth_user_id) {
    if (delete_auth_user) {
      await admin.auth.admin.deleteUser(target.auth_user_id);
    }
    await admin.from('profiles').delete().eq('id', target.auth_user_id);
  }
  await admin
    .from('allowed_users')
    .update({ claimed: false, claimed_at: null, auth_user_id: null, is_active: true })
    .eq('id', target.id);

  return jsonResponse({ success: true }, 200);
});
