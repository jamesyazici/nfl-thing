-- submit_weekly_picks() forfeit/lock behavior (spec §41-§46/§97-A/§97-M):
-- a forfeited pick (submitted after that game had already started) stores
-- no selection at all (plain FORFEIT) and never earns credit, no
-- exceptions. Also covers weekly_user_scores()'s non-submitter penalty
-- (spec §53/§54, a separate mechanism - there's no one to grade on behalf
-- of if they never submit at all), and weekly_leaderboard()'s
-- expected_wins: a decided game contributes its actual 0/1 outcome (not a
-- stale probability), a still-undecided game prefers the CURRENT
-- prediction_market_odds row over the snapshot taken at submission time.
-- See picks_privacy.test.sql for how to run this.
begin;
select plan(14);

select tests.create_user('00000000-0000-0000-0000-000000000011', 'Carol');
select tests.create_user('00000000-0000-0000-0000-000000000012', 'Dave');

-- Three games: one already started (forfeit candidate), one not yet
-- started with no market odds at all, one not yet started WITH a market
-- (for the live-odds-vs-snapshot check below).
insert into public.games (id, external_id, season, week, gameday, kickoff_at, away_team, home_team, status)
values
  ('30000000-0000-0000-0000-000000000001', 'test_2026_03_started', 2026, 3, current_date, now() - interval '5 minutes', 'NE', 'SEA', 'SCHEDULED'),
  ('30000000-0000-0000-0000-000000000002', 'test_2026_03_upcoming', 2026, 3, current_date, now() + interval '1 day', 'BUF', 'MIA', 'SCHEDULED'),
  ('30000000-0000-0000-0000-000000000003', 'test_2026_03_live_odds', 2026, 3, current_date, now() + interval '2 days', 'DAL', 'NYG', 'SCHEDULED');

-- Game 3's market at submission time: HOME priced at 0.30. Carol's pick
-- of HOME will snapshot this exact value.
insert into public.prediction_market_odds (game_id, provider, away_probability_display, home_probability_display)
values ('30000000-0000-0000-0000-000000000003', 'kalshi', 0.70, 0.30);

-- Carol submits: the already-started game gets force-completed regardless
-- of what she sent for it; the not-yet-started games keep her real
-- selections.
select is(
  (select forfeited from public.submit_weekly_picks(
    '00000000-0000-0000-0000-000000000011'::uuid, 2026, 3,
    '[{"game_id":"30000000-0000-0000-0000-000000000001","selection":"AWAY"},{"game_id":"30000000-0000-0000-0000-000000000002","selection":"HOME"},{"game_id":"30000000-0000-0000-0000-000000000003","selection":"HOME"}]'::jsonb
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

-- Checkpoint A: nothing decided yet. Game 1 (forfeit) contributes 0, game
-- 2 (real pick, no market ever existed) falls back to a neutral 0.5,
-- game 3 (real pick, HOME priced at 0.30 right now, same as the snapshot
-- since the odds haven't been touched since submission) contributes 0.30.
select results_eq(
  $$ select expected_wins, total_games from public.weekly_leaderboard(2026, 3)
     where user_id = '00000000-0000-0000-0000-000000000011' $$,
  $$ values (0.80::numeric, 3::bigint) $$,
  'checkpoint A: 0 (forfeit) + 0.5 (unpriced) + 0.30 (priced, matches snapshot) = 0.80 of 3'
);

-- The market moves (simulating a live in-game/pre-game price change) -
-- HOME is now priced at 0.70, not 0.30. Game 3 is still undecided.
update public.prediction_market_odds
set home_probability_display = 0.70
where game_id = '30000000-0000-0000-0000-000000000003' and provider = 'kalshi';

-- Checkpoint B: expected_wins must move WITH the live odds, not stay
-- pinned to the 0.30 snapshot Carol's pick recorded at submission time.
select results_eq(
  $$ select expected_wins from public.weekly_leaderboard(2026, 3)
     where user_id = '00000000-0000-0000-0000-000000000011' $$,
  $$ values (1.20::numeric) $$,
  'checkpoint B: game 3''s current odds (0.70) are used over its stale 0.30 snapshot - 0 + 0.5 + 0.70 = 1.20'
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

-- Finalize games 1 and 2 (game 3 stays undecided for now): game 1 AWAY
-- wins (Carol's forfeit has no selection, so it's incorrect regardless),
-- game 2 HOME wins (Carol's REAL pick of HOME, so this one counts).
update public.games set status = 'FINAL', away_score = 20, home_score = 17, winner = 'AWAY'
  where id = '30000000-0000-0000-0000-000000000001';
update public.games set status = 'FINAL', away_score = 14, home_score = 24, winner = 'HOME'
  where id = '30000000-0000-0000-0000-000000000002';

-- Checkpoint C: once a game is decided it's a fact, not a probability -
-- game 1 now contributes exactly 0 (not a leftover probability - it never
-- had one anyway), game 2 now contributes exactly 1 (not the old 0.5
-- fallback - she actually won it). Game 3 is still undecided, so it still
-- uses its live odds (0.70) from checkpoint B, unchanged.
select results_eq(
  $$ select expected_wins from public.weekly_leaderboard(2026, 3)
     where user_id = '00000000-0000-0000-0000-000000000011' $$,
  $$ values (1.70::numeric) $$,
  'checkpoint C: decided games snap to their actual outcome (0 + 1), still-undecided game 3 keeps using live odds (0.70) = 1.70'
);

-- Now finalize game 3 too: AWAY wins, so Carol's HOME pick was wrong.
update public.games set status = 'FINAL', away_score = 27, home_score = 13, winner = 'AWAY'
  where id = '30000000-0000-0000-0000-000000000003';

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000011' and season = 2026 and week = 3 $$,
  $$ values (1::bigint, 3::bigint) $$,
  'a forfeited pick never earns credit - only Carol''s real, correct pick (game 2) counts out of all 3 games'
);

select results_eq(
  $$ select correct, counted from public.weekly_user_scores()
     where user_id = '00000000-0000-0000-0000-000000000012' and season = 2026 and week = 3 $$,
  $$ values (0::bigint, 3::bigint) $$,
  'a user who never submitted a now-completed week is still graded 0-for-N via the separate non-submitter mechanism'
);

-- Checkpoint D: now that EVERY game in the week is decided, expected_wins
-- reverts to the pure pre-game projection (each pick's original snapshot,
-- ignoring how the games actually turned out) rather than staying pinned
-- to the real correct count - the whole point being a fixed "here's what
-- we projected" benchmark to compare the final real record against.
-- Crucially this uses game 3's ORIGINAL 0.30 snapshot, not the 0.70 live
-- price from checkpoint B/C - once frozen, later live movement no longer
-- matters: 0 (forfeit) + 0.5 (unpriced) + 0.30 (game 3's snapshot) = 0.80.
select results_eq(
  $$ select expected_wins from public.weekly_leaderboard(2026, 3)
     where user_id = '00000000-0000-0000-0000-000000000011' $$,
  $$ values (0.80::numeric) $$,
  'checkpoint D: once the whole week is decided, expected_wins reverts to the frozen pre-game projection (0.80), not the live/decided hybrid'
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
