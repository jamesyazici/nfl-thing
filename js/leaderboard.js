import { supabase } from './supabase-client.js';
import { escapeHtml, displayUsername } from './utils.js';
import { formatPercent, formatAvgFinish, formatExpectedRecord } from '../shared/logic.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export async function render(panel, state) {
  const [
    { data: winRateTop3, error: winRateError },
    { data: avgFinishTop3, error: avgFinishError },
    { data: weeklyRows, error: weeklyError },
  ] = await Promise.all([
    supabase.rpc('top3_win_rate'),
    supabase.rpc('top3_avg_finish'),
    supabase.rpc('weekly_leaderboard', { p_season: state.season, p_week: state.week }),
  ]);

  if (winRateError || avgFinishError) {
    panel.innerHTML = `<p class="error-note">Could not load the leaderboard.</p>`;
    return;
  }

  panel.innerHTML = `
    <section class="leaderboard-section">
      <h2>Week ${state.week} Leaderboard</h2>
      ${weeklyError ? `<p class="error-note">Could not load Week ${state.week}'s leaderboard.</p>` : renderWeeklyTable(weeklyRows, state)}
    </section>

    <section class="leaderboard-section">
      <h2>Top 3 — Season Win Rate</h2>
      <p class="leaderboard-section__subtitle">Based on correct picks out of all games (skipped weeks count against you; a late auto-pick still grades on the real result).</p>
      ${renderPodium(winRateTop3, state, (row) => ({
        headline: formatPercent(Number(row.win_rate)),
        detail: `${row.total_correct} / ${row.total_counted} · Avg Finish: ${formatAvgFinish(row.avg_finish == null ? null : Number(row.avg_finish))}`,
      }))}
    </section>

    <section class="leaderboard-section">
      <h2>Top 3 — Avg Weekly Finish</h2>
      <p class="leaderboard-section__subtitle">Average weekly standing across completed weeks. Lower is better.</p>
      ${renderPodium(avgFinishTop3, state, (row) => ({
        headline: formatAvgFinish(Number(row.avg_finish)),
        detail: `Win Rate: ${formatPercent(Number(row.win_rate))}`,
      }))}
    </section>
  `;
}

function formatSubmittedAt(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderWeeklyTable(rows, state) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state">No family members yet.</div>`;
  }

  let place = 0;
  const bodyRows = rows
    .map((row) => {
      const isSelf = row.normalized_username === state.profile?.normalized_username;
      const rowClass = isSelf ? 'weekly-leaderboard__row--self' : '';

      if (!row.submitted) {
        return `
          <tr class="${rowClass}">
            <td>—</td>
            <td>${escapeHtml(displayUsername(row.username))}</td>
            <td class="weekly-leaderboard__muted" colspan="3">Not submitted</td>
            <td class="weekly-leaderboard__muted">—</td>
          </tr>
        `;
      }

      place += 1;
      const correct = Number(row.correct);
      const decided = Number(row.decided);
      const record = `${correct}-${decided - correct}`;
      const expectedRecord = formatExpectedRecord(row.expected_wins, Number(row.total_games));
      const upsets = Number(row.upset_wins);
      const allForfeitedNote = row.all_forfeited
        ? `<br><span class="weekly-leaderboard__muted" style="font-size:0.75em;">All picks forfeited to home teams</span>`
        : '';
      return `
        <tr class="${rowClass}">
          <td>${place}</td>
          <td>${escapeHtml(displayUsername(row.username))}${allForfeitedNote}</td>
          <td>${record}</td>
          <td>${escapeHtml(expectedRecord)}</td>
          <td>${upsets}</td>
          <td>${escapeHtml(formatSubmittedAt(row.submitted_at))} ET</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="other-picks-table-wrap">
      <table class="weekly-leaderboard">
        <thead>
          <tr>
            <th>Place</th>
            <th>User</th>
            <th>Record</th>
            <th>Expected Record</th>
            <th>Upset Wins</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function renderPodium(rows, state, describe) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state">No completed weeks yet — check back after the first week finishes.</div>`;
  }
  const cards = rows
    .map((row, i) => {
      const { headline, detail } = describe(row);
      const isSelf = row.normalized_username === state.profile?.normalized_username;
      return `
        <div class="podium-card podium-card--${i + 1} ${isSelf ? 'podium-card--self' : ''}">
          <div class="podium-card__medal">${MEDALS[i] ?? ''}</div>
          <div class="podium-card__name">${escapeHtml(displayUsername(row.username))}</div>
          <div class="podium-card__headline">${escapeHtml(headline)}</div>
          <div class="podium-card__detail">${escapeHtml(detail)}</div>
        </div>
      `;
    })
    .join('');
  return `<div class="podium">${cards}</div>`;
}
