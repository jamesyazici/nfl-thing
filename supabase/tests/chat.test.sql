-- chat_messages RLS (spec follow-up): a single shared family room. Any
-- authenticated user can read it; only the sender can insert as
-- themselves; only the sender can edit their own message
-- (edited_at/user_id/created_at are server-enforced by a trigger no
-- matter what the client sends); the sender OR an admin can delete a
-- message — a real DELETE, no trace left behind — but nobody else can
-- touch it at all. This exact scenario was also verified live against
-- production (RLS-impersonated as three real profiles, not just this
-- pgTAP file) before shipping. See picks_privacy.test.sql for how to run
-- this suite.
begin;
select plan(8);

select tests.create_user('00000000-0000-0000-0000-000000000031', 'Alice');
select tests.create_user('00000000-0000-0000-0000-000000000032', 'Bob');
select tests.create_user('00000000-0000-0000-0000-000000000033', 'AdminAllison');
update public.profiles set is_admin = true where id = '00000000-0000-0000-0000-000000000033';

-- Alice sends a message.
select tests.authenticate_as('00000000-0000-0000-0000-000000000031');
insert into public.chat_messages (id, user_id, message)
values ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000031', 'hello family');

select throws_ok(
  $$ insert into public.chat_messages (user_id, message) values ('00000000-0000-0000-0000-000000000032', 'pretending to be bob') $$,
  'new row violates row-level security policy for table "chat_messages"',
  'a user cannot insert a chat message on someone else''s behalf'
);

-- Bob is neither the sender nor an admin.
select tests.authenticate_as('00000000-0000-0000-0000-000000000032');
select isnt_empty(
  $$ select 1 from public.chat_messages where id = '00000000-0000-0000-0000-000000000041' $$,
  'any authenticated family member can read the shared chat room'
);

update public.chat_messages set message = 'hacked' where id = '00000000-0000-0000-0000-000000000041';
select is(
  (select message from public.chat_messages where id = '00000000-0000-0000-0000-000000000041'),
  'hello family',
  'a non-owner, non-admin cannot edit someone else''s message'
);

delete from public.chat_messages where id = '00000000-0000-0000-0000-000000000041';
select isnt_empty(
  $$ select 1 from public.chat_messages where id = '00000000-0000-0000-0000-000000000041' $$,
  'a non-owner, non-admin cannot delete someone else''s message either'
);

-- Alice edits her own message, also trying to spoof protected columns in
-- the same statement.
select tests.authenticate_as('00000000-0000-0000-0000-000000000031');
update public.chat_messages
  set message = 'hello family (v2)',
      edited_at = '2000-01-01'::timestamptz,
      user_id = '00000000-0000-0000-0000-000000000032'
  where id = '00000000-0000-0000-0000-000000000041';

select is(
  (select message from public.chat_messages where id = '00000000-0000-0000-0000-000000000041'),
  'hello family (v2)',
  'the sender can edit their own message'
);
select isnt(
  (select edited_at from public.chat_messages where id = '00000000-0000-0000-0000-000000000041'),
  '2000-01-01'::timestamptz,
  'edited_at is server-computed by a trigger, not settable by the client'
);
select is(
  (select user_id from public.chat_messages where id = '00000000-0000-0000-0000-000000000041'),
  '00000000-0000-0000-0000-000000000031'::uuid,
  'user_id cannot be reassigned via UPDATE, even by the message''s own sender'
);

-- An admin who is NOT the sender can still delete it, and it leaves no trace.
select tests.authenticate_as('00000000-0000-0000-0000-000000000033');
delete from public.chat_messages where id = '00000000-0000-0000-0000-000000000041';
select is_empty(
  $$ select 1 from public.chat_messages where id = '00000000-0000-0000-0000-000000000041' $$,
  'an admin can delete any message, and a deleted message leaves no trace at all'
);

select * from finish();
rollback;
