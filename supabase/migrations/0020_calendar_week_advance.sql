-- get_current_week() switches from calendar-day-agnostic ("wait for the
-- last game to go FINAL") to a fixed weekly cadence, per follow-up: a
-- week's tab stays "current" through Tuesday (a buffer day to compare
-- Expected Record against how it actually played out and check
-- placements), then automatically flips to the next week at Wednesday
-- 00:00 America/New_York - regardless of whether every game has actually
-- gone FINAL by then. Users can still manually browse any week at any
-- time via the existing week selector; this only changes which week
-- loads by default.
--
-- Each week's own boundary is the first Wednesday midnight on/after that
-- week's LATEST scheduled kickoff (normally the Monday night game, so
-- +2 days = Wednesday). Derived from the actual synced schedule rather
-- than a hardcoded day offset, so it stays correct even if a given week's
-- last game ever lands on an unusual day (a moved Tuesday makeup game,
-- etc).
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
  v_max_week integer;
  v_advanced_weeks integer;
begin
  select coalesce(p_season, current_season), current_week_override
    into v_season, v_override
    from public.app_settings;

  if v_override is not null then
    return v_override;
  end if;

  select max(week) into v_max_week from public.games where season = v_season;

  if v_max_week is null then
    -- Nothing synced yet for this season.
    return 1;
  end if;

  select count(*) into v_advanced_weeks
  from (
    select week, max(kickoff_at) as last_kickoff
    from public.games
    where season = v_season
    group by week
  ) w
  where (
    (
      date_trunc('day', w.last_kickoff at time zone 'America/New_York')
      + (((3 - extract(dow from w.last_kickoff at time zone 'America/New_York')::int) + 7) % 7) * interval '1 day'
    ) at time zone 'America/New_York'
  ) <= now();

  -- Capped at the last synced week (season over, or nothing beyond it
  -- synced yet) - same fallback the old rule had.
  return least(v_advanced_weeks + 1, v_max_week);
end;
$$;

revoke all on function public.get_current_week(integer) from public;
grant execute on function public.get_current_week(integer) to authenticated;
