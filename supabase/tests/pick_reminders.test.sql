-- Pick-reminder schema (spec follow-up): the pick_reminders_sent primary
-- key IS the idempotency guarantee send-pick-reminders relies on to never
-- double-email the same person for the same checkpoint, and
-- allowed_users.email rejects an obviously malformed address before it
-- can ever reach SendGrid. See picks_privacy.test.sql for how to run this.
begin;
select plan(3);

select tests.create_user('00000000-0000-0000-0000-000000000051', 'Reminded');
insert into public.allowed_users (username, normalized_username, auth_user_id, claimed, is_active)
values ('Reminded', 'reminded', '00000000-0000-0000-0000-000000000051', true, true);

insert into public.pick_reminders_sent (season, week, checkpoint, user_id)
values (2026, 5, '24h_before_g1', '00000000-0000-0000-0000-000000000051');

select throws_ok(
  $$ insert into public.pick_reminders_sent (season, week, checkpoint, user_id)
     values (2026, 5, '24h_before_g1', '00000000-0000-0000-0000-000000000051') $$,
  'duplicate key value violates unique constraint "pick_reminders_sent_pkey"',
  'the same (season, week, checkpoint, user) can never be logged twice - this is the dedup guard itself'
);

select lives_ok(
  $$ insert into public.pick_reminders_sent (season, week, checkpoint, user_id)
     values (2026, 5, '5h_before_g1', '00000000-0000-0000-0000-000000000051') $$,
  'a different checkpoint for the same user/week is a separate row, not a conflict'
);

select throws_ok(
  $$ update public.allowed_users set email = 'not-an-email' where auth_user_id = '00000000-0000-0000-0000-000000000051' $$,
  'new row for relation "allowed_users" violates check constraint "allowed_users_email_format"',
  'an obviously malformed email is rejected by the format check'
);

select * from finish();
rollback;
