-- Per-week leaderboard table for the top of the Leaderboard tab: unlike
-- top3_win_rate()/top3_avg_finish() (season-long, top 3 only), this shows
-- EVERY family member for one selected week, updates live as games finish,
-- and includes "upset wins" (correctly picked a team priced as an underdog
-- by the cached prediction-market odds).
--
-- SECURITY DEFINER for the same reason as the rest of the leaderboard
-- pipeline (0007): it needs to read every user's picks to compute
-- aggregates, which a normal RLS-respecting query only could for weeks the
-- caller has themselves submitted. Never returns an individual `selection`
-- though — only counts — so pick privacy (spec §48) is untouched; whether
-- someone submitted a game correctly stays folded into an aggregate here,
-- exactly like the rest of this pipeline.
create or replace function public.weekly_leaderboard(p_season integer, p_week integer)
returns table (
  user_id uuid,
  username text,
  normalized_username text,
  submitted boolean,
  submitted_at timestamptz,
  correct bigint,
  decided bigint,
  upset_wins bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with week_games as (
    select id, status, winner
    from public.games
    where season = p_season and week = p_week
  ),
  decided_games as (
    select id, winner from week_games where status = 'FINAL' and winner is not null
  ),
  decided_count as (
    select count(*) as n from decided_games
  ),
  -- Prefer Kalshi odds over Polymarket when both exist for a game, same
  -- preference rule used for on-screen display (spec §28).
  odds_preferred as (
    select distinct on (game_id) game_id, away_probability_display, home_probability_display
    from public.prediction_market_odds
    where game_id in (select id from week_games)
    order by game_id, (provider = 'kalshi') desc
  ),
  submissions as (
    select user_id, submitted_at
    from public.weekly_submissions
    where season = p_season and week = p_week
  ),
  picks_this_week as (
    select user_id, game_id, selection
    from public.picks
    where season = p_season and week = p_week
  ),
  per_user_game as (
    select
      prof.id as user_id,
      dg.id as game_id,
      (pk.selection is not null and pk.selection = dg.winner) as is_correct,
      case pk.selection
        when 'AWAY' then op.away_probability_display
        when 'HOME' then op.home_probability_display
        else null
      end as picked_team_probability
    from public.profiles prof
    cross join decided_games dg
    left join picks_this_week pk on pk.user_id = prof.id and pk.game_id = dg.id
    left join odds_preferred op on op.game_id = dg.id
  )
  select
    prof.id as user_id,
    prof.username,
    prof.normalized_username,
    (sub.user_id is not null) as submitted,
    sub.submitted_at,
    coalesce(sum(pug.is_correct::int), 0) as correct,
    (select n from decided_count) as decided,
    coalesce(sum((pug.is_correct and pug.picked_team_probability is not null and pug.picked_team_probability < 0.45)::int), 0) as upset_wins
  from public.profiles prof
  left join submissions sub on sub.user_id = prof.id
  left join per_user_game pug on pug.user_id = prof.id
  group by prof.id, prof.username, prof.normalized_username, sub.user_id, sub.submitted_at
  order by submitted desc, correct desc, sub.submitted_at asc nulls last, prof.normalized_username asc;
$$;

revoke all on function public.weekly_leaderboard(integer, integer) from public;
grant execute on function public.weekly_leaderboard(integer, integer) to authenticated;
