import { supabase } from './supabase-client.js';
import { escapeHtml } from './utils.js';

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
    supabase.from('games').select('id, away_team, home_team, kickoff_at').eq('season', season).eq('week', week).order('kickoff_at'),
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

  const headerCells = users.map((u) => `<th>${escapeHtml(u.username)}</th>`).join('');
  const rows = games
    .map((g) => {
      const cells = users
        .map((u) => {
          if (!submittedUserIds.has(u.id)) {
            return `<td class="other-picks-cell--pending">NOT SUBMITTED</td>`;
          }
          const pick = pickLookup.get(`${u.id}:${g.id}`);
          if (!pick || pick.forfeited || !pick.selection) {
            return `<td class="other-picks-cell--forfeit">FORFEIT</td>`;
          }
          const label = pick.selection === 'TIE' ? 'TIE' : pick.selection === 'AWAY' ? g.away_team : g.home_team;
          return `<td>${escapeHtml(label)}</td>`;
        })
        .join('');
      return `<tr><td>${escapeHtml(g.away_team)} @ ${escapeHtml(g.home_team)}</td>${cells}</tr>`;
    })
    .join('');

  panel.innerHTML = `
    <h1>Week ${week} — Other Picks</h1>
    <div class="other-picks-table-wrap">
      <table class="other-picks">
        <thead><tr><th>Game</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}
