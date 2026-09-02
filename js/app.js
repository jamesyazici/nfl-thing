import { requireSession, signOut, getMyProfile } from './auth.js';
import { supabase } from './supabase-client.js';
import { $, $all, toast } from './utils.js';
import * as picksTab from './picks.js';
import * as otherPicksTab from './other-picks.js';
import * as leaderboardTab from './leaderboard.js';

export const state = { session: null, profile: null, season: null, week: null };

async function init() {
  const session = await requireSession('index.html');
  if (!session) return;
  state.session = session;

  try {
    state.profile = await getMyProfile(session.user.id);
  } catch {
    toast('Could not load your profile. Please log in again.', 'error');
    await signOut();
    window.location.href = 'index.html';
    return;
  }

  $('#current-username').textContent = state.profile.username;
  if (state.profile.is_admin) {
    $('#admin-link').hidden = false;
  }

  const { data: settings, error: settingsError } = await supabase
    .from('app_settings')
    .select('current_season')
    .single();
  if (settingsError || !settings) {
    $('#panel-my-picks').innerHTML = '<p class="error-note">App is not configured yet (no app_settings row).</p>';
    return;
  }
  state.season = settings.current_season;

  const { data: currentWeek } = await supabase.rpc('get_current_week', { p_season: state.season });
  state.week = currentWeek ?? 1;

  populateWeekSelector();
  wireTabs();
  wireHeader();
  await renderActiveTab();
}

function populateWeekSelector() {
  const select = $('#week-select');
  select.innerHTML = '';
  for (let w = 1; w <= 18; w++) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = `Week ${w}`;
    if (w === state.week) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', async () => {
    state.week = Number(select.value);
    await renderActiveTab();
  });
}

function wireHeader() {
  $('#logout-btn').addEventListener('click', async () => {
    await signOut();
    window.location.href = 'index.html';
  });
}

function activeTabName() {
  return $('.tab-btn[aria-selected="true"]')?.dataset.tab ?? 'my-picks';
}

function wireTabs() {
  $all('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      $all('.tab-btn').forEach((b) => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      $all('.tab-panel').forEach((p) => {
        p.hidden = true;
      });
      $(`#panel-${btn.dataset.tab}`).hidden = false;
      await renderActiveTab();
    });
  });
}

export async function renderActiveTab() {
  const tab = activeTabName();
  const panel = $(`#panel-${tab}`);
  panel.innerHTML = '<p class="loading-note">Loading…</p>';
  try {
    if (tab === 'my-picks') await picksTab.render(panel, state);
    else if (tab === 'other-picks') await otherPicksTab.render(panel, state);
    else if (tab === 'leaderboard') await leaderboardTab.render(panel, state);
  } catch (err) {
    console.error(err);
    panel.innerHTML = `<p class="error-note">Could not load this tab. ${err.message ?? 'Please try again.'}</p>`;
  }
}

init();
