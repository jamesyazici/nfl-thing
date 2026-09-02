-- Top-3-only leaderboard sections (spec §57-§60/§101). See
-- picks_privacy.test.sql for how to run this suite.
begin;
select plan(3);

-- Six users, only 3 may ever appear in either top3_* result set.
select tests.create_user('00000000-0000-0000-0000-000000000021', 'PlayerA');
select tests.create_user('00000000-0000-0000-0000-000000000022', 'PlayerB');
select tests.create_user('00000000-0000-0000-0000-000000000023', 'PlayerC');
select tests.create_user('00000000-0000-0000-0000-000000000024', 'PlayerD');
select tests.create_user('00000000-0000-0000-0000-000000000025', 'PlayerE');
select tests.create_user('00000000-0000-0000-0000-000000000026', 'PlayerF');

-- One fully-decided week with a single game so each user's correct/incorrect
-- pick alone determines their weekly rank and season win rate.
insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, away_score, home_score, status, winner)
values ('40000000-0000-0000-0000-000000000001', 'test_2026_04_lb', 2026, 4, current_date, now() - interval '1 day', 'NE', 'SEA', 24, 17, 'FINAL', 'AWAY');

-- A, B, C pick correctly; D, E, F pick incorrectly (or don't submit).
insert into public.weekly_submissions (id, user_id, season, week) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000021', 2026, 4),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000022', 2026, 4),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000023', 2026, 4),
  ('50000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000024', 2026, 4);

insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000021', '40000000-0000-0000-0000-000000000001', 2026, 4, 'AWAY', false),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000022', '40000000-0000-0000-0000-000000000001', 2026, 4, 'AWAY', false),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000023', '40000000-0000-0000-0000-000000000001', 2026, 4, 'AWAY', false),
  ('50000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000024', '40000000-0000-0000-0000-000000000001', 2026, 4, 'HOME', false);
-- PlayerE and PlayerF never submit week 4 at all -> synthetic 0/1 (spec §54).

select is(
  (select count(*) from public.top3_win_rate()),
  3::bigint,
  'top3_win_rate never returns more than 3 rows even with 6 eligible users'
);

select is(
  (select count(*) from public.top3_avg_finish()),
  3::bigint,
  'top3_avg_finish never returns more than 3 rows even with 6 eligible users'
);

-- The three correct pickers (A, B, C) must occupy the win-rate podium;
-- the incorrect/non-submitting D, E, F must not appear.
select results_eq(
  $$ select normalized_username from public.top3_win_rate() order by normalized_username $$,
  $$ values ('playera'), ('playerb'), ('playerc') $$,
  'only the users who actually picked correctly appear in the win-rate top 3'
);

select * from finish();
rollback;
