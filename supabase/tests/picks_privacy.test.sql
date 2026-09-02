-- Other Picks privacy gate (spec §48-§50/§97-D/§97-E/§97-N).
-- Run with: supabase test db  (after `supabase start`; loads helpers.sql
-- from this same directory first per the pgTAP test runner's convention).
begin;
select plan(8);

select tests.create_user('00000000-0000-0000-0000-000000000001', 'Alice');
select tests.create_user('00000000-0000-0000-0000-000000000002', 'Bob');

insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, status)
values ('10000000-0000-0000-0000-000000000001', 'test_2026_01_NE_SEA', 2026, 1, '2026-09-10', '2026-09-10T20:20:00Z', 'NE', 'SEA', 'SCHEDULED');

-- Alice submits Week 1, Bob does not.
insert into public.weekly_submissions (id, user_id, season, week)
values ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 2026, 1);

insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
values ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 2026, 1, 'AWAY', false);

-- Bob (has not submitted) must not see Alice's Week 1 pick.
select tests.authenticate_as('00000000-0000-0000-0000-000000000002');
select is_empty(
  $$ select 1 from public.picks where user_id = '00000000-0000-0000-0000-000000000001' and season = 2026 and week = 1 $$,
  'a user who has not submitted week 1 cannot see another user''s week 1 picks'
);
select is_empty(
  $$ select 1 from public.weekly_submissions where user_id = '00000000-0000-0000-0000-000000000001' and season = 2026 and week = 1 $$,
  'a user who has not submitted week 1 cannot see another user''s week 1 submission row either'
);

-- Bob cannot write picks directly (spec §97-N: RLS rejects direct writes).
select throws_ok(
  $$ insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
     values ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 2026, 1, 'HOME', false) $$,
  'new row violates row-level security policy for table "picks"',
  'a normal user cannot insert into picks directly (no insert policy exists)'
);

-- Once Bob submits Week 1 himself (even as a full-forfeit submission), Alice's picks become visible to him.
insert into public.weekly_submissions (id, user_id, season, week)
values ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 2026, 1);
insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
values ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 2026, 1, null, true);

select isnt_empty(
  $$ select 1 from public.picks where user_id = '00000000-0000-0000-0000-000000000001' and season = 2026 and week = 1 $$,
  'after Bob submits week 1 himself, he can now see Alice''s week 1 picks'
);

-- Alice can always see her own picks (submitter sees self regardless).
select tests.authenticate_as('00000000-0000-0000-0000-000000000001');
select isnt_empty(
  $$ select 1 from public.picks where user_id = '00000000-0000-0000-0000-000000000001' $$,
  'a user can always see their own picks'
);

-- A user cannot see a DIFFERENT week they have not submitted, even though
-- they've submitted week 1 (the gate is per-week, spec §50).
insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, status)
values ('10000000-0000-0000-0000-000000000002', 'test_2026_02_BUF_MIA', 2026, 2, '2026-09-17', '2026-09-17T20:20:00Z', 'BUF', 'MIA', 'SCHEDULED');
select tests.authenticate_as('00000000-0000-0000-0000-000000000002');
insert into public.weekly_submissions (id, user_id, season, week)
values ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 2026, 2);
insert into public.picks (submission_id, user_id, game_id, season, week, selection, forfeited)
values ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 2026, 2, 'HOME', false);

select is_empty(
  $$ select 1 from public.picks where user_id = '00000000-0000-0000-0000-000000000001' and season = 2026 and week = 2 $$,
  'submitting week 1 does not unlock week 2 (gate is per-week)'
);

-- Games/profiles remain readable to any authenticated user regardless of submission state.
select isnt_empty(
  $$ select 1 from public.games where id = '10000000-0000-0000-0000-000000000001' $$,
  'games are readable by any authenticated user'
);
select isnt_empty(
  $$ select 1 from public.profiles where id = '00000000-0000-0000-0000-000000000001' $$,
  'profiles are readable by any authenticated user'
);

select * from finish();
rollback;
