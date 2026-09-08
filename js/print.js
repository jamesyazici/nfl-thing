import { escapeHtml, formatKickoff } from './utils.js';
import { teamShortName } from './team-meta.js';
import { formatRecord, formatProbabilityPercent } from '../shared/logic.js';

/**
 * Builds the printable sheet (spec §63-§69) from the same data My Picks
 * already loaded — no extra fetch. Laid out as two fixed-height columns
 * (see css/print.css) so a full 16-game week and a 13-game bye week both
 * land on exactly one page, just with more or less breathing room per row.
 * Each pick is its own full-width line (checkbox + name + stats inline)
 * rather than a 3-across grid, so a long name never has to wrap. Every box
 * always prints blank/unchecked, even for a week that's already been
 * submitted — this is meant as a fresh pen-and-paper form, not a receipt
 * of picks already made.
 */
export function renderPrintSheet(state, weekData) {
  const container = document.getElementById('print-sheet');
  if (!container) return;
  const { games, oddsByGame } = weekData;

  const header = `
    <div class="print-sheet__header">
      <span class="print-sheet__name-line">Name: </span>
    </div>
  `;

  const gameBlocks = games.map((g) => buildPrintGame(g, oddsByGame?.get(g.id)));
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

function pickLine(className, checked, name, statsText, side) {
  const sideTag = side ? `<span class="print-pick__side">${side}</span>` : '';
  return `
    <div class="print-pick ${className}">
      <span class="print-pick__name">${checkbox(checked)}${escapeHtml(name)}${sideTag}</span>
      ${statsText ? `<span class="print-pick__stats">${statsText}</span>` : ''}
    </div>
  `;
}

function statsText(game, side, odds) {
  const record = formatRecord({
    wins: game[`${side}_wins`],
    losses: game[`${side}_losses`],
    ties: game[`${side}_ties`],
  });
  const prob = odds ? odds[`${side}_probability_display`] : null;
  const last5 = game[`${side}_last_5`];
  return escapeHtml(`${record} · ${formatProbabilityPercent(prob)} · ${last5}`);
}

function buildPrintGame(game, odds) {
  const started = new Date() >= new Date(game.kickoff_at);
  const awayName = teamShortName(game.away_team);
  const homeName = teamShortName(game.home_team);

  if (started) {
    return `
      <div class="print-game">
        <div class="print-game__kickoff">${formatKickoff(game.kickoff_at)}</div>
        <div class="print-game__started">${escapeHtml(awayName)} @ ${escapeHtml(homeName)} — ALREADY STARTED<br>AUTO-PICKS ${escapeHtml(homeName.toUpperCase())} IF SUBMITTED NOW</div>
      </div>
    `;
  }

  // Always print with every box blank, regardless of whether this week has
  // already been submitted — the printed sheet is meant as a fresh
  // pen-and-paper form, not a record of picks already made.
  return `
    <div class="print-game">
      <div class="print-game__kickoff">${formatKickoff(game.kickoff_at)}</div>
      ${pickLine('', false, awayName, statsText(game, 'away', odds), 'Away')}
      ${pickLine('print-pick--tie', false, 'TIE', '')}
      ${pickLine('', false, homeName, statsText(game, 'home', odds), 'Home')}
    </div>
  `;
}
