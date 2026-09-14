// Family-wide live chat: one shared room, no DMs (spec follow-up).
// Realtime via Supabase's built-in Postgres Changes — no custom
// websocket code, no separate server. Writes go straight to
// chat_messages under RLS (own message to edit/delete, admins can
// delete anyone's) rather than through an Edge Function; the rules are
// simple enough that a policy is the right amount of machinery, not a
// server-side transaction like submit-picks needs.
import { supabase } from './supabase-client.js';
import { escapeHtml, displayUsername, toast } from './utils.js';

const HISTORY_LIMIT = 100;

let profilesById = new Map();
let currentUserId = null;
let isAdmin = false;

export async function init(state) {
  const toggle = document.getElementById('chat-toggle');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const list = document.getElementById('chat-messages');
  if (!toggle || !panel || !closeBtn || !form || !input || !list) return;

  currentUserId = state.session.user.id;
  isAdmin = !!state.profile?.is_admin;

  toggle.addEventListener('click', () => setOpen(panel, toggle, !panel.classList.contains('chat-panel--open')));
  closeBtn.addEventListener('click', () => setOpen(panel, toggle, false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.disabled = true;
    const { error } = await supabase.from('chat_messages').insert({ user_id: currentUserId, message });
    input.disabled = false;
    if (error) {
      toast('Could not send your message. Please try again.', 'error');
      return;
    }
    input.value = '';
    input.focus();
    // Realtime's own INSERT event renders it (for us too) — no
    // optimistic local render, so there's no chance of a duplicate.
  });

  const [{ data: profiles }, { data: messages }] = await Promise.all([
    supabase.from('profiles').select('id, username'),
    supabase
      .from('chat_messages')
      .select('id, user_id, message, created_at, edited_at')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  profilesById = new Map((profiles ?? []).map((p) => [p.id, p.username]));

  list.innerHTML = '';
  (messages ?? [])
    .slice()
    .reverse()
    .forEach((m) => appendMessage(list, m));
  scrollToBottom(list);

  supabase
    .channel('chat_messages_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      appendMessage(list, payload.new);
      scrollToBottom(list);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, (payload) => {
      updateMessage(list, payload.new);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_messages' }, (payload) => {
      removeMessage(list, payload.old.id);
    })
    .subscribe();
}

function setOpen(panel, toggle, open) {
  panel.classList.toggle('chat-panel--open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? '💬 Close Chat' : '💬 Open Chat';
}

function scrollToBottom(list) {
  list.scrollTop = list.scrollHeight;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function messageInnerHtml(m) {
  const username = escapeHtml(displayUsername(profilesById.get(m.user_id) ?? 'Unknown'));
  const canEdit = m.user_id === currentUserId;
  const canDelete = m.user_id === currentUserId || isAdmin;
  const editedTag = m.edited_at ? ' <span class="chat-message__edited">(edited)</span>' : '';
  const actionsHtml =
    canEdit || canDelete
      ? `
        <div class="chat-message__actions">
          ${canEdit ? `<button type="button" class="chat-message__action" data-action="edit">Edit</button>` : ''}
          ${canDelete ? `<button type="button" class="chat-message__action" data-action="delete">Delete</button>` : ''}
        </div>
      `
      : '';
  return `
    <div class="chat-message__meta">
      <strong>${username}</strong>
      <span class="chat-message__time">${escapeHtml(formatTime(m.created_at))}</span>${editedTag}
    </div>
    <div class="chat-message__body">${escapeHtml(m.message)}</div>
    ${actionsHtml}
  `;
}

function appendMessage(list, m) {
  if (list.querySelector(`[data-message-id="${m.id}"]`)) return;
  const el = document.createElement('div');
  el.className = 'chat-message';
  el.dataset.messageId = m.id;
  el.innerHTML = messageInnerHtml(m);
  wireMessageActions(el, m);
  list.appendChild(el);
}

function updateMessage(list, m) {
  const el = list.querySelector(`[data-message-id="${m.id}"]`);
  if (!el) return;
  el.innerHTML = messageInnerHtml(m);
  wireMessageActions(el, m);
}

function removeMessage(list, id) {
  list.querySelector(`[data-message-id="${id}"]`)?.remove();
}

function wireMessageActions(el, m) {
  el.querySelector('[data-action="edit"]')?.addEventListener('click', () => startEdit(el, m));
  el.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteMessage(m.id));
}

function startEdit(el, m) {
  const body = el.querySelector('.chat-message__body');
  const actions = el.querySelector('.chat-message__actions');
  const original = m.message;
  if (actions) actions.hidden = true;

  body.innerHTML = `
    <form class="chat-message__edit-form">
      <input type="text" class="chat-message__edit-input" maxlength="2000" value="${escapeHtml(original)}">
      <button type="submit" class="btn btn--small">Save</button>
      <button type="button" class="btn btn--secondary btn--small" data-action="cancel-edit">Cancel</button>
    </form>
  `;
  const editForm = body.querySelector('form');
  const editInput = body.querySelector('input');
  editInput.focus();
  editInput.setSelectionRange(editInput.value.length, editInput.value.length);

  const restore = () => {
    body.textContent = original;
    if (actions) actions.hidden = false;
  };
  body.querySelector('[data-action="cancel-edit"]').addEventListener('click', restore);

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newMessage = editInput.value.trim();
    if (!newMessage || newMessage === original) {
      restore();
      return;
    }
    const { error } = await supabase.from('chat_messages').update({ message: newMessage }).eq('id', m.id);
    if (error) {
      toast('Could not save your edit. Please try again.', 'error');
      restore();
      return;
    }
    // Realtime's UPDATE event re-renders this message with the
    // server-computed edited_at — nothing else to do on success.
  });
}

function deleteMessage(id) {
  if (!confirm('Delete this message? This cannot be undone.')) return;
  supabase
    .from('chat_messages')
    .delete()
    .eq('id', id)
    .then(({ error }) => {
      if (error) toast('Could not delete that message. Please try again.', 'error');
      // Realtime's DELETE event removes it from the DOM for everyone, including us.
    });
}
