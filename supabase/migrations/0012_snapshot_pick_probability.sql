-- Locks in "underdog" status at the moment a pick is actually submitted,
-- rather than deriving it later from prediction_market_odds — which is a
-- single continuously-overwritten row per game/provider, so a live join
-- would silently drift if the line moved between submission and kickoff
-- (or just reflect "whatever was cached when the game went final", which
-- isn't the same thing as "what the odds were when they picked it").

-- ---------------------------------------------------------------------
-- New column: the picked team's implied probability, snapshotted once,
-- at submission time. Null when no odds were available yet, or for a
-- TIE pick — both already handled as "unknown, don't count either way"
-- by weekly_leaderboard().
-- ---------------------------------------------------------------------
alter table public.picks add column if not exists picked_team_probability numeric(5, 4);

-- ---------------------------------------------------------------------
-- submit_weekly_picks: snapshot the picked team's current cached
-- probability (prefer Kalshi over Polymarket, same rule used everywhere
-- else) into the new column at insert time. The two previous separate
-- INSERTs (forfeited vs. real selection) are unified into one now that
-- both need this same snapshot step.
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
      v_final_selection text;
      v_probability numeric(5, 4);
    begin
      if v_forfeited then
        -- Started games are always force-completed regardless of what (if
        -- anything) the client sent for them (spec §41/§44/§97-M) —
        -- defaults to HOME rather than no selection at all, per request.
        v_final_selection := 'HOME';
      else
        if v_client_selection is null or v_client_selection not in ('HOME', 'AWAY', 'TIE') then
          raise exception 'MISSING_SELECTION:%', v_game.id using errcode = 'P0001';
        end if;
        v_final_selection := v_client_selection;
      end if;

      select case v_final_selection
               when 'AWAY' then o.away_probability_display
               when 'HOME' then o.home_probability_display
               else null
             end
        into v_probability
        from public.prediction_market_odds o
        where o.game_id = v_game.id
        order by (o.provider = 'kalshi') desc
        limit 1;

      insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited, picked_team_probability)
      values (v_submission_id, p_user_id, v_game.id, p_season, p_week, v_final_selection, v_forfeited, v_probability);
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
-- One-time backfill for picks submitted before this column existed: best
-- effort using whatever odds are cached right now (these games mostly
-- haven't kicked off yet, so this is a close approximation, not a true
-- retroactive snapshot — there's no way to recover what the odds actually
-- were at their real submission time). Only fills rows that are still
-- null; never overwrites a real snapshot.
-- ---------------------------------------------------------------------
update public.picks p
set picked_team_probability = sub.prob
from (
  select p2.id as pick_id,
    case p2.selection
      when 'AWAY' then o.away_probability_display
      when 'HOME' then o.home_probability_display
      else null
    end as prob
  from public.picks p2
  left join lateral (
    select away_probability_display, home_probability_display
    from public.prediction_market_odds
    where game_id = p2.game_id
    order by (provider = 'kalshi') desc
    limit 1
  ) o on true
  where p2.picked_team_probability is null
) sub
where p.id = sub.pick_id and sub.prob is not null;

-- ---------------------------------------------------------------------
-- weekly_leaderboard: use the stored snapshot instead of a live join
-- against prediction_market_odds.
-- ---------------------------------------------------------------------
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
  submissions as (
    select user_id, submitted_at
    from public.weekly_submissions
    where season = p_season and week = p_week
  ),
  picks_this_week as (
    select user_id, game_id, selection, picked_team_probability
    from public.picks
    where season = p_season and week = p_week
  ),
  per_user_game as (
    select
      prof.id as user_id,
      dg.id as game_id,
      (pk.selection is not null and pk.selection = dg.winner) as is_correct,
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
    coalesce(sum((pug.is_correct and pug.picked_team_probability is not null and pug.picked_team_probability < 0.45)::int), 0) as upset_wins
  from public.profiles prof
  left join submissions sub on sub.user_id = prof.id
  left join per_user_game pug on pug.user_id = prof.id
  group by prof.id, prof.username, prof.normalized_username, sub.user_id, sub.submitted_at
  order by submitted desc, correct desc, sub.submitted_at asc nulls last, prof.normalized_username asc;
$$;

revoke all on function public.weekly_leaderboard(integer, integer) from public;
grant execute on function public.weekly_leaderboard(integer, integer) to authenticated;
