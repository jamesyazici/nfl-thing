-- The single atomic operation behind the submit-picks Edge Function
-- (spec §42-§46). Everything happens inside one Postgres statement/
-- transaction so there is no read-then-write gap for a game to slip past
-- kickoff in, and every forfeit decision uses the database's own `now()` —
-- never anything the client sent (spec §16/§43/§44).
--
-- Deliberately NOT granted to `authenticated`: p_user_id is trusted as
-- coming from the Edge Function's own verified JWT lookup, not from the
-- request body, so only the service-role-authenticated submit-picks
-- function may call this (spec §97-K "forged user ID").
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
        -- Started games are always forfeited, regardless of what (if
        -- anything) the client sent for them (spec §41/§44/§97-M).
        insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
        values (v_submission_id, p_user_id, v_game.id, p_season, p_week, null, true);
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
