-- Family-wide live chat (spec follow-up): one single shared room, no DMs,
-- no per-week/per-game scoping. Realtime-driven via Supabase's built-in
-- Postgres Changes (already part of supabase-js — no extra library, no
-- separate server, and comfortably inside the free plan's 200 concurrent
-- connections / 2M messages per month for a family this size).
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,

  constraint chat_messages_length check (char_length(message) between 1 and 2000)
);

create index chat_messages_created_at_idx on public.chat_messages (created_at);

alter table public.chat_messages enable row level security;

-- Any authenticated family member can read the whole room — it's one
-- shared space, not per-user data, so there's no gating beyond sign-in.
create policy chat_messages_select_authenticated
  on public.chat_messages for select
  to authenticated
  using (true);

-- Only ever insert as yourself — never on someone else's behalf.
create policy chat_messages_insert_own
  on public.chat_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Edit only your own message. user_id/created_at/edited_at are all
-- server-enforced by the trigger below no matter what a client sends, so
-- this policy only needs to gate WHICH rows are touchable at all.
create policy chat_messages_update_own
  on public.chat_messages for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Delete your own message, OR any message at all if you're an admin
-- (spec follow-up). This is a real DELETE — a removed message leaves no
-- trace, no soft-delete placeholder; it looks like it was never there.
create policy chat_messages_delete_own_or_admin
  on public.chat_messages for delete
  to authenticated
  using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- Keep user_id/created_at immutable and edited_at server-computed
-- regardless of what a client puts in an UPDATE request — the "(edited)"
-- indicator has to be trustworthy, not something a client can fake or
-- suppress.
create function public.chat_messages_before_update()
returns trigger
language plpgsql
as $$
begin
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  new.edited_at := case when new.message is distinct from old.message then now() else old.edited_at end;
  return new;
end;
$$;

create trigger chat_messages_before_update
  before update on public.chat_messages
  for each row execute function public.chat_messages_before_update();

-- Turn on Postgres Changes for this table so inserts/edits/deletes push
-- live to every connected browser (respecting the RLS policies above —
-- Realtime only ever forwards rows a given connection could already SELECT).
alter publication supabase_realtime add table public.chat_messages;
