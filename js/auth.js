import { supabase } from './supabase-client.js';
import { normalizeUsername, syntheticEmailFor } from '../shared/logic.js';
import { callFunction } from './utils.js';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signInWithUsername(username, password) {
  const email = syntheticEmailFor(normalizeUsername(username));
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Incorrect username or password.');
}

export async function signOut() {
  await supabase.auth.signOut();
}

/** Call at the top of every page that requires a logged-in user. */
export async function requireSession(redirectTo = 'index.html') {
  const session = await getSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

/** Call at the top of index.html / create-account.html so an already-logged-in visitor skips straight to the app. */
export async function redirectIfAuthenticated(redirectTo = 'app.html') {
  const session = await getSession();
  if (session) window.location.href = redirectTo;
}

export async function claimAccount(username, password) {
  return callFunction('claim-account', { username, password });
}

export async function getMyProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}
