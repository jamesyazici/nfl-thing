# NFL Thing

A private, family-only NFL regular-season pick'em app. Everyone logs in with a
username and password (no email visible), picks AWAY / TIE / HOME for every
Week 1–18 game, submits their whole week at once, and picks lock permanently
at submission. Scores, records, and grading are all automatic. This is a
private game, not a gambling or trading product.

- **Frontend:** plain HTML/CSS/vanilla JS (ES modules), deployable straight to
  GitHub Pages. No build step, no bundler, no framework.
- **Backend:** Supabase — Postgres, Auth, Row Level Security, Edge Functions,
  and Supabase Cron. There is no separate server to host.

```
                      nflverse
             NFL schedule + results
                         |
                         v
               Edge Function: sync-nfl-games
                         |
                         v
                    Postgres: games
                         |
GitHub Pages <----- Supabase Auth/RLS/DB -----> Edge Functions:
   (static UI)              |                     claim-account
                             |                     admin-create-username
                             v                     admin-manage-user
                       Leaderboard views/functions submit-picks
                                                    sync-prediction-market-odds
   Kalshi / Polymarket ---> sync-prediction-market-odds ---> Postgres: prediction_market_odds ---> My Picks UI
```

The GitHub Pages frontend is UI only. Every trusted decision (who you are,
whether a game has started, whether you already submitted, who's an admin)
is enforced in Postgres/Edge Functions, not in the browser.

---

## 1. What you need to do (exact steps)

This section is the fast path from a fresh clone to a working, deployed app.
Later sections explain the pieces in more depth.

1. **Create a Supabase project** at [supabase.com](https://supabase.com) → New Project.
2. **Install the Supabase CLI** and log in:
   ```
   npm install -g supabase
   supabase login
   ```
3. **Link this repo to your project** (run from the repo root):
   ```
   supabase link --project-ref YOUR_PROJECT_REF
   ```
   (Find `YOUR_PROJECT_REF` in Supabase Dashboard → Project Settings → General → Reference ID.)
4. **Apply the database migrations:**
   ```
   supabase db push
   ```
5. **Set your Edge Function secrets** (see the full table in §3 below):
   ```
   supabase secrets set SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   supabase secrets set SUPABASE_SECRET_KEY=sb_secret_XXXXXXXXXXXXXXXXXXXX
   supabase secrets set ALLOWED_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io
   supabase secrets set PREDICTION_MARKET_PROVIDER=auto
   supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
   ```
6. **Deploy the Edge Functions:**
   ```
   supabase functions deploy claim-account
   supabase functions deploy admin-create-username
   supabase functions deploy admin-manage-user
   supabase functions deploy submit-picks
   supabase functions deploy sync-nfl-games
   supabase functions deploy sync-prediction-market-odds
   ```
7. **Configure the frontend:** copy `js/config.example.js` to `js/config.js`
   and fill in your Supabase URL + publishable key (Dashboard → Project
   Settings → API Keys).
8. **Set `current_season`** if you're not using this year's default — see §7.
9. **Create your first admin** — see §5.
10. **Set up Cron** so games/odds sync automatically — see §8.
11. **Push to GitHub and enable Pages** — see §9.
12. **Reserve usernames for your family** from `admin.html`, then have each
    person visit `create-account.html` — see §6.

---

## 2. Local development

Nothing here needs a build step.

- **Frontend:** open `index.html` with any static file server (e.g.
  `npx serve .` or the VS Code "Live Server" extension) — opening it directly
  as a `file://` URL won't work because ES modules require `http(s)://`.
- **Edge Functions:** `supabase start` (spins up local Postgres/Auth/Storage
  via Docker) then `supabase functions serve --env-file supabase/functions/.env`
  (copy `supabase/functions/.env.example` first).
- **Unit tests for the shared business logic** (grading, forfeit boundary,
  Last-5 formatting, average finish, Kalshi/Polymarket probability math):
  ```
  npm test
  ```
  These run with Node's built-in test runner — no dependencies to install.
- **Database tests (pgTAP):** `supabase test db` (needs `supabase start`
  running first). See `supabase/tests/`.

---

## 3. Environment variables

### Public (safe in the GitHub Pages bundle — protected by RLS, not secrecy)

| Name | Where to get it | Where it goes |
|---|---|---|
| `SUPABASE_URL` | Dashboard → Project Settings → API | `js/config.js` |
| `SUPABASE_PUBLISHABLE_KEY` | Dashboard → Project Settings → API Keys → "Publishable key" (`sb_publishable_...`). Older projects may only show a legacy "anon" key — that works too. | `js/config.js` |

### Secret (Edge Function secrets — NEVER put these in `js/config.js` or anywhere GitHub Pages serves)

| Name | Where to get it | Command |
|---|---|---|
| `SUPABASE_URL` | Same as above | `supabase secrets set SUPABASE_URL=...` |
| `SUPABASE_SECRET_KEY` | Dashboard → Project Settings → API Keys → "Secret key" (`sb_secret_...`). Legacy projects: "service_role" key. | `supabase secrets set SUPABASE_SECRET_KEY=...` |
| `ALLOWED_ORIGIN` | Your GitHub Pages URL, e.g. `https://yourname.github.io` | `supabase secrets set ALLOWED_ORIGIN=...` |
| `CRON_SECRET` | Generate one yourself: `openssl rand -hex 32` | `supabase secrets set CRON_SECRET=...` |
| `PREDICTION_MARKET_PROVIDER` | `kalshi`, `polymarket`, or `auto` (default) | `supabase secrets set PREDICTION_MARKET_PROVIDER=auto` |
| `KALSHI_API_BASE` | Optional override; default `https://external-api.kalshi.com/trade-api/v2` is a public, read-only, no-auth-required endpoint | only if you need to override |
| `POLYMARKET_GAMMA_API_BASE` | Optional override; default `https://gamma-api.polymarket.com` is public, read-only, no-auth-required | only if you need to override |
| `NFLVERSE_SCHEDULE_URL` | Optional override; default is the live nflverse schedule feed (see §10) | only if you need to override |

Neither Kalshi nor Polymarket requires an API key for the read-only market
data this app uses — no account signup needed for either. If a future API
change requires credentials, add them the same way with `supabase secrets set`.

`js/config.js` and `supabase/functions/.env` are both gitignored — copy from
the `.example` versions and never commit real values.

---

## 4. Database, migrations, RLS

Run `supabase db push` to apply everything in `supabase/migrations/` in
order. Highlights:

- **`app_settings`** — one row holding `current_season` and an admin-only
  `current_week_override`.
- **`allowed_users`** / **`profiles`** — the invite list and public profiles.
  No one can create an account without an admin having reserved their
  username first.
- **`games`** — synced from nflverse; entering-game record and Last-5 are
  recomputed on every sync.
- **`weekly_submissions`** / **`picks`** — a submission is immutable once it
  exists; only the `submit_weekly_picks` Postgres function (called from the
  `submit-picks` Edge Function) may write to either table.
- **`prediction_market_mappings`** / **`prediction_market_odds`** — cached
  Kalshi/Polymarket data; the frontend never calls those APIs directly.

RLS is on for every table. The short version: everyone can read games/odds/
profiles; a user can read their own picks always, and can read *anyone's*
picks for a given week only once they have their own `weekly_submissions` row
for that week; nobody outside of an Edge Function (which uses the secret key
and bypasses RLS by design) can write picks, submissions, games, or odds
directly. See `supabase/migrations/0006_rls_policies.sql` for the exact
policies and `0007`/`0009` for the SECURITY DEFINER functions that compute
leaderboard aggregates and process submissions.

---

## 5. Creating your first admin

There's no special bootstrap function — you make yourself an admin with one
SQL statement, then claim the account normally.

1. In the Supabase Dashboard → SQL Editor, run (pick your own username):
   ```sql
   insert into public.allowed_users (username, normalized_username, is_admin)
   values ('Dad', 'dad', true);
   ```
2. Visit `create-account.html` on your deployed site, enter that username
   and a password you choose.
3. You're now logged in as an admin. `admin.html` (linked from the app
   header once you're an admin) is where you reserve more usernames, manage
   accounts, trigger syncs, and fix prediction-market mappings.

The MVP intentionally has no email confirmation, SMS, or invite-link step —
whoever knows a reserved username first can claim it (spec-accepted tradeoff
for a private family game). If you want stronger security later, the
easiest addition is a one-time claim code: add a `claim_code` column to
`allowed_users`, require it in the `claim-account` request body, and check
it alongside `claimed = false` in that function.

---

## 6. Reserving usernames & the claim flow

From `admin.html`: **Reserve a Username** → enter e.g. `Mom`. Text/tell Mom
her username is `Mom`. She visits `create-account.html`, enters `Mom` and a
password of her choosing (min. 8 characters), and she's in. If the username
wasn't reserved, or was already claimed, she gets a clear error and nothing
is created.

Internally, Supabase Auth still runs on email+password under the hood, so
`claim-account` builds a deterministic address like `mom@users.family-pickem.invalid`
that Mom never sees or needs.

---

## 7. Season configuration

`app_settings.current_season` (default `2026`) is the single source of truth
— nothing else hardcodes a year. To roll over to a new season, update it:

```sql
update public.app_settings set current_season = 2027;
```

Then run `sync-nfl-games` (or wait for the next cron tick) to pull the new
season's schedule.

---

## 8. Cron setup

Migration `0008` enables `pg_cron`/`pg_net`, but the actual scheduled jobs
aren't created by a migration — they need your live project URL and
`CRON_SECRET`, which must never be committed to source control. Run this
once in the SQL Editor after you've deployed the functions and set your
secrets:

```sql
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('YOUR_SUPABASE_PUBLISHABLE_KEY', 'publishable_key');
select vault.create_secret('YOUR_CRON_SECRET', 'cron_secret');

select cron.schedule(
  'sync-nfl-games-every-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-nfl-games',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'sync-prediction-market-odds-every-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-prediction-market-odds',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Running both jobs year-round is fine — they cheaply no-op outside season
(no REG games to sync, no upcoming games to price). To stop a job:
`select cron.unschedule('sync-nfl-games-every-10-min');`.

You can also trigger either sync manually any time from `admin.html`.

---

## 9. Deploying the frontend to GitHub Pages

1. Push this repo to GitHub.
2. Repo → Settings → Pages → Source: **Deploy from a branch** → `main` → `/ (root)`.
3. Your site is now at `https://YOUR_GITHUB_USERNAME.github.io/REPO_NAME/`.
4. Set `ALLOWED_ORIGIN` (see §3) to that exact origin (scheme + host, no
   trailing path) so the Edge Functions' CORS headers allow it.

No build step — GitHub Pages just serves the static files as-is.

---

## 10. NFL data source

`sync-nfl-games` pulls
`https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv`
(the live nflverse schedule/results feed), filters to `game_type = REG` and
weeks 1–18 of `current_season`, and upserts on nflverse's own stable
`game_id` (e.g. `2026_01_NE_SEA`) — safe to run as often as you like.
`gametime` in that feed is a bare `HH:MM` in **America/New_York local time**;
the sync converts it to a correct UTC `timestamptz`, accounting for
EDT/EST, using `Intl.DateTimeFormat`'s timezone offset lookup (no hardcoded
DST dates).

Entering-game record and Last-5 are computed from that same sync pass —
only prior REG games within the same season count, ordered by week number.

---

## 11. Prediction markets (Kalshi / Polymarket)

Both are **optional** — the app fully works with neither configured. Set
`PREDICTION_MARKET_PROVIDER` to `kalshi`, `polymarket`, or `auto` (prefers
Kalshi, falls back to Polymarket per-game, never averages the two).

Both integrations are read-only market-data lookups (no trading, no API key
needed for either as of this writing). Matching a market to a specific game
never guesses: it requires the market to name both teams *and* have a
close/start time near that game's kickoff (division rivals play twice a
season, so team names alone can't disambiguate). A game that doesn't clear
that bar simply shows `—` until conditions change.

**Debugging a bad or missing match:** go to `admin.html` → *Prediction
Market Mappings*. You can hand-enter the correct market ID(s) and check
"Override" so the next sync won't replace your fix. For Polymarket, put the
same market ID in both the Away and Home fields — Polymarket represents a
game as a single market with two outcomes, not two separate markets like
Kalshi.

---

## 12. How the game works (rules recap)

- **Submit-all-at-once:** you pick every game for the week and press
  **Submit Picks** once. There's no picking Thursday's games separately from
  Sunday's.
- **Late submission:** you can still submit after some games have started —
  those are automatically marked FORFEIT, and you must fill in every game
  that *hasn't* started yet before submitting.
- **Lock boundary:** a game is locked the instant `now() >= kickoff_at`,
  using the database's own clock — never the browser's. This is evaluated
  inside one atomic Postgres transaction (`submit_weekly_picks`), so there's
  no gap between "check if it started" and "save the pick."
- **Forfeits count as incorrect**, including for the *whole* denominator —
  16 games, 2 forfeits, 12 right ⇒ 12/16, not 12/14.
- **Skipping a week entirely:** once that week is fully final, you're scored
  0-for-N for it — there's no advantage to not submitting.
- **Other Picks:** locked until you've submitted that same week yourself,
  enforced by Row Level Security (not just hidden with CSS) — there's
  nothing to see even via direct API calls.
- **Ties:** every game includes a TIE option; a correct tie prediction
  counts as correct.
- **Leaderboard:** only the top 3 in *Season Win Rate* and the top 3 in
  *Avg Weekly Finish* are ever shown — never a full ranked list. Win rate =
  correct ÷ all counted picks (season-to-date). Avg finish = mean of your
  weekly `RANK() OVER (ORDER BY correct DESC)` across **completed** weeks
  only (ties share a rank). Both lists use avg-finish/win-rate as a
  secondary sort and normalized username as a final deterministic tiebreak.
- **Admin ≠ shortcut:** admin tools live entirely on `admin.html`; being an
  admin doesn't unlock Other Picks early in the normal app.

---

## 13. Printing

**My Picks → 🖨 Print Pick Sheet** builds a blank (or, if you've already
submitted, pre-checked) paper version of the current week using the same
data already on screen — no extra request, no PDF service. `css/print.css`
hides all navigation/buttons and keeps the sheet to black/white/grayscale,
one matchup per block with `break-inside: avoid` so a game never splits
across a page. Use the browser's own "Save as PDF" if you want a file
instead of a physical printout. Already-started games print as
"ALREADY STARTED — FORFEITED IF SUBMITTED NOW" instead of checkboxes.

---

## 14. Security model (short version)

- Every table has RLS on; the only way to write games/odds/submissions/picks
  is through an Edge Function using the secret key, which never reaches the
  browser.
- `submit-picks` re-derives forfeits from the database clock inside one
  transaction — nothing the client claims about time, game status, or its
  own user ID is trusted (the user ID comes from the verified JWT, not the
  request body).
- `claim-account` uses a single conditional `UPDATE ... WHERE claimed = false`
  as its race-condition guard, so two simultaneous claims of the same
  username can't both succeed.
- `submit_weekly_picks` (the Postgres function underneath `submit-picks`) is
  only grantable to `service_role` — a normal authenticated user cannot call
  it directly and forge picks for someone else's `user_id`.
- Leaderboard aggregates run as `SECURITY DEFINER` functions so they can see
  across all users' picks to compute correct counts — but they only ever
  return counts/ranks, never an individual `selection`, so pick privacy
  stays enforced entirely by the RLS policies on the base tables.

---

## 15. Manual QA checklist

Automated coverage: `npm test` (pure logic — actually run during this
project's build) and `supabase/tests/*.test.sql` (pgTAP — RLS/grading/
leaderboard behavior against a real Postgres; run `supabase test db`
yourself, since this project was built without a local Supabase/Docker
environment available). The rest is easiest to verify by hand against your
deployed project:

- [ ] **Exact kickoff boundary** — submit a pick 1 second before kickoff (accepted) and confirm a game is forced to FORFEIT once its kickoff time passes, even mid-submission.
- [ ] **Sunday late submit** — open the app after early games have started; confirm those show FORFEIT and only later games are selectable.
- [ ] **Early submission stays locked** — submit Thursday before any kickoff; confirm you cannot change any pick afterward, including Sunday/Monday games.
- [ ] **Other Picks before/after submission** — confirm the locked message before you submit, and the full matrix after.
- [ ] **Tie game** — a TIE pick on a tied final game grades CORRECT.
- [ ] **Market API unavailable** — temporarily set `PREDICTION_MARKET_PROVIDER` to an unreachable state (or just watch a week with no match) and confirm the rest of the app still works, showing `—`.
- [ ] **Ambiguous market** — confirm a divisional rematch doesn't get mis-mapped to the wrong week.
- [ ] **Skipped week** — don't submit one week; once it's complete, confirm it counts as 0/N in your season stats.
- [ ] **Duplicate submission** — try submitting the same week twice; second attempt is rejected.
- [ ] **Direct API tampering** — with dev tools open, try inserting into `picks` directly via the Supabase client; confirm RLS rejects it.
- [ ] **Browser clock skew** — change your system clock and confirm submission behavior is unaffected (server time still governs).
- [ ] **Account claim race** — two browsers claiming the same reserved username at once; confirm only one succeeds.

---

## 16. Troubleshooting

- **"Admin access required" calling an admin function** — your `profiles.is_admin` isn't true yet; confirm via SQL Editor: `select is_admin from public.profiles where normalized_username = 'yourusername';`.
- **CORS errors in the browser console** — `ALLOWED_ORIGIN` doesn't match your GitHub Pages origin exactly (scheme + host, no trailing slash/path).
- **`claim-account` returns 401/JWT errors** — make sure `supabase/config.toml`'s `[functions.claim-account]` block with `verify_jwt = false` was picked up (redeploy the function if you edited config.toml after the first deploy).
- **Odds always show `—`** — check `admin.html` → Data Synchronization → run the odds sync manually and read the returned summary; then check the Mappings section for a low-confidence/no match.
- **Games never advance to the next week** — confirm `sync-nfl-games` is actually running (Cron job exists and the SQL in §8 was executed) and that `current_week_override` in `app_settings` isn't stuck on an old week.
- **`supabase db push` fails on `pg_cron`/`pg_net`** — these extensions are enabled by default on hosted Supabase projects; if you're running fully local/self-hosted Postgres without them available, comment out migration `0008` and skip Cron (manual sync still works).
