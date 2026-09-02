import { requireSession, signOut, getMyProfile } from './auth.js';
import { supabase } from './supabase-client.js';
import { $, $all, escapeHtml, toast, callFunction } from './utils.js';

const root = document.getElementById('admin-root');

async function init() {
  const session = await requireSession('index.html');
  if (!session) return;

  $('#logout-btn').addEventListener('click', async () => {
    await signOut();
    window.location.href = 'index.html';
  });

  let profile;
  try {
    profile = await getMyProfile(session.user.id);
  } catch {
    root.innerHTML = `<p class="error-note">Could not load your profile.</p>`;
    return;
  }

  // Admin tools live entirely on this separate page (spec §11) — being an
  // admin never grants a shortcut inside the normal My Picks / Other Picks
  // / Leaderboard tabs.
  if (!profile.is_admin) {
    root.innerHTML = `<p class="error-note">Admin access required.</p>`;
    return;
  }

  await renderAll();
}

async function renderAll() {
  root.innerHTML = `
    <section class="admin-section" id="section-week-override"></section>
    <section class="admin-section" id="section-reserve"></section>
    <section class="admin-section" id="section-users"></section>
    <section class="admin-section" id="section-sync"></section>
    <section class="admin-section" id="section-mappings"></section>
  `;
  await Promise.all([
    renderWeekOverride(),
    renderReserveForm(),
    renderUsersTable(),
    renderSyncSection(),
    renderMappingsSection(),
  ]);
}

// ------------------------------------------------------------- week override

async function renderWeekOverride() {
  const el = $('#section-week-override');
  const { data: settings } = await supabase.from('app_settings').select('current_season, current_week_override').single();

  el.innerHTML = `
    <h2>Current Week</h2>
    <p>Season: <strong>${escapeHtml(String(settings?.current_season ?? '—'))}</strong> (the app determines the active week automatically; use the override only for debugging/emergencies, spec §17).</p>
    <div class="inline-form">
      <label for="week-override-select">Override:</label>
      <select id="week-override-select">
        <option value="">Auto (recommended)</option>
        ${Array.from({ length: 18 }, (_, i) => i + 1)
          .map((w) => `<option value="${w}" ${settings?.current_week_override === w ? 'selected' : ''}>Week ${w}</option>`)
          .join('')}
      </select>
      <button type="button" class="btn btn--small" id="save-week-override">Save</button>
    </div>
  `;

  $('#save-week-override').addEventListener('click', async () => {
    const value = $('#week-override-select').value;
    const { error } = await supabase
      .from('app_settings')
      .update({ current_week_override: value === '' ? null : Number(value) })
      .eq('id', true);
    if (error) toast(`Could not save: ${error.message}`, 'error');
    else toast('Saved.', 'success');
  });
}

// ------------------------------------------------------------------ reserve

function renderReserveForm() {
  const el = $('#section-reserve');
  el.innerHTML = `
    <h2>Reserve a Username</h2>
    <p>Create a username here. Set a password now to hand them a ready-to-use login yourself, or leave it blank and they can set their own on the Create Account page.</p>
    <form class="inline-form" id="reserve-form">
      <input id="reserve-username" placeholder="Username" maxlength="32" required>
      <input id="reserve-password" type="password" placeholder="Password (optional)" minlength="8">
      <label><input type="checkbox" id="reserve-is-admin"> Grant admin</label>
      <button type="submit" class="btn btn--small">Reserve</button>
    </form>
  `;

  $('#reserve-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#reserve-username').value;
    const password = $('#reserve-password').value;
    const isAdmin = $('#reserve-is-admin').checked;
    if (password && password.length < 8) {
      toast('Password must be at least 8 characters (or leave it blank).', 'error');
      return;
    }
    try {
      const result = await callFunction('admin-create-username', {
        username,
        is_admin: isAdmin,
        password: password || undefined,
      });
      if (result.password_warning) {
        toast(result.password_warning, 'error');
      } else {
        toast(password ? `"${username}" created and ready to log in.` : `Reserved "${username}".`, 'success');
      }
      $('#reserve-form').reset();
      await renderUsersTable();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// -------------------------------------------------------------------- users

async function renderUsersTable() {
  const el = $('#section-users');
  const { data: users, error } = await supabase
    .from('allowed_users')
    .select('id, username, claimed, is_active, is_admin, created_at, claimed_at')
    .order('created_at', { ascending: false });

  if (error) {
    el.innerHTML = `<h2>Reserved Usernames</h2><p class="error-note">${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (users ?? [])
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>
          ${u.claimed ? '<span class="badge badge--claimed">Claimed</span>' : '<span class="badge badge--unclaimed">Unclaimed</span>'}
          ${u.is_active ? '' : '<span class="badge badge--inactive">Inactive</span>'}
          ${u.is_admin ? '<span class="badge badge--admin">Admin</span>' : ''}
        </td>
        <td>
          <button class="btn btn--small" data-action="set_password" data-id="${u.id}" data-username="${escapeHtml(u.username)}">${u.claimed ? 'Reset Password' : 'Set Password'}</button>
          ${u.is_active
            ? `<button class="btn btn--small btn--secondary" data-action="deactivate" data-id="${u.id}">Deactivate</button>`
            : `<button class="btn btn--small btn--secondary" data-action="reactivate" data-id="${u.id}">Reactivate</button>`}
          ${u.claimed ? `<button class="btn btn--small btn--danger" data-action="release" data-id="${u.id}">Release</button>` : ''}
        </td>
      </tr>
    `,
    )
    .join('');

  el.innerHTML = `
    <h2>Reserved Usernames</h2>
    <table class="admin-table">
      <thead><tr><th>Username</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No usernames reserved yet.</td></tr>'}</tbody>
    </table>
  `;

  $all('button[data-action]', el).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const payload = { allowed_user_id: btn.dataset.id, action };

      if (action === 'release' && !confirm('Release this account? The username can then be claimed again from scratch, and the person will need to create a new password.')) {
        return;
      }
      if (action === 'set_password') {
        const password = prompt(`New password for "${btn.dataset.username}" (min 8 characters):`);
        if (!password) return; // cancelled
        if (password.length < 8) {
          toast('Password must be at least 8 characters.', 'error');
          return;
        }
        payload.password = password;
      }

      try {
        const result = await callFunction('admin-manage-user', payload);
        if (action === 'set_password') {
          toast(result.mode === 'claimed' ? 'Account created — ready to log in.' : 'Password updated.', 'success');
        } else {
          toast('Done.', 'success');
        }
        await renderUsersTable();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

// --------------------------------------------------------------------- sync

function renderSyncSection() {
  const el = $('#section-sync');
  el.innerHTML = `
    <h2>Data Synchronization</h2>
    <div class="inline-form">
      <button type="button" class="btn btn--small" id="sync-games-btn">Sync NFL Games</button>
      <button type="button" class="btn btn--small" id="sync-odds-btn">Sync Prediction Market Odds</button>
    </div>
    <p id="sync-status" style="color:var(--color-text-muted); font-size:0.85rem; margin-top:12px;"></p>
  `;

  const statusEl = $('#sync-status');

  $('#sync-games-btn').addEventListener('click', async () => {
    statusEl.textContent = 'Syncing NFL games…';
    try {
      const result = await callFunction('sync-nfl-games', {});
      statusEl.textContent = `Synced ${result.games_synced} games for season ${result.season} at ${new Date().toLocaleTimeString()}.`;
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    }
  });

  $('#sync-odds-btn').addEventListener('click', async () => {
    statusEl.textContent = 'Syncing prediction market odds…';
    try {
      const result = await callFunction('sync-prediction-market-odds', {});
      statusEl.textContent = `Considered ${result.games_considered} games. Written: ${JSON.stringify(result.providers_written)}.`;
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    }
  });
}

// ---------------------------------------------------------------- mappings

async function renderMappingsSection() {
  const el = $('#section-mappings');
  const { data: mappings, error } = await supabase
    .from('prediction_market_mappings')
    .select('id, game_id, provider, external_event_id, away_market_id, home_market_id, tie_market_id, match_confidence, manually_overridden, games(away_team, home_team, week)')
    .order('updated_at', { ascending: false })
    .limit(50);

  if (error) {
    el.innerHTML = `<h2>Prediction Market Mappings</h2><p class="error-note">${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (mappings ?? [])
    .map(
      (m) => `
      <tr data-id="${m.id}">
        <td>W${m.games?.week ?? '?'} ${escapeHtml(m.games?.away_team ?? '?')} @ ${escapeHtml(m.games?.home_team ?? '?')}</td>
        <td>${escapeHtml(m.provider)}</td>
        <td><input class="map-away" value="${escapeHtml(m.away_market_id ?? '')}" size="14"></td>
        <td><input class="map-home" value="${escapeHtml(m.home_market_id ?? '')}" size="14"></td>
        <td><input class="map-tie" value="${escapeHtml(m.tie_market_id ?? '')}" size="14"></td>
        <td>${Number(m.match_confidence).toFixed(2)}</td>
        <td><input type="checkbox" class="map-override" ${m.manually_overridden ? 'checked' : ''}></td>
        <td><button class="btn btn--small" data-save="${m.id}">Save</button></td>
      </tr>
    `,
    )
    .join('');

  el.innerHTML = `
    <h2>Prediction Market Mappings</h2>
    <p style="color:var(--color-text-muted); font-size:0.85rem;">
      Correct a bad automatic match here, then check "Override" so the next sync won't replace it.
      For Polymarket, use the same ID in both the Away and Home fields — Polymarket represents a
      game as one market with two outcomes rather than two separate markets.
    </p>
    <div class="other-picks-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Game</th><th>Provider</th><th>Away Market ID</th><th>Home Market ID</th><th>Tie Market ID</th><th>Confidence</th><th>Override</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8">No mappings yet — run a sync first.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  $all('button[data-save]', el).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = btn.dataset.save;
      const update = {
        away_market_id: $('.map-away', row).value || null,
        home_market_id: $('.map-home', row).value || null,
        tie_market_id: $('.map-tie', row).value || null,
        manually_overridden: $('.map-override', row).checked,
        updated_at: new Date().toISOString(),
      };
      const { error: updateError } = await supabase.from('prediction_market_mappings').update(update).eq('id', id);
      if (updateError) toast(`Could not save: ${updateError.message}`, 'error');
      else toast('Saved.', 'success');
    });
  });
}

init();
