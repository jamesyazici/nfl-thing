-- Row Level Security policies.
--
-- General shape: authenticated users can read games/odds/profiles freely;
-- writes to every table are performed exclusively by Edge Functions using
-- the service-role (secret) client, which bypasses RLS entirely — so this
-- file deliberately grants NO insert/update/delete to the `authenticated`
-- role anywhere except the two narrow admin exceptions below. Postgres RLS
-- defaults to deny for any command with no matching policy, which is what
-- enforces spec §106 ("normal users cannot directly insert/update/delete
-- official picks", "RLS rejects it").

-- ---------------------------------------------------------------------
-- Helper functions. SECURITY DEFINER so they run with the migration
-- owner's privileges (which bypass RLS) instead of re-entering RLS on the
-- tables they check — this is the standard pattern for avoiding RLS
-- recursion when a policy needs to look at a *different* table's rows.
-- ---------------------------------------------------------------------

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = uid), false);
$$;

create or replace function public.has_submitted(uid uuid, p_season integer, p_week integer)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.weekly_submissions ws
    where ws.user_id = uid and ws.season = p_season and ws.week = p_week
  );
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated;

revoke all on function public.has_submitted(uuid, integer, integer) from public;
grant execute on function public.has_submitted(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------

create policy app_settings_select_authenticated on public.app_settings
  for select to authenticated using (true);

-- Admin-only emergency current_week_override (spec §17). Everything else
-- about app_settings still requires an Edge Function/service role.
create policy app_settings_update_admin on public.app_settings
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------

create policy profiles_select_authenticated on public.profiles
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- allowed_users (admin/backend only, spec §72)
-- ---------------------------------------------------------------------

create policy allowed_users_select_admin on public.allowed_users
  for select to authenticated using (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- games
-- ---------------------------------------------------------------------

create policy games_select_authenticated on public.games
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- weekly_submissions — the Other Picks gate (spec §48/§50)
-- ---------------------------------------------------------------------

create policy weekly_submissions_select_gated on public.weekly_submissions
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_submitted(auth.uid(), season, week)
  );

-- ---------------------------------------------------------------------
-- picks — same gate as weekly_submissions
-- ---------------------------------------------------------------------

create policy picks_select_gated on public.picks
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_submitted(auth.uid(), season, week)
  );

-- ---------------------------------------------------------------------
-- prediction_market_mappings — admins may hand-correct a bad auto-match
-- ---------------------------------------------------------------------

create policy pmm_select_authenticated on public.prediction_market_mappings
  for select to authenticated using (true);

create policy pmm_update_admin on public.prediction_market_mappings
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- prediction_market_odds
-- ---------------------------------------------------------------------

create policy pmo_select_authenticated on public.prediction_market_odds
  for select to authenticated using (true);
