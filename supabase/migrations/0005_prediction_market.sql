-- Which Kalshi/Polymarket market(s) correspond to which game (spec §34).
-- Populated by sync-prediction-market-odds; admins may hand-correct a bad
-- automatic match via manually_overridden (checked by the sync so it won't
-- clobber a manual fix).
create table if not exists public.prediction_market_mappings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  provider text not null,
  external_event_id text not null,
  away_market_id text,
  home_market_id text,
  tie_market_id text,
  match_confidence numeric(4, 3) not null default 0,
  manually_overridden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pmm_provider_values check (provider in ('kalshi', 'polymarket')),
  constraint pmm_confidence_range check (match_confidence between 0 and 1),
  constraint pmm_unique_game_provider unique (game_id, provider)
);

alter table public.prediction_market_mappings enable row level security;

-- Cached implied-probability snapshots (spec §35). The frontend only ever
-- reads this table — it never calls Kalshi/Polymarket directly (spec §39).
create table if not exists public.prediction_market_odds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  provider text not null,

  away_probability_raw numeric(6, 5),
  home_probability_raw numeric(6, 5),
  tie_probability_raw numeric(6, 5),

  away_probability_display numeric(5, 4),
  home_probability_display numeric(5, 4),
  tie_probability_display numeric(5, 4),

  away_bid numeric(6, 5),
  away_ask numeric(6, 5),
  away_last numeric(6, 5),

  home_bid numeric(6, 5),
  home_ask numeric(6, 5),
  home_last numeric(6, 5),

  tie_bid numeric(6, 5),
  tie_ask numeric(6, 5),
  tie_last numeric(6, 5),

  derivation_method text,
  fetched_at timestamptz not null default now(),

  constraint pmo_provider_values check (provider in ('kalshi', 'polymarket')),
  constraint pmo_unique_game_provider unique (game_id, provider)
);

create index if not exists prediction_market_odds_game_idx on public.prediction_market_odds (game_id);

alter table public.prediction_market_odds enable row level security;
-- Policies added in 0006_rls_policies.sql.
