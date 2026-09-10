import { supabase } from './supabase-client.js';
import { escapeHtml, displayUsername } from './utils.js';
import { standardCompetitionRanks, medalForRank } from '../shared/logic.js';

// Don't crown a leader off just Thursday Night Football — wait until at
// least this many games in the week are final.
const MIN_FINAL_GAMES_FOR_MEDALS = 3;

export async function render(panel, state) {
  const { season, week } = state;

  const { data: mySubmission } = await supabase
    .from('weekly_submissions')
    .select('id')
    .eq('user_id', state.session.user.id)
    .eq('season', season)
    .eq('week', week)
    .maybeSingle();

  if (!mySubmission) {
    panel.innerHTML = `
      <div class="locked-panel">
        <span class="locked-panel__icon">🔒</span>
        <p>Submit your Week ${week} picks<br>to see everyone else's picks.</p>
      </div>
    `;
    return;
  }

  // RLS enforces this server-side (spec §48) — this fetch would simply
  // return nothing beyond our own row if we hadn't submitted. The check
  // above is only for a friendlier message; it is not the security boundary.
  const [{ data: games }, { data: picks }, { data: submissions }, { data: profiles }] = await Promise.all([
    supabase.from('games').select('id, away_team, home_team, kickoff_at, status, winner').eq('season', season).eq('week', week).order('kickoff_at'),
    supabase.from('picks').select('user_id, game_id, selection, forfeited').eq('season', season).eq('week', week),
    supabase.from('weekly_submissions').select('user_id').eq('season', season).eq('week', week),
    supabase.from('profiles').select('id, username, normalized_username').order('normalized_username'),
  ]);

  if (!games || games.length === 0) {
    panel.innerHTML = `<div class="empty-state">No games are scheduled for Week ${week} yet.</div>`;
    return;
  }

  const submittedUserIds = new Set((submissions ?? []).map((s) => s.user_id));
  const pickLookup = new Map((picks ?? []).map((p) => [`${p.user_id}:${p.game_id}`, p]));
  const users = profiles ?? [];

  // Running total of correct picks per user, updated as each game is
  // rendered — only games that are actually FINAL contribute, same as the
  // per-cell green/red coloring below, so this always matches what's shown.
  const correctCounts = new Map(users.map((u) => [u.id, 0]));

  const rows = games
    .map((g) => {
      const decided = g.status === 'FINAL' && g.winner;
      const cells = users
        .map((u) => {
          if (!submittedUserIds.has(u.id)) {
            return `<td class="other-picks-cell--pending">NOT SUBMITTED</td>`;
          }
          const pick = pickLookup.get(`${u.id}:${g.id}`);
          // A forfeited pick stores no selection at all (never earns
          // credit either way, no exceptions), so this also covers it.
          // Shown as a plain dash — no team was recorded, nothing to grade.
          if (!pick || !pick.selection) {
            return `<td class="other-picks-cell--forfeit">—</td>`;
          }
          const label = pick.selection === 'TIE' ? 'TIE' : pick.selection === 'AWAY' ? g.away_team : g.home_team;
          // Subtle background-only tint so it's easy to eyeball how lopsided
          // a game's picks are at a glance.
          const sideClass =
            pick.selection === 'AWAY' ? 'other-picks-cell--away' : pick.selection === 'HOME' ? 'other-picks-cell--home' : '';
          // Once the game is final, the text itself turns green (correct)
          // or red (incorrect) — nothing else about the cell changes.
          let gradeClass = '';
          if (decided) {
            const correct = pick.selection === g.winner;
            gradeClass = correct ? 'other-picks-cell--correct' : 'other-picks-cell--incorrect';
            if (correct) correctCounts.set(u.id, (correctCounts.get(u.id) ?? 0) + 1);
          }
          return `<td class="${sideClass} ${gradeClass}">${escapeHtml(label)}</td>`;
        })
        .join('');
      return `<tr><td>${escapeHtml(g.away_team)} @ ${escapeHtml(g.home_team)}</td>${cells}</tr>`;
    })
    .join('');

  const totalCells = users
    .map((u) => `<td>${submittedUserIds.has(u.id) ? correctCounts.get(u.id) : '—'}</td>`)
    .join('');
  const totalRow = `<tr class="other-picks-total-row"><td>Total</td>${totalCells}</tr>`;

  // Medals for whoever's currently leading the week, once there's enough
  // data to mean something (spec: at least 3 games final). Ranked only
  // among people who've actually submitted — ties share a medal, per
  // standard competition ranking (same rule as weekly finishing position).
  const finalGamesCount = games.filter((g) => g.status === 'FINAL' && g.winner).length;
  const medalById = new Map();
  if (finalGamesCount >= MIN_FINAL_GAMES_FOR_MEDALS) {
    const entries = users.filter((u) => submittedUserIds.has(u.id)).map((u) => ({ id: u.id, count: correctCounts.get(u.id) }));
    const ranks = standardCompetitionRanks(entries);
    for (const u of users) {
      const medal = medalForRank(ranks.get(u.id));
      if (medal) medalById.set(u.id, medal);
    }
  }

  const headerCells = users
    .map((u) => {
      const medal = medalById.get(u.id);
      const name = escapeHtml(displayUsername(u.username));
      return medal
        ? `<th class="other-picks-header--medal">${medal} <strong>${name}</strong></th>`
        : `<th>${name}</th>`;
    })
    .join('');

  panel.innerHTML = `
    <h1>Week ${week} — Other Picks</h1>
    <div class="other-picks-table-wrap">
      <table class="other-picks">
        <thead><tr><th>Game</th>${headerCells}</tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>
  `;
}
