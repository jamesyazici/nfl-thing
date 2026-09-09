-- submit_weekly_picks() forfeit/lock behavior (spec §41-§46/§97-A/§97-M):
-- a forfeited pick auto-fills HOME for the record, but per explicit
-- request never earns credit, no exceptions, even if that team wins.
-- Also covers weekly_user_scores()'s non-submitter penalty (spec §53/§54,
-- a separate mechanism - there's no one to auto-pick on behalf of if they
-- never submit at all). See picks_privacy.test.sql for how to run this.
begin;
select plan(10);

select tests.create_user('00000000-0000-0000-0000-000000000011', 'Carol');
select tests.create_user('00000000-0000-0000-0000-000000000012', 'Dave');

-- Three games: two already started (forfeit candidates - one will finalize
-- AWAY-won, one will finalize HOME-won, to prove a forfeit is incorrect
-- either way), one not yet started.
insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, status)
values
  ('30000000-0000-0000-0000-000000000001', 'test_2026_03_started_away_wins', 2026, 3, current_date, now() - interval '5 minutes', 'NE', 'SEA', 'SCHEDULED'),
  ('30000000-0000-0000-0000-000000000002', 'test_2026_03_upcoming', 2026, 3, current_date, now() + interval '1 day', 'BUF', 'MIA', 'SCHEDULED'),
  ('30000000-0000-0000-0000-000000000003', 'test_2026_03_started_home_wins', 2026, 3, current_date, now() - interval '10 minutes', 'DAL', 'PHI', 'SCHEDULED');

-- Carol submits: the already-started games get force-completed regardless
-- of what she sends for them; the upcoming game keeps her real selection.
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
  'HOME',
  'a forfeited pick auto-defaults to HOME, not null, per the auto-pick rule'
);

select is(
  (select forfeited from public.picks where user_id = '00000000-0000-0000-0000-000000000011' and game_id = '30000000-0000-0000-0000-000000000003'),
  true,
  'the second already-started game is also force-forfeited'
);

select is(
  (select selection::text from public.picks where user_id = '00000000-0000-0000-0000-000000000011' and game_id = '30000000-0000-0000-0000-000000000003'),
  'HOME',
  'that forfeited pick also auto-defaults to HOME'
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

-- Finalize all three games: game 1 AWAY wins (Carol's forfeited HOME is
-- wrong there anyway), game 2 HOME wins (Carol's REAL pick of HOME, so
-- this one counts), game 3 also HOME wins (Carol's forfeited HOME pick -
-- this must NOT count despite matching the winner, per the no-exceptions
-- rule). Carol should end up 1-for-3 (only game 2); Dave, who never
-- submitted at all, is still graded 0-for-3 via the separate non-
-- submitter mechanism.
update public.games set status = 'FINAL', away_score = 20, home_score = 17, winner = 'AWAY'
  where id = '30000000-0000-0000-0000-000000000001';
update public.games set status = 'FINAL', away_score = 14, home_score = 24, winner = 'HOME'
  where id = '30000000-0000-0000-0000-000000000002';
update public.games set status = 'FINAL', away_score = 10, home_score = 27, winner = 'HOME'
  where id = '30000000-0000-0000-0000-000000000003';

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000011' and season = 2026 and week = 3 $$,
  $$ values (1::bigint, 3::bigint) $$,
  'a forfeited pick never earns credit even when the auto-filled HOME team wins (game 3) - only Carol''s real pick (game 2) counts'
);

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000012' and season = 2026 and week = 3 $$,
  $$ values (0::bigint, 3::bigint) $$,
  'a user who never submitted a now-completed week is still graded 0-for-N via the separate non-submitter mechanism'
);

select * from finish();
rollback;
