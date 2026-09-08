-- Changes what a forfeit means, per request: a game that's already started
-- by the time someone submits (or re-submits after some games began) no
-- longer locks in as an automatic loss. It now defaults to the HOME team
-- and grades normally against the actual result — `forfeited` stays true
-- purely as a display flag ("this pick was auto-filled, not chosen") and
-- no longer has any effect on grading itself.
--
-- Scope: this only covers games that had already started AT THE MOMENT a
-- user submitted their week. Someone who never submits a week at all is
-- untouched by this — that stays a flat 0/N via weekly_user_scores()'s
-- existing non-submitter handling, since there is no one to auto-pick on
-- behalf of.

-- ---------------------------------------------------------------------
-- submit_weekly_picks: forfeited games now get selection = 'HOME'
-- instead of null.
-- ---------------------------------------------------------------------
create or replace function public.submit_weekly_picks(
  p_user_id uuid,
  p_season integer,
  p_week integer,
  p_selections jsonb -- [{ "game_id": "...", "selection": "HOME" | "AWAY" | "TIE" }, ...]
)
returns table (game_id uuid, selection text, forfeited boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission_id uuid;
  v_game record;
  v_selection_map jsonb;
begin
  if exists (
    select 1 from public.weekly_submissions
    where user_id = p_user_id and season = p_season and week = p_week
  ) then
    raise exception 'ALREADY_SUBMITTED' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.games where season = p_season and week = p_week) then
    raise exception 'NO_GAMES_FOR_WEEK' using errcode = 'P0001';
  end if;

  select jsonb_object_agg(elem ->> 'game_id', elem ->> 'selection')
    into v_selection_map
    from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) elem
    where elem ->> 'game_id' is not null;
  v_selection_map := coalesce(v_selection_map, '{}'::jsonb);

  insert into public.weekly_submissions (user_id, season, week)
  values (p_user_id, p_season, p_week)
  returning id into v_submission_id;

  for v_game in
    select g.id, g.kickoff_at from public.games g
    where g.season = p_season and g.week = p_week
  loop
    declare
      v_forfeited boolean := now() >= v_game.kickoff_at;
      v_client_selection text := v_selection_map ->> v_game.id::text;
    begin
      if v_forfeited then
        -- Started games are always force-completed regardless of what (if
        -- anything) the client sent for them (spec §41/§44/§97-M) — but
        -- now default to HOME rather than no selection at all, per request.
        insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
        values (v_submission_id, p_user_id, v_game.id, p_season, p_week, 'HOME', true);
      else
        if v_client_selection is null or v_client_selection not in ('HOME', 'AWAY', 'TIE') then
          raise exception 'MISSING_SELECTION:%', v_game.id using errcode = 'P0001';
        end if;
        insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
        values (v_submission_id, p_user_id, v_game.id, p_season, p_week, v_client_selection, false);
      end if;
    end;
  end loop;

  return query
    select p.game_id, p.selection, p.forfeited
    from public.picks p
    where p.submission_id = v_submission_id;
end;
$$;

revoke all on function public.submit_weekly_picks(uuid, integer, integer, jsonb) from public;
grant execute on function public.submit_weekly_picks(uuid, integer, integer, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- weekly_user_scores: grading now only depends on selection vs winner,
-- not on the forfeited flag. A forfeited pick with selection = 'HOME'
-- grades CORRECT when home actually won, same as if they'd picked it
-- themselves. selection is only ever null for legacy rows predating this
-- migration, or the non-submitter synthetic-0 path below, both of which
-- still correctly grade as not-correct.
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
      (p.selection is not null and p.selection = g.winner) as is_correct
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
