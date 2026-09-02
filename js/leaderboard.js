import { supabase } from './supabase-client.js';
import { escapeHtml } from './utils.js';
import { formatPercent, formatAvgFinish } from '../shared/logic.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export async function render(panel, state) {
  const [{ data: winRateTop3, error: winRateError }, { data: avgFinishTop3, error: avgFinishError }] =
    await Promise.all([supabase.rpc('top3_win_rate'), supabase.rpc('top3_avg_finish')]);

  if (winRateError || avgFinishError) {
    panel.innerHTML = `<p class="error-note">Could not load the leaderboard.</p>`;
    return;
  }

  panel.innerHTML = `
    <section class="leaderboard-section">
      <h2>Top 3 — Season Win Rate</h2>
      <p class="leaderboard-section__subtitle">Based on correct picks out of all games (forfeits and skipped weeks count against you).</p>
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
          <div class="podium-card__name">${escapeHtml(row.username)}</div>
          <div class="podium-card__headline">${escapeHtml(headline)}</div>
          <div class="podium-card__detail">${escapeHtml(detail)}</div>
        </div>
      `;
    })
    .join('');
  return `<div class="podium">${cards}</div>`;
}
