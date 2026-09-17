-- Pick-reminder emails (spec follow-up): 24h/5h/30min before the week's
-- first game, and 6h before its second game, sent to anyone who hasn't
-- submitted picks yet for the current week.
--
-- Email lives on allowed_users, not profiles: allowed_users already has
-- an admin-only SELECT policy (allowed_users_select_admin, migration
-- 0006), so an admin-entered email address is private from the rest of
-- the family for free, with no column-level grant surgery and no changes
-- to any existing profiles query. It's also settable the moment a
-- username is reserved, before the person even claims it.
alter table public.allowed_users add column if not exists email text;
alter table public.allowed_users add constraint allowed_users_email_format
  check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- Idempotency log for send-pick-reminders: exactly one row per
-- (season, week, checkpoint, user) that's ever actually been emailed, so
-- a cron tick that finds a checkpoint still "due" (see
-- shared/logic.js's computeDueCheckpoints) never re-sends to someone
-- who was already reminded for that same checkpoint. Pure internal
-- bookkeeping for the service-role Edge Function - RLS enabled with
-- zero policies, so every client role is denied by default; nothing
-- here is ever meant to be readable from the browser.
create table public.pick_reminders_sent (
  season integer not null,
  week integer not null,
  checkpoint text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now(),

  constraint pick_reminders_sent_pkey primary key (season, week, checkpoint, user_id),
  constraint pick_reminders_checkpoint_values check (
    checkpoint in ('24h_before_g1', '5h_before_g1', '30m_before_g1', '6h_before_g2')
  )
);
alter table public.pick_reminders_sent enable row level security;

-- send-pick-reminders (service role) needs get_current_week() too - it
-- was previously granted only to `authenticated`.
grant execute on function public.get_current_week(integer) to service_role;
