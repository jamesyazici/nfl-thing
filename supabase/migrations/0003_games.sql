-- NFL regular-season games, synced from nflverse (spec §12/§13/§70).
-- external_id is nflverse's stable game_id (e.g. "2026_01_NE_SEA") and is
-- what makes sync-nfl-games idempotent.
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  season integer not null,
  week integer not null,
  game_type text not null default 'REG',

  gameday date not null,
  kickoff_at timestamptz not null,

  away_team text not null,
  home_team text not null,

  away_score integer,
  home_score integer,

  status text not null default 'SCHEDULED',
  winner text,

  -- Entering-this-game record/last-5, computed from prior REG games in the
  -- same season (spec §22/§23) — recomputed on every sync.
  away_wins integer not null default 0,
  away_losses integer not null default 0,
  away_ties integer not null default 0,

  home_wins integer not null default 0,
  home_losses integer not null default 0,
  home_ties integer not null default 0,

  away_last_5 text not null default '-----',
  home_last_5 text not null default '-----',

  last_synced_at timestamptz,

  constraint games_week_range check (week between 1 and 18),
  constraint games_game_type_reg check (game_type = 'REG'),
  constraint games_status_values check (status in ('SCHEDULED', 'IN_PROGRESS', 'FINAL')),
  constraint games_winner_values check (winner is null or winner in ('HOME', 'AWAY', 'TIE')),
  constraint games_last5_len check (char_length(away_last_5) = 5 and char_length(home_last_5) = 5)
);

create index if not exists games_season_week_idx on public.games (season, week);
create index if not exists games_kickoff_at_idx on public.games (kickoff_at);

alter table public.games enable row level security;
-- Policies added in 0006_rls_policies.sql.
