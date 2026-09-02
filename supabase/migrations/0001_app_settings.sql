-- Extensions we rely on for UUID generation.
create extension if not exists pgcrypto;

-- Single-row app-wide configuration: the active season, and an admin-only
-- emergency override for which week the app should treat as "current"
-- (spec §17).
create table if not exists public.app_settings (
  id boolean primary key default true,
  current_season integer not null,
  current_week_override integer,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = true),
  constraint app_settings_week_override_range
    check (current_week_override is null or current_week_override between 1 and 18)
);

insert into public.app_settings (id, current_season)
values (true, 2026)
on conflict (id) do nothing;

alter table public.app_settings enable row level security;
-- Policies added in 0006_rls_policies.sql, once helper functions exist.
