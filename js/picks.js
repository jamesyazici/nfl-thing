import { supabase } from './supabase-client.js';
import { $, $all, escapeHtml, formatKickoff, toast, callFunction } from './utils.js';
import { teamName } from './team-meta.js';
import { formatRecord, formatProbabilityPercent } from '../shared/logic.js';
import { renderPrintSheet } from './print.js';

// Module-level cache of the currently-loaded week's data, so the Print
// button and the submit-confirmation modal don't have to refetch.
let loadedWeek = { season: null, week: null, games: [], oddsByGame: new Map(), submission: null, picksByGame: new Map() };
let selections = {}; // game_id -> 'HOME' | 'AWAY' | 'TIE', for the not-yet-submitted case

export function getLoadedWeekData() {
  return loadedWeek;
}

async function fetchOddsByGame(gameIds) {
  if (gameIds.length === 0) return new Map();
  const { data } = await supabase
    .from('prediction_market_odds')
    .select('game_id, provider, away_probability_display, home_probability_display, tie_probability_display')
    .in('game_id', gameIds);
  const byGame = new Map();
  for (const row of data ?? []) {
    const existing = byGame.get(row.game_id);
    // Prefer Kalshi over Polymarket when both exist (spec §28's "auto" rule, applied for display too).
    if (!existing || row.provider === 'kalshi') byGame.set(row.game_id, row);
  }
  return byGame;
}

export async function render(panel, state) {
  const { season, week } = state;
  selections = {};

  const [{ data: games, error: gamesError }, { data: submission }] = await Promise.all([
    supabase.from('games').select('*').eq('season', season).eq('week', week).order('kickoff_at'),
    supabase
      .from('weekly_submissions')
      .select('id, submitted_at')
      .eq('user_id', state.session.user.id)
      .eq('season', season)
      .eq('week', week)
      .maybeSingle(),
  ]);

  if (gamesError) {
    panel.innerHTML = `<p class="error-note">Could not load games. ${escapeHtml(gamesError.message)}</p>`;
    return;
  }
  if (!games || games.length === 0) {
    panel.innerHTML = `<div class="empty-state">No games are scheduled for Week ${week} yet. Check back once the schedule syncs.</div>`;
    return;
  }

  const oddsByGame = await fetchOddsByGame(games.map((g) => g.id));

  let picksByGame = new Map();
  if (submission) {
    const { data: picks } = await supabase
      .from('picks')
      .select('game_id, selection, forfeited')
      .eq('user_id', state.session.user.id)
      .eq('season', season)
      .eq('week', week);
    picksByGame = new Map((picks ?? []).map((p) => [p.game_id, p]));
  }

  loadedWeek = { season, week, games, oddsByGame, submission, picksByGame };

  panel.innerHTML = buildHeaderHtml(week, submission) + games.map((g) => buildGameCardHtml(g, oddsByGame.get(g.id), submission, picksByGame.get(g.id))).join('') + buildFooterHtml(submission);

  wireHandlers(panel, state);
}

function buildHeaderHtml(week, submission) {
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
      <h1 style="margin:0;">Week ${week}</h1>
      <button type="button" class="btn btn--secondary btn--small no-print" id="print-sheet-btn">🖨 Print Pick Sheet</button>
    </div>
    ${submission ? `<p style="color:var(--color-text-muted); margin-top:-8px;">Submitted ${escapeHtml(new Date(submission.submitted_at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }))} ET — <strong>LOCKED</strong></p>` : ''}
  `;
}

function buildFooterHtml(submission) {
  if (submission) return '';
  return `
    <div class="submit-bar">
      <span id="selection-count" style="color:var(--color-text-muted); font-size:0.9rem;"></span>
      <button type="button" class="btn" id="open-submit-modal">Submit Picks</button>
    </div>
  `;
}

function statsColumnHtml(game, side, odds) {
  const wins = game[`${side}_wins`];
  const losses = game[`${side}_losses`];
  const ties = game[`${side}_ties`];
  const last5 = game[`${side}_last_5`];
  const record = formatRecord({ wins, losses, ties });
  // Shown to family members as plain "Odds" rather than naming the
  // provider (Kalshi/Polymarket) — most people don't know what those are,
  // and the app never displays sportsbook-style odds anyway, just this
  // implied win probability, so the generic label reads more clearly here.
  const providerLabel = odds?.provider === 'kalshi' || odds?.provider === 'polymarket' ? 'Odds' : null;
  const prob = odds ? odds[`${side}_probability_display`] : null;
  return `
    <div class="game-card__stats-col">
      <div><span class="stats-label">Record:</span> ${escapeHtml(record)}</div>
      ${providerLabel ? `<div><span class="stats-label">${providerLabel}:</span> ${formatProbabilityPercent(prob)}</div>` : ''}
      <div><span class="stats-label">Last 5:</span> <span class="last5">${escapeHtml(last5)}</span></div>
    </div>
  `;
}

function resultBannerHtml(pick, game) {
  if (game.status !== 'FINAL') {
    return `<div class="game-card__result-banner game-card__result-banner--pending">Your Pick: ${pickLabel(pick, game)} — PENDING</div>`;
  }
  if (pick.forfeited || !pick.selection) {
    return `<div class="game-card__result-banner game-card__result-banner--incorrect">Your Pick: FORFEIT ❌</div>`;
  }
  const correct = pick.selection === game.winner;
  return `<div class="game-card__result-banner ${correct ? 'game-card__result-banner--correct' : 'game-card__result-banner--incorrect'}">Your Pick: ${pickLabel(pick, game)} ${correct ? '✅' : '❌'}</div>`;
}

function pickLabel(pick, game) {
  if (pick.forfeited || !pick.selection) return 'FORFEIT';
  if (pick.selection === 'TIE') return 'Tie';
  return teamName(pick.selection === 'AWAY' ? game.away_team : game.home_team);
}

function buildGameCardHtml(game, odds, submission, pick) {
  const started = new Date() >= new Date(game.kickoff_at); // display-only hint; server re-verifies authoritatively
  const awayName = teamName(game.away_team);
  const homeName = teamName(game.home_team);

  const optionHtml = (value, label, disabled, selected) => `
    <label class="pick-option ${value === 'TIE' ? 'pick-option--tie' : ''} ${selected ? 'pick-option--selected' : ''} ${disabled ? 'pick-option--disabled' : ''}" data-value="${value}">
      <input type="radio" name="pick-${game.id}" value="${value}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="pick-option__label">${escapeHtml(label)}</span>
    </label>
  `;

  let picksSection;
  if (submission) {
    const currentSelection = pick?.selection ?? null;
    picksSection = `
      <div class="game-card__picks">
        ${optionHtml('AWAY', awayName, true, currentSelection === 'AWAY')}
        ${optionHtml('TIE', 'Tie', true, currentSelection === 'TIE')}
        ${optionHtml('HOME', homeName, true, currentSelection === 'HOME')}
      </div>
      ${resultBannerHtml(pick ?? { forfeited: true, selection: null }, game)}
    `;
  } else if (started) {
    picksSection = `
      <div class="game-card__picks">
        ${optionHtml('AWAY', awayName, true, false)}
        ${optionHtml('TIE', 'Tie', true, false)}
        ${optionHtml('HOME', homeName, true, false)}
      </div>
      <div class="game-card__forfeit-banner">FORFEIT — GAME ALREADY STARTED</div>
    `;
  } else {
    picksSection = `
      <div class="game-card__picks" data-game-id="${game.id}">
        ${optionHtml('AWAY', awayName, false, selections[game.id] === 'AWAY')}
        ${optionHtml('TIE', 'Tie', false, selections[game.id] === 'TIE')}
        ${optionHtml('HOME', homeName, false, selections[game.id] === 'HOME')}
      </div>
    `;
  }

  const finalScoreHtml =
    game.status === 'FINAL'
      ? `<div class="game-card__final-score">FINAL — ${escapeHtml(awayName)} ${game.away_score} · ${escapeHtml(homeName)} ${game.home_score}</div>`
      : '';

  return `
    <article class="game-card" data-game-id="${game.id}">
      <div class="game-card__kickoff">${formatKickoff(game.kickoff_at)}</div>
      ${picksSection}
      <div class="game-card__stats">
        ${statsColumnHtml(game, 'away', odds)}
        <div></div>
        ${statsColumnHtml(game, 'home', odds)}
      </div>
      ${finalScoreHtml}
    </article>
  `;
}

function updateSelectionCount(panel) {
  const countEl = $('#selection-count', panel);
  if (!countEl) return;
  const unstarted = loadedWeek.games.filter((g) => new Date() < new Date(g.kickoff_at));
  const chosen = unstarted.filter((g) => selections[g.id]).length;
  const forfeitCount = loadedWeek.games.length - unstarted.length;
  countEl.textContent = `${chosen}/${unstarted.length} selections made${forfeitCount ? ` · ${forfeitCount} automatic forfeit${forfeitCount === 1 ? '' : 's'}` : ''}`;
}

function wireHandlers(panel, state) {
  updateSelectionCount(panel);

  panel.addEventListener('click', (e) => {
    const option = e.target.closest('.pick-option');
    if (!option || option.classList.contains('pick-option--disabled')) return;
    const group = option.closest('.game-card__picks');
    if (!group || !group.dataset.gameId) return;
    const gameId = group.dataset.gameId;
    const value = option.dataset.value;
    selections[gameId] = value;
    $all('.pick-option', group).forEach((el) => el.classList.toggle('pick-option--selected', el === option));
    $all('input[type="radio"]', group).forEach((input) => {
      input.checked = input.value === value;
    });
    updateSelectionCount(panel);
  });

  const printBtn = $('#print-sheet-btn', panel);
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      renderPrintSheet(state, loadedWeek);
      window.print();
    });
  }

  const openModalBtn = $('#open-submit-modal', panel);
  if (openModalBtn) {
    openModalBtn.addEventListener('click', () => openSubmitModal(panel, state));
  }
}

function openSubmitModal(panel, state) {
  const unstarted = loadedWeek.games.filter((g) => new Date() < new Date(g.kickoff_at));
  const missing = unstarted.filter((g) => !selections[g.id]);
  if (missing.length > 0) {
    toast(`Please choose an outcome for every game that hasn't started yet (${missing.length} remaining).`, 'error');
    return;
  }

  const forfeitCount = loadedWeek.games.length - unstarted.length;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>Submit Week ${loadedWeek.week} Picks?</h2>
      <p>${unstarted.length} selection${unstarted.length === 1 ? '' : 's'}${forfeitCount ? `<br>${forfeitCount} automatic forfeit${forfeitCount === 1 ? '' : 's'}` : ''}</p>
      <p><strong>Once submitted, your Week ${loadedWeek.week} picks CANNOT be changed.</strong></p>
      <div class="modal__actions">
        <button type="button" class="btn btn--secondary" id="modal-cancel">Cancel</button>
        <button type="button" class="btn" id="modal-confirm">Submit and Lock Picks</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  $('#modal-cancel', backdrop).addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  $('#modal-confirm', backdrop).addEventListener('click', async () => {
    const confirmBtn = $('#modal-confirm', backdrop);
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Submitting…';
    try {
      await submitPicks(state);
      backdrop.remove();
      toast('Picks submitted!', 'success');
      const { renderActiveTab } = await import('./app.js');
      await renderActiveTab();
    } catch (err) {
      toast(err.message, 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Submit and Lock Picks';
    }
  });
}

async function submitPicks(state) {
  const payload = {
    season: loadedWeek.season,
    week: loadedWeek.week,
    selections: Object.entries(selections).map(([game_id, selection]) => ({ game_id, selection })),
  };
  await callFunction('submit-picks', payload);
}
