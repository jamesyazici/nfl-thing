-- Fixes a semantic bug from migration 0016: a user who never submitted
-- picks for the week has zero rows in `picks`, so the per-game "no market
-- odds available" fallback of 0.5 was silently applying to every single
-- one of their games too - projecting a fake 50/50 record for someone who
-- made no picks at all. Those are two different kinds of "unknown" and
-- shouldn't share a value: an unpriced game on a real submitted pick
-- reasonably defaults to a neutral 50/50, but a user who never submitted
-- has nothing to project - expected_wins should be null (frontend already
-- reads this as "—", same convention as everywhere else null means "no
-- data"). The frontend currently never even shows this cell for a
-- non-submitter (it renders "Not submitted" instead), but the function
-- itself should still report the truth.
drop function if exists public.weekly_leaderboard(integer, integer);

create function public.weekly_leaderboard(p_season integer, p_week integer)
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
  -- Only users who actually have picks this week get a row here at all -
  -- the 0.5 "no market odds" fallback only ever applies to a real,
  -- submitted pick, never conjured up for a non-submitter.
  per_user_expected as (
    select
      pk.user_id,
      sum(case when pk.forfeited then 0 else coalesce(pk.picked_team_probability, 0.5) end) as expected_wins
    from picks_this_week pk
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
    max(pe.expected_wins) as expected_wins,
    (select n from total_games_count) as total_games
  from public.profiles prof
  left join submissions sub on sub.user_id = prof.id
  left join per_user_game pug on pug.user_id = prof.id
  left join pick_totals pt on pt.user_id = prof.id
  left join per_user_expected pe on pe.user_id = prof.id
  group by prof.id, prof.username, prof.normalized_username, sub.user_id, sub.submitted_at, pt.total_picks, pt.forfeited_picks
  order by submitted desc, correct desc, sub.submitted_at asc nulls last, prof.normalized_username asc;
$$;

revoke all on function public.weekly_leaderboard(integer, integer) from public;
grant execute on function public.weekly_leaderboard(integer, integer) to authenticated;
