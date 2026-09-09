-- Tie-break order for the weekly leaderboard, per follow-up: when two
-- users have the same real record (correct), the tie no longer goes
-- straight to whoever submitted earliest - it first goes to whoever has
-- the higher Expected Record (their picks were probabilistically
-- "better," even if the results haven't shown it yet), and only THEN, if
-- Expected Record is also tied, to whoever submitted earliest. The
-- submitted_at column itself is unchanged - still shown, still the final
-- tie-break, just no longer the first one.
--
-- Only the ORDER BY changes - the returned columns are identical, so this
-- is a plain CREATE OR REPLACE (no signature change, no DROP needed).
create or replace function public.weekly_leaderboard(p_season integer, p_week integer)
returns table (
  user_id uuid,
  username text,
  normalized_username text,
  submitted boolean,
  submitted_at timestamptz,
  correct bigint,
  decided bigint,
  upset_wins bigint,
  all_forfeited boolean,
  expected_wins numeric,
  total_games bigint
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
  total_games_count as (
    select count(*) as n from week_games
  ),
  decided_games as (
    select id, winner from week_games where status = 'FINAL' and winner is not null
  ),
  decided_count as (
    select count(*) as n from decided_games
  ),
  undecided_games as (
    select id from week_games where not (status = 'FINAL' and winner is not null)
  ),
  submissions as (
    select user_id, submitted_at
    from public.weekly_submissions
    where season = p_season and week = p_week
  ),
  picks_this_week as (
    select user_id, game_id, selection, forfeited, picked_team_probability
    from public.picks
    where season = p_season and week = p_week
  ),
  pick_totals as (
    select user_id, count(*) as total_picks, count(*) filter (where forfeited) as forfeited_picks
    from picks_this_week
    group by user_id
  ),
  per_user_game as (
    select
      prof.id as user_id,
      dg.id as game_id,
      (not pk.forfeited and pk.selection is not null and pk.selection = dg.winner) as is_correct,
      pk.picked_team_probability
    from public.profiles prof
    cross join decided_games dg
    left join picks_this_week pk on pk.user_id = prof.id and pk.game_id = dg.id
  ),
  current_odds as (
    select distinct on (o.game_id)
      o.game_id, o.away_probability_display, o.home_probability_display
    from public.prediction_market_odds o
    where o.game_id in (select id from undecided_games)
    order by o.game_id, (o.provider = 'kalshi') desc, o.fetched_at desc
  ),
  per_user_pending as (
    select
      pk.user_id,
      sum(
        case
          when pk.forfeited then 0
          when pk.selection = 'AWAY' then coalesce(co.away_probability_display, pk.picked_team_probability, 0.5)
          when pk.selection = 'HOME' then coalesce(co.home_probability_display, pk.picked_team_probability, 0.5)
          else coalesce(pk.picked_team_probability, 0.5)
        end
      ) as pending_expected_wins
    from picks_this_week pk
    join undecided_games ug on ug.id = pk.game_id
    left join current_odds co on co.game_id = pk.game_id
    group by pk.user_id
  )
  select
    prof.id as user_id,
    prof.username,
    prof.normalized_username,
    (sub.user_id is not null) as submitted,
    sub.submitted_at,
    coalesce(sum(pug.is_correct::int), 0) as correct,
    (select n from decided_count) as decided,
    coalesce(sum((pug.is_correct and pug.picked_team_probability is not null and pug.picked_team_probability < 0.45)::int), 0) as upset_wins,
    (coalesce(pt.total_picks, 0) > 0 and pt.total_picks = pt.forfeited_picks) as all_forfeited,
    case
      when coalesce(pt.total_picks, 0) = 0 then null
      else coalesce(sum(pug.is_correct::int), 0) + coalesce(max(pp.pending_expected_wins), 0)
    end as expected_wins,
    (select n from total_games_count) as total_games
  from public.profiles prof
  left join submissions sub on sub.user_id = prof.id
  left join per_user_game pug on pug.user_id = prof.id
  left join pick_totals pt on pt.user_id = prof.id
  left join per_user_pending pp on pp.user_id = prof.id
  group by prof.id, prof.username, prof.normalized_username, sub.user_id, sub.submitted_at, pt.total_picks, pt.forfeited_picks
  order by submitted desc, correct desc, expected_wins desc, sub.submitted_at asc nulls last, prof.normalized_username asc;
$$;

revoke all on function public.weekly_leaderboard(integer, integer) from public;
grant execute on function public.weekly_leaderboard(integer, integer) to authenticated;
