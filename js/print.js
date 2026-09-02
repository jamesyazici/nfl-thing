import { escapeHtml, formatKickoff } from './utils.js';
import { teamName } from './team-meta.js';
import { formatRecord, formatProbabilityPercent } from '../shared/logic.js';

/** Builds the printable sheet (spec §63-§69) from the same data My Picks already loaded — no extra fetch. */
export function renderPrintSheet(state, weekData) {
  const container = document.getElementById('print-sheet');
  if (!container) return;
  const { season, week, games, oddsByGame, picksByGame } = weekData;

  const header = `
    <div class="print-sheet__header">
      <p class="print-sheet__title">NFL THING</p>
      <p class="print-sheet__subtitle">${escapeHtml(String(season))} — WEEK ${escapeHtml(String(week))}</p>
      <div class="print-sheet__fields">
        <span>Name: ${escapeHtml(state.profile?.username ?? '')}</span>
        <span>Printed: ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}</span>
      </div>
    </div>
  `;

  const gamesHtml = games
    .map((g) => buildPrintGame(g, oddsByGame?.get(g.id), picksByGame?.get(g.id)))
    .join('');

  container.innerHTML = header + gamesHtml;
}

function checkbox(checked) {
  return `<span class="print-checkbox${checked ? ' print-checkbox--checked' : ''}"></span>`;
}

function buildPrintGame(game, odds, pick) {
  const started = new Date() >= new Date(game.kickoff_at);
  const awayName = teamName(game.away_team);
  const homeName = teamName(game.home_team);

  if (started) {
    return `
      <div class="print-game">
        <div class="print-game__kickoff">${formatKickoff(game.kickoff_at)}</div>
        <div class="print-game__row">
          <div>${escapeHtml(awayName)}</div><div>vs</div><div>${escapeHtml(homeName)}</div>
        </div>
        <div class="print-game__started">ALREADY STARTED — FORFEITED IF SUBMITTED NOW</div>
      </div>
    `;
  }

  // If the week has already been submitted, show the recorded pick checked
  // (spec §68 nice-to-have); otherwise every box is blank for pen-and-paper use.
  const selection = pick && !pick.forfeited ? pick.selection : null;

  return `
    <div class="print-game">
      <div class="print-game__kickoff">${formatKickoff(game.kickoff_at)}</div>
      <div class="print-game__row">
        <div>${checkbox(selection === 'AWAY')}${escapeHtml(awayName)}</div>
        <div>${checkbox(selection === 'TIE')}TIE</div>
        <div>${checkbox(selection === 'HOME')}${escapeHtml(homeName)}</div>
      </div>
      <div class="print-game__stats">
        ${printStatsCol(game, 'away', odds)}
        <div></div>
        ${printStatsCol(game, 'home', odds)}
      </div>
    </div>
  `;
}

function printStatsCol(game, side, odds) {
  const record = formatRecord({
    wins: game[`${side}_wins`],
    losses: game[`${side}_losses`],
    ties: game[`${side}_ties`],
  });
  const providerLabel = odds?.provider === 'kalshi' ? 'Kalshi' : odds?.provider === 'polymarket' ? 'Polymarket' : null;
  const prob = odds ? odds[`${side}_probability_display`] : null;
  return `
    <div>
      <div>Record: ${escapeHtml(record)}</div>
      ${providerLabel ? `<div>${providerLabel}: ${formatProbabilityPercent(prob)}</div>` : ''}
      <div>Last 5: ${escapeHtml(game[`${side}_last_5`])}</div>
    </div>
  `;
}
