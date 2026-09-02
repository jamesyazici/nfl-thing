import { escapeHtml, formatKickoff } from './utils.js';
import { teamShortName } from './team-meta.js';
import { formatRecord, formatProbabilityPercent } from '../shared/logic.js';

/**
 * Builds the printable sheet (spec §63-§69) from the same data My Picks
 * already loaded — no extra fetch. Laid out as two fixed-height columns
 * (see css/print.css) so a full 16-game week and a 13-game bye week both
 * land on exactly one page, just with more or less breathing room per row.
 */
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
    <p class="print-sheet__legend">Record shown entering this game &middot; % is current win probability where available &middot; Last 5 reads oldest-to-newest, left-to-right</p>
  `;

  const gameBlocks = games.map((g) => buildPrintGame(g, oddsByGame?.get(g.id), picksByGame?.get(g.id)));
  const half = Math.ceil(gameBlocks.length / 2);
  const columnsHtml = `
    <div class="print-columns">
      <div class="print-column">${gameBlocks.slice(0, half).join('')}</div>
      <div class="print-column">${gameBlocks.slice(half).join('')}</div>
    </div>
  `;

  container.innerHTML = header + columnsHtml;
}

function checkbox(checked) {
  return `<span class="print-checkbox${checked ? ' print-checkbox--checked' : ''}"></span>`;
}

function buildPrintGame(game, odds, pick) {
  const started = new Date() >= new Date(game.kickoff_at);
  const awayName = teamShortName(game.away_team);
  const homeName = teamShortName(game.home_team);

  if (started) {
    return `
      <div class="print-game">
        <div class="print-game__kickoff">${formatKickoff(game.kickoff_at)}</div>
        <div class="print-game__started">${escapeHtml(awayName)} @ ${escapeHtml(homeName)} — ALREADY STARTED<br>FORFEITED IF SUBMITTED NOW</div>
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
        <div class="print-pick">
          <div class="print-pick__label">${checkbox(selection === 'AWAY')}${escapeHtml(awayName)}</div>
          ${printStatsLine(game, 'away', odds)}
        </div>
        <div class="print-pick print-pick--tie">
          <div class="print-pick__label">${checkbox(selection === 'TIE')}TIE</div>
        </div>
        <div class="print-pick">
          <div class="print-pick__label">${checkbox(selection === 'HOME')}${escapeHtml(homeName)}</div>
          ${printStatsLine(game, 'home', odds)}
        </div>
      </div>
    </div>
  `;
}

function printStatsLine(game, side, odds) {
  const record = formatRecord({
    wins: game[`${side}_wins`],
    losses: game[`${side}_losses`],
    ties: game[`${side}_ties`],
  });
  const prob = odds ? odds[`${side}_probability_display`] : null;
  const probText = formatProbabilityPercent(prob);
  const last5 = game[`${side}_last_5`];
  return `<div class="print-pick__stats">${escapeHtml(record)} &middot; ${escapeHtml(probText)} &middot; ${escapeHtml(last5)}</div>`;
}
