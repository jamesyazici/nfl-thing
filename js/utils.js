import { supabase } from './supabase-client.js';

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/**
 * Usernames can't contain spaces (the create-account charset is letters,
 * numbers, underscore, hyphen), so a family member like "Aunt-Sheryl" uses
 * a hyphen as a stand-in for one. Wherever a username is shown as a *name*
 * (Other Picks columns, Leaderboard, the header greeting) rather than as a
 * literal login credential, display it with hyphens turned back into
 * spaces — the stored/login username itself never changes.
 */
export function displayUsername(username) {
  return String(username ?? '').replace(/-/g, ' ');
}

/** Kickoff times are always shown in Eastern Time, regardless of the viewer's own timezone (spec §15). */
export function formatKickoff(iso) {
  const d = new Date(iso);
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  return `${datePart} • ${timePart} ET`;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

let toastContainer;
export function toast(message, type = 'info', timeoutMs = 5000) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-stack';
    document.body.appendChild(toastContainer);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), timeoutMs);
}

/** Edge Functions return `{ error }` JSON on non-2xx; supabase-js only exposes that via the raw Response on error.context. */
export async function extractFunctionError(error) {
  try {
    if (error?.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body?.error) return body.error;
    }
  } catch {
    // fall through to the generic message below
  }
  return error?.message || 'Something went wrong. Please try again.';
}

export async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw new Error(await extractFunctionError(error));
  return data;
}
