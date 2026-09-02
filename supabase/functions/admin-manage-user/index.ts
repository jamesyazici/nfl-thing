// admin-manage-user: deactivate/reactivate a claimed account, or release a
// claimed username back to unclaimed (spec §10). Admin-only.
import { jsonResponse, handleOptions } from '../_shared/cors.ts';
import { createAdminClient, getRequestUser, isAdminUser } from '../_shared/supabaseAdmin.ts';

const VALID_ACTIONS = ['deactivate', 'reactivate', 'release'];

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
  const { allowed_user_id, action, delete_auth_user = true } = body ?? {};

  if (!allowed_user_id || !VALID_ACTIONS.includes(action)) {
    return jsonResponse({ error: 'A valid allowed_user_id and action are required.' }, 400);
  }

  const { data: target, error: lookupError } = await admin
    .from('allowed_users')
    .select('id, auth_user_id')
    .eq('id', allowed_user_id)
    .maybeSingle();

  if (lookupError || !target) {
    return jsonResponse({ error: 'User not found.' }, 404);
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
