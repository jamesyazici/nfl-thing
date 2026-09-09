-- Adds an "expected record" per user per week to weekly_leaderboard(): the
-- sum of each pick's probability of being correct at the moment it was
-- submitted, across the WHOLE week's slate (not just decided games) so it
-- reads as a standing projection you can compare your real record against
-- once the week finishes. A forfeited pick always contributes 0 (never
-- earns credit, no exceptions - same rule as everywhere else). A real,
-- non-forfeited pick whose game had no matched market at submission time
-- (picked_team_probability is null) falls back to 0.5 - a neutral "no
-- information" assumption - rather than skewing the total in either
-- direction or leaving it undefined.
--
-- Postgres won't let CREATE OR REPLACE change an existing function's
-- return row type (adding a column counts as changing it), so the old
-- signature has to be dropped first.
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
  per_user_expected as (
    select
      prof.id as user_id,
      sum(case when pk.forfeited then 0 else coalesce(pk.picked_team_probability, 0.5) end) as expected_wins
    from public.profiles prof
    cross join week_games wg
    left join picks_this_week pk on pk.user_id = prof.id and pk.game_id = wg.id
    group by prof.id
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
    coalesce(max(pe.expected_wins), 0) as expected_wins,
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
