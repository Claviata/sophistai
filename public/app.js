import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

const main = document.getElementById('main');
const keyDialog = document.getElementById('key-dialog');
const keyForm = document.getElementById('key-form');
const keyInput = document.getElementById('api-key-input');
const keyError = document.getElementById('key-error');
const btnSettings = document.getElementById('btn-settings');
const modelsDialog = document.getElementById('models-dialog');
const modelsSearch = document.getElementById('models-search');
const modelsList = document.getElementById('models-list');
const modelsStatus = document.getElementById('models-status');
const modelsCancel = document.getElementById('models-cancel');
const modelsConfirm = document.getElementById('models-confirm');

const state = {
  apiKeyConfigured: false,
  view: 'list', // list | room
  conversations: [],
  conversation: null,
  mentors: [],
  messages: [],
  roundCandidates: [],
  pendingCandidates: [],
  discardedCandidates: [],
  roomTab: 'conversation', // conversation | discarded
  loading: false,
  error: '',
  modelsCache: [],
  selectedModelIds: new Set(),
  modelsLoading: false,
  keyRequired: false,
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

function formatDate(iso) {
  try {
    return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString('es');
  } catch {
    return iso;
  }
}

function languageLabel(lang) {
  return lang === 'en' ? 'Inglés' : 'Español';
}

async function refreshKeyStatus() {
  const data = await api('/api/settings/key');
  state.apiKeyConfigured = Boolean(data.configured);
  btnSettings.hidden = false;
  return state.apiKeyConfigured;
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations || [];
}

async function loadRoom(id) {
  const data = await api(`/api/conversations/${id}`);
  state.conversation = data.conversation;
  state.mentors = data.mentors || [];
  state.messages = data.messages || [];
  state.roundCandidates = data.roundCandidates || data.pendingCandidates || [];
  state.pendingCandidates =
    data.pendingCandidates ||
    state.roundCandidates.filter(
      (c) => c.status === 'pending' || c.status === 'rejected'
    );
  state.discardedCandidates = data.discardedCandidates || [];
  state.view = 'room';
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

  const existingByModel = new Map(
    state.mentors.map((m) => [m.model_id, m.name])
  );

  const mentors = selected.map((m, index) => ({
    model_id: m.id,
    name: existingByModel.get(m.id) || defaultMentorName(m, index),
    sort_order: index,
  }));

  try {
    modelsStatus.textContent = 'Guardando mentores…';
    const data = await api(
      `/api/conversations/${state.conversation.id}/mentors`,
      {
        method: 'PUT',
        body: JSON.stringify({ mentors }),
      }
    );
    state.mentors = data.mentors;
    state.roundCandidates = [];
    state.pendingCandidates = [];
    state.discardedCandidates = state.discardedCandidates || [];
    modelsDialog.close();
    render();
  } catch (err) {
    modelsStatus.textContent = err.message;
  }
});

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
    modelsList.innerHTML = `<div class="empty">Cargando modelos…</div>`;
    return;
  }

  if (filtered.length === 0) {
    modelsList.innerHTML = `<div class="empty">No hay modelos para mostrar.</div>`;
    return;
  }

  modelsList.innerHTML = filtered
    .map((m) => {
      const checked = state.selectedModelIds.has(m.id) ? 'checked' : '';
      const pricing = formatPricing(m.pricing);
      return `
        <label class="model-row">
          <input type="checkbox" data-model-id="${escapeHtml(m.id)}" ${checked} />
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
      if (input.checked) state.selectedModelIds.add(id);
      else state.selectedModelIds.delete(id);
    });
  });
}

async function openModelsModal() {
  if (!state.apiKeyConfigured) {
    openKeyDialog({ required: true });
    return;
  }
  if (
    state.roundCandidates.some(
      (c) => c.status === 'pending' || c.status === 'rejected'
    )
  ) {
    state.error =
      'Hay opiniones por revisar. Selecciona las que quieras o pulsa Continuar.';
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

function renderListView() {
  const items =
    state.conversations.length === 0
      ? `<div class="empty">Aún no hay salas. Crea la primera.</div>`
      : `<ul class="conversation-list">
          ${state.conversations
            .map(
              (c) => `
            <li>
              <button type="button" class="item" data-open="${c.id}">
                <span class="item-title">${escapeHtml(c.title)}</span>
                <span class="item-meta">${languageLabel(c.language)} · ${escapeHtml(
                  formatDate(c.updated_at)
                )}</span>
              </button>
            </li>`
            )
            .join('')}
        </ul>`;

  main.innerHTML = `
    <section class="panel stack">
      <div class="row spread">
        <div>
          <h2 class="section-title">Tus salas</h2>
          <p class="hint">Cada sala es un consejo de mentores que escuchan juntos.</p>
        </div>
        <button type="button" class="btn primary" id="btn-new">Nueva sala</button>
      </div>
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
      ${items}
    </section>
  `;

  document.getElementById('btn-new')?.addEventListener('click', () => {
    renderCreateForm();
  });

  main.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.error = '';
        await loadRoom(Number(btn.getAttribute('data-open')));
        render();
      } catch (err) {
        state.error = err.message;
        render();
      }
    });
  });
}

function renderCreateForm() {
  main.innerHTML = `
    <section class="panel stack">
      <h2 class="section-title">Nueva sala</h2>
      <p class="hint">Elige el idioma de la conversación. Los system prompts de los mentores siempre van en inglés.</p>
      <form id="create-form" class="stack">
        <label>
          Título
          <input type="text" name="title" value="Nueva sala" required />
        </label>
        <label>
          Idioma de la conversación
          <select name="language">
            <option value="es" selected>Español</option>
            <option value="en">Inglés</option>
          </select>
        </label>
        <div class="row">
          <button type="button" class="btn ghost" id="btn-cancel-create">Cancelar</button>
          <button type="submit" class="btn primary">Crear</button>
        </div>
        <p class="error" id="create-error" hidden></p>
      </form>
    </section>
  `;

  document.getElementById('btn-cancel-create')?.addEventListener('click', () => {
    state.view = 'list';
    render();
  });

  document.getElementById('create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errEl = document.getElementById('create-error');
    errEl.hidden = true;
    try {
      const data = await api('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title.value,
          language: form.language.value,
        }),
      });
      await loadRoom(data.conversation.id);
      render();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
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

function renderRoomView() {
  const c = state.conversation;
  const tab = state.roomTab || 'conversation';
  const round = state.roundCandidates || [];
  const discarded = state.discardedCandidates || [];
  const openChoices = round.filter(
    (x) => x.status === 'pending' || x.status === 'rejected'
  );
  const hasPending = openChoices.length > 0;
  const hasRound = round.length > 0;

  const mentorsHtml =
    state.mentors.length === 0
      ? `<div class="empty">Todavía no hay mentores. Elige modelos para la sala.</div>`
      : state.mentors
          .map(
            (m) => `
        <div class="mentor-card" data-mentor="${m.id}">
          <label>
            Seudónimo
            <input type="text" class="mentor-name" value="${escapeHtml(m.name)}" />
          </label>
          <div class="model-id">${escapeHtml(m.model_id)}</div>
        </div>`
          )
          .join('');

  const messagesHtml =
    state.messages.length === 0
      ? `<div class="empty">La sala está en silencio. Empieza la conversación.</div>`
      : `<div class="messages">
          ${state.messages
            .map((msg) => {
              const who =
                msg.role === 'user' ? 'Tú' : msg.mentor_name || 'Mentor';
              const cls = msg.role === 'user' ? 'user' : 'mentor';
              return `<article class="bubble ${cls}">
                <div class="who">${escapeHtml(who)}</div>
                <div class="body md">${renderMarkdown(msg.content)}</div>
              </article>`;
            })
            .join('')}
        </div>`;

  const candidatesHtml = !hasRound
    ? ''
    : `
      <section class="stack">
        <h3 class="section-title">Opiniones del consejo</h3>
        <p class="hint">Puedes elegir una o varias. Las no elegidas pasan a Descartadas al continuar.</p>
        <div class="candidates">
          ${round
            .map((cand) => {
              const selected = cand.status === 'selected';
              return `
            <article class="candidate ${selected ? 'is-selected' : ''}">
              <header>
                <div>
                  <div class="name">${escapeHtml(cand.mentor_name)}</div>
                  <div class="model">${escapeHtml(cand.model_id)}</div>
                </div>
                ${
                  selected
                    ? `<span class="badge chosen">Elegida</span>`
                    : `<button type="button" class="btn primary small" data-select="${cand.id}">
                        Elegir esta
                      </button>`
                }
              </header>
              <div class="body md">${renderMarkdown(cand.content)}</div>
            </article>`;
            })
            .join('')}
        </div>
        ${
          hasPending
            ? `<div class="row">
                <button type="button" class="btn ghost" id="btn-dismiss">
                  Continuar sin elegir más
                </button>
              </div>`
            : ''
        }
      </section>`;

  const discardedGrouped = discarded.reduce((acc, cand) => {
    const key = String(cand.user_message_id);
    if (!acc[key]) acc[key] = { prompt: cand.user_prompt || '', items: [] };
    acc[key].items.push(cand);
    return acc;
  }, {});

  const discardedHtml =
    discarded.length === 0
      ? `<div class="empty">No hay opiniones descartadas todavía.</div>`
      : `<div class="stack discarded-list">
          ${Object.entries(discardedGrouped)
            .map(
              ([, group]) => `
            <section class="discarded-group stack">
              <p class="discarded-prompt muted">
                <strong>Ante:</strong> ${escapeHtml(
                  group.prompt.length > 180
                    ? `${group.prompt.slice(0, 180)}…`
                    : group.prompt
                )}
              </p>
              <div class="candidates">
                ${group.items
                  .map(
                    (cand) => `
                  <article class="candidate is-discarded">
                    <header>
                      <div>
                        <div class="name">${escapeHtml(cand.mentor_name)}</div>
                        <div class="model">${escapeHtml(cand.model_id)}</div>
                      </div>
                      <span class="badge">Solo lectura</span>
                    </header>
                    <div class="body md">${renderMarkdown(cand.content)}</div>
                  </article>`
                  )
                  .join('')}
              </div>
            </section>`
            )
            .join('')}
        </div>`;

  const conversationPanel = `
      <div class="panel stack">
        ${messagesHtml}
        ${
          state.loading
            ? `<div class="status-banner">Consultando mentores…</div>`
            : ''
        }
        ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
        ${candidatesHtml}
        <form id="compose-form" class="composer">
          <label>
            Tu intervención
            <textarea name="content" placeholder="Habla con el consejo…" ${
              hasPending || state.loading || state.mentors.length === 0
                ? 'disabled'
                : ''
            } required></textarea>
          </label>
          <div class="row">
            <button type="submit" class="btn primary" ${
              hasPending || state.loading || state.mentors.length === 0
                ? 'disabled'
                : ''
            }>
              Enviar al consejo
            </button>
          </div>
          ${
            hasPending
              ? `<div class="status-banner warn">Selecciona una o más opiniones, o Continuar para cerrar la ronda.</div>`
              : ''
          }
        </form>
      </div>`;

  const discardedPanel = `
      <div class="panel stack">
        <p class="hint">Archivo de opiniones no elegidas. Solo lectura; no se reintroducen al hilo.</p>
        ${discardedHtml}
      </div>`;

  main.innerHTML = `
    <section class="stack">
      <div class="row spread">
        <button type="button" class="btn ghost" id="btn-back">← Salas</button>
        <span class="badge">${languageLabel(c.language)}</span>
      </div>

      <div class="panel stack">
        <div class="row spread">
          <div>
            <h2 class="section-title">${escapeHtml(c.title)}</h2>
            <p class="hint">Mentores en la sala</p>
          </div>
          <div class="row">
            <button type="button" class="btn ghost" id="btn-models" ${
              hasPending ? 'disabled' : ''
            }>Elegir modelos</button>
            <button type="button" class="btn danger small" id="btn-delete">Eliminar</button>
          </div>
        </div>
        <form id="meta-form" class="row">
          <label style="flex:1;min-width:12rem">
            Título
            <input type="text" name="title" value="${escapeHtml(c.title)}" required />
          </label>
          <label>
            Idioma
            <select name="language">
              <option value="es" ${c.language === 'es' ? 'selected' : ''}>Español</option>
              <option value="en" ${c.language === 'en' ? 'selected' : ''}>Inglés</option>
            </select>
          </label>
          <button type="submit" class="btn ghost small">Guardar</button>
        </form>
        <div class="stack">${mentorsHtml}</div>
      </div>

      <div class="tabs" role="tablist">
        <button type="button" class="tab ${
          tab === 'conversation' ? 'active' : ''
        }" data-tab="conversation" role="tab">
          Conversación
        </button>
        <button type="button" class="tab ${
          tab === 'discarded' ? 'active' : ''
        }" data-tab="discarded" role="tab">
          Descartadas${
            discarded.length ? ` (${discarded.length})` : ''
          }
        </button>
      </div>

      ${tab === 'discarded' ? discardedPanel : conversationPanel}
    </section>
  `;

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.roomTab = btn.getAttribute('data-tab');
      render();
    });
  });

  document.getElementById('btn-back')?.addEventListener('click', async () => {
    state.view = 'list';
    state.conversation = null;
    state.roomTab = 'conversation';
    await loadConversations();
    render();
  });

  document.getElementById('btn-models')?.addEventListener('click', () => {
    openModelsModal();
  });

  document.getElementById('meta-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      state.error = '';
      const data = await api(`/api/conversations/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: form.title.value,
          language: form.language.value,
        }),
      });
      state.conversation = data.conversation;
      render();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  document.getElementById('btn-delete')?.addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta sala?')) return;
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    state.view = 'list';
    state.conversation = null;
    await loadConversations();
    render();
  });

  main.querySelectorAll('.mentor-card').forEach((card) => {
    const mentorId = Number(card.getAttribute('data-mentor'));
    const input = card.querySelector('.mentor-name');
    input?.addEventListener('change', async () => {
      try {
        await saveMentorName(mentorId, input.value);
      } catch (err) {
        state.error = err.message;
        render();
      }
    });
  });

  main.querySelectorAll('[data-select]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.error = '';
        state.loading = true;
        render();
        const data = await api(`/api/conversations/${c.id}/select`, {
          method: 'POST',
          body: JSON.stringify({ candidate_id: Number(btn.getAttribute('data-select')) }),
        });
        state.messages = data.messages;
        state.roundCandidates = data.roundCandidates || [];
        state.pendingCandidates =
          data.pendingCandidates ||
          state.roundCandidates.filter(
            (x) => x.status === 'pending' || x.status === 'rejected'
          );
        if (data.discardedCandidates) {
          state.discardedCandidates = data.discardedCandidates;
        }
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

  document.getElementById('compose-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const content = form.content.value.trim();
    if (!content) return;
    try {
      state.error = '';
      state.loading = true;
      render();
      const data = await api(`/api/conversations/${c.id}/turns`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      state.messages = [...state.messages, data.userMessage];
      state.roundCandidates = data.roundCandidates || data.candidates || [];
      state.pendingCandidates =
        data.pendingCandidates ||
        state.roundCandidates.filter(
          (x) => x.status === 'pending' || x.status === 'rejected'
        );
      if (data.errors?.length) {
        state.error = data.errors
          .map((x) => `${x.mentor_name}: ${x.error}`)
          .join(' · ');
      }
    } catch (err) {
      state.error = err.message;
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
  });
}

function render() {
  if (state.view === 'room' && state.conversation) {
    renderRoomView();
  } else {
    renderListView();
  }
}

async function boot() {
  try {
    const ok = await refreshKeyStatus();
    if (!ok) {
      openKeyDialog({ required: true });
      main.innerHTML = `
        <section class="panel">
          <h2 class="section-title">Bienvenido a Sofistai</h2>
          <p class="hint">Configura tu API key de OpenRouter para empezar.</p>
        </section>`;
      return;
    }
    await loadConversations();
    if (state.view === 'room' && state.conversation) {
      await loadRoom(state.conversation.id);
    } else {
      state.view = 'list';
    }
    render();
  } catch (err) {
    main.innerHTML = `<section class="panel"><p class="error">${escapeHtml(
      err.message
    )}</p></section>`;
  }
}

boot();
