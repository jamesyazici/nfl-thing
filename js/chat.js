// Family-wide live chat: one shared room, no DMs (spec follow-up).
// Realtime via Supabase's built-in Postgres Changes — no custom
// websocket code, no separate server. Writes go straight to
// chat_messages under RLS (own message to edit/delete, admins can
// delete anyone's) rather than through an Edge Function; the rules are
// simple enough that a policy is the right amount of machinery, not a
// server-side transaction like submit-picks needs.
//
// Consecutive messages from the same sender within GROUP_WINDOW_MS of
// the one before them render under one shared username/time header
// (spec follow-up) instead of repeating it per message. The whole list
// is kept as a plain in-memory array and fully re-rendered into groups
// on every insert/update/delete — simpler and less error-prone than
// incrementally patching group boundaries in the DOM, and cheap at the
// message volumes a family chat actually sees.
import { supabase } from './supabase-client.js';
import { escapeHtml, displayUsername, toast } from './utils.js';

const HISTORY_LIMIT = 100;
const GROUP_WINDOW_MS = 15 * 60 * 1000;

// Must match the min-width in styles.css's desktop chat rules — above
// this, the panel is always visible (a permanent sidebar), so there's no
// such thing as "unread" there.
const DESKTOP_BREAKPOINT = '(min-width: 1400px)';

let profilesById = new Map();
let currentUserId = null;
let isAdmin = false;
let unreadCount = 0;
let messages = []; // ordered oldest -> newest

export async function init(state) {
  const toggle = document.getElementById('chat-toggle');
  const toggleLabel = document.getElementById('chat-toggle-label');
  const badge = document.getElementById('chat-unread-badge');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const list = document.getElementById('chat-messages');
  if (!toggle || !toggleLabel || !panel || !closeBtn || !form || !input || !list) return;

  currentUserId = state.session.user.id;
  isAdmin = !!state.profile?.is_admin;

  const isVisible = () => window.matchMedia(DESKTOP_BREAKPOINT).matches || panel.classList.contains('chat-panel--open');

  toggle.addEventListener('click', () => setOpen(panel, toggle, toggleLabel, badge, !panel.classList.contains('chat-panel--open')));
  closeBtn.addEventListener('click', () => setOpen(panel, toggle, toggleLabel, badge, false));

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

  const [{ data: profiles }, { data: history }] = await Promise.all([
    supabase.from('profiles').select('id, username'),
    supabase
      .from('chat_messages')
      .select('id, user_id, message, created_at, edited_at')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  profilesById = new Map((profiles ?? []).map((p) => [p.id, p.username]));

  messages = (history ?? []).slice().reverse();
  renderAll(list);
  scrollToBottom(list);

  supabase
    .channel('chat_messages_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      if (messages.some((m) => m.id === payload.new.id)) return;
      messages.push(payload.new);
      renderAll(list);
      scrollToBottom(list);
      // Someone else's message arriving while the panel isn't actually
      // visible (mobile, closed) — flag it on the toggle. Our own
      // messages never count as unread.
      if (payload.new.user_id !== currentUserId && !isVisible()) {
        setUnread(badge, unreadCount + 1);
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, (payload) => {
      const i = messages.findIndex((m) => m.id === payload.new.id);
      if (i === -1) return;
      messages[i] = payload.new;
      renderAll(list);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_messages' }, (payload) => {
      messages = messages.filter((m) => m.id !== payload.old.id);
      renderAll(list);
    })
    .subscribe();
}

function setOpen(panel, toggle, toggleLabel, badge, open) {
  panel.classList.toggle('chat-panel--open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggleLabel.textContent = open ? 'Close Chat' : 'Open Chat';
  if (open) setUnread(badge, 0);
}

function setUnread(badge, count) {
  unreadCount = count;
  badge.hidden = count <= 0;
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.closest('.chat-toggle')?.classList.toggle('chat-toggle--unread', count > 0);
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

// Rebuilds the whole message list as visual groups: a shared
// username/time header per run of same-sender messages that are each
// within GROUP_WINDOW_MS of the previous one (a rolling gap, not a fixed
// window from the group's start — three messages 14 minutes apart each
// all group together even though the first and last are 28 minutes
// apart). The header's time is always the group's LATEST message, so it
// keeps advancing as more messages land in it. Editing never changes
// grouping — only created_at does; edited_at is unrelated.
function renderAll(list) {
  const scrollTop = list.scrollTop;
  list.innerHTML = '';

  let groupEl = null;
  let groupUserId = null;
  let groupTimeMs = null;

  for (const m of messages) {
    const msgTimeMs = new Date(m.created_at).getTime();
    const sameGroup = groupEl && groupUserId === m.user_id && msgTimeMs - groupTimeMs <= GROUP_WINDOW_MS;

    if (!sameGroup) {
      groupEl = document.createElement('div');
      groupEl.className = 'chat-group';
      const username = escapeHtml(displayUsername(profilesById.get(m.user_id) ?? 'Unknown'));
      groupEl.innerHTML = `
        <div class="chat-group__meta">
          <strong>${username}</strong>
          <span data-role="group-time" class="chat-group__time"></span>
        </div>
        <div data-role="group-messages" class="chat-group__messages"></div>
      `;
      list.appendChild(groupEl);
      groupUserId = m.user_id;
    }
    groupTimeMs = msgTimeMs;
    groupEl.querySelector('[data-role="group-time"]').textContent = formatTime(m.created_at);

    const row = document.createElement('div');
    row.className = 'chat-message';
    row.dataset.messageId = m.id;
    row.innerHTML = messageRowHtml(m);
    wireMessageActions(row, m);
    groupEl.querySelector('[data-role="group-messages"]').appendChild(row);
  }

  list.scrollTop = scrollTop;
}

function messageRowHtml(m) {
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
    <div class="chat-message__body">${escapeHtml(m.message)}${editedTag}</div>
    ${actionsHtml}
  `;
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
    // Realtime's UPDATE event re-renders the whole list with the
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
      // Realtime's DELETE event removes it for everyone, including us.
    });
}
