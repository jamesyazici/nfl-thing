import { syntheticEmailFor } from './logic.ts';

/**
 * Atomically claims a reserved (unclaimed) username with the given
 * password, creating the Supabase Auth user + profile. Shared by the
 * self-service claim-account flow and the admin-driven "set password for a
 * not-yet-claimed user" flow in admin-manage-user — the exact
 * race-condition-safe claim logic (spec §9/§97-O) only exists in one place,
 * so both callers get the same guarantees. Returns { error, status } on
 * failure, { success: true, username } on success.
 */
export async function claimUsername(admin, normalizedUsername, password) {
  // Friendly-error pre-check. The actual race-condition-safe gate is the
  // conditional UPDATE below — this SELECT only decides which error to
  // show for the straightforward (non-racing) case.
  const { data: existing, error: lookupError } = await admin
    .from('allowed_users')
    .select('claimed, is_active')
    .eq('normalized_username', normalizedUsername)
    .maybeSingle();

  if (lookupError) return { error: 'Something went wrong. Please try again.', status: 500 };
  if (!existing) return { error: 'That username has not been invited.', status: 404 };
  if (!existing.is_active) return { error: 'That username has been deactivated.', status: 403 };
  if (existing.claimed) return { error: 'That account has already been created.', status: 409 };

  const { data: claimRow, error: claimError } = await admin
    .from('allowed_users')
    .update({ claimed: true, claimed_at: new Date().toISOString() })
    .eq('normalized_username', normalizedUsername)
    .eq('claimed', false)
    .eq('is_active', true)
    .select('id, username, is_admin')
    .maybeSingle();

  if (claimError) return { error: 'Something went wrong. Please try again.', status: 500 };
  if (!claimRow) return { error: 'That account has already been created.', status: 409 };

  const email = syntheticEmailFor(normalizedUsername);
  const { data: authResult, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: claimRow.username, normalized_username: normalizedUsername },
  });

  if (authError || !authResult?.user) {
    // Compensate: release the claim so the username isn't stuck locked forever.
    await admin.from('allowed_users').update({ claimed: false, claimed_at: null }).eq('id', claimRow.id);
    return { error: 'Could not create account. Please try again.', status: 500 };
  }

  await admin.from('allowed_users').update({ auth_user_id: authResult.user.id }).eq('id', claimRow.id);

  const { error: profileError } = await admin.from('profiles').insert({
    id: authResult.user.id,
    username: claimRow.username,
    normalized_username: normalizedUsername,
    is_admin: claimRow.is_admin,
    is_active: true,
  });

  if (profileError) {
    return { error: 'Account created but profile setup failed. Contact the administrator.', status: 500 };
  }

  return { success: true, username: claimRow.username };
}
