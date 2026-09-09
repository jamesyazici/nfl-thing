-- Simplifies forfeits further: since migration 0014 already made a
-- forfeited pick worth 0 points no matter what, there's no real reason
-- left to record a specific team ("HOME") for it — that was only
-- meaningful back when it was going to be graded normally. Storing a pick
-- that can never count as correct is just confusing complexity. Forfeited
-- picks now store selection = NULL again (plain "FORFEIT" everywhere,
-- same as before migration 0010 ever existed) instead of 'HOME'.
--
-- No other function needs to change: weekly_user_scores()/
-- weekly_leaderboard() already gate correctness on `not forfeited`
-- (migration 0014), so they're correct regardless of what a forfeited
-- row's selection happens to be. The display code (picks.js,
-- other-picks.js) already branches on "selection is null -> show FORFEIT",
-- that's exactly what re-activates here.

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
        -- anything) the client sent for them (spec §41/§44/§97-M). No
        -- team is recorded - it's worth 0 points either way.
        insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited, picked_team_probability)
        values (v_submission_id, p_user_id, v_game.id, p_season, p_week, null, true, null);
      else
        if v_client_selection is null or v_client_selection not in ('HOME', 'AWAY', 'TIE') then
          raise exception 'MISSING_SELECTION:%', v_game.id using errcode = 'P0001';
        end if;

        insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited, picked_team_probability)
        values (
          v_submission_id, p_user_id, v_game.id, p_season, p_week, v_client_selection, false,
          (
            select case v_client_selection
                     when 'AWAY' then o.away_probability_display
                     when 'HOME' then o.home_probability_display
                     else null
                   end
            from public.prediction_market_odds o
            where o.game_id = v_game.id
            order by (o.provider = 'kalshi') desc
            limit 1
          )
        );
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

-- One-time cleanup for any forfeited picks already stored with the old
-- 'HOME' fill-in (there shouldn't be many yet - the season had barely
-- started - but keep the data consistent with the new rule either way).
update public.picks
set selection = null, picked_team_probability = null
where forfeited = true and selection is not null;
