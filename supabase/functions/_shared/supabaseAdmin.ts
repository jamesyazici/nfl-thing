import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Service-role ("secret key") client. Only ever used inside Edge Functions —
// never send this key to a browser. It bypasses Row Level Security, which is
// exactly why every privileged write in this app goes through a function
// that uses this client rather than the browser writing to Postgres directly.
export function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const secretKey =
    Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !secretKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SECRET_KEY must be set as function secrets (see README).',
    );
  }
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Extract and verify the calling user from the request's bearer token. Returns null if absent/invalid. */
export async function getRequestUser(req, adminClient) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/** Look up whether a given auth user id is an active admin, per `profiles`. */
export async function isAdminUser(adminClient, userId) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('is_admin, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return false;
  return Boolean(data.is_admin && data.is_active);
}

/**
 * Dual-mode authorization for the sync functions (spec §14/§38 automatic
 * cron + §10 "admin can trigger sync manually"): either a valid
 * `x-cron-secret` header matching CRON_SECRET, or a signed-in admin's JWT.
 * Never trusts anything else the caller claims.
 */
export async function assertCronOrAdmin(req, adminClient) {
  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  if (cronSecret && providedSecret && providedSecret === cronSecret) {
    return { mode: 'cron' };
  }
  const user = await getRequestUser(req, adminClient);
  if (user && (await isAdminUser(adminClient, user.id))) {
    return { mode: 'admin', user };
  }
  return null;
}
