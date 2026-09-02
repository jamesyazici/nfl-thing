-- One row per (user, season, week) the instant a weekly slate is submitted.
-- Its mere existence is what unlocks Other Picks for that week (spec §46/§50)
-- and is permanently immutable — there is no client UPDATE/DELETE policy,
-- and only submit-picks (service role) may insert.
create table if not exists public.weekly_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  season integer not null,
  week integer not null,
  submitted_at timestamptz not null default now(),
  constraint weekly_submissions_week_range check (week between 1 and 18),
  constraint weekly_submissions_unique unique (user_id, season, week)
);

create index if not exists weekly_submissions_season_week_idx
  on public.weekly_submissions (season, week);

alter table public.weekly_submissions enable row level security;

-- Individual picks. season/week are denormalized from games at insert time
-- so the Other-Picks RLS policy (0006) can compare directly against
-- weekly_submissions without joining through games on every row check.
create table if not exists public.picks (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.weekly_submissions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  season integer not null,
  week integer not null,

  selection text,
  forfeited boolean not null default false,
  submitted_at timestamptz not null default now(),

  constraint picks_week_range check (week between 1 and 18),
  constraint picks_selection_values check (selection is null or selection in ('HOME', 'AWAY', 'TIE')),
  constraint picks_forfeit_or_selected check (forfeited = true or selection is not null),
  constraint picks_unique_user_game unique (user_id, game_id)
);

create index if not exists picks_season_week_idx on public.picks (season, week);
create index if not exists picks_submission_id_idx on public.picks (submission_id);

alter table public.picks enable row level security;
-- Policies added in 0006_rls_policies.sql.
