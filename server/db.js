import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MENTORS } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath =
  process.env.SOPHISTAI_DB_PATH || path.join(dataDir, 'sophistai.sqlite');
const legacyDbPath = path.join(dataDir, 'sofistai.sqlite');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function adoptLegacyDbFile(fromPath, toPath) {
  if (fs.existsSync(toPath) || !fs.existsSync(fromPath)) return;
  fs.renameSync(fromPath, toPath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const fromSide = `${fromPath}${suffix}`;
    const toSide = `${toPath}${suffix}`;
    if (fs.existsSync(fromSide) && !fs.existsSync(toSide)) {
      fs.renameSync(fromSide, toSide);
    }
  }
}

if (!process.env.SOPHISTAI_DB_PATH) {
  adoptLegacyDbFile(legacyDbPath, dbPath);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function ensureColumn(table, column, definition) {
  // table/column identifiers are hardcoded at call sites, never request input
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Nueva sala',
    language TEXT NOT NULL DEFAULT 'es' CHECK (language IN ('es', 'en')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mentors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'mentor')),
    mentor_id INTEGER REFERENCES mentors(id) ON DELETE SET NULL,
    speaker_name TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentor_id INTEGER REFERENCES mentors(id) ON DELETE SET NULL,
    mentor_name TEXT NOT NULL DEFAULT 'Mentor',
    model_id TEXT,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'selected', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mentors_conversation ON mentors(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_conversation ON candidates(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_user_message ON candidates(user_message_id);
`);

ensureColumn('messages', 'speaker_name', 'TEXT');

const CANDIDATE_COLUMNS = `
  c.id, c.conversation_id, c.user_message_id, c.mentor_id, c.message_id,
  c.content, c.status, c.created_at,
  COALESCE(c.mentor_name, mentors.name, 'Mentor') AS mentor_name,
  COALESCE(c.model_id, mentors.model_id) AS model_id
`;

const CANDIDATE_FROM = `
  FROM candidates c
  LEFT JOIN mentors ON mentors.id = c.mentor_id
`;

const CANDIDATE_SELECT = `SELECT ${CANDIDATE_COLUMNS} ${CANDIDATE_FROM}`;

function candidatesNeedRebuild() {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidates'`
    )
    .get();
  if (!row?.sql) return false;
  const info = db.prepare(`PRAGMA table_info(candidates)`).all();
  const names = new Set(info.map((c) => c.name));
  if (!names.has('mentor_name') || !names.has('model_id') || !names.has('message_id')) {
    return true;
  }
  if (row.sql.includes("'rejected'")) return true;
  const mentorCol = info.find((c) => c.name === 'mentor_id');
  if (mentorCol && mentorCol.notnull === 1) return true;
  return false;
}

function migrateCandidatesSchema() {
  if (!candidatesNeedRebuild()) return;

  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE candidates_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          mentor_id INTEGER REFERENCES mentors(id) ON DELETE SET NULL,
          mentor_name TEXT NOT NULL DEFAULT 'Mentor',
          model_id TEXT,
          message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'selected', 'dismissed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO candidates_new
          (id, conversation_id, user_message_id, mentor_id, mentor_name, model_id,
           message_id, content, status, created_at)
        SELECT
          c.id,
          c.conversation_id,
          c.user_message_id,
          c.mentor_id,
          COALESCE(m.name, 'Mentor'),
          m.model_id,
          NULL,
          c.content,
          CASE c.status WHEN 'rejected' THEN 'dismissed' ELSE c.status END,
          c.created_at
        FROM candidates c
        LEFT JOIN mentors m ON m.id = c.mentor_id;
        DROP TABLE candidates;
        ALTER TABLE candidates_new RENAME TO candidates;
        CREATE INDEX IF NOT EXISTS idx_candidates_conversation ON candidates(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_candidates_user_message ON candidates(user_message_id);
      `);

      const selected = db
        .prepare(
          `SELECT id, conversation_id, mentor_id, content
           FROM candidates WHERE status = 'selected'`
        )
        .all();
      const findMsg = db.prepare(
        `SELECT id FROM messages
         WHERE conversation_id = ?
           AND role = 'mentor'
           AND mentor_id IS ?
           AND content = ?
         ORDER BY id DESC
         LIMIT 1`
      );
      const setMsg = db.prepare(
        `UPDATE candidates SET message_id = ? WHERE id = ?`
      );
      for (const c of selected) {
        const msg = findMsg.get(c.conversation_id, c.mentor_id, c.content);
        if (msg) setMsg.run(msg.id, c.id);
      }
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

migrateCandidatesSchema();

export function sweepOrphanUserMessages() {
  db.prepare(
    `DELETE FROM messages
     WHERE role = 'user'
       AND id NOT IN (SELECT user_message_id FROM candidates)`
  ).run();
}

sweepOrphanUserMessages();

export function touchConversation(id) {
  db.prepare(
    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

export function getConversation(id) {
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
}

export function listConversations() {
  return db
    .prepare(
      `SELECT id, title, language, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`
    )
    .all();
}

export function createConversation({ title = 'Nueva sala', language = 'es' } = {}) {
  const lang = language === 'en' ? 'en' : 'es';
  const nextTitle = String(title ?? '').trim() || 'Nueva sala';
  const result = db
    .prepare(`INSERT INTO conversations (title, language) VALUES (?, ?)`)
    .run(nextTitle, lang);
  return getConversation(result.lastInsertRowid);
}

export function updateConversation(id, { title, language } = {}) {
  const current = getConversation(id);
  if (!current) return null;
  const nextTitle =
    title !== undefined ? String(title).trim() || current.title : current.title;
  const nextLang =
    language !== undefined
      ? language === 'en'
        ? 'en'
        : 'es'
      : current.language;
  db.prepare(
    `UPDATE conversations
     SET title = ?, language = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextTitle, nextLang, id);
  return getConversation(id);
}

export function deleteConversation(id) {
  return db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function getMentors(conversationId) {
  return db
    .prepare(
      `SELECT id, conversation_id, name, model_id, sort_order
       FROM mentors
       WHERE conversation_id = ?
       ORDER BY sort_order ASC, id ASC`
    )
    .all(conversationId);
}

export function normalizeMentorInput(mentors) {
  const seen = new Set();
  const out = [];
  for (const m of mentors || []) {
    const model_id = String(m?.model_id || '').trim();
    if (!model_id || seen.has(model_id)) continue;
    seen.add(model_id);
    out.push({
      model_id,
      name: m.name,
      sort_order: m.sort_order,
    });
  }
  return out;
}

export function replaceMentors(conversationId, mentors) {
  const items = normalizeMentorInput(mentors);
  if (items.length > MAX_MENTORS) {
    throw Object.assign(new Error(`Máximo ${MAX_MENTORS} mentores por sala`), {
      status: 400,
    });
  }
  const replace = db.transaction((nextItems) => {
    const existing = getMentors(conversationId);
    const keep = new Set(nextItems.map((m) => m.model_id));
    const del = db.prepare(`DELETE FROM mentors WHERE id = ?`);
    for (const m of existing) {
      if (!keep.has(m.model_id)) del.run(m.id);
    }

    const insert = db.prepare(
      `INSERT INTO mentors (conversation_id, name, model_id, sort_order)
       VALUES (?, ?, ?, ?)`
    );
    const update = db.prepare(
      `UPDATE mentors SET name = ?, sort_order = ? WHERE id = ?`
    );
    const remaining = new Map(
      getMentors(conversationId).map((m) => [m.model_id, m])
    );

    nextItems.forEach((m, index) => {
      const name = String(m.name || `Mentor ${index + 1}`).trim() || `Mentor ${index + 1}`;
      const sort = Number.isFinite(m.sort_order) ? m.sort_order : index;
      const found = remaining.get(m.model_id);
      if (found) update.run(name, sort, found.id);
      else insert.run(conversationId, name, m.model_id, sort);
    });

    touchConversation(conversationId);
    return getMentors(conversationId);
  });
  return replace(items);
}

export function updateMentorName(mentorId, conversationId, name) {
  const result = db
    .prepare(
      `UPDATE mentors SET name = ?
       WHERE id = ? AND conversation_id = ?`
    )
    .run(String(name).trim(), mentorId, conversationId);
  if (result.changes === 0) return null;
  return db.prepare(`SELECT * FROM mentors WHERE id = ?`).get(mentorId);
}

export function deleteMessage(messageId, conversationId) {
  return db
    .prepare(`DELETE FROM messages WHERE id = ? AND conversation_id = ?`)
    .run(messageId, conversationId);
}

export function getMessages(conversationId) {
  return db
    .prepare(
      `SELECT m.id, m.conversation_id, m.role, m.mentor_id, m.content, m.created_at,
              COALESCE(m.speaker_name, mentors.name) AS mentor_name
       FROM messages m
       LEFT JOIN mentors ON mentors.id = m.mentor_id
       WHERE m.conversation_id = ?
       ORDER BY m.id ASC`
    )
    .all(conversationId);
}

export function insertUserMessage(conversationId, content) {
  const result = db
    .prepare(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES (?, 'user', ?)`
    )
    .run(conversationId, content);
  touchConversation(conversationId);
  return db
    .prepare(
      `SELECT id, conversation_id, role, mentor_id, content, created_at
       FROM messages WHERE id = ?`
    )
    .get(result.lastInsertRowid);
}

export function insertMentorMessage(conversationId, mentorId, content) {
  const mentor = db
    .prepare(`SELECT name FROM mentors WHERE id = ?`)
    .get(mentorId);
  const speakerName = mentor?.name || 'Mentor';
  const result = db
    .prepare(
      `INSERT INTO messages (conversation_id, role, mentor_id, speaker_name, content)
       VALUES (?, 'mentor', ?, ?, ?)`
    )
    .run(conversationId, mentorId, speakerName, content);
  touchConversation(conversationId);
  return db
    .prepare(
      `SELECT m.id, m.conversation_id, m.role, m.mentor_id, m.content, m.created_at,
              COALESCE(m.speaker_name, mentors.name) AS mentor_name
       FROM messages m
       LEFT JOIN mentors ON mentors.id = m.mentor_id
       WHERE m.id = ?`
    )
    .get(result.lastInsertRowid);
}

export function insertCandidate({
  conversationId,
  userMessageId,
  mentorId,
  content,
}) {
  const mentor = db
    .prepare(`SELECT name, model_id FROM mentors WHERE id = ?`)
    .get(mentorId);
  if (!mentor) {
    throw Object.assign(new Error('Mentor no encontrado'), { status: 409 });
  }
  const result = db
    .prepare(
      `INSERT INTO candidates
         (conversation_id, user_message_id, mentor_id, mentor_name, model_id, content, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(
      conversationId,
      userMessageId,
      mentorId,
      mentor.name || 'Mentor',
      mentor.model_id,
      content
    );
  return getCandidate(result.lastInsertRowid);
}

export function getPendingCandidates(conversationId, userMessageId = null) {
  if (userMessageId) {
    return db
      .prepare(
        `${CANDIDATE_SELECT}
         WHERE c.conversation_id = ?
           AND c.user_message_id = ?
           AND c.status = 'pending'
         ORDER BY c.id ASC`
      )
      .all(conversationId, userMessageId);
  }
  return db
    .prepare(
      `${CANDIDATE_SELECT}
       WHERE c.conversation_id = ? AND c.status = 'pending'
       ORDER BY c.id ASC`
    )
    .all(conversationId);
}

/**
 * Council round for the latest user message only.
 * Closed once any opinion is dismissed. Fully selected rounds stay
 * open so the user can unselect before sending the next turn.
 */
export function getRoundCandidates(conversationId) {
  const latestUser = db
    .prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND role = 'user'
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(conversationId);
  if (!latestUser) return [];

  const statuses = db
    .prepare(
      `SELECT status FROM candidates
       WHERE conversation_id = ? AND user_message_id = ?`
    )
    .all(conversationId, latestUser.id);
  if (statuses.length === 0) return [];
  if (statuses.some((s) => s.status === 'dismissed')) return [];

  return db
    .prepare(
      `${CANDIDATE_SELECT}
       WHERE c.conversation_id = ?
         AND c.user_message_id = ?
         AND c.status IN ('pending', 'selected')
       ORDER BY c.id ASC`
    )
    .all(conversationId, latestUser.id);
}

export function getOpenRoundCandidates(conversationId) {
  return getRoundCandidates(conversationId);
}

export function countOpenRoundChoices(conversationId) {
  return getRoundCandidates(conversationId).filter((c) => c.status === 'pending')
    .length;
}

export function getCandidate(id) {
  return db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id);
}

export function selectCandidate(candidateId, conversationId) {
  const select = db.transaction((id, convId) => {
    const candidate = getCandidate(id);
    if (!candidate) return null;
    if (Number(candidate.conversation_id) !== Number(convId)) {
      throw Object.assign(new Error('Candidata de otra conversación'), {
        status: 400,
      });
    }
    if (candidate.status !== 'pending') {
      throw new Error('Esta opinión ya no se puede elegir');
    }

    const message = insertMentorMessage(
      candidate.conversation_id,
      candidate.mentor_id,
      candidate.content
    );

    db.prepare(
      `UPDATE candidates SET status = 'selected', message_id = ? WHERE id = ?`
    ).run(message.id, id);

    return {
      candidate: getCandidate(id),
      message,
      roundCandidates: getRoundCandidates(convId),
    };
  });

  return select(candidateId, conversationId);
}

export function unselectCandidate(candidateId, conversationId) {
  const unselect = db.transaction((id, convId) => {
    const candidate = getCandidate(id);
    if (!candidate) return null;
    if (Number(candidate.conversation_id) !== Number(convId)) {
      throw Object.assign(new Error('Candidata de otra conversación'), {
        status: 400,
      });
    }
    if (candidate.status !== 'selected') {
      throw new Error('Esta opinión no está elegida');
    }

    const siblings = db
      .prepare(
        `SELECT status FROM candidates
         WHERE conversation_id = ? AND user_message_id = ?`
      )
      .all(convId, candidate.user_message_id);
    if (siblings.some((s) => s.status === 'dismissed')) {
      throw new Error('La ronda ya se cerró');
    }

    if (candidate.message_id) {
      deleteMessage(candidate.message_id, convId);
    }

    db.prepare(
      `UPDATE candidates SET status = 'pending', message_id = NULL WHERE id = ?`
    ).run(id);
    touchConversation(convId);

    return {
      candidate: getCandidate(id),
      messages: getMessages(convId),
      roundCandidates: getRoundCandidates(convId),
    };
  });

  return unselect(candidateId, conversationId);
}

export function dismissPendingCandidates(conversationId) {
  const dismiss = db.transaction((convId) => {
    const round = getRoundCandidates(convId);
    const open = round.filter((c) => c.status === 'pending');
    if (open.length === 0) {
      return { dismissed: 0, roundCandidates: [] };
    }
    const result = db
      .prepare(
        `UPDATE candidates SET status = 'dismissed'
         WHERE conversation_id = ? AND user_message_id = ? AND status = 'pending'`
      )
      .run(convId, open[0].user_message_id);
    touchConversation(convId);
    return {
      dismissed: result.changes,
      rejected: result.changes,
      roundCandidates: [],
      dismissedFromUserMessageId: open[0].user_message_id,
    };
  });
  return dismiss(conversationId);
}

/**
 * Opinions set aside (dismissed) — read-only archive for the Discarded tab.
 */
export function getDiscardedCandidates(conversationId) {
  const open = getRoundCandidates(conversationId);
  const openIds = new Set(open.map((c) => c.id));

  return db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS},
              um.content AS user_prompt
       ${CANDIDATE_FROM}
       LEFT JOIN messages um ON um.id = c.user_message_id
       WHERE c.conversation_id = ?
         AND c.status = 'dismissed'
       ORDER BY c.user_message_id DESC, c.id ASC`
    )
    .all(conversationId)
    .filter((c) => !openIds.has(c.id));
}

export default db;
