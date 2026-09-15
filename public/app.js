import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

const appEl = document.getElementById('app');
const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const btnCollapse = document.getElementById('btn-collapse');
const paramsBody = document.getElementById('params-body');
const btnParamsCollapse = document.getElementById('btn-params-collapse');
const salaNav = document.getElementById('sala-nav');
const sidebarSearch = document.getElementById('sidebar-search');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const keyDialog = document.getElementById('key-dialog');
const keyForm = document.getElementById('key-form');
const keyInput = document.getElementById('api-key-input');
const keyError = document.getElementById('key-error');
const btnSettings = document.getElementById('btn-settings');
const btnNew = document.getElementById('btn-new');
const modelsDialog = document.getElementById('models-dialog');
const modelsSearch = document.getElementById('models-search');
const modelsList = document.getElementById('models-list');
const modelsStatus = document.getElementById('models-status');
const modelsCancel = document.getElementById('models-cancel');
const modelsConfirm = document.getElementById('models-confirm');
const deleteDialog = document.getElementById('delete-dialog');
const deleteForm = document.getElementById('delete-form');
const deleteCopy = document.getElementById('delete-copy');

const LANG_KEY = 'sophistai.language';
const MAX_MENTORS = 8;
const ROOM_HASH_RE = /^#\/c\/(\d+)$/;

const ICON_MENU = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>`;
const ICON_MORE = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5h.01M8 8h.01M8 12.5h.01" stroke-width="3"/></svg>`;
const ICON_SEND = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 8 3 3v4l6 1-6 1z"/></svg>`;
const ICON_EQ = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2v12M2 7h4M8 2v12M6 10h4M12 2v12M10 5h4"/></svg>`;

const state = {
  apiKeyConfigured: false,
  view: 'list',
  conversations: [],
  conversation: null,
  mentors: [],
  messages: [],
  roundCandidates: [],
  pendingCandidates: [],
  discardedCandidates: [],
  roomTab: 'conversation',
  draftTabId: null,
  loading: false,
  error: '',
  modelsCache: [],
  selectedModelIds: new Set(),
  modelsLoading: false,
  keyRequired: false,
  sidebarQuery: '',
  sidebarCollapsed: window.matchMedia('(max-width: 768px)').matches,
  paramsCollapsed: window.matchMedia('(max-width: 768px)').matches,
  composerDraft: '',
  deleteId: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

function wrapMarkdownTables(html) {
  return String(html).replace(
    /<table[\s\S]*?<\/table>/gi,
    (table) => `<div class="table-wrap">${table}</div>`
  );
}

function renderMarkdown(text) {
  const raw = marked.parse(String(text ?? ''), { async: false });
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['class'],
  });
  return wrapMarkdownTables(clean);
}

function isPending(candidate) {
  return candidate?.status === 'pending';
}

function hasPendingChoices(round = state.roundCandidates) {
  return (round || []).some(isPending);
}

function dateLocale() {
  return state.conversation?.language === 'en' ? 'en' : 'es';
}

function formatDate(iso) {
  try {
    return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString(
      dateLocale(),
      {
        dateStyle: 'short',
        timeStyle: 'short',
      }
    );
  } catch {
    return iso;
  }
}

function syncDocumentLang() {
  document.documentElement.lang =
    state.conversation?.language === 'en' ? 'en' : 'es';
}

function parseRoomHash() {
  const match = String(location.hash || '').match(ROOM_HASH_RE);
  return match ? Number(match[1]) : null;
}

function setRoomHash(id) {
  const next = `#/c/${id}`;
  if (location.hash !== next) {
    history.replaceState(null, '', next);
  }
}

function clearRoomHash() {
  if (location.hash) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
}

function languageLabel(lang) {
  return lang === 'en' ? 'EN' : 'ES';
}

function preferredLanguage() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'es') return stored;
  } catch {
    /* ignore */
  }
  return 'es';
}

function rememberLanguage(lang) {
  try {
    localStorage.setItem(LANG_KEY, lang === 'en' ? 'en' : 'es');
  } catch {
    /* ignore */
  }
}

function snapshotComposer() {
  const area = document.querySelector('#compose-form textarea');
  if (area) state.composerDraft = area.value;
}

function restoreComposer() {
  const area = document.querySelector('#compose-form textarea');
  if (area && state.composerDraft) {
    area.value = state.composerDraft;
    resizeComposer(area);
  }
}

function resizeComposer(area) {
  area.style.height = 'auto';
  const min = 33.6;
  area.style.height = `${Math.max(min, Math.min(area.scrollHeight, 192))}px`;
}

function isNarrow() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function inRoom() {
  return state.view === 'room' && Boolean(state.conversation);
}

function syncShell() {
  appEl.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  appEl.classList.toggle('params-collapsed', state.paramsCollapsed);
  appEl.classList.toggle('has-params', inRoom());
  const overlay =
    isNarrow() &&
    (!state.sidebarCollapsed || (inRoom() && !state.paramsCollapsed));
  sidebarBackdrop.hidden = !overlay;
}

function closeSidebar() {
  state.sidebarCollapsed = true;
  syncShell();
}

function openSidebar() {
  state.sidebarCollapsed = false;
  if (isNarrow()) state.paramsCollapsed = true;
  syncShell();
}

function toggleSidebar() {
  if (state.sidebarCollapsed) openSidebar();
  else closeSidebar();
}

function closeSidebarIfNarrow() {
  if (isNarrow()) closeSidebar();
}

function closeParams() {
  state.paramsCollapsed = true;
  syncShell();
}

function openParams() {
  state.paramsCollapsed = false;
  if (isNarrow()) state.sidebarCollapsed = true;
  syncShell();
}

function toggleParams() {
  if (state.paramsCollapsed) openParams();
  else closeParams();
}

const WORDMARK_HEAD = `<p class="wordmark wordmark-head" lang="el">σοφισταί</p>`;

function roomHeadMenuHtml() {
  return `
        <button type="button" class="btn ghost icon-only btn-menu" id="btn-menu" aria-label="Mostrar salas">
          ${ICON_MENU}
        </button>
        ${WORDMARK_HEAD}`;
}

async function refreshKeyStatus() {
  const data = await api('/api/settings/key');
  state.apiKeyConfigured = Boolean(data.configured);
  return state.apiKeyConfigured;
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations || [];
}

async function loadRoom(id, { keepDraft = false } = {}) {
  const data = await api(`/api/conversations/${id}`);
  state.conversation = data.conversation;
  state.mentors = data.mentors || [];
  state.messages = data.messages || [];
  state.roundCandidates = data.roundCandidates || data.pendingCandidates || [];
  state.pendingCandidates =
    data.pendingCandidates || state.roundCandidates.filter(isPending);
  state.discardedCandidates = data.discardedCandidates || [];
  state.view = 'room';
  state.roomTab = 'conversation';
  if (!keepDraft) state.composerDraft = '';
  const firstOpen = state.roundCandidates.find(isPending);
  state.draftTabId = (firstOpen || state.roundCandidates[0] || {}).id ?? null;
  setRoomHash(id);
}

async function createRoom() {
  const data = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Nueva sala',
      language: preferredLanguage(),
    }),
  });
  await loadConversations();
  await loadRoom(data.conversation.id, { keepDraft: true });
}

function openKeyDialog({ required = false } = {}) {
  keyError.hidden = true;
  keyError.textContent = '';
  keyInput.value = '';
  state.keyRequired = required;
  keyDialog.showModal();
}

keyDialog.addEventListener('cancel', (event) => {
  if (state.keyRequired && !state.apiKeyConfigured) {
    event.preventDefault();
  }
});

keyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  keyError.hidden = true;
  try {
    await api('/api/settings/key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey: keyInput.value }),
    });
    state.apiKeyConfigured = true;
    state.keyRequired = false;
    keyDialog.close();
    await boot();
  } catch (err) {
    keyError.textContent = err.message;
    keyError.hidden = false;
  }
});

btnSettings.addEventListener('click', () => openKeyDialog());

btnNew.addEventListener('click', async () => {
  if (!state.apiKeyConfigured) {
    openKeyDialog({ required: true });
    return;
  }
  try {
    state.error = '';
    await createRoom();
    closeSidebarIfNarrow();
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
});

sidebarSearch.addEventListener('input', () => {
  state.sidebarQuery = sidebarSearch.value;
  renderSidebar();
});

btnCollapse.addEventListener('click', closeSidebar);
btnParamsCollapse.addEventListener('click', closeParams);
sidebarBackdrop.addEventListener('click', () => {
  closeSidebar();
  closeParams();
});
syncShell();

modelsCancel.addEventListener('click', () => modelsDialog.close());

modelsSearch.addEventListener('input', () => renderModelsList());

modelsConfirm.addEventListener('click', async () => {
  if (!state.conversation) return;
  const selected = state.modelsCache.filter((m) =>
    state.selectedModelIds.has(m.id)
  );
  if (selected.length === 0) {
    modelsStatus.textContent = 'Selecciona al menos un modelo.';
    return;
  }
  if (selected.length > MAX_MENTORS) {
    modelsStatus.textContent = `Máximo ${MAX_MENTORS} mentores por sala.`;
    return;
  }

  const existingByModel = new Map(
    state.mentors.map((m) => [m.model_id, m.name])
  );

  const mentors = selected.map((m, index) => ({
    model_id: m.id,
    name: existingByModel.get(m.id) || defaultMentorName(m, index),
    sort_order: index,
  }));

  try {
    modelsStatus.textContent = 'Guardando…';
    const data = await api(
      `/api/conversations/${state.conversation.id}/mentors`,
      {
        method: 'PUT',
        body: JSON.stringify({ mentors }),
      }
    );
    state.mentors = data.mentors;
    if (data.discardedCandidates) {
      state.discardedCandidates = data.discardedCandidates;
    }
    modelsDialog.close();
    await loadRoom(state.conversation.id, { keepDraft: true });
    const pendingSend = state.composerDraft.trim();
    if (pendingSend && state.conversation && state.mentors.length > 0) {
      await sendTurn(pendingSend);
    } else {
      render();
    }
  } catch (err) {
    modelsStatus.textContent = err.message;
  }
});

deleteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = event.submitter?.value;
  if (value !== 'delete' || !state.deleteId) {
    state.deleteId = null;
    deleteDialog.close();
    return;
  }
  const id = state.deleteId;
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.conversation?.id === id) {
      state.view = 'list';
      state.conversation = null;
      state.mentors = [];
      state.messages = [];
      state.roundCandidates = [];
      state.pendingCandidates = [];
      state.discardedCandidates = [];
      clearRoomHash();
    }
    state.deleteId = null;
    deleteDialog.close();
    await loadConversations();
    render();
  } catch (err) {
    state.error = err.message;
    deleteDialog.close();
    render();
  }
});

function selectedModelCaption(mentor) {
  const id = String(mentor.model_id || '');
  const cached = state.modelsCache.find((x) => x.id === id);
  if (cached?.name && cached.name !== id) {
    return `${cached.name} · ${id}`;
  }
  return id;
}

function defaultMentorName(model, index) {
  const base = (model.name || model.id || `Mentor ${index + 1}`)
    .split(':')[0]
    .split('/')
    .pop();
  return base || `Mentor ${index + 1}`;
}

function formatPricing(pricing) {
  if (!pricing) return '';
  const prompt = pricing.prompt;
  const completion = pricing.completion;
  if (prompt == null && completion == null) return '';
  const p = Number(prompt);
  const c = Number(completion);
  if (p === 0 && c === 0) return 'Gratis';
  return `prompt ${prompt} · completion ${completion}`;
}

function renderModelsList() {
  const q = modelsSearch.value.trim().toLowerCase();
  const filtered = !q
    ? state.modelsCache
    : state.modelsCache.filter(
        (m) =>
          String(m.id).toLowerCase().includes(q) ||
          String(m.name).toLowerCase().includes(q)
      );

  if (state.modelsLoading) {
    modelsList.innerHTML = `<div class="pane-empty">Cargando…</div>`;
    return;
  }

  if (filtered.length === 0) {
    modelsList.innerHTML = `<div class="pane-empty">Nada que mostrar.</div>`;
    return;
  }

  modelsList.innerHTML = filtered
    .map((m) => {
      const checked = state.selectedModelIds.has(m.id) ? 'checked' : '';
      const atCap = state.selectedModelIds.size >= MAX_MENTORS;
      const disabled = !state.selectedModelIds.has(m.id) && atCap ? 'disabled' : '';
      const pricing = formatPricing(m.pricing);
      return `
        <label class="model-row">
          <input type="checkbox" data-model-id="${escapeHtml(m.id)}" ${checked} ${disabled} />
          <span class="meta">
            <span class="title">${escapeHtml(m.name || m.id)}</span>
            <span class="id">${escapeHtml(m.id)}</span>
            ${
              pricing
                ? `<span class="pricing">${escapeHtml(pricing)}</span>`
                : ''
            }
          </span>
        </label>
      `;
    })
    .join('');

  modelsList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.getAttribute('data-model-id');
      if (input.checked) {
        if (state.selectedModelIds.size >= MAX_MENTORS) {
          input.checked = false;
          modelsStatus.textContent = `Máximo ${MAX_MENTORS} mentores por sala.`;
          return;
        }
        state.selectedModelIds.add(id);
      } else {
        state.selectedModelIds.delete(id);
      }
      renderModelsList();
    });
  });
}

async function openModelsModal() {
  if (state.loading) return;
  if (!state.apiKeyConfigured) {
    openKeyDialog({ required: true });
    return;
  }
  if (
    state.roundCandidates.some(isPending)
  ) {
    state.error = 'Hay opiniones por revisar. Elige o pulsa Continuar.';
    render();
    return;
  }
  state.selectedModelIds = new Set(state.mentors.map((m) => m.model_id));
  modelsSearch.value = '';
  modelsStatus.textContent = '';
  state.modelsLoading = true;
  renderModelsList();
  modelsDialog.showModal();

  try {
    const data = await api('/api/models');
    state.modelsCache = data.models || [];
    modelsStatus.textContent = `${state.modelsCache.length} modelos`;
  } catch (err) {
    state.modelsCache = [];
    modelsStatus.textContent = err.message;
  } finally {
    state.modelsLoading = false;
    renderModelsList();
  }
}

function askDelete(conversation) {
  state.deleteId = conversation.id;
  deleteCopy.textContent = `Se eliminará «${conversation.title}».`;
  deleteDialog.showModal();
}

async function saveMentorName(mentorId, name) {
  const data = await api(
    `/api/conversations/${state.conversation.id}/mentors/${mentorId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }
  );
  const idx = state.mentors.findIndex((m) => m.id === mentorId);
  if (idx >= 0) state.mentors[idx] = data.mentor;
}

async function saveRoomMeta({ title, language }) {
  const c = state.conversation;
  const data = await api(`/api/conversations/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      title: title ?? c.title,
      language: language ?? c.language,
    }),
  });
  state.conversation = data.conversation;
  rememberLanguage(data.conversation.language);
  await loadConversations();
}

function composerDisabled() {
  return hasPendingChoices() || state.loading;
}

function composerHtml() {
  const disabled = composerDisabled() ? 'disabled' : '';
  return `
    <form id="compose-form" class="composer">
      <textarea name="content" rows="1" placeholder="Escribe…" ${disabled}></textarea>
      <button type="submit" class="btn primary icon-only" aria-label="Enviar" ${disabled}>
        ${ICON_SEND}
      </button>
    </form>
  `;
}

function bindComposer() {
  const form = document.getElementById('compose-form');
  const area = form?.querySelector('textarea');
  if (!form || !area) return;
  restoreComposer();
  area.addEventListener('input', () => {
    state.composerDraft = area.value;
    resizeComposer(area);
  });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', onComposeSubmit);
}

async function sendTurn(content) {
  state.error = '';
  state.loading = true;
  state.composerDraft = '';
  render();
  try {
    const data = await api(`/api/conversations/${state.conversation.id}/turns`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    state.messages = [...state.messages, data.userMessage];
    state.roundCandidates = data.roundCandidates || data.candidates || [];
    state.pendingCandidates =
      data.pendingCandidates || state.roundCandidates.filter(isPending);
    const firstOpen = state.roundCandidates.find(isPending);
    state.draftTabId = (firstOpen || state.roundCandidates[0] || {}).id ?? null;
    if (data.errors?.length) {
      state.error = data.errors
        .map((x) => `${x.mentor_name}: ${x.error}`)
        .join(' · ');
    }
    await loadConversations();
  } catch (err) {
    state.error = err.message;
    state.composerDraft = content;
    if (err.data?.pendingCandidates) {
      state.pendingCandidates = err.data.pendingCandidates;
    }
    if (err.data?.roundCandidates) {
      state.roundCandidates = err.data.roundCandidates;
    }
    if (err.data?.errors?.length) {
      state.error =
        err.message +
        ' · ' +
        err.data.errors.map((x) => `${x.mentor_name}: ${x.error}`).join(' · ');
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function onComposeSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const content = form.content.value.trim();
  if (!content) return;

  if (!state.apiKeyConfigured) {
    openKeyDialog({ required: true });
    return;
  }

  if (!state.conversation) {
    state.composerDraft = content;
    try {
      await createRoom();
      render();
      if (state.mentors.length === 0) openModelsModal();
      else await sendTurn(content);
    } catch (err) {
      state.error = err.message;
      render();
    }
    return;
  }
  if (state.mentors.length === 0) {
    state.composerDraft = content;
    openModelsModal();
    return;
  }

  await sendTurn(content);
}

function renderSidebar() {
  const q = state.sidebarQuery.trim().toLowerCase();
  const items = !q
    ? state.conversations
    : state.conversations.filter((c) =>
        String(c.title).toLowerCase().includes(q)
      );
  const activeId = state.conversation?.id;

  if (items.length === 0) {
    salaNav.innerHTML = `<div class="nav-empty">${
      state.conversations.length === 0 ? 'Sin salas' : 'Sin coincidencias'
    }</div>`;
    return;
  }

  salaNav.innerHTML = `<ul class="sala-list">
    ${items
      .map(
        (c) => `
      <li class="sala-item ${c.id === activeId ? 'is-active' : ''}">
        <button type="button" class="sala-open" data-open="${c.id}">
          <span class="title">${escapeHtml(c.title)}</span>
          <span class="meta">${languageLabel(c.language)} · ${escapeHtml(
            formatDate(c.updated_at)
          )}</span>
        </button>
        <button type="button" class="sala-more" data-delete="${c.id}" aria-label="Eliminar" ${
            state.loading && c.id === activeId ? 'disabled' : ''
          }>
          ${ICON_MORE}
        </button>
      </li>`
      )
      .join('')}
  </ul>`;

  salaNav.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.error = '';
        await loadRoom(Number(btn.getAttribute('data-open')));
        closeSidebarIfNarrow();
        render();
      } catch (err) {
        state.error = err.message;
        render();
      }
    });
  });

  salaNav.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = Number(btn.getAttribute('data-delete'));
      const conv = state.conversations.find((c) => c.id === id);
      if (conv) askDelete(conv);
    });
  });
}

function bindRoomHead() {
  document.getElementById('btn-menu')?.addEventListener('click', toggleSidebar);
  document.getElementById('btn-params')?.addEventListener('click', openParams);

  const title = document.getElementById('room-title');
  title?.addEventListener('change', async () => {
    try {
      await saveRoomMeta({ title: title.value });
      renderSidebar();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });
}

function bindParams() {
  document.getElementById('room-lang')?.addEventListener('change', async (e) => {
    try {
      await saveRoomMeta({ language: e.target.value });
      render();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  document.getElementById('btn-models')?.addEventListener('click', () => {
    openModelsModal();
  });

  document.getElementById('btn-discarded')?.addEventListener('click', () => {
    state.roomTab =
      state.roomTab === 'discarded' ? 'conversation' : 'discarded';
    render();
  });

  paramsBody.querySelectorAll('[data-mentor]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await saveMentorName(Number(input.getAttribute('data-mentor')), input.value);
      } catch (err) {
        state.error = err.message;
        render();
      }
    });
  });
}

function renderParams(hasPending) {
  const c = state.conversation;
  const busy = state.loading;
  const tab = state.roomTab || 'conversation';
  const discarded = state.discardedCandidates || [];
  const viewingDiscarded = tab === 'discarded';
  const discardedCopy = viewingDiscarded
    ? 'Estás viendo las opiniones que no entraron al hilo. Vuelve cuando quieras seguir la conversación.'
    : 'Las opiniones que no elegiste quedan aparte. Ábrelas para revisarlas sin mezclarlas con el hilo.';
  const discardedLabel = viewingDiscarded
    ? 'Volver'
    : `Ver descartadas${discarded.length ? ` (${discarded.length})` : ''}`;
  const chips =
    state.mentors.length === 0
      ? `<p class="hint-line">Elige modelos.</p>`
      : `<div class="mentor-chips">
          ${state.mentors
            .map(
              (m) => `
            <label class="chip">
              <input type="text" value="${escapeHtml(m.name)}" data-mentor="${m.id}" aria-label="Seudónimo" ${
                busy ? 'disabled' : ''
              } />
              <span class="chip-model">${escapeHtml(selectedModelCaption(m))}</span>
            </label>`
            )
            .join('')}
        </div>`;

  paramsBody.innerHTML = `
    <label class="params-field">
      Idioma
      <select id="room-lang" class="lang-select" ${busy ? 'disabled' : ''}>
        <option value="es" ${c.language === 'es' ? 'selected' : ''}>Español</option>
        <option value="en" ${c.language === 'en' ? 'selected' : ''}>Inglés</option>
      </select>
    </label>
    <div class="params-field">
      Mentores
      ${chips}
    </div>
    <button type="button" class="btn ghost btn-block" id="btn-models" ${
      hasPending || busy ? 'disabled' : ''
    }>Modelos</button>
    <hr class="params-rule" />
    <div class="params-field">
      <p class="params-copy">${discardedCopy}</p>
      <button type="button" class="btn ghost btn-block ${
        viewingDiscarded ? 'is-on' : ''
      }" id="btn-discarded">
        ${discardedLabel}
      </button>
    </div>
  `;
  bindParams();
}

function renderEmptyLanding() {
  main.innerHTML = `
    <div class="canvas">
      <header class="room-head is-bare">
        ${roomHeadMenuHtml()}
      </header>
      <div class="empty-canvas">
        <div class="inner">
          <p class="empty-prompt">¿Qué quieres preguntar o discutir hoy?</p>
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
          ${composerHtml()}
        </div>
      </div>
    </div>
  `;
  document.getElementById('btn-menu')?.addEventListener('click', toggleSidebar);
  bindComposer();
}

function councilHtml(round, hasPending) {
  if (!round.length) return '';
  const activeId =
    round.some((c) => c.id === state.draftTabId)
      ? state.draftTabId
      : round[0].id;
  const active = round.find((c) => c.id === activeId) || round[0];
  const selected = active.status === 'selected';
  const busy = state.loading ? 'disabled' : '';

  return `
    <section class="council">
      <div class="council-tabs" role="tablist">
        ${round
          .map(
            (cand) => `
          <button type="button" class="council-tab ${
            cand.id === active.id ? 'is-active' : ''
          } ${cand.status === 'selected' ? 'is-chosen' : ''}" data-draft="${cand.id}" role="tab">
            ${escapeHtml(cand.mentor_name)}
          </button>`
          )
          .join('')}
      </div>
      <div class="draft-body md">${renderMarkdown(active.content)}</div>
      <div class="council-actions">
        ${
          selected
            ? `<button type="button" class="btn brick small" data-unselect="${active.id}" ${busy}>Desmarcar</button>`
            : `<button type="button" class="btn primary small" data-select="${active.id}" ${busy}>Elegir</button>`
        }
        ${
          hasPending
            ? `<button type="button" class="btn ghost small" id="btn-dismiss" ${busy}>Continuar</button>`
            : ''
        }
      </div>
    </section>
  `;
}

function discardedHtml(discarded) {
  if (discarded.length === 0) {
    return `<div class="pane-empty">Nada descartado.</div>`;
  }
  const grouped = discarded.reduce((acc, cand) => {
    const key = String(cand.user_message_id);
    if (!acc[key]) acc[key] = { prompt: cand.user_prompt || '', items: [] };
    acc[key].items.push(cand);
    return acc;
  }, {});
  return `<div class="discarded-list">
    ${Object.values(grouped)
      .map(
        (group) => `
      <section class="discarded-group">
        <p class="discarded-prompt muted">${escapeHtml(
          group.prompt.length > 180
            ? `${group.prompt.slice(0, 180)}…`
            : group.prompt
        )}</p>
        ${group.items
          .map(
            (cand) => `
          <article class="discarded-item">
            <header>
              <strong>${escapeHtml(cand.mentor_name)}</strong>
              <span class="muted">${escapeHtml(cand.model_id)}</span>
            </header>
            <div class="body md">${renderMarkdown(cand.content)}</div>
          </article>`
          )
          .join('')}
      </section>`
      )
      .join('')}
  </div>`;
}

function bindCouncil(c) {
  main.querySelectorAll('[data-draft]').forEach((btn) => {
    btn.addEventListener('click', () => {
      snapshotComposer();
      state.draftTabId = Number(btn.getAttribute('data-draft'));
      render();
    });
  });

  main.querySelectorAll('[data-select]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.error = '';
        state.loading = true;
        snapshotComposer();
        render();
        const data = await api(`/api/conversations/${c.id}/select`, {
          method: 'POST',
          body: JSON.stringify({
            candidate_id: Number(btn.getAttribute('data-select')),
          }),
        });
        state.messages = data.messages;
        state.roundCandidates = data.roundCandidates || [];
        state.pendingCandidates =
          data.pendingCandidates || state.roundCandidates.filter(isPending);
        if (data.discardedCandidates) {
          state.discardedCandidates = data.discardedCandidates;
        }
        const still = state.roundCandidates.find(isPending);
        state.draftTabId = Number(btn.getAttribute('data-select'));
        if (!state.roundCandidates.some((x) => x.id === state.draftTabId) && still) {
          state.draftTabId = still.id;
        }
      } catch (err) {
        state.error = err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  });

  main.querySelectorAll('[data-unselect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.error = '';
        state.loading = true;
        snapshotComposer();
        render();
        const data = await api(`/api/conversations/${c.id}/unselect`, {
          method: 'POST',
          body: JSON.stringify({
            candidate_id: Number(btn.getAttribute('data-unselect')),
          }),
        });
        state.messages = data.messages;
        state.roundCandidates = data.roundCandidates || [];
        state.pendingCandidates =
          data.pendingCandidates || state.roundCandidates.filter(isPending);
        if (data.discardedCandidates) {
          state.discardedCandidates = data.discardedCandidates;
        }
        state.draftTabId = Number(btn.getAttribute('data-unselect'));
      } catch (err) {
        state.error = err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  });

  document.getElementById('btn-dismiss')?.addEventListener('click', async () => {
    try {
      state.error = '';
      state.loading = true;
      snapshotComposer();
      render();
      const data = await api(`/api/conversations/${c.id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      state.messages = data.messages || state.messages;
      state.roundCandidates = [];
      state.pendingCandidates = [];
      state.discardedCandidates = data.discardedCandidates || [];
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      render();
    }
  });
}

function renderRoomView() {
  const c = state.conversation;
  const tab = state.roomTab || 'conversation';
  const round = state.roundCandidates || [];
  const discarded = state.discardedCandidates || [];
  const hasPending = hasPendingChoices(round);
  const emptyThread = state.messages.length === 0 && round.length === 0;

  const messagesHtml = state.messages
    .map((msg) => {
      const who = msg.role === 'user' ? 'Tú' : msg.mentor_name || 'Mentor';
      const cls = msg.role === 'user' ? 'user' : 'mentor';
      return `<article class="msg ${cls}">
        <div class="who">${escapeHtml(who)}</div>
        <div class="body md">${renderMarkdown(msg.content)}</div>
      </article>`;
    })
    .join('');

  const threadBody =
    tab === 'discarded'
      ? discardedHtml(discarded)
      : emptyThread
        ? state.mentors.length === 0
          ? `<p class="hint-line">Elige modelos.</p>`
          : ''
        : `${messagesHtml}${
            state.loading ? `<p class="status-line">Consultando…</p>` : ''
          }${
            state.error
              ? `<p class="error">${escapeHtml(state.error)}</p>`
              : ''
          }${councilHtml(round, hasPending)}`;

  const showComposer = tab !== 'discarded';

  main.innerHTML = `
    <div class="canvas">
      <header class="room-head">
        ${roomHeadMenuHtml()}
        <input id="room-title" class="room-title" value="${escapeHtml(c.title)}" ${
          state.loading ? 'disabled' : ''
        } />
        <button type="button" class="btn ghost icon-only btn-params" id="btn-params" aria-label="Parámetros">
          ${ICON_EQ}
        </button>
      </header>
      <div class="thread" id="thread">
        <div class="thread-inner">
          ${
            tab === 'conversation' && emptyThread && state.error
              ? `<p class="error">${escapeHtml(state.error)}</p>`
              : ''
          }
          ${threadBody}
        </div>
      </div>
      ${
        showComposer
          ? `<div class="composer-dock">
              ${
                hasPending
                  ? `<p class="status-line warn">Elige o Continuar para seguir.</p>`
                  : ''
              }
              ${composerHtml()}
            </div>`
          : ''
      }
    </div>
  `;

  bindRoomHead();
  renderParams(hasPending);
  bindComposer();
  bindCouncil(c);

  const thread = document.getElementById('thread');
  if (thread && tab === 'conversation') {
    thread.scrollTop = thread.scrollHeight;
  }
}

function render() {
  renderSidebar();
  if (state.view === 'room' && state.conversation) {
    renderRoomView();
  } else {
    renderEmptyLanding();
  }
  syncDocumentLang();
  syncShell();
}

window.addEventListener('hashchange', async () => {
  const id = parseRoomHash();
  if (!id) {
    if (state.view === 'room') {
      state.view = 'list';
      state.conversation = null;
      state.mentors = [];
      state.messages = [];
      state.roundCandidates = [];
      state.pendingCandidates = [];
      state.discardedCandidates = [];
      render();
    }
    return;
  }
  if (state.conversation?.id === id) return;
  try {
    state.error = '';
    await loadRoom(id);
    render();
  } catch (err) {
    state.error = err.message;
    clearRoomHash();
    state.view = 'list';
    state.conversation = null;
    render();
  }
});

async function boot() {
  try {
    const ok = await refreshKeyStatus();
    await loadConversations();
    if (!ok) {
      openKeyDialog({ required: true });
    }
    const hashId = parseRoomHash();
    if (hashId) {
      try {
        await loadRoom(hashId);
      } catch (err) {
        clearRoomHash();
        state.view = 'list';
        state.error = err.message;
      }
    } else if (state.view === 'room' && state.conversation) {
      await loadRoom(state.conversation.id);
    } else {
      state.view = 'list';
    }
    render();
  } catch (err) {
    main.innerHTML = `<div class="empty-canvas"><p class="error">${escapeHtml(
      err.message
    )}</p></div>`;
  }
}

boot();
