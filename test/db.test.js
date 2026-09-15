import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sophistai-db-'));
process.env.SOPHISTAI_DB_PATH = path.join(dir, 'test.sqlite');

const {
  createConversation,
  replaceMentors,
  getMentors,
  insertUserMessage,
  insertCandidate,
  selectCandidate,
  unselectCandidate,
  dismissPendingCandidates,
  getRoundCandidates,
  countOpenRoundChoices,
  getDiscardedCandidates,
  getMessages,
  sweepOrphanUserMessages,
} = await import('../server/db.js');
const { MAX_MENTORS } = await import('../server/constants.js');

function seedRoom() {
  const conv = createConversation({ title: 'Sala test' });
  const mentors = replaceMentors(conv.id, [
    { model_id: 'model/a', name: 'Ada' },
    { model_id: 'model/b', name: 'Bea' },
  ]);
  return { conv, mentors };
}

test('createConversation coerces a null title', () => {
  const conv = createConversation({ title: null });
  assert.equal(conv.title, 'Nueva sala');
});

test('select then unselect deletes only the linked message', () => {
  const { conv, mentors } = seedRoom();
  const user = insertUserMessage(conv.id, 'hola');
  const first = insertCandidate({
    conversationId: conv.id,
    userMessageId: user.id,
    mentorId: mentors[0].id,
    content: 'same text',
  });
  const second = insertCandidate({
    conversationId: conv.id,
    userMessageId: user.id,
    mentorId: mentors[1].id,
    content: 'same text',
  });
  const selectedFirst = selectCandidate(first.id, conv.id);
  const selectedSecond = selectCandidate(second.id, conv.id);
  assert.ok(selectedFirst.candidate.message_id);
  assert.ok(selectedSecond.candidate.message_id);

  unselectCandidate(first.id, conv.id);
  const mentorMessages = getMessages(conv.id).filter((m) => m.role === 'mentor');
  assert.equal(mentorMessages.length, 1);
  assert.equal(mentorMessages[0].id, selectedSecond.message.id);
});

test('replaceMentors upserts by model_id and keeps dismissed archive', () => {
  const { conv, mentors } = seedRoom();
  const adaId = mentors[0].id;
  const user = insertUserMessage(conv.id, 'pregunta');
  const keep = insertCandidate({
    conversationId: conv.id,
    userMessageId: user.id,
    mentorId: mentors[0].id,
    content: 'quédate',
  });
  insertCandidate({
    conversationId: conv.id,
    userMessageId: user.id,
    mentorId: mentors[1].id,
    content: 'descarta',
  });
  selectCandidate(keep.id, conv.id);
  dismissPendingCandidates(conv.id);

  const before = getDiscardedCandidates(conv.id);
  assert.equal(before.length, 1);
  assert.equal(before[0].mentor_name, 'Bea');

  const next = replaceMentors(conv.id, [
    { model_id: 'model/a', name: 'Ada Prime' },
    { model_id: 'model/c', name: 'Cora' },
  ]);
  assert.equal(next.find((m) => m.model_id === 'model/a').id, adaId);
  assert.equal(next.find((m) => m.model_id === 'model/a').name, 'Ada Prime');
  assert.ok(next.find((m) => m.model_id === 'model/c'));
  assert.equal(next.find((m) => m.model_id === 'model/b'), undefined);

  const discarded = getDiscardedCandidates(conv.id);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].content, 'descarta');
  assert.equal(discarded[0].mentor_name, 'Bea');
});

test('a closed later round does not resurrect an earlier fully selected round', () => {
  const { conv, mentors } = seedRoom();
  const firstUser = insertUserMessage(conv.id, 'turno 1');
  const a1 = insertCandidate({
    conversationId: conv.id,
    userMessageId: firstUser.id,
    mentorId: mentors[0].id,
    content: 'uno-a',
  });
  const b1 = insertCandidate({
    conversationId: conv.id,
    userMessageId: firstUser.id,
    mentorId: mentors[1].id,
    content: 'uno-b',
  });
  selectCandidate(a1.id, conv.id);
  selectCandidate(b1.id, conv.id);
  assert.equal(countOpenRoundChoices(conv.id), 0);
  assert.equal(getRoundCandidates(conv.id).length, 2);

  const secondUser = insertUserMessage(conv.id, 'turno 2');
  const a2 = insertCandidate({
    conversationId: conv.id,
    userMessageId: secondUser.id,
    mentorId: mentors[0].id,
    content: 'dos-a',
  });
  insertCandidate({
    conversationId: conv.id,
    userMessageId: secondUser.id,
    mentorId: mentors[1].id,
    content: 'dos-b',
  });
  selectCandidate(a2.id, conv.id);
  dismissPendingCandidates(conv.id);

  assert.equal(getRoundCandidates(conv.id).length, 0);
  assert.equal(countOpenRoundChoices(conv.id), 0);
  assert.equal(getDiscardedCandidates(conv.id).length, 1);
});

test('replaceMentors rejects more than MAX_MENTORS', () => {
  const conv = createConversation();
  const tooMany = Array.from({ length: MAX_MENTORS + 1 }, (_, i) => ({
    model_id: `model/${i}`,
    name: `M${i}`,
  }));
  assert.throws(() => replaceMentors(conv.id, tooMany), /Máximo/);
});

test('sweepOrphanUserMessages deletes user turns with no candidates', () => {
  const { conv } = seedRoom();
  insertUserMessage(conv.id, 'huérfano');
  sweepOrphanUserMessages();
  assert.equal(getMessages(conv.id).length, 0);
});
