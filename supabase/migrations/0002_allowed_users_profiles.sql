-- Admin-reserved usernames. A row here is the ONLY way a username can ever
-- be claimed via create-account.html (spec §5/§8) — there is no open signup.
create table if not exists public.allowed_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  normalized_username text not null unique,
  claimed boolean not null default false,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  constraint allowed_users_username_charset check (username ~ '^[A-Za-z0-9_-]{1,32}$')
);

create index if not exists allowed_users_normalized_username_idx
  on public.allowed_users (normalized_username);

alter table public.allowed_users enable row level security;

-- Public-facing profile, one row per claimed auth user. This is what
-- Other Picks / Leaderboard join against for display names.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  normalized_username text not null unique,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint profiles_username_charset check (username ~ '^[A-Za-z0-9_-]{1,32}$')
);

alter table public.profiles enable row level security;
-- Policies added in 0006_rls_policies.sql.
