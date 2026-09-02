-- Leaderboard + current-week logic, all computed in Postgres (spec §74)
-- rather than in browser JavaScript.
--
-- Every function below is SECURITY DEFINER so it can read across ALL users'
-- `picks` rows to compute aggregates (a normal, RLS-respecting query could
-- only ever see the caller's own picks + weeks they've submitted, which
-- would silently produce a wrong/partial leaderboard for anyone who has
-- skipped a week). This is safe specifically because none of these
-- functions ever return an individual `selection` value — only aggregate
-- counts, ranks, and win rates. Pick-level privacy is still enforced
-- entirely by the RLS policies in 0006 on the base tables; nothing here
-- reopens that.

-- ---------------------------------------------------------------------
-- Current week (spec §17)
-- ---------------------------------------------------------------------

create or replace function public.get_current_week(p_season integer default null)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_season integer;
  v_override integer;
  v_week integer;
  v_max_week integer;
begin
  select coalesce(p_season, current_season), current_week_override
    into v_season, v_override
    from public.app_settings;

  if v_override is not null then
    return v_override;
  end if;

  -- Earliest week that has not fully concluded (spec §17: "once Monday
  -- night's final game is final, the app should naturally move toward the
  -- next week").
  select min(week) into v_week
  from (
    select week from public.games
    where season = v_season
    group by week
    having bool_and(status = 'FINAL') = false
  ) incomplete_weeks;

  if v_week is not null then
    return v_week;
  end if;

  -- Every synced week is FINAL (season over) or nothing has synced yet.
  select max(week) into v_max_week from public.games where season = v_season;

  return coalesce(v_max_week, 1);
end;
$$;

revoke all on function public.get_current_week(integer) from public;
grant execute on function public.get_current_week(integer) to authenticated;

-- ---------------------------------------------------------------------
-- completed_weeks: weeks where every game is FINAL. Weekly ranking and
-- season accuracy are both gated at this granularity (spec §55/§56/§61) —
-- a week's standings/accuracy contribution only lands once it's fully
-- decided, including whatever any non-submitter's synthetic 0/N penalty
-- ends up being.
-- ---------------------------------------------------------------------

create or replace function public.completed_weeks()
returns table (season integer, week integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select season, week from public.games
  group by season, week
  having bool_and(status = 'FINAL');
$$;

-- ---------------------------------------------------------------------
-- weekly_user_scores: correct/counted per (user, completed week). Every
-- profile gets a row for every completed week (via the cross join), so a
-- user who never submitted that week still gets counted = total games,
-- correct = 0 (spec §54) instead of being silently excluded.
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- weekly_ranks: RANK() over correct desc, ties share a rank (spec §55).
-- ---------------------------------------------------------------------

create or replace function public.weekly_ranks()
returns table (user_id uuid, season integer, week integer, correct bigint, counted bigint, weekly_rank bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_id, season, week, correct, counted,
    rank() over (partition by season, week order by correct desc) as weekly_rank
  from public.weekly_user_scores();
$$;

-- ---------------------------------------------------------------------
-- season_user_stats: current-season win rate + average finish across
-- completed weeks only (spec §56/§61). Only produces a row for a user once
-- they have at least one completed week to their name.
-- ---------------------------------------------------------------------

create or replace function public.season_user_stats()
returns table (user_id uuid, total_correct bigint, total_counted bigint, win_rate numeric, avg_finish numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    wr.user_id,
    sum(wr.correct) as total_correct,
    sum(wr.counted) as total_counted,
    case when sum(wr.counted) = 0 then 0::numeric
         else round(sum(wr.correct)::numeric / sum(wr.counted), 4)
    end as win_rate,
    round(avg(wr.weekly_rank), 2) as avg_finish
  from public.weekly_ranks() wr
  join public.app_settings s on wr.season = s.current_season
  group by wr.user_id;
$$;

-- ---------------------------------------------------------------------
-- Top-3 leaderboard sections (spec §57-§60). Deterministic tiebreaks:
-- normalized_username as the final fallback so ordering never changes
-- between page loads.
-- ---------------------------------------------------------------------

create or replace function public.top3_win_rate()
returns table (
  username text,
  normalized_username text,
  total_correct bigint,
  total_counted bigint,
  win_rate numeric,
  avg_finish numeric,
  position bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    prof.username,
    prof.normalized_username,
    sus.total_correct,
    sus.total_counted,
    sus.win_rate,
    sus.avg_finish,
    row_number() over (
      order by sus.win_rate desc, sus.avg_finish asc, prof.normalized_username asc
    ) as position
  from public.season_user_stats() sus
  join public.profiles prof on prof.id = sus.user_id
  order by position
  limit 3;
$$;

create or replace function public.top3_avg_finish()
returns table (
  username text,
  normalized_username text,
  avg_finish numeric,
  win_rate numeric,
  total_correct bigint,
  total_counted bigint,
  position bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    prof.username,
    prof.normalized_username,
    sus.avg_finish,
    sus.win_rate,
    sus.total_correct,
    sus.total_counted,
    row_number() over (
      order by sus.avg_finish asc, sus.win_rate desc, prof.normalized_username asc
    ) as position
  from public.season_user_stats() sus
  join public.profiles prof on prof.id = sus.user_id
  order by position
  limit 3;
$$;

revoke all on function public.completed_weeks() from public;
revoke all on function public.weekly_user_scores() from public;
revoke all on function public.weekly_ranks() from public;
revoke all on function public.season_user_stats() from public;
revoke all on function public.top3_win_rate() from public;
revoke all on function public.top3_avg_finish() from public;

grant execute on function public.completed_weeks() to authenticated;
grant execute on function public.weekly_user_scores() to authenticated;
grant execute on function public.weekly_ranks() to authenticated;
grant execute on function public.season_user_stats() to authenticated;
grant execute on function public.top3_win_rate() to authenticated;
grant execute on function public.top3_avg_finish() to authenticated;
