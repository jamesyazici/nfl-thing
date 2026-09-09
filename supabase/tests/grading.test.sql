-- submit_weekly_picks() forfeit/lock behavior (spec §41-§46/§97-A/§97-M):
-- a forfeited pick (submitted after that game had already started) stores
-- no selection at all (plain FORFEIT) and never earns credit, no
-- exceptions. Also covers weekly_user_scores()'s non-submitter penalty
-- (spec §53/§54, a separate mechanism - there's no one to grade on behalf
-- of if they never submit at all). See picks_privacy.test.sql for how to
-- run this.
begin;
select plan(11);

select tests.create_user('00000000-0000-0000-0000-000000000011', 'Carol');
select tests.create_user('00000000-0000-0000-0000-000000000012', 'Dave');

-- Two games: one already started (forfeit candidate), one not yet started.
insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, status)
values
  ('30000000-0000-0000-0000-000000000001', 'test_2026_03_started', 2026, 3, current_date, now() - interval '5 minutes', 'NE', 'SEA', 'SCHEDULED'),
  ('30000000-0000-0000-0000-000000000002', 'test_2026_03_upcoming', 2026, 3, current_date, now() + interval '1 day', 'BUF', 'MIA', 'SCHEDULED');

-- Carol submits: the already-started game gets force-completed regardless
-- of what she sent for it; the upcoming game keeps her real selection.
select is(
  (select forfeited from public.submit_weekly_picks(
    '00000000-0000-0000-0000-000000000011'::uuid, 2026, 3,
    '[{"game_id":"30000000-0000-0000-0000-000000000001","selection":"AWAY"},{"game_id":"30000000-0000-0000-0000-000000000002","selection":"HOME"}]'::jsonb
  ) where game_id = '30000000-0000-0000-0000-000000000001'),
  true,
  'a game whose kickoff has already passed is force-forfeited even if the client sent a selection for it'
);

select is(
  (select selection::text from public.picks where user_id = '00000000-0000-0000-0000-000000000011' and game_id = '30000000-0000-0000-0000-000000000001'),
  null,
  'a forfeited pick stores no selection at all - no team is recorded, since it can never earn credit either way'
);

select is(
  (select picked_team_probability from public.picks where user_id = '00000000-0000-0000-0000-000000000011' and game_id = '30000000-0000-0000-0000-000000000001'),
  null,
  'a forfeited pick has no probability snapshot either, since there is no team to look one up for'
);

select is(
  (select selection::text from public.picks where user_id = '00000000-0000-0000-0000-000000000011' and game_id = '30000000-0000-0000-0000-000000000002'),
  'HOME',
  'the not-yet-started game keeps the client''s real selection'
);

-- A second submission for the same (user, season, week) must be rejected.
select throws_ok(
  $$ select public.submit_weekly_picks('00000000-0000-0000-0000-000000000011'::uuid, 2026, 3, '[]'::jsonb) $$,
  'ALREADY_SUBMITTED',
  'a duplicate weekly submission is rejected'
);

-- Missing a selection for a not-yet-started game must be rejected, and the
-- whole attempt (including weekly_submissions) must roll back so the user
-- can retry cleanly.
select throws_ok(
  $$ select public.submit_weekly_picks('00000000-0000-0000-0000-000000000012'::uuid, 2026, 3, '[]'::jsonb) $$,
  'MISSING_SELECTION:30000000-0000-0000-0000-000000000002',
  'submitting without a selection for an unstarted game is rejected'
);
select is_empty(
  $$ select 1 from public.weekly_submissions where user_id = '00000000-0000-0000-0000-000000000012' and season = 2026 and week = 3 $$,
  'a rejected submission does not leave a partial weekly_submissions row behind'
);

-- Finalize both games: game 1 AWAY wins (Carol's forfeit has no selection,
-- so it's incorrect regardless), game 2 HOME wins (Carol's REAL pick of
-- HOME, so this one counts). Carol should end up 1-for-2; Dave, who never
-- submitted at all, is still graded 0-for-2 via the separate non-
-- submitter mechanism.
update public.games set status = 'FINAL', away_score = 20, home_score = 17, winner = 'AWAY'
  where id = '30000000-0000-0000-0000-000000000001';
update public.games set status = 'FINAL', away_score = 14, home_score = 24, winner = 'HOME'
  where id = '30000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000011' and season = 2026 and week = 3 $$,
  $$ values (1::bigint, 2::bigint) $$,
  'a forfeited pick never earns credit - only Carol''s real pick (game 2) counts'
);

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000012' and season = 2026 and week = 3 $$,
  $$ values (0::bigint, 2::bigint) $$,
  'a user who never submitted a now-completed week is still graded 0-for-N via the separate non-submitter mechanism'
);

-- Expected record (weekly_leaderboard's expected_wins/total_games):
-- Carol's forfeited game-1 pick contributes 0 (never earns credit, no
-- exceptions), and her real game-2 pick has no prediction_market_odds row
-- in this test at all, so it falls back to the neutral 0.5 rather than
-- being skipped or skewing the total - 0 + 0.5 = 0.5 expected wins out of
-- the week's 2 games, regardless of how either game actually turned out.
select results_eq(
  $$ select expected_wins, total_games from public.weekly_leaderboard(2026, 3)
     where user_id = '00000000-0000-0000-0000-000000000011' $$,
  $$ values (0.5::numeric, 2::bigint) $$,
  'a forfeit contributes 0 and an unpriced real pick falls back to 0.5 - Carol projects 0.5 expected wins out of 2'
);

-- Dave never submitted at all - expected_wins must be null (nothing to
-- project), never a fabricated 50/50 guess across his non-existent picks.
select results_eq(
  $$ select expected_wins from public.weekly_leaderboard(2026, 3)
     where user_id = '00000000-0000-0000-0000-000000000012' $$,
  $$ values (null::numeric) $$,
  'a non-submitter has null expected_wins, not a fabricated 0.5-per-game guess'
);

select * from finish();
rollback;
