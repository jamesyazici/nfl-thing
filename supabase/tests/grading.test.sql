-- submit_weekly_picks() forfeit/lock behavior (spec §41-§46/§97-A/§97-M) and
-- weekly_user_scores() grading, including the non-submitter penalty
-- (spec §53/§54). See picks_privacy.test.sql for how to run this.
begin;
select plan(7);

select tests.create_user('00000000-0000-0000-0000-000000000011', 'Carol');
select tests.create_user('00000000-0000-0000-0000-000000000012', 'Dave');

-- Two games: one already started (5 minutes ago), one not yet started (in a day).
insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, status)
values
  ('30000000-0000-0000-0000-000000000001', 'test_2026_03_started', 2026, 3, current_date, now() - interval '5 minutes', 'NE', 'SEA', 'SCHEDULED'),
  ('30000000-0000-0000-0000-000000000002', 'test_2026_03_upcoming', 2026, 3, current_date, now() + interval '1 day', 'BUF', 'MIA', 'SCHEDULED');

-- Carol submits: tries to pick the already-started game (should be
-- force-forfeited regardless) and picks the upcoming game normally.
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
  'the forfeited pick''s selection is stored as null, not whatever the client sent'
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

-- Now finalize both games and confirm weekly_user_scores grades Carol
-- correctly and penalizes Dave (who never successfully submitted) as 0/2.
update public.games set status = 'FINAL', away_score = 20, home_score = 17, winner = 'AWAY'
  where id = '30000000-0000-0000-0000-000000000001';
update public.games set status = 'FINAL', away_score = 14, home_score = 24, winner = 'HOME'
  where id = '30000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000012' and season = 2026 and week = 3 $$,
  $$ values (0::bigint, 2::bigint) $$,
  'a user who never submitted a now-completed week is graded 0-for-N, not excluded'
);

select * from finish();
rollback;
