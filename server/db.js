import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'sophistai.sqlite');
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

adoptLegacyDbFile(legacyDbPath, dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureColumn(table, column, definition) {
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
    mentor_id INTEGER NOT NULL REFERENCES mentors(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'selected', 'rejected', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mentors_conversation ON mentors(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_conversation ON candidates(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_user_message ON candidates(user_message_id);
`);

ensureColumn('messages', 'speaker_name', 'TEXT');

function migrateCandidatesStatusConstraint() {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidates'`
    )
    .get();
  if (!row?.sql || row.sql.includes("'dismissed'")) return;

  db.exec(`
    CREATE TABLE candidates_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      mentor_id INTEGER NOT NULL REFERENCES mentors(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'selected', 'rejected', 'dismissed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO candidates_new
      (id, conversation_id, user_message_id, mentor_id, content, status, created_at)
    SELECT id, conversation_id, user_message_id, mentor_id, content, status, created_at
    FROM candidates;
    DROP TABLE candidates;
    ALTER TABLE candidates_new RENAME TO candidates;
    CREATE INDEX IF NOT EXISTS idx_candidates_conversation ON candidates(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_user_message ON candidates(user_message_id);
  `);
}

migrateCandidatesStatusConstraint();

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
  const result = db
    .prepare(
      `INSERT INTO conversations (title, language) VALUES (?, ?)`
    )
    .run(title.trim() || 'Nueva sala', lang);
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

export function replaceMentors(conversationId, mentors) {
  const replace = db.transaction((items) => {
    db.prepare(`DELETE FROM mentors WHERE conversation_id = ?`).run(
      conversationId
    );
    const insert = db.prepare(
      `INSERT INTO mentors (conversation_id, name, model_id, sort_order)
       VALUES (?, ?, ?, ?)`
    );
    items.forEach((m, index) => {
      insert.run(
        conversationId,
        String(m.name || `Mentor ${index + 1}`).trim(),
        String(m.model_id).trim(),
        Number.isFinite(m.sort_order) ? m.sort_order : index
      );
    });
    touchConversation(conversationId);
    return getMentors(conversationId);
  });
  return replace(mentors);
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
  const result = db
    .prepare(
      `INSERT INTO candidates
         (conversation_id, user_message_id, mentor_id, content, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(conversationId, userMessageId, mentorId, content);
  return db
    .prepare(
      `SELECT c.id, c.conversation_id, c.user_message_id, c.mentor_id,
              c.content, c.status, c.created_at,
              mentors.name AS mentor_name, mentors.model_id
       FROM candidates c
       JOIN mentors ON mentors.id = c.mentor_id
       WHERE c.id = ?`
    )
    .get(result.lastInsertRowid);
}

export function getPendingCandidates(conversationId, userMessageId = null) {
  if (userMessageId) {
    return db
      .prepare(
        `SELECT c.id, c.conversation_id, c.user_message_id, c.mentor_id,
                c.content, c.status, c.created_at,
                mentors.name AS mentor_name, mentors.model_id
         FROM candidates c
         JOIN mentors ON mentors.id = c.mentor_id
         WHERE c.conversation_id = ?
           AND c.user_message_id = ?
           AND c.status = 'pending'
         ORDER BY c.id ASC`
      )
      .all(conversationId, userMessageId);
  }
  return db
    .prepare(
      `SELECT c.id, c.conversation_id, c.user_message_id, c.mentor_id,
              c.content, c.status, c.created_at,
              mentors.name AS mentor_name, mentors.model_id
       FROM candidates c
       JOIN mentors ON mentors.id = c.mentor_id
       WHERE c.conversation_id = ? AND c.status = 'pending'
       ORDER BY c.id ASC`
    )
    .all(conversationId);
}

/**
 * Open council round for the latest user message that still has
 * pending or rejected (not yet dismissed) opinions to review/rescue.
 */
export function getRoundCandidates(conversationId) {
  let row = db
    .prepare(
      `SELECT user_message_id
       FROM candidates
       WHERE conversation_id = ?
         AND status IN ('pending', 'rejected')
       ORDER BY user_message_id DESC, id DESC
       LIMIT 1`
    )
    .get(conversationId);

  if (!row) {
    row = db
      .prepare(
        `SELECT user_message_id
         FROM candidates
         WHERE conversation_id = ?
           AND status = 'selected'
           AND user_message_id NOT IN (
             SELECT user_message_id FROM candidates
             WHERE conversation_id = ? AND status = 'dismissed'
           )
         ORDER BY user_message_id DESC, id DESC
         LIMIT 1`
      )
      .get(conversationId, conversationId);
  }
  if (!row) return [];

  return db
    .prepare(
      `SELECT c.id, c.conversation_id, c.user_message_id, c.mentor_id,
              c.content, c.status, c.created_at,
              mentors.name AS mentor_name, mentors.model_id
       FROM candidates c
       JOIN mentors ON mentors.id = c.mentor_id
       WHERE c.conversation_id = ?
         AND c.user_message_id = ?
         AND c.status IN ('pending', 'selected', 'rejected')
       ORDER BY c.id ASC`
    )
    .all(conversationId, row.user_message_id);
}

export function getOpenRoundCandidates(conversationId) {
  return getRoundCandidates(conversationId);
}

export function countOpenRoundChoices(conversationId) {
  return getRoundCandidates(conversationId).filter(
    (c) => c.status === 'pending' || c.status === 'rejected'
  ).length;
}

export function getCandidate(id) {
  return db
    .prepare(
      `SELECT c.id, c.conversation_id, c.user_message_id, c.mentor_id,
              c.content, c.status, c.created_at,
              mentors.name AS mentor_name, mentors.model_id
       FROM candidates c
       JOIN mentors ON mentors.id = c.mentor_id
       WHERE c.id = ?`
    )
    .get(id);
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
    if (candidate.status !== 'pending' && candidate.status !== 'rejected') {
      throw new Error('Esta opinión ya no se puede elegir');
    }

    db.prepare(`UPDATE candidates SET status = 'selected' WHERE id = ?`).run(id);

    const message = insertMentorMessage(
      candidate.conversation_id,
      candidate.mentor_id,
      candidate.content
    );

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

    const inserted = db
      .prepare(
        `SELECT id FROM messages
         WHERE conversation_id = ?
           AND role = 'mentor'
           AND mentor_id = ?
           AND content = ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(convId, candidate.mentor_id, candidate.content);
    if (inserted) {
      deleteMessage(inserted.id, convId);
    }

    db.prepare(`UPDATE candidates SET status = 'pending' WHERE id = ?`).run(id);
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
    const open = db
      .prepare(
        `SELECT id, user_message_id FROM candidates
         WHERE conversation_id = ? AND status IN ('pending', 'rejected')
         ORDER BY id ASC`
      )
      .all(convId);
    if (open.length === 0) {
      return { rejected: 0, roundCandidates: [] };
    }
    const result = db
      .prepare(
        `UPDATE candidates SET status = 'dismissed'
         WHERE conversation_id = ? AND status IN ('pending', 'rejected')`
      )
      .run(convId);
    touchConversation(convId);
    return {
      rejected: result.changes,
      roundCandidates: [],
      dismissedFromUserMessageId: open[0].user_message_id,
    };
  });
  return dismiss(conversationId);
}

/**
 * Opinions set aside (dismissed) or leftover rejected outside the open
 * review round — read-only archive for the Discarded tab.
 */
export function getDiscardedCandidates(conversationId) {
  const open = getRoundCandidates(conversationId);
  const openIds = new Set(open.map((c) => c.id));

  return db
    .prepare(
      `SELECT c.id, c.conversation_id, c.user_message_id, c.mentor_id,
              c.content, c.status, c.created_at,
              mentors.name AS mentor_name, mentors.model_id,
              um.content AS user_prompt
       FROM candidates c
       JOIN mentors ON mentors.id = c.mentor_id
       LEFT JOIN messages um ON um.id = c.user_message_id
       WHERE c.conversation_id = ?
         AND c.status IN ('dismissed', 'rejected')
       ORDER BY c.user_message_id DESC, c.id ASC`
    )
    .all(conversationId)
    .filter((c) => !openIds.has(c.id));
}

export default db;
