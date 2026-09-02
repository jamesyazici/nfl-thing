-- Enables the extensions Supabase Cron needs (pg_cron to schedule, pg_net
-- to make the HTTP call into an Edge Function). Both are bundled with every
-- Supabase project; this just turns them on.
--
-- The actual `cron.schedule(...)` jobs are NOT created here on purpose:
-- they need your project's live URL and a secret (CRON_SECRET) that must
-- never be committed to source control, and migration files are committed.
-- Run the one-time SQL in README.md → "Cron setup" from the Supabase SQL
-- editor after you've deployed the Edge Functions and set your secrets —
-- it uses Supabase Vault to store the URL/secret instead of inlining them.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
