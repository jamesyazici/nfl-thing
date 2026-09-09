-- Reverts the grading half of migration 0010 ("forfeited defaults to
-- home, grades normally"), per explicit follow-up request with no
-- exceptions: a forfeited pick (submitted after that game had already
-- started) never earns credit, even when the auto-picked HOME team wins.
-- `picks.selection`/`picked_team_probability` are still stored and shown
-- for forfeited picks (so Other Picks etc. can still say "Team (auto)"),
-- they just no longer count toward correct/upset_wins.
--
-- Not touched by this migration, still fully intact: the per-game
-- forfeit determination itself in submit_weekly_picks (now() >=
-- kickoff_at), and the requirement to provide a real selection for every
-- game that hasn't started yet. Someone submitting Sunday at 1:05pm still
-- can't submit for the 1pm or Thursday games, but can and must still pick
-- every later game.

create or replace function public.weekly_user_scores()
returns table (user_id uuid, season integer, week integer, correct bigint, counted bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cw as (
    select * from public.completed_weeks()
  ),
  week_game_counts as (
    select g.season, g.week, count(*) as total_games
    from public.games g
    join cw on cw.season = g.season and cw.week = g.week
    group by g.season, g.week
  ),
  grades as (
    select p.user_id, p.season, p.week,
      (not p.forfeited and p.selection is not null and p.selection = g.winner) as is_correct
    from public.picks p
    join public.games g on g.id = p.game_id
    join cw on cw.season = p.season and cw.week = p.week
  ),
  grade_counts as (
    select user_id, season, week, count(*) filter (where is_correct) as correct_count
    from grades
    group by user_id, season, week
  )
  select
    prof.id as user_id,
    wgc.season,
    wgc.week,
    coalesce(gc.correct_count, 0) as correct,
    wgc.total_games as counted
  from week_game_counts wgc
  cross join public.profiles prof
  left join grade_counts gc
    on gc.user_id = prof.id and gc.season = wgc.season and gc.week = wgc.week;
$$;

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
  all_forfeited boolean
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
    (coalesce(pt.total_picks, 0) > 0 and pt.total_picks = pt.forfeited_picks) as all_forfeited
  from public.profiles prof
  left join submissions sub on sub.user_id = prof.id
  left join per_user_game pug on pug.user_id = prof.id
  left join pick_totals pt on pt.user_id = prof.id
  group by prof.id, prof.username, prof.normalized_username, sub.user_id, sub.submitted_at, pt.total_picks, pt.forfeited_picks
  order by submitted desc, correct desc, sub.submitted_at asc nulls last, prof.normalized_username asc;
$$;
