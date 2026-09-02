-- Shared pgTAP test helpers. Not a migration — only loaded by `supabase test
-- db` (see README "Running the database tests"). These tests were written
-- against the schema in supabase/migrations/ but could not be executed in
-- the environment this project was built in (no Docker/Supabase CLI
-- available there) — run them yourself after `supabase start`.
create schema if not exists tests;

-- Impersonate a given auth user as Postgres/PostgREST would for an
-- authenticated request, so RLS policies evaluate exactly as they would in
-- production.
create or replace function tests.authenticate_as(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
end;
$$;

create or replace function tests.clear_authentication()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Minimal auth.users + profiles row for a test fixture user.
create or replace function tests.create_user(p_id uuid, p_username text, p_is_admin boolean default false)
returns void
language plpgsql
as $$
begin
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, aud, role)
  values (p_id, lower(p_username) || '@users.family-pickem.invalid', 'x', now(), now(), now(), 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  insert into public.profiles (id, username, normalized_username, is_admin, is_active)
  values (p_id, p_username, lower(p_username), p_is_admin, true)
  on conflict (id) do nothing;
end;
$$;
